#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Promote verified Beta bytes locally; publication is a separate operation."""

import argparse
import copy
import json
import pathlib
import shutil
import tempfile

import prepare_cn as P

CHECKS = ("source_checks", "installation", "migration", "component_update_order",
          "restart", "settings", "update_channel", "self_update", "rollback")
OWNER_CHECKS = ("source_checks", "code_review", "reproducible_build")
UPSTREAM_CHECKS = ("source_checks", "upstream_review", "reproducible_build")


def upstream_commits(value):
    return (isinstance(value, dict) and set(value) == set(P.REPOS)
            and all(isinstance(sha, str) and P.COMMIT.fullmatch(sha) for sha in value.values()))


def reviewed_upstream(manifest):
    validation = manifest.get("validation", {})
    return (manifest.get("status") == "stable-upstream-reviewed"
            and validation.get("method") == "reviewed-upstream"
            and set(validation.get("checks", [])) == set(UPSTREAM_CHECKS)
            and validation.get("fully_vehicle_validated") is False
            and upstream_commits(validation.get("upstream_commits"))
            and all(r.get("integration") == {"context": P.CONTEXT, "state": "pending", "sha": r["commit"]}
                    for r in manifest["repositories"].values()))


def owner_reviewed(manifest):
    v = manifest.get("validation", {})
    kept = v.get("retained_repositories", [])
    components = v.get("retained_components", {})
    return (manifest.get("status") == "stable-owner-reviewed"
            and v.get("method") == "owner-reviewed"
            and set(v.get("checks", [])) == set(OWNER_CHECKS)
            and v.get("fully_vehicle_validated") is False
            and v.get("owner_authorized") is True
            and isinstance(kept, list) and len(set(kept)) == len(kept)
            and set(kept) < set(P.REPOS)
            and retained_components_valid(components)
            and not set(components).intersection(kept)
            and (not (kept or components) or P.SHA.fullmatch(v.get("retained_from", "")))
            and all(r.get("integration") == {"context": P.CONTEXT, "state": "pending", "sha": r["commit"]}
                    for r in manifest["repositories"].values()))


def retained_components_valid(value):
    return (isinstance(value, dict) and set(value) <= set(P.REPOS)
            and all(isinstance(ids, list) and ids and len(ids) == len(set(ids))
                    and all(isinstance(identity, str) and P.IDENTITY.fullmatch(identity) for identity in ids)
                    for ids in value.values()))


def compare_component_retention(beta, candidate, base, retained):
    """New/shared entries match Beta exactly; selected trial entries remain exact Stable bytes."""
    for repo, identities in retained.items():
        def entries(root):
            return {c["id"]: c for c in P.read_json(pathlib.Path(root) / repo / "catalog.json")["components"]}
        a, b, old = entries(beta), entries(candidate), entries(base)
        if set(a) != set(b) or not set(identities) < set(b) or not set(identities) <= set(old):
            raise ValueError("Retained component set must exist beside shared Beta components")
        for identity, component in b.items():
            expected = old[identity] if identity in identities else a[identity]
            if component != expected:
                raise ValueError("Component differs from its reviewed channel: " + identity)
        if P.digest(pathlib.Path(beta) / repo / "LICENSE") != P.digest(pathlib.Path(candidate) / repo / "LICENSE"):
            raise ValueError("Component retention cannot change repository licensing")


def payloads(manifest, repositories=None):
    return {e["path"]: (e["size"], e["sha256"]) for e in manifest["files"]
            if not e["path"].endswith("/catalog.json")
            and (repositories is None or e["path"].split("/")[0] in repositories)}


def snapshot(root):
    root = pathlib.Path(root).resolve()
    manifest = P.read_json(P.regular(root, "cn-manifest.json"))
    channel = manifest.get("release_channel", "stable")
    if (manifest.get("schema") != 1 or manifest.get("distribution") != "walle-cn"
            or channel not in P.BASES or manifest.get("base_url") != P.BASES[channel]):
        raise ValueError("Invalid CN channel manifest")
    files = {}
    for entry in manifest.get("files", []):
        rel = str(P.relative(entry["path"]))
        if rel in files or not isinstance(entry.get("size"), int) or isinstance(entry["size"], bool):
            raise ValueError("Invalid or duplicate inventory")
        file = P.regular(root, rel)
        if file.stat().st_size != entry["size"]:
            raise ValueError("Snapshot size mismatch: " + rel)
        P.verified(file, entry["sha256"])
        files[rel] = entry
    expected = {"NOTICE.txt", "bootstrap/SHA256SUMS"} | {"bootstrap/" + n for n in P.BOOTSTRAP}
    catalogs = {}
    for repo in P.REPOS:
        record = manifest.get("repositories", {}).get(repo, {})
        if record.get("repository") != P.REPOS[repo] or not P.COMMIT.fullmatch(record.get("commit", "")):
            raise ValueError("Invalid snapshot source identity")
        source = repo + "/source/" + record["commit"] + ".tar.gz"
        expected.update((repo + "/LICENSE", repo + "/catalog.json", repo + "/source-catalog.json", source))
        P.verified(P.regular(root, source), record.get("source_sha256"))
        P.inspect_tar(root / source, record["commit"])
        P.verified(P.regular(root, repo + "/source-catalog.json"), record.get("catalog_sha256"))
        catalog = P.read_json(P.regular(root, repo + "/catalog.json"))
        if (catalog.get("distribution") != "walle-cn" or catalog.get("release_channel", "stable") != channel
                or catalog.get("commit") != record["commit"]
                or record.get("catalog_url") != P.BASES[channel] + repo + "/catalog.json"):
            raise ValueError("Catalog channel/commit differs from snapshot")
        local = copy.deepcopy(catalog)
        for entry in local.get("components", []):
            a = entry["artifact"]
            rel = "packages/" + a["sha256"] + "/" + a["name"]
            if a.get("url") != rel:
                raise ValueError("Noncanonical CN package URL")
            file = P.regular(root, repo + "/" + rel)
            P.verified(file, a["sha256"])
            if file.stat().st_size != a["size"]:
                raise ValueError("Package size differs from catalog")
            P.inspect_tar(file)
            expected.add(repo + "/" + rel)
            a["url"] = a["name"]
            if entry.get("icon"):
                name = pathlib.PurePosixPath(entry["icon"]).name
                rel = "icons/" + entry["iconSha256"] + "/" + name
                if entry["icon"] != rel:
                    raise ValueError("Noncanonical CN icon URL")
                P.verified(P.regular(root, repo + "/" + rel), entry["iconSha256"])
                P.verify_png(root / repo / rel)
                expected.add(repo + "/" + rel)
                entry["icon"] = name
        catalogs[repo] = P.validate_catalog(local)
    if set(files) != expected:
        raise ValueError("Snapshot inventory does not match catalogs and provenance")
    P.validate_dependencies(catalogs)
    sums = "".join(P.digest(root / "bootstrap" / n) + "  " + n + "\n" for n in P.BOOTSTRAP)
    if (root / "bootstrap/SHA256SUMS").read_text() != sums:
        raise ValueError("Bootstrap checksums differ")
    return manifest


def promote(beta, evidence, output, stable_base=None, stable_candidate=None):
    beta, evidence, output = pathlib.Path(beta).resolve(), pathlib.Path(evidence), pathlib.Path(output).absolute()
    manifest = snapshot(beta)
    if manifest.get("release_channel") != "beta":
        raise ValueError("Promotion requires a Beta snapshot")
    review = P.read_json(evidence)
    beta_sha = P.digest(beta / "cn-manifest.json")
    upstream = review.get("method") == "reviewed-upstream"
    owner = review.get("method") == "owner-reviewed"
    checks = OWNER_CHECKS if owner else UPSTREAM_CHECKS if upstream else CHECKS
    if (review.get("schema") != 1 or review.get("snapshot_sha256") != beta_sha
            or review.get("state") != "passed"
            or review.get("method") not in ("owner-vehicle", "head-unit-emulator-and-vehicle", "reviewed-upstream", "owner-reviewed")
            or any(review.get("checks", {}).get(c) != "passed" for c in checks)
            or (upstream and not upstream_commits(review.get("upstream_commits")))
            or (owner and review.get("owner_authorized") is not True)):
        raise ValueError("Promotion requires passed validation of this exact Beta snapshot")
    retained = review.get("retained_repositories", [])
    if not isinstance(retained, list) or len(set(retained)) != len(retained) or not set(retained) < set(P.REPOS):
        raise ValueError("Retain only a proper subset of repositories")
    components = review.get("retained_components", {})
    if not retained_components_valid(components) or set(components).intersection(retained):
        raise ValueError("Invalid retained component selection")
    base = None
    if retained or components:
        if not owner or stable_base is None:
            raise ValueError("Retaining Stable requires explicit owner review and its exact snapshot")
        stable_base = pathlib.Path(stable_base).resolve()
        base = snapshot(stable_base)
        if base.get("release_channel") != "stable" or review.get("retained_from") != P.digest(stable_base / "cn-manifest.json"):
            raise ValueError("Retained Stable snapshot differs from owner review")
    copy_root, copy_manifest = beta, manifest
    if components:
        if stable_candidate is None:
            raise ValueError("Component retention requires a prepared Stable source candidate")
        copy_root = pathlib.Path(stable_candidate).resolve()
        copy_manifest = snapshot(copy_root)
        if (copy_manifest.get("release_channel") != "beta"
                or review.get("stable_candidate_sha256") != P.digest(copy_root / "cn-manifest.json")):
            raise ValueError("Stable source candidate differs from owner review")
        unaffected = set(P.REPOS) - set(components)
        if payloads(manifest, unaffected) != payloads(copy_manifest, unaffected):
            raise ValueError("Unselected repositories must match Beta")
        # Bootstrap and root notices are shared even when the app source commits differ.
        if {k: v for k, v in payloads(manifest).items() if k.split("/")[0] not in P.REPOS} != {
                k: v for k, v in payloads(copy_manifest).items() if k.split("/")[0] not in P.REPOS}:
            raise ValueError("Bootstrap must match Beta")
        compare_component_retention(beta, copy_root, stable_base, components)
    elif stable_candidate is not None:
        raise ValueError("A separate candidate is only for component retention")
    report = review.get("report")
    if not isinstance(report, str) or not report.strip() or not pathlib.Path(report).is_file():
        raise ValueError("Keep the actual private validation report before promotion")
    if output.exists() or output.is_symlink():
        raise ValueError("Output must be a new folder")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = pathlib.Path(tempfile.mkdtemp(prefix=".cn-promote-", dir=output.parent)).resolve()
    try:
        for entry in copy_manifest["files"]:
            P.copy_file(P.regular(copy_root, entry["path"]), stage / entry["path"])
        promoted = copy.deepcopy(copy_manifest)
        if base:
            for repo in retained:
                shutil.rmtree(stage / repo)
                for entry in base["files"]:
                    if entry["path"].startswith(repo + "/"):
                        P.copy_file(P.regular(stable_base, entry["path"]), stage / entry["path"])
                promoted["repositories"][repo] = copy.deepcopy(base["repositories"][repo])
            promoted["files"] = [e for e in promoted["files"] if e["path"].split("/")[0] not in retained] + [
                copy.deepcopy(e) for e in base["files"] if e["path"].split("/")[0] in retained]

        promoted.update(release_channel="stable", base_url=P.BASES["stable"],
                        status="stable-owner-reviewed" if owner else "stable-upstream-reviewed" if upstream else "stable-validated", installReady=True,
                        promoted_from=beta_sha,
                        validation={"method": review["method"], "checks": list(checks)})
        if owner:
            promoted["validation"].update(owner_authorized=True, fully_vehicle_validated=False,
                                          retained_repositories=retained)
            if components:
                promoted["validation"]["retained_components"] = components
                promoted["validation"]["stable_candidate_sha256"] = review["stable_candidate_sha256"]
            if retained or components:
                promoted["validation"]["retained_from"] = review["retained_from"]
        if upstream:
            promoted["validation"].update(upstream_commits=review["upstream_commits"],
                                          fully_vehicle_validated=False)
        for repo in P.REPOS:
            file = stage / repo / "catalog.json"
            catalog = P.read_json(file)
            catalog["release_channel"] = "stable"
            P.write_json(file, catalog)
            record = promoted["repositories"][repo]
            record["catalog_url"] = P.BASES["stable"] + repo + "/catalog.json"
            record["integration"] = {"context": P.CONTEXT, "state": "pending" if upstream or owner else "success",
                                     "sha": record["commit"]}
        for entry in promoted["files"]:
            file = stage / entry["path"]
            if entry["path"].endswith("/catalog.json"):
                entry.update(size=file.stat().st_size, sha256=P.digest(file))
            elif P.digest(file) != entry["sha256"]:
                raise ValueError("Promotion must preserve package, source and bootstrap bytes")
        P.write_json(stage / "cn-manifest.json", promoted)
        snapshot(stage)
        stage.rename(output)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return promoted


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--beta", required=True, type=pathlib.Path)
    parser.add_argument("--evidence", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--stable-base", type=pathlib.Path)
    parser.add_argument("--stable-candidate", type=pathlib.Path)
    args = parser.parse_args()
    try:
        result = promote(**vars(args))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, "CN promotion stopped: " + str(error) + "\n")
    print(json.dumps({"status": result["status"], "output": str(args.output),
                      "promoted_from": result["promoted_from"]}, indent=2))


if __name__ == "__main__":
    main()
