#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Publish an exact CN channel snapshot to its fixed OSS prefix; never delete."""

import argparse
import datetime
import json
import os
import pathlib
import subprocess
import tempfile
import urllib.parse

import prepare_cn as P
import promote_cn as C

DESTINATIONS = {"stable": "oss://walle-mgu/mgu/cn/",
                "beta": "oss://walle-mgu/mgu/cn/beta/"}
REQUIRED_CI = {"mgu-store": ("CN source checks", "CN installer checks"),
               "idrive-apps": ("CN source checks", "Test")}

class ConcurrentPublication(RuntimeError):
    pass


def immutable(rel):
    return any("/" + part + "/" in "/" + rel for part in ("packages", "icons", "source", "candidates"))


def cache(rel):
    return "public, max-age=31536000, immutable" if immutable(rel) else "no-cache"


def content_type(rel):
    if rel.endswith(".png"):
        return "image/png"
    if rel.endswith(".json"):
        return "application/json"
    if rel.endswith(".js"):
        return "application/javascript"
    if rel.endswith((".tgz", ".tar.gz")):
        return "application/gzip"
    return "text/plain; charset=utf-8"


def download(url, output):
    """Only public HTTPS; callers never pass signed or authenticated URLs."""
    output.parent.mkdir(parents=True, exist_ok=True)
    headers = output.with_name(output.name + ".headers")
    p = subprocess.run(["curl", "--silent", "--show-error", "--proto", "=https",
                        "--connect-timeout", "15", "--max-time", "180",
                        "--max-filesize", str(P.MAX_FILE), "--dump-header", str(headers),
                        "--output", str(output), "--write-out", "%{http_code}", url],
                       capture_output=True, text=True, timeout=190)
    if p.returncode:
        raise RuntimeError("Public HTTPS request failed: " + urllib.parse.urlsplit(url).path)
    if p.stdout.strip() == "404":
        return None
    if p.stdout.strip() != "200":
        raise RuntimeError("Public HTTPS status " + p.stdout.strip() + ": " + urllib.parse.urlsplit(url).path)
    return {k.lower(): v.strip() for line in headers.read_text().splitlines()
            if ":" in line for k, v in [line.split(":", 1)]}


def check_ci(manifest, work):
    evidence = {}
    for repo, names in REQUIRED_CI.items():
        record = manifest["repositories"][repo]
        file = work / (repo + "-ci.json")
        url = ("https://api.github.com/repos/" + P.REPOS[repo] +
               "/actions/runs?head_sha=" + record["commit"] + "&per_page=100")
        if download(url, file) is None:
            raise ValueError("CI evidence unavailable: " + repo)
        runs = P.read_json(file).get("workflow_runs", [])
        accepted = []
        for name in names:
            matches = [r for r in runs if r.get("head_sha") == record["commit"] and r.get("name") == name]
            newest = max(matches, key=lambda r: (r.get("id", 0), r.get("run_attempt", 0)), default=None)
            if not newest or newest.get("status") != "completed" or newest.get("conclusion") != "success":
                raise ValueError("Exact-commit CI is not successful: " + repo + " / " + name)
            accepted.append({k: newest[k] for k in ("id", "name", "head_sha", "html_url")})
        evidence[repo] = accepted
    return evidence


def validate_transition(old, new, old_root, new_root):
    if not old:
        return
    for repo in P.REPOS:
        before = P.read_json(old_root / repo / "catalog.json")
        after = {c["id"]: c for c in P.read_json(new_root / repo / "catalog.json")["components"]}
        for previous in before["components"]:
            current = after.get(previous["id"])
            if not current or tuple(map(int, current["version"].split("."))) < tuple(map(int, previous["version"].split("."))):
                raise ValueError("Channel publication cannot remove or downgrade " + previous["id"])
            if current["version"] == previous["version"] and current["artifact"] != previous["artifact"]:
                raise ValueError("Published component bytes require a new version: " + previous["id"])


class Remote:
    def __init__(self, channel, cli, config, work):
        if channel not in DESTINATIONS:
            raise ValueError("Unknown CN release channel")
        self.channel, self.cli, self.config, self.work = channel, cli, config, work
        self.base, self.destination = P.BASES[channel], DESTINATIONS[channel]
        self.options = ["--config-file", str(config), "--region", "cn-hangzhou",
                        "--endpoint", "https://oss-cn-hangzhou.aliyuncs.com", "--retry-times", "1"]

    def binding(self):
        p = subprocess.run([str(self.cli), "api", "list-cname", "--bucket", "walle-mgu",
                            "--output-format", "json"] + self.options,
                           capture_output=True, text=True, timeout=60, cwd=self.work)
        if p.returncode:
            raise RuntimeError("Cannot verify the CN domain/certificate binding")
        value = json.JSONDecoder().raw_decode(p.stdout.lstrip())[0]
        entries = value.get("Cname", [])
        if isinstance(entries, dict):
            entries = [entries]
        if value.get("Bucket") != "walle-mgu" or not any(
                e.get("Domain") == "mgu.walle.pw" and e.get("Status") == "Enabled"
                and e.get("Certificate", {}).get("Status") == "Enabled" for e in entries):
            raise ValueError("CN domain and HTTPS certificate must be enabled")

    def get(self, rel, root):
        P.relative(rel)
        return download(self.base + rel, root / rel)

    def put(self, rel, root):
        P.relative(rel)
        p = subprocess.run([str(self.cli), "cp", str(root / rel), self.destination + rel,
                            "--force", "--no-progress", "--cache-control", cache(rel),
                            "--content-type", content_type(rel), "--output-dir",
                            str(self.work / "ossutil-output")] + self.options,
                           capture_output=True, text=True, timeout=300, cwd=self.work)
        if p.returncode:
            raise RuntimeError("OSS upload failed: " + rel)

    def verify(self, rel, entry, root):
        headers = self.get(rel, root)
        if headers is None:
            raise ValueError("Public file is missing: " + rel)
        file = root / rel
        if file.stat().st_size != entry["size"]:
            raise ValueError("Public size mismatch: " + rel)
        P.verified(file, entry["sha256"])
        directives = {v.strip().lower() for v in headers.get("cache-control", "").split(",")}
        wanted = {v.strip() for v in cache(rel).split(",")}
        if not wanted <= directives or (immutable(rel) and directives.intersection({"no-cache", "no-store", "private"})):
            raise ValueError("Public cache metadata mismatch: " + rel)
        if rel.endswith(".png") and headers.get("content-type", "").split(";")[0] != "image/png":
            raise ValueError("Public PNG content type mismatch: " + rel)


def entry(root, rel):
    file = root / rel
    return {"path": rel, "size": file.stat().st_size, "sha256": P.digest(file)}


def publish(remote, source, work, execute):
    manifest = C.snapshot(source)
    if manifest.get("release_channel", "stable") != remote.channel:
        raise ValueError("Explicit channel differs from snapshot")
    if remote.channel == "stable":
        vehicle_validated = (manifest.get("status") == "stable-validated"
                             and manifest.get("validation", {}).get("method") in
                             ("owner-vehicle", "head-unit-emulator-and-vehicle")
                             and set(manifest.get("validation", {}).get("checks", [])) == set(C.CHECKS)
                             and all(r.get("integration") == {"context": P.CONTEXT, "state": "success", "sha": r["commit"]}
                                     for r in manifest["repositories"].values()))
        if (manifest.get("installReady") is not True
                or not P.SHA.fullmatch(manifest.get("promoted_from", ""))
                or not (vehicle_validated or C.reviewed_upstream(manifest))):
            raise ValueError("Stable publication requires an exact vehicle-validated or reviewed-upstream promotion")
        rel = "candidates/" + manifest["promoted_from"] + "/cn-manifest.json"
        file = work / "beta-proof.json"
        if download(P.BASES["beta"] + rel, file) is None:
            raise ValueError("Promoted Beta candidate was not publicly published")
        P.verified(file, manifest["promoted_from"])
        beta = P.read_json(file)
        unchanged = lambda m: {e["path"]: (e["size"], e["sha256"]) for e in m["files"]
                              if not e["path"].endswith("/catalog.json")}
        if beta.get("release_channel") != "beta" or unchanged(beta) != unchanged(manifest):
            raise ValueError("Stable payload differs from the tested public Beta")
    elif manifest.get("installReady") is not False:
        raise ValueError("Beta must not claim Stable installation readiness")
    ci = check_ci(manifest, work)
    remote.binding()
    old_root = work / "before"
    old = None
    if remote.get("cn-manifest.json", old_root) is not None:
        old = P.read_json(old_root / "cn-manifest.json")
        if old.get("release_channel", "stable") != remote.channel or not isinstance(old.get("files"), list):
            raise ValueError("The existing public channel manifest is invalid")
        for item in old["files"]:
            remote.verify(item["path"], item, old_root)
        C.snapshot(old_root)
    validate_transition(old, manifest, old_root, source)
    current_sha = P.digest(old_root / "cn-manifest.json") if old else None
    old_files = {f["path"]: f for f in old["files"]} if old else {}
    plan = []
    for item in manifest["files"]:
        rel = item["path"]
        if item.get("cache_control") != cache(rel):
            raise ValueError("Snapshot cache policy mismatch: " + rel)
        if old_files.get(rel) == item:
            continue
        if immutable(rel):
            probe = work / "existing-resources"
            if remote.get(rel, probe) is not None:
                if (probe / rel).stat().st_size != item["size"] or P.digest(probe / rel) != item["sha256"]:
                    raise ValueError("Refusing to overwrite an immutable resource: " + rel)
        plan.append(item)
    digest = P.digest(source / "cn-manifest.json")
    candidate = "candidates/" + digest + "/cn-manifest.json"
    P.copy_file(source / "cn-manifest.json", work / "candidate" / candidate)
    result = {"channel": remote.channel, "status": "prepared", "manifest_sha256": digest,
              "ci": ci, "planned": [p["path"] for p in plan], "uploaded": [],
              "public_verified": False,
              "vehicle_validated": remote.channel == "stable" and manifest.get("status") == "stable-validated"}
    if not execute:
        return result
    if current_sha == digest and not plan:
        remote.verify("cn-manifest.json", entry(source, "cn-manifest.json"), work / "unchanged-check")
        result.update(status="unchanged", public_verified=True)
        return result
    changed = []
    phase = "resources"
    try:
        for item in sorted(plan, key=lambda f: (not immutable(f["path"]), f["path"])):
            rel = item["path"]
            if not immutable(rel):
                phase = "metadata"
                probe = work / "concurrency-check"
                exists = remote.get("cn-manifest.json", probe) is not None
                if (P.digest(probe / "cn-manifest.json") if exists else None) != current_sha:
                    raise ConcurrentPublication("The public channel changed during publication")
                changed.append(rel)
            remote.put(rel, source)
            remote.verify(rel, item, work / "uploaded-check")
            result["uploaded"].append(rel)
        probe = work / "existing-candidate"
        if remote.get(candidate, probe) is not None and P.digest(probe / candidate) != digest:
            raise ValueError("Immutable candidate record differs from its SHA-256")
        remote.put(candidate, work / "candidate")
        remote.verify(candidate, entry(work / "candidate", candidate), work / "candidate-check")
        phase = "manifest"
        probe = work / "final-concurrency-check"
        exists = remote.get("cn-manifest.json", probe) is not None
        if (P.digest(probe / "cn-manifest.json") if exists else None) != current_sha:
            raise ConcurrentPublication("The public channel changed before manifest commit")
        changed.append("cn-manifest.json")
        remote.put("cn-manifest.json", source)
        for item in manifest["files"] + [entry(source, "cn-manifest.json")]:
            remote.verify(item["path"], item, work / "acceptance")
        C.snapshot(work / "acceptance")
        result.update(status="published", public_verified=True,
                      uploaded=result["uploaded"] + [candidate, "cn-manifest.json"])
    except Exception as error:
        failed = []
        for rel in changed:
            if isinstance(error, ConcurrentPublication) or not old or (rel != "cn-manifest.json" and rel not in old_files):
                failed.append(rel)
                continue
            try:
                remote.put(rel, old_root)
                remote.verify(rel, entry(old_root, rel), work / "rollback-check")
            except Exception:
                failed.append(rel)
        result.update(status="failed", phase=phase, error=str(error),
                      rollback_complete=not failed, affected_paths=failed,
                      concurrency_conflict=isinstance(error, ConcurrentPublication),
                      note="Historical and unreferenced resources are retained; no objects are deleted")
        P.write_json(work / "result.json", result)
        raise
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, type=pathlib.Path)
    parser.add_argument("--expect-snapshot", required=True)
    parser.add_argument("--channel", choices=tuple(DESTINATIONS), default="stable")
    for name in ("ossutil", "config", "work-dir"):
        parser.add_argument("--" + name, required=True, type=pathlib.Path)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    repo = pathlib.Path(__file__).resolve().parents[1]
    for name in ("snapshot", "ossutil", "config", "work_dir"):
        value = getattr(args, name).expanduser().resolve()
        if name != "ossutil" and (value == repo or repo in value.parents):
            parser.error("Private settings and release resources belong outside the repository")
        setattr(args, name, value)
    if not args.config.is_file() or args.config.stat().st_mode & 0o077:
        parser.error("OSS configuration must exist and be readable only by its owner")
    args.work_dir.mkdir(parents=True, exist_ok=True)
    lock = args.work_dir / ".publish.lock"
    held = False
    work = None
    try:
        P.verified(P.regular(args.snapshot, "cn-manifest.json"), args.expect_snapshot)
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        held = True
        with os.fdopen(fd, "w") as stream:
            stream.write(str(os.getpid()) + "\n")
        work = pathlib.Path(tempfile.mkdtemp(prefix=datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ-"),
                                            dir=args.work_dir))
        manifest = C.snapshot(args.snapshot)
        source = work / "snapshot"
        for item in manifest["files"] + [entry(args.snapshot, "cn-manifest.json")]:
            P.copy_file(P.regular(args.snapshot, item["path"]), source / item["path"])
        P.verified(source / "cn-manifest.json", args.expect_snapshot)
        result = publish(Remote(args.channel, args.ossutil, args.config, work), source, work, args.publish)
        P.write_json(work / "result.json", result)
        P.write_json(args.work_dir / ("latest-" + args.channel + "-" + ("success" if args.publish else "prepared") + ".json"),
                     dict(result, work_dir=str(work)))
        print(json.dumps({"status": result["status"], "channel": args.channel, "result": str(work / "result.json")}))
    except (OSError, ValueError, KeyError, RuntimeError, P.tarfile.TarError, subprocess.TimeoutExpired) as error:
        if work is not None and not (work / "result.json").exists():
            P.write_json(work / "result.json", {"status": "failed", "phase": "preflight", "error": str(error)})
        parser.exit(1, "CN publication stopped: " + str(error) + "\n")
    finally:
        if held:
            lock.unlink()


if __name__ == "__main__":
    main()
