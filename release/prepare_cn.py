#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Prepare a local CN release snapshot; never upload, execute packages or contact a car."""

import argparse
import copy
import hashlib
import json
import pathlib
import re
import shutil
import struct
import tarfile
import tempfile
import zlib

BASE = "https://mgu.walle.pw/mgu/cn/"
BASES = {"stable": BASE, "beta": BASE + "beta/"}
REPOS = {"mgu-store": "Wallezy/mgu-store-cn", "idrive-apps": "Wallezy/idrive-apps-cn"}
CONTEXT = "release-check/cn-integration"
BOOTSTRAP = ("mgu-install.js", "install.sh", "install.ps1")
MAX_FILE = 512 << 20
MAX_EXPANDED = 2 << 30
SHA = re.compile(r"[a-f0-9]{64}")
COMMIT = re.compile(r"[a-f0-9]{40}")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")
IDENTITY = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")


def digest(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_json(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    pathlib.Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def relative(value):
    if (not isinstance(value, str) or not value or
            any(c in value for c in "\\:?#%") or
            any(p in ("", ".", "..") for p in value.split("/"))):
        raise ValueError("Unsafe relative path: " + str(value))
    return pathlib.PurePosixPath(value)


def regular(root, name):
    rel = relative(name)
    path = root.joinpath(*rel.parts)
    if (not path.is_file() or any(p.is_symlink() for p in (path, *path.parents))
            or not 0 < path.stat().st_size <= MAX_FILE):
        raise ValueError("Missing, linked or oversized file: " + name)
    return path


def verified(path, expected):
    if not isinstance(expected, str) or not SHA.fullmatch(expected) or digest(path) != expected:
        raise ValueError("SHA-256 mismatch: " + path.name)


def inspect_tar(path, commit=None, keep=()):
    """Inspect without extraction; release/source input never becomes executable."""
    with tarfile.open(path, "r:gz") as archive:
        if commit is not None and archive.pax_headers.get("comment") != commit:
            raise ValueError("Source must be git archive tar.gz of the exact catalog commit")
        total, files, selected = 0, set(), {}
        for index, member in enumerate(archive):
            name = member.name.rstrip("/") if member.isdir() else member.name
            parts = relative(name).parts
            if name in files or index >= 100000:
                raise ValueError("Duplicate or excessive archive members")
            files.add(name)
            if "oap-sdk" in parts or parts[-2:] == ("javascript", "app.js"):
                raise ValueError("Refusing bundled SDK or BMW-linked app: " + name)
            if not member.isfile() and not member.isdir():
                raise ValueError("Archive links/special files are not supported: " + name)
            total += member.size
            if total > MAX_EXPANDED:
                raise ValueError("Expanded archive exceeds limit")
            wanted = (name in ("component.json", "mgu-app.json", "LICENSE") or name in keep or
                      name in ("deploy/" + n for n in BOOTSTRAP))
            if wanted and member.isfile():
                if member.size > 8 << 20:
                    raise ValueError("Oversized archive metadata")
                selected[name] = archive.extractfile(member).read()
        if commit is not None and "LICENSE" not in selected:
            raise ValueError("Source archive must include LICENSE at its root")
        return selected


def verify_png(path):
    data = path.read_bytes()
    if len(data) > 1 << 20 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Invalid PNG icon")
    offset, count, pixels = 8, 0, False
    while offset + 12 <= len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + length + 12
        if end > len(data):
            break
        body = data[offset + 8:end - 4]
        if zlib.crc32(kind + body) & 0xffffffff != struct.unpack_from(">I", data, end - 4)[0]:
            raise ValueError("Invalid PNG checksum")
        if count == 0:
            if kind != b"IHDR" or length != 13:
                raise ValueError("Missing PNG header")
            width, height = struct.unpack_from(">II", body)
            if not (0 < width <= 2048 and 0 < height <= 2048):
                raise ValueError("Invalid PNG dimensions")
        elif kind == b"IHDR":
            raise ValueError("Duplicate PNG header")
        pixels = pixels or (kind == b"IDAT" and bool(body))
        if kind == b"IEND":
            if length or end != len(data) or not pixels:
                raise ValueError("Invalid PNG end")
            return
        count += 1
        offset = end
    raise ValueError("Truncated PNG")


def validate_catalog(value):
    if value.get("schema") != 2 or not isinstance(value.get("components"), list) or not value["components"]:
        raise ValueError("A nonempty schema 2 local release catalog is required")
    if not COMMIT.fullmatch(str(value.get("commit", ""))):
        raise ValueError("Catalog requires an exact source commit")
    seen = set()
    for c in value["components"]:
        identity, version = c.get("id", ""), c.get("version", "")
        if not IDENTITY.fullmatch(identity) or identity in seen or not VERSION.fullmatch(version):
            raise ValueError("Invalid component identity/version")
        seen.add(identity)
        if c.get("kind") not in ("app", "tool") or (c["kind"] == "app" and c.get("build") != "unit"):
            raise ValueError("Only tools and SDK-free source apps are supported")
        a = c.get("artifact", {})
        if a.get("name") != identity + "@" + version + ".tgz":
            raise ValueError("Artifact must use its exact component id and version")
        if (not isinstance(a.get("size"), int) or isinstance(a["size"], bool) or
                not 0 < a["size"] <= MAX_FILE or not SHA.fullmatch(str(a.get("sha256", "")))):
            raise ValueError("Artifact requires size and SHA-256")
        if a.get("url", a["name"]) != a["name"]:
            raise ValueError("Use local release catalogs, with flat local artifact URLs")
        needs = c.get("requires", {})
        if not isinstance(needs, dict) or any(
                not IDENTITY.fullmatch(k) or k == identity or not VERSION.fullmatch(str(v))
                for k, v in needs.items()):
            raise ValueError("Invalid dependency declaration")
        if c.get("icon"):
            name = relative(c["icon"])
            if len(name.parts) != 1 or name.suffix != ".png" or not SHA.fullmatch(str(c.get("iconSha256", ""))):
                raise ValueError("Local icons need a PNG filename and iconSha256")
    return value


def validate_dependencies(catalogs):
    entries = {}
    for cat in catalogs.values():
        for entry in cat["components"]:
            if entry["id"] in entries:
                raise ValueError("Duplicate component across CN catalogs: " + entry["id"])
            entries[entry["id"]] = entry
    for entry in entries.values():
        for name, minimum in entry.get("requires", {}).items():
            partner = entries.get(name)
            if partner is None or tuple(map(int, partner["version"].split("."))) < tuple(map(int, minimum.split("."))):
                raise ValueError(entry["id"] + " has an unmet dependency: " + name)
    complete, active = set(), set()

    def visit(name):
        if name in active:
            raise ValueError("Dependency cycle at " + name)
        if name in complete:
            return
        active.add(name)
        for dependency in entries[name].get("requires", {}):
            visit(dependency)
        active.remove(name)
        complete.add(name)

    for name in entries:
        visit(name)
    required = {"mgu-deploy", "mgu-updater", "mgu-python", "mgu-render",
                "mgu-uplink", "app-privacy", "robertn_store"}
    if not required.issubset({c["id"] for c in catalogs["mgu-store"]["components"]}):
        raise ValueError("CN Store catalog lacks bootstrap components")


def attest(repo, catalog, raw, source, evidence):
    record = evidence.get("repositories", {}).get(repo, {})
    commit = catalog["commit"]
    status = record.get("integration", {})
    if (evidence.get("schema") != 1 or record.get("repository") != REPOS[repo] or
            record.get("commit") != commit or status.get("sha") != commit or
            status.get("context") != CONTEXT or status.get("state") not in ("pending", "success") or
            (status.get("state") == "success" and
             (not isinstance(status.get("evidence"), str) or not status["evidence"].strip()))):
        raise ValueError("Exact-commit integration attestation required for " + repo)
    verified(raw, record.get("catalog_sha256"))
    verified(source, record.get("source_sha256"))
    # The private attestation can hold local report paths and reviewer notes.
    # Only these public provenance fields belong in a distributable snapshot.
    return {name: record[name] for name in ("repository", "commit", "catalog_sha256", "source_sha256")} | {
        "integration": {name: status[name] for name in ("context", "state", "sha")}}


def copy_file(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def prepare(store_dir, apps_dir, store_source, apps_source, bootstrap_dir, validation, output,
            channel="stable"):
    """Pending snapshots support local integration; neither state permits publication."""
    if channel not in BASES:
        raise ValueError("Unknown CN release channel")
    base = BASES[channel]
    directories = {"mgu-store": pathlib.Path(store_dir).resolve(), "idrive-apps": pathlib.Path(apps_dir).resolve()}
    archives = {"mgu-store": pathlib.Path(store_source).resolve(), "idrive-apps": pathlib.Path(apps_source).resolve()}
    bootstrap_dir, output = pathlib.Path(bootstrap_dir).resolve(), pathlib.Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Output must be a new folder")
    evidence = read_json(validation)
    catalogs, records, sources = {}, {}, {}
    for repo in REPOS:
        raw = regular(directories[repo], "catalog.json")
        source = regular(archives[repo].parent, archives[repo].name)
        catalogs[repo] = validate_catalog(read_json(raw))
        records[repo] = attest(repo, catalogs[repo], raw, source, evidence)
        sources[repo] = inspect_tar(source, catalogs[repo]["commit"], (
            "native/mgu-updater/updater.conf", "native/mgu-updater/js/cn_sources.js"))
    validate_dependencies(catalogs)
    sums = {}
    for line in regular(bootstrap_dir, "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  (mgu-install\.js|install\.sh|install\.ps1)", line)
        if not match or match[2] in sums:
            raise ValueError("Invalid bootstrap checksum manifest")
        sums[match[2]] = match[1]
    if set(sums) != set(BOOTSTRAP):
        raise ValueError("Bootstrap must checksum all three scripts")
    for name in BOOTSTRAP:
        script = regular(bootstrap_dir, name)
        verified(script, sums[name])
        if script.read_bytes() != sources["mgu-store"].get("deploy/" + name):
            raise ValueError("Bootstrap differs from the validated Store source: " + name)
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = pathlib.Path(tempfile.mkdtemp(prefix=".cn-release-", dir=output.parent)).resolve()
    try:
        for repo, catalog in catalogs.items():
            dest, local = stage / repo, directories[repo]
            dest.mkdir()
            result = copy.deepcopy(catalog)
            result["distribution"] = "walle-cn"
            result["release_channel"] = channel
            for entry in result["components"]:
                a = entry["artifact"]
                package = regular(local, a["name"])
                if package.stat().st_size != a["size"]:
                    raise ValueError("Package size mismatch: " + a["name"])
                verified(package, a["sha256"])
                metadata = inspect_tar(package, keep=("files/updater.conf", "files/cn_sources.js"))
                manifest_name = "component.json" if entry["kind"] == "tool" else "mgu-app.json"
                manifest = json.loads(metadata.get(manifest_name, b"{}"))
                if manifest.get("id") != entry["id"] or manifest.get("version") != entry["version"]:
                    raise ValueError("Package identity differs from catalog: " + a["name"])
                if entry["id"] == "mgu-updater":
                    config = metadata.get("files/updater.conf", b"")
                    if not re.search(rb"(?m)^distribution_channel\s*=\s*walle-cn\s*$", config):
                        raise ValueError("Refusing an upstream updater in the CN catalog")
                    for shipped, original in (
                            ("files/updater.conf", "native/mgu-updater/updater.conf"),
                            ("files/cn_sources.js", "native/mgu-updater/js/cn_sources.js")):
                        if not metadata.get(shipped) or metadata[shipped] != sources["mgu-store"].get(original):
                            raise ValueError("Updater channel files differ from validated source: " + shipped)
                a["url"] = "packages/" + a["sha256"] + "/" + a["name"]
                copy_file(package, dest / a["url"])
                if entry.get("icon"):
                    icon = regular(local, entry["icon"])
                    verified(icon, entry["iconSha256"])
                    verify_png(icon)
                    entry["icon"] = "icons/" + entry["iconSha256"] + "/" + entry["icon"]
                    copy_file(icon, dest / entry["icon"])
            copy_file(local / "catalog.json", dest / "source-catalog.json")
            source_rel = "source/" + catalog["commit"] + ".tar.gz"
            copy_file(archives[repo], dest / source_rel)
            (dest / "LICENSE").write_bytes(sources[repo]["LICENSE"])
            records[repo]["source_path"] = repo + "/" + source_rel
            records[repo]["catalog_url"] = base + repo + "/catalog.json"
            write_json(dest / "catalog.json", result)
        for name in (*BOOTSTRAP, "SHA256SUMS"):
            copy_file(bootstrap_dir / name, stage / "bootstrap" / name)
        (stage / "NOTICE.txt").write_text(
            "Wallezy CN distribution; corresponding sources and licenses accompany each catalog.\n"
            "Package/icon bytes are retained; CN catalogs change transport URLs and add a distribution marker.\n"
            "The manifest records the release channel and supplied validation attestation; publication is verified separately.\n"
            "Publication requires independent exact-commit checks, public HTTPS/hash/cache verification and migration/recovery tests.\n",
            encoding="utf-8")
        inventory = []
        for p in sorted(stage.rglob("*")):
            if p.is_file():
                rel = p.relative_to(stage).as_posix()
                immutable = "/packages/" in rel or "/icons/" in rel or "/source/" in rel
                inventory.append({"path": rel, "size": p.stat().st_size, "sha256": digest(p),
                                  "cache_control": "public, max-age=31536000, immutable" if immutable else "no-cache"})
        manifest = {"schema": 1, "distribution": "walle-cn", "base_url": base,
                    "release_channel": channel,
                    "status": "beta-candidate" if channel == "beta" else "prepared-not-published", "installReady": False,
                    "repositories": records, "files": inventory}
        write_json(stage / "cn-manifest.json", manifest)
        # Verify every staged copy before the new output directory becomes visible.
        for entry in inventory:
            p = regular(stage, entry["path"])
            if p.stat().st_size != entry["size"]:
                raise ValueError("Staged size mismatch: " + entry["path"])
            verified(p, entry["sha256"])
        stage.rename(output)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("store-dir", "apps-dir", "store-source", "apps-source",
                 "bootstrap-dir", "validation", "output"):
        parser.add_argument("--" + name, type=pathlib.Path, required=True)
    parser.add_argument("--channel", choices=tuple(BASES), default="stable")
    args = parser.parse_args()
    try:
        manifest = prepare(**vars(args))
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        parser.exit(1, "CN preparation stopped: " + str(error) + "\n")
    print(json.dumps({"output": str(args.output), "status": manifest["status"],
                      "installReady": False, "files": len(manifest["files"])}, indent=2))


if __name__ == "__main__":
    main()
