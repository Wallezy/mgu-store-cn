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


def promote(beta, evidence, output):
    beta, evidence, output = pathlib.Path(beta).resolve(), pathlib.Path(evidence), pathlib.Path(output).absolute()
    manifest = snapshot(beta)
    if manifest.get("release_channel") != "beta":
        raise ValueError("Promotion requires a Beta snapshot")
    review = P.read_json(evidence)
    beta_sha = P.digest(beta / "cn-manifest.json")
    if (review.get("schema") != 1 or review.get("snapshot_sha256") != beta_sha
            or review.get("state") != "passed"
            or review.get("method") not in ("owner-vehicle", "head-unit-emulator-and-vehicle")
            or any(review.get("checks", {}).get(c) != "passed" for c in CHECKS)):
        raise ValueError("Promotion requires passed validation of this exact Beta snapshot")
    report = review.get("report")
    if not isinstance(report, str) or not report.strip() or not pathlib.Path(report).is_file():
        raise ValueError("Keep the actual private validation report before promotion")
    if output.exists() or output.is_symlink():
        raise ValueError("Output must be a new folder")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = pathlib.Path(tempfile.mkdtemp(prefix=".cn-promote-", dir=output.parent)).resolve()
    try:
        for entry in manifest["files"]:
            P.copy_file(P.regular(beta, entry["path"]), stage / entry["path"])
        promoted = copy.deepcopy(manifest)
        promoted.update(release_channel="stable", base_url=P.BASES["stable"],
                        status="stable-validated", installReady=True,
                        promoted_from=beta_sha,
                        validation={"method": review["method"], "checks": list(CHECKS)})
        for repo in P.REPOS:
            file = stage / repo / "catalog.json"
            catalog = P.read_json(file)
            catalog["release_channel"] = "stable"
            P.write_json(file, catalog)
            record = promoted["repositories"][repo]
            record["catalog_url"] = P.BASES["stable"] + repo + "/catalog.json"
            record["integration"] = {"context": P.CONTEXT, "state": "success", "sha": record["commit"]}
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
    args = parser.parse_args()
    try:
        result = promote(**vars(args))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, "CN promotion stopped: " + str(error) + "\n")
    print(json.dumps({"status": result["status"], "output": str(args.output),
                      "promoted_from": result["promoted_from"]}, indent=2))


if __name__ == "__main__":
    main()
