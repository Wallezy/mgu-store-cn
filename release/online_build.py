#!/usr/bin/env python3
"""Seal and retrieve exact-commit GitHub Actions release build outputs."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile

WORKFLOWS = {
    "Wallezy/mgu-store-cn": ".github/workflows/cn-build.yml",
    "Wallezy/idrive-apps-cn": ".github/workflows/test.yml",
}
MAX_BYTES = 512 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text())


def checked_name(name):
    p = PurePosixPath(name)
    if not name or "\\" in name or p.is_absolute() or ".." in p.parts or str(p) != name:
        raise ValueError("Unsafe build output path")
    return p


def validate(root, repository, commit, run_id=None, attempt=None):
    proof = read(root / "online-build.json")
    if (proof.get("schema") != 1 or proof.get("repository") != repository
            or proof.get("commit") != commit
            or (run_id is not None and proof.get("run_id") != run_id)
            or (attempt is not None and proof.get("run_attempt") != attempt)):
        raise ValueError("Build identity does not match the selected workflow run")
    files = proof["files"]
    actual = set()
    for p in root.rglob("*"):
        if p.is_symlink() or not (p.is_file() or p.is_dir()):
            raise ValueError("Build output contains a link or special file")
        if p.is_file() and p.relative_to(root).as_posix() != "online-build.json":
            actual.add(p.relative_to(root).as_posix())
    if actual != set(files):
        raise ValueError("Build output file inventory differs")
    for name, record in files.items():
        checked_name(name)
        data = (root / name).read_bytes()
        if len(data) != record["size"] or digest(data) != record["sha256"]:
            raise ValueError("Build output hash mismatch: " + name)
    catalog = read(root / "catalog.json")
    if catalog.get("commit") != commit or not catalog.get("components"):
        raise ValueError("Build catalog does not identify this commit")
    ids = set()
    for component in catalog["components"]:
        identity = component["id"]
        if identity in ids:
            raise ValueError("Duplicate component")
        ids.add(identity)
        artifact = component["artifact"]
        record = files.get(artifact["name"], {})
        if record != {"size": artifact["size"], "sha256": artifact["sha256"]}:
            raise ValueError("Catalog package differs from the build inventory")
        if component.get("icon"):
            if files.get(component["icon"], {}).get("sha256") != component["iconSha256"]:
                raise ValueError("Catalog icon differs from the build inventory")
    return proof


def seal(root, repository, commit):
    files = {}
    for p in sorted(root.rglob("*")):
        if p.is_symlink() or not (p.is_file() or p.is_dir()):
            raise ValueError("Only regular build files can be exported")
        if p.is_file() and p.relative_to(root).as_posix() != "online-build.json":
            name = p.relative_to(root).as_posix()
            checked_name(name)
            data = p.read_bytes()
            files[name] = {"size": len(data), "sha256": digest(data)}
    proof = {
        "schema": 1, "repository": repository, "commit": commit,
        "run_id": int(os.environ.get("GITHUB_RUN_ID", "0")),
        "run_attempt": int(os.environ.get("GITHUB_RUN_ATTEMPT", "1")),
        "files": files,
    }
    (root / "online-build.json").write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n")
    return validate(root, repository, commit)


def api(url):
    # curl uses the machine's trusted certificate store. Never log token values.
    args = ["curl", "--fail", "--silent", "--show-error", "--location",
            "--connect-timeout", "15", "--max-time", "90", "--config", "-"]
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token and shutil.which("gh"):
        result = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
        if result.returncode == 0:
            token = result.stdout.strip()
    if token and re.search(r'[\r\n"\\]', token):
        raise ValueError("Invalid GitHub authentication value")
    config = 'header = "Accept: application/vnd.github+json"\n'
    if token:
        config += 'header = "Authorization: Bearer ' + token + '"\n'
    result = subprocess.run(args + [url], input=config.encode(), capture_output=True)
    if result.returncode:
        raise ValueError("GitHub request failed; check access, Actions artifact permissions or expiry")
    return json.loads(result.stdout)


def extract(archive, output):
    with zipfile.ZipFile(archive) as z:
        members = z.infolist()
        if sum(m.file_size for m in members) > MAX_BYTES or len(members) > 4096:
            raise ValueError("Build archive exceeds its extraction budget")
        names = set()
        for m in members:
            name = m.filename.rstrip("/") if m.is_dir() else m.filename
            checked_name(name)
            if name in names:
                raise ValueError("Duplicate archive path")
            names.add(name)
            mode = m.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError("Archive contains a link or special file")
        z.extractall(output)


def fetch(repository, commit, output, run_id=None, archive=None):
    base = "https://api.github.com/repos/" + repository
    workflow = WORKFLOWS[repository]
    if run_id:
        run = api(base + "/actions/runs/" + str(run_id))
    else:
        runs = api(base + "/actions/runs?head_sha=" + commit + "&per_page=100")["workflow_runs"]
        matches = [r for r in runs if r.get("path") == workflow and r.get("head_sha") == commit]
        run = max(matches, key=lambda r: (r["id"], r.get("run_attempt", 1)), default=None)
    if (not run or run.get("head_sha") != commit or run.get("path") != workflow
            or run.get("event") not in ("push", "workflow_dispatch")
            or run.get("head_branch") != "main"
            or (run.get("head_repository") or {}).get("full_name") != repository
            or run.get("status") != "completed" or run.get("conclusion") != "success"):
        raise ValueError("The exact main commit has no successful trusted build run")
    artifacts = api(base + "/actions/runs/" + str(run["id"]) + "/artifacts?per_page=100")["artifacts"]
    name = "cn-release-" + commit + "-a"
    matches = [a for a in artifacts if a["name"] == name and not a.get("expired")]
    if len(matches) != 1:
        raise ValueError("The selected build output is missing, expired or ambiguous")
    artifact = matches[0]
    if output.exists():
        raise ValueError("Choose a new output directory")
    with tempfile.TemporaryDirectory(prefix="mgu-online-") as tmp:
        tmp = Path(tmp)
        if archive:
            zipped = archive
        else:
            # gh handles the authenticated redirect without putting credentials in URLs.
            if not shutil.which("gh"):
                raise ValueError("Download the run's artifact ZIP, then supply --archive; or configure gh authentication")
            zipped = tmp / "build.zip"
            with zipped.open("wb") as dest:
                p = subprocess.run(["gh", "api", "repos/" + repository + "/actions/artifacts/"
                                    + str(artifact["id"]) + "/zip"], stdout=dest, stderr=subprocess.PIPE)
            if p.returncode:
                raise ValueError("Cannot download the Actions artifact; check gh authentication")
        if zipped.stat().st_size > MAX_BYTES:
            raise ValueError("Build archive is too large")
        expected = artifact.get("digest", "")
        if not expected.startswith("sha256:") or digest(zipped.read_bytes()) != expected[7:]:
            raise ValueError("Archive does not match the artifact's GitHub digest")
        tree = tmp / "files"
        extract(zipped, tree)
        proof = validate(tree, repository, commit, run["id"], run["run_attempt"])
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(tree, output)
    return {"repository": repository, "commit": commit, "run_id": run["id"],
            "artifact_id": artifact["id"], "archive_digest": expected,
            "files": len(proof["files"]), "output": str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("seal", "verify", "fetch"):
        p = sub.add_parser(name)
        p.add_argument("--repository", required=True, choices=WORKFLOWS)
        p.add_argument("--commit", required=True)
        p.add_argument("--out", required=True, type=Path)
        if name == "fetch":
            p.add_argument("--run-id", type=int)
            p.add_argument("--archive", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        parser.error("--commit must be a full commit SHA")
    try:
        if args.command == "fetch":
            result = fetch(args.repository, args.commit, args.out, args.run_id, args.archive)
        elif args.command == "seal":
            result = seal(args.out, args.repository, args.commit)
        else:
            result = validate(args.out, args.repository, args.commit)
        print(json.dumps(result, sort_keys=True))
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as e:
        parser.exit(1, str(e) + "\n")


if __name__ == "__main__":
    main()
