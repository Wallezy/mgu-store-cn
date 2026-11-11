# SPDX-License-Identifier: GPL-3.0-or-later
"""Local release fixtures only: no vehicle, credentials, network or publication."""

import copy
import hashlib
import importlib.util
import io
import json
import pathlib
import struct
import tarfile
import tempfile
import unittest
import zlib

SPEC = importlib.util.spec_from_file_location("prepare_cn", pathlib.Path(__file__).parents[1] / "prepare_cn.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def write_tar(path, files, commit=None):
    with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT,
                      pax_headers={"comment": commit} if commit else {}) as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))


def png():
    def chunk(name, data):
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(b"\0\xff\0\0\xff")) + chunk(b"IEND", b""))


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.dirs, self.sources, self.catalogs = {}, {}, {}
        self.bootstrap = self.root / "bootstrap"
        self.bootstrap.mkdir()
        for name in M.BOOTSTRAP:
            (self.bootstrap / name).write_bytes(("fixture " + name).encode())
        self.write_sums()
        for index, repo in enumerate(M.REPOS):
            self.dirs[repo] = self.root / repo
            self.dirs[repo].mkdir()
            commit = str(index + 1) * 40
            self.catalogs[repo] = {"schema": 2, "commit": commit, "components": []}
            source = self.root / (repo + "-source.tar.gz")
            self.sources[repo] = source
            files = {"LICENSE": b"GPL-3.0-or-later fixture"}
            if repo == "mgu-store":
                files.update({"deploy/" + n: (self.bootstrap / n).read_bytes() for n in M.BOOTSTRAP})
                files.update({"native/mgu-updater/updater.conf": b"distribution_channel = walle-cn\n",
                              "native/mgu-updater/js/cn_sources.js": b"fixture CN policy"})
            write_tar(source, files, commit)
        for name in ("mgu-deploy", "mgu-updater", "mgu-python", "mgu-render", "mgu-uplink", "app-privacy"):
            self.add_component("mgu-store", name)
        self.add_component("mgu-store", "robertn_store", "app")
        self.add_component("idrive-apps", "cluster-render")
        self.add_component("idrive-apps", "robertn_waze_cluster", "app", {"cluster-render": "1.0.0", "mgu-updater": "1.0.0"})
        self.validation = self.root / "validation.json"
        self.write_evidence()
        self.output = self.root / "output"

    def tearDown(self):
        self.temp.cleanup()

    def write_sums(self):
        (self.bootstrap / "SHA256SUMS").write_text(
            "".join(M.digest(self.bootstrap / n) + "  " + n + "\n" for n in M.BOOTSTRAP), encoding="utf-8")

    def add_component(self, repo, name, kind="tool", requires=None):
        manifest = {"id": name, "version": "1.0.0"}
        artifact = self.dirs[repo] / (name + "@1.0.0.tgz")
        metadata_name = "component.json" if kind == "tool" else "mgu-app.json"
        files = {metadata_name: json.dumps(manifest).encode(), "payload.txt": b"fixture"}
        if name == "mgu-updater":
            files.update({"files/updater.conf": b"distribution_channel = walle-cn\n",
                          "files/cn_sources.js": b"fixture CN policy"})
        write_tar(artifact, files)
        entry = {"id": name, "kind": kind, "version": "1.0.0",
                 "artifact": {"name": artifact.name, "url": artifact.name,
                              "size": artifact.stat().st_size, "sha256": M.digest(artifact)}}
        if kind == "app":
            entry["build"] = "unit"
            icon = self.dirs[repo] / (name + ".png")
            icon.write_bytes(png())
            entry.update(icon=icon.name, iconSha256=M.digest(icon))
        if requires:
            entry["requires"] = requires
        self.catalogs[repo]["components"].append(entry)

    def write_evidence(self):
        records = {}
        for repo, catalog in self.catalogs.items():
            raw = self.dirs[repo] / "catalog.json"
            M.write_json(raw, catalog)
            records[repo] = {
                "repository": M.REPOS[repo], "commit": catalog["commit"],
                "catalog_sha256": M.digest(raw), "source_sha256": M.digest(self.sources[repo]),
                "integration": {"context": M.CONTEXT, "state": "success",
                                "sha": catalog["commit"], "evidence": "synthetic test fixture only"}
            }
        M.write_json(self.validation, {"schema": 1, "repositories": records})

    def run_prepare(self):
        return M.prepare(self.dirs["mgu-store"], self.dirs["idrive-apps"],
                         self.sources["mgu-store"], self.sources["idrive-apps"],
                         self.bootstrap, self.validation, self.output)

    def reject(self, reason):
        with self.assertRaisesRegex(ValueError, reason):
            self.run_prepare()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob(".cn-release-*")))

    def replace_package(self, repo, name, files):
        entry = next(c for c in self.catalogs[repo]["components"] if c["id"] == name)
        artifact = self.dirs[repo] / entry["artifact"]["name"]
        write_tar(artifact, files)
        entry["artifact"].update(size=artifact.stat().st_size, sha256=M.digest(artifact))
        self.write_evidence()

    def test_complete_snapshot_preserves_bytes_and_never_claims_ready(self):
        original = copy.deepcopy(self.catalogs)
        manifest = self.run_prepare()
        self.assertFalse(manifest["installReady"])
        self.assertEqual(manifest["status"], "prepared-not-published")
        self.assertEqual(manifest["base_url"], M.BASE)
        for repo in M.REPOS:
            generated = M.read_json(self.output / repo / "catalog.json")
            self.assertEqual(generated["distribution"], "walle-cn")
            for before, after in zip(original[repo]["components"], generated["components"]):
                self.assertEqual(before["version"], after["version"])
                self.assertEqual(before.get("requires"), after.get("requires"))
                self.assertEqual(before["artifact"]["sha256"], after["artifact"]["sha256"])
                M.verified(self.output / repo / after["artifact"]["url"], before["artifact"]["sha256"])
                if after.get("icon"):
                    M.verified(self.output / repo / after["icon"], before["iconSha256"])
        self.assertTrue(all(f["cache_control"] == "no-cache" for f in manifest["files"] if f["path"].endswith(".json")))
        with self.assertRaisesRegex(ValueError, "new folder"):
            self.run_prepare()

    def test_unmet_cross_repository_dependency(self):
        self.catalogs["idrive-apps"]["components"][-1]["requires"]["mgu-updater"] = "2.0.0"
        self.write_evidence()
        self.reject("unmet dependency")

    def test_duplicate_identity_across_catalogs(self):
        self.add_component("idrive-apps", "mgu-deploy")
        self.write_evidence()
        self.reject("Duplicate component")

    def test_dependency_cycle_rejected(self):
        self.catalogs["idrive-apps"]["components"][0]["requires"] = {"mgu-updater": "1.0.0"}
        updater = next(c for c in self.catalogs["mgu-store"]["components"] if c["id"] == "mgu-updater")
        updater["requires"] = {"cluster-render": "1.0.0"}
        self.write_evidence()
        self.reject("Dependency cycle")

    def test_private_attestation_fields_never_enter_public_snapshot(self):
        value = M.read_json(self.validation)
        record = value["repositories"]["mgu-store"]
        record["private_note"] = "private-note-fixture"
        record["integration"]["evidence"] = "/private/report-path-fixture"
        record["integration"]["private_body"] = "private-report-body-fixture"
        M.write_json(self.validation, value)
        self.run_prepare()
        manifest = (self.output / "cn-manifest.json").read_text()
        for private in ("private-note-fixture", "report-path-fixture", "private-report-body-fixture"):
            self.assertNotIn(private, manifest)
        self.assertEqual(set(M.read_json(self.output / "cn-manifest.json")["repositories"]["mgu-store"]["integration"]),
                         {"context", "state", "sha"})

    def test_catalog_hash_mismatch(self):
        (self.dirs["idrive-apps"] / "catalog.json").write_text("{}")
        self.reject("nonempty schema")

    def test_pending_snapshot_is_preparable_but_not_ready(self):
        evidence = M.read_json(self.validation)
        evidence["repositories"]["mgu-store"]["integration"]["state"] = "pending"
        del evidence["repositories"]["mgu-store"]["integration"]["evidence"]
        M.write_json(self.validation, evidence)
        manifest = self.run_prepare()
        self.assertFalse(manifest["installReady"])
        self.assertEqual(manifest["status"], "prepared-not-published")
        self.assertEqual(manifest["repositories"]["mgu-store"]["integration"]["state"], "pending")

    def test_wrong_commit_validation(self):
        evidence = M.read_json(self.validation)
        evidence["repositories"]["mgu-store"]["integration"].update(state="success", sha="f" * 40)
        M.write_json(self.validation, evidence)
        self.reject("attestation")

    def test_success_without_evidence_or_failed_validation_refused(self):
        evidence = M.read_json(self.validation)
        evidence["repositories"]["mgu-store"]["integration"]["evidence"] = ""
        M.write_json(self.validation, evidence)
        self.reject("attestation")
        evidence["repositories"]["mgu-store"]["integration"]["state"] = "failure"
        M.write_json(self.validation, evidence)
        self.reject("attestation")

    def test_source_commit_must_match_catalog(self):
        write_tar(self.sources["idrive-apps"], {"LICENSE": b"fixture"}, "f" * 40)
        self.write_evidence()
        self.reject("exact catalog commit")

    def test_bootstrap_must_match_source_even_with_updated_checksum(self):
        (self.bootstrap / "install.sh").write_bytes(b"changed bootstrap")
        self.write_sums()
        self.reject("Bootstrap differs")

    def test_package_hash_mismatch(self):
        (self.dirs["mgu-store"] / "mgu-updater@1.0.0.tgz").write_bytes(b"bad")
        self.reject("size mismatch")

    def test_official_updater_rejected(self):
        self.replace_package("mgu-store", "mgu-updater", {
            "component.json": b'{"id":"mgu-updater","version":"1.0.0"}'})
        self.reject("upstream updater")

    def test_updater_channel_code_must_match_source(self):
        self.replace_package("mgu-store", "mgu-updater", {
            "component.json": b'{"id":"mgu-updater","version":"1.0.0"}',
            "files/updater.conf": b"distribution_channel = walle-cn\n",
            "files/cn_sources.js": b"different policy"})
        self.reject("differ from validated source")

    def test_sdk_and_built_apps_rejected(self):
        for bad in ("oap-sdk/index.js", "package/javascript/app.js"):
            self.replace_package("mgu-store", "mgu-updater", {bad: b"forbidden"})
            self.reject("bundled SDK or BMW-linked")

    def test_tar_path_traversal_rejected(self):
        self.replace_package("mgu-store", "mgu-updater", {"../outside": b"bad"})
        self.reject("Unsafe relative path")

    def test_icon_hash_and_png_are_checked(self):
        entry = self.catalogs["mgu-store"]["components"][-1]
        icon = self.dirs["mgu-store"] / entry["icon"]
        icon.write_bytes(b"not PNG")
        self.reject("SHA-256 mismatch")
        entry["iconSha256"] = M.digest(icon)
        self.write_evidence()
        self.reject("Invalid PNG")

    def test_external_artifact_url_rejected(self):
        self.catalogs["idrive-apps"]["components"][0]["artifact"]["url"] = "https://github.com/example/asset.tgz"
        self.write_evidence()
        self.reject("flat local artifact")

    def test_source_catalog_digest_is_checked(self):
        value = M.read_json(self.validation)
        value["repositories"]["idrive-apps"]["catalog_sha256"] = "0" * 64
        M.write_json(self.validation, value)
        self.reject("SHA-256 mismatch")


if __name__ == "__main__":
    unittest.main()
