# SPDX-License-Identifier: GPL-3.0-or-later
"""Publication transaction tests with in-memory objects, never real OSS."""

import pathlib
import json
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
import publish_cn as U
import test_prepare_cn as F
from test_promote_cn import component_fixture

P = F.M


class FakeRemote:
    channel = "beta"

    def __init__(self):
        self.objects = {}
        self.fail_manifest_once = False
        self.writes = []

    def binding(self):
        pass

    def get(self, rel, root):
        if rel not in self.objects:
            return None
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.objects[rel])
        return {}

    def put(self, rel, root):
        self.writes.append(rel)
        self.objects[rel] = (root / rel).read_bytes()

    def verify(self, rel, entry, root):
        if rel == "cn-manifest.json" and self.fail_manifest_once:
            self.fail_manifest_once = False
            raise ValueError("synthetic public acceptance failure")
        if self.get(rel, root) is None:
            raise ValueError("missing fixture object")
        if (root / rel).stat().st_size != entry["size"]:
            raise ValueError("size mismatch")
        P.verified(root / rel, entry["sha256"])


class PublicationTests(F.PreparationTests):
    def test_shared_app_publication_keeps_stable_trial_and_checks_public_beta(self):
        beta, candidate, base, review, record = component_fixture(self)
        target = self.root / "component-stable"
        U.C.promote(beta, review, target, base, candidate)
        self.output = target
        remote = FakeRemote()
        remote.channel = "stable"
        for item in U.C.snapshot(base)["files"] + [{"path": "cn-manifest.json"}]:
            remote.objects[item["path"]] = (base / item["path"]).read_bytes()

        def download(url, file):
            rel = url.removeprefix(P.BASES["beta"])
            source = beta / ("cn-manifest.json" if rel.startswith("candidates/") else rel)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(source.read_bytes())
            return {}

        with mock.patch.object(U, "download", side_effect=download):
            result = self.execute(remote, "component-publication")
            self.assertTrue(result["public_verified"])
            self.assertTrue(any("ambient_config@" in name for name in remote.writes))
            self.assertFalse(any("cluster-render@" in name for name in remote.writes))
            remote.writes.clear()
            with self.assertRaisesRegex(ValueError, "Stable changed"):
                self.execute(remote, "component-stale")
            self.assertFalse(remote.writes)

    def beta(self):
        return P.prepare(self.dirs["mgu-store"], self.dirs["idrive-apps"],
                         self.sources["mgu-store"], self.sources["idrive-apps"],
                         self.bootstrap, self.validation, self.output, channel="beta")

    def execute(self, remote, name, publish=True):
        work = self.root / name
        work.mkdir()
        with mock.patch.object(U, "check_ci", return_value={"synthetic": True}):
            return U.publish(remote, self.output, work, publish)

    def test_dry_run_and_initial_publication(self):
        self.beta()
        remote = FakeRemote()
        self.assertEqual(self.execute(remote, "plan", False)["status"], "prepared")
        self.assertFalse(remote.writes)
        result = self.execute(remote, "publish")
        self.assertTrue(result["public_verified"])
        self.assertFalse(result["vehicle_validated"])
        self.assertEqual(remote.writes[-1], "cn-manifest.json")
        self.assertEqual(P.read_json(self.output / "cn-manifest.json")["installReady"], False)
        first_metadata = next(i for i, name in enumerate(remote.writes) if not U.immutable(name))
        self.assertTrue(all(U.immutable(n) for n in remote.writes[:first_metadata]))
        writes = len(remote.writes)
        self.assertEqual(self.execute(remote, "again")["status"], "unchanged")
        self.assertEqual(len(remote.writes), writes)

    def test_public_corrupt_immutable_resource_is_preserved(self):
        manifest = self.beta()
        remote = FakeRemote()
        name = next(f["path"] for f in manifest["files"] if f["path"].endswith(".tgz"))
        remote.objects[name] = b"corrupt fixture"
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.execute(remote, "publish")
        self.assertFalse(remote.writes)
        self.assertEqual(remote.objects[name], b"corrupt fixture")

    def test_failed_manifest_acceptance_restores_previous_manifest(self):
        self.beta()
        remote = FakeRemote()
        self.execute(remote, "initial")
        previous = remote.objects["cn-manifest.json"]
        manifest = P.read_json(self.output / "cn-manifest.json")
        manifest["status"] = "beta-candidate-reviewed"
        P.write_json(self.output / "cn-manifest.json", manifest)
        remote.fail_manifest_once = True
        with self.assertRaisesRegex(ValueError, "synthetic"):
            self.execute(remote, "next")
        self.assertEqual(remote.objects["cn-manifest.json"], previous)
        self.assertTrue(P.read_json(self.root / "next/result.json")["rollback_complete"])

    def test_same_version_payload_replacement_is_refused(self):
        self.beta()
        remote = FakeRemote()
        self.execute(remote, "initial")
        before_writes = len(remote.writes)
        self.replace_package("idrive-apps", "cluster-render", {
            "component.json": b'{"id":"cluster-render","version":"1.0.0"}',
            "payload.txt": b"different implementation"
        })
        self.output = self.root / "changed"
        self.beta()
        with self.assertRaisesRegex(ValueError, "new version"):
            self.execute(remote, "replacement")
        self.assertEqual(len(remote.writes), before_writes)

    def test_concurrent_manifest_is_not_overwritten_by_rollback(self):
        self.beta()
        remote = FakeRemote()
        self.execute(remote, "initial")
        external = dict(P.read_json(self.output / "cn-manifest.json"), status="another-publisher")
        file = self.output / "NOTICE.txt"
        file.write_bytes(file.read_bytes() + b"Additional candidate note.\n")
        manifest = P.read_json(self.output / "cn-manifest.json")
        for item in manifest["files"]:
            if item["path"] == "NOTICE.txt":
                item.update(size=file.stat().st_size, sha256=P.digest(file))
        P.write_json(self.output / "cn-manifest.json", manifest)
        original = remote.get

        def get(rel, root):
            if root.name == "final-concurrency-check":
                remote.objects["cn-manifest.json"] = (json.dumps(external) + "\n").encode()
            return original(rel, root)

        remote.get = get
        with self.assertRaises(U.ConcurrentPublication):
            self.execute(remote, "concurrent")
        result = P.read_json(self.root / "concurrent/result.json")
        self.assertFalse(result["rollback_complete"])
        self.assertTrue(result["concurrency_conflict"])
        self.assertIn("NOTICE.txt", result["affected_paths"])
        self.assertEqual(json.loads(remote.objects["cn-manifest.json"])["status"], "another-publisher")

    def test_owner_review_retained_repository_and_stale_baseline(self):
        self.beta()
        beta_bytes = (self.output / "cn-manifest.json").read_bytes()
        report = self.root / "owner.txt"
        report.write_text("Synthetic explicit owner approval; no vehicle validation.")
        review = self.root / "review.json"
        record = {"schema": 1, "snapshot_sha256": P.digest(self.output / "cn-manifest.json"),
                  "state": "passed", "method": "owner-reviewed", "owner_authorized": True,
                  "report": str(report), "checks": {c: "passed" for c in U.C.OWNER_CHECKS}}
        P.write_json(review, record)
        base = self.root / "stable-base"
        U.C.promote(self.output, review, base)
        record.update(retained_repositories=["idrive-apps"], retained_from=P.digest(base / "cn-manifest.json"))
        P.write_json(review, record)
        target = self.root / "stable-update"
        U.C.promote(self.output, review, target, base)
        self.output = target
        remote = FakeRemote()
        remote.channel = "stable"
        for f in U.C.snapshot(base)["files"] + [{"path": "cn-manifest.json"}]:
            remote.objects[f["path"]] = (base / f["path"]).read_bytes()

        def download(url, file):
            file.write_bytes(beta_bytes)
            return {}

        with mock.patch.object(U, "download", side_effect=download):
            cat_path = target / "idrive-apps/catalog.json"
            root_path = target / "cn-manifest.json"
            saved_cat, saved_root = cat_path.read_bytes(), root_path.read_bytes()
            catalog = P.read_json(cat_path)
            catalog["components"][0]["description"] = "unapproved retained change"
            P.write_json(cat_path, catalog)
            altered = P.read_json(root_path)
            for f in altered["files"]:
                if f["path"] == "idrive-apps/catalog.json":
                    f.update(size=cat_path.stat().st_size, sha256=P.digest(cat_path))
            P.write_json(root_path, altered)
            with self.assertRaisesRegex(ValueError, "Retained Stable repository changed"):
                self.execute(remote, "tampered-retained")
            self.assertFalse(remote.writes)
            cat_path.write_bytes(saved_cat)
            root_path.write_bytes(saved_root)
            result = self.execute(remote, "owner-publish")
            self.assertTrue(result["public_verified"])
            self.assertFalse(result["vehicle_validated"])
            self.assertFalse(any(p.startswith("idrive-apps/") for p in remote.writes))
            remote.writes.clear()
            with self.assertRaisesRegex(ValueError, "Stable changed"):
                self.execute(remote, "stale-owner-publish")
            self.assertFalse(remote.writes)

    def test_stable_needs_promotion_and_does_not_accept_beta(self):
        self.beta()
        remote = FakeRemote()
        remote.channel = "stable"
        with self.assertRaisesRegex(ValueError, "Explicit channel"):
            self.execute(remote, "stable")
        self.assertFalse(remote.writes)

    def test_reviewed_upstream_publishes_stable_without_claiming_vehicle_tests(self):
        self.beta()
        beta_manifest = (self.output / "cn-manifest.json").read_bytes()
        report = self.root / "review.txt"
        report.write_text("Synthetic upstream review fixture; no vehicle tests.")
        review = self.root / "review.json"
        P.write_json(review, {
            "schema": 1, "snapshot_sha256": P.digest(self.output / "cn-manifest.json"),
            "state": "passed", "method": "reviewed-upstream", "report": str(report),
            "checks": {c: "passed" for c in U.C.UPSTREAM_CHECKS},
            "upstream_commits": {repo: "a" * 40 for repo in P.REPOS}})
        target = self.root / "stable"
        U.C.promote(self.output, review, target)
        self.output = target
        remote = FakeRemote()
        remote.channel = "stable"

        def download(url, file):
            file.write_bytes(beta_manifest)
            return {}

        with mock.patch.object(U, "download", side_effect=download):
            result = self.execute(remote, "stable-publish")
        self.assertTrue(result["public_verified"])
        self.assertFalse(result["vehicle_validated"])
        manifest = P.read_json(target / "cn-manifest.json")
        manifest["validation"]["fully_vehicle_validated"] = True
        P.write_json(target / "cn-manifest.json", manifest)
        writes = len(remote.writes)
        with self.assertRaisesRegex(ValueError, "reviewed-upstream"):
            self.execute(remote, "false-validation")
        self.assertEqual(writes, len(remote.writes))

    def test_cli_diagnostics_are_confined_to_private_work_directory(self):
        work = self.root / "private-work"
        work.mkdir(mode=0o700)
        remote = U.Remote("beta", pathlib.Path("/fixture/ossutil"), pathlib.Path("/fixture/config"), work)
        response = mock.Mock(returncode=0, stdout=json.dumps({
            "Bucket": "walle-mgu", "Cname": [{"Domain": "mgu.walle.pw", "Status": "Enabled",
                                            "Certificate": {"Status": "Enabled"}}]}))
        with mock.patch.object(U.subprocess, "run", return_value=response) as run:
            remote.binding()
            remote.put("NOTICE.txt", self.root)
            self.assertEqual(len(run.call_args_list), 2)
            self.assertTrue(all(call.kwargs["cwd"] == work for call in run.call_args_list))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(PublicationTests(name) for name in PublicationTests.__dict__
                              if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main()
