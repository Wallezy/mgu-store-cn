# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic release lifecycle fixtures; no vehicle or public publication."""

import pathlib
import copy
import json
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
import promote_cn as C
from test_prepare_cn import PreparationTests, M, write_tar


def component_fixture(case):
    def prepare(output):
        M.prepare(case.dirs["mgu-store"], case.dirs["idrive-apps"],
                  case.sources["mgu-store"], case.sources["idrive-apps"],
                  case.bootstrap, case.validation, output, channel="beta")
    initial = case.root / "initial-beta"
    prepare(initial)
    report = case.root / "owner-component-report.txt"
    report.write_text("Synthetic component retention review.")
    review = case.root / "component-review.json"
    record = {"schema": 1, "snapshot_sha256": M.digest(initial / "cn-manifest.json"),
              "state": "passed", "method": "owner-reviewed", "owner_authorized": True,
              "report": str(report), "checks": {c: "passed" for c in C.OWNER_CHECKS}}
    M.write_json(review, record)
    base = case.root / "component-stable-base"
    C.promote(initial, review, base)
    case.add_component("idrive-apps", "ambient_config", "app")
    case.write_evidence()
    candidate = case.root / "component-stable-candidate"
    prepare(candidate)
    component = next(c for c in case.catalogs["idrive-apps"]["components"] if c["id"] == "cluster-render")
    package = case.dirs["idrive-apps"] / "cluster-render@1.0.1.tgz"
    write_tar(package, {"component.json": b'{"id":"cluster-render","version":"1.0.1"}', "trial.txt": b"Beta only"})
    component.update(version="1.0.1", artifact={"name": package.name, "url": package.name,
                     "size": package.stat().st_size, "sha256": M.digest(package)})
    case.write_evidence()
    beta = case.root / "component-beta"
    prepare(beta)
    record.update(snapshot_sha256=M.digest(beta / "cn-manifest.json"),
                  retained_components={"idrive-apps": ["cluster-render"]},
                  retained_from=M.digest(base / "cn-manifest.json"),
                  stable_candidate_sha256=M.digest(candidate / "cn-manifest.json"))
    M.write_json(review, record)
    return beta, candidate, base, review, record


def variant_fixture(case):
    _, _, base, review, record = component_fixture(case)
    components = case.catalogs["idrive-apps"]["components"]
    trial = copy.deepcopy(next(c for c in components if c["id"] == "cluster-render"))
    old = M.read_json(base / "idrive-apps/source-catalog.json")["components"]
    stable_renderer = next(c for c in old if c["id"] == "cluster-render")
    renderer = next(c for c in components if c["id"] == "cluster-render")
    app = next(c for c in components if c["id"] == "robertn_waze_cluster")
    outputs = {}
    for channel, version, selected_renderer in (
            ("stable", "1.0.1", stable_renderer), ("beta", "1.0.2", trial)):
        renderer.clear()
        renderer.update(copy.deepcopy(selected_renderer))
        package = case.dirs["idrive-apps"] / ("robertn_waze_cluster@" + version + ".tgz")
        write_tar(package, {
            "mgu-app.json": json.dumps({"id": "robertn_waze_cluster", "version": version}).encode(),
            "payload.txt": ("shared fix; " + channel).encode(),
        })
        app.update(version=version, artifact={"name": package.name, "url": package.name,
                   "size": package.stat().st_size, "sha256": M.digest(package)})
        case.write_evidence()
        target = case.root / ("variant-" + channel)
        M.prepare(case.dirs["mgu-store"], case.dirs["idrive-apps"],
                  case.sources["mgu-store"], case.sources["idrive-apps"],
                  case.bootstrap, case.validation, target, channel="beta")
        outputs[channel] = target
    pins = {}
    for channel, target in outputs.items():
        entry = next(c for c in M.read_json(target / "idrive-apps/catalog.json")["components"]
                     if c["id"] == "robertn_waze_cluster")
        pins[channel] = C.component_digest(entry)
    record.update(snapshot_sha256=M.digest(outputs["beta"] / "cn-manifest.json"),
                  stable_candidate_sha256=M.digest(outputs["stable"] / "cn-manifest.json"),
                  channel_variants={"idrive-apps": {"robertn_waze_cluster": pins}})
    M.write_json(review, record)
    return outputs["beta"], outputs["stable"], base, review, record


class PromotionTests(PreparationTests):
    def test_shared_fix_updates_reviewed_variants_and_retains_renderer(self):
        beta, candidate, base, review, record = variant_fixture(self)
        target = self.root / "variant-promoted"
        promoted = C.promote(beta, review, target, base, candidate)
        self.assertTrue(C.owner_reviewed(promoted))
        entries = {c["id"]: c for c in M.read_json(target / "idrive-apps/catalog.json")["components"]}
        self.assertEqual(entries["robertn_waze_cluster"]["version"], "1.0.1")
        self.assertEqual(entries["cluster-render"]["version"], "1.0.0")
        self.assertEqual(promoted["validation"]["channel_variants"], record["channel_variants"])
        record["channel_variants"]["idrive-apps"]["robertn_waze_cluster"]["stable"] = "f" * 64
        M.write_json(review, record)
        with self.assertRaisesRegex(ValueError, "variant differs"):
            C.promote(beta, review, self.root / "wrong-variant", base, candidate)

    def test_variant_metadata_and_undeclared_changes_are_refused(self):
        beta, candidate, base, review, record = variant_fixture(self)
        with self.assertRaisesRegex(ValueError, "differs from its reviewed channel"):
            C.compare_component_retention(beta, candidate, base, record["retained_components"])
        path = candidate / "idrive-apps/catalog.json"
        catalog = M.read_json(path)
        next(c for c in catalog["components"] if c["id"] == "robertn_waze_cluster")["releaseNotes"] = [
            {"version": "1.0.1", "changes": ["Unreviewed metadata"]}]
        M.write_json(path, catalog)
        with self.assertRaisesRegex(ValueError, "variant differs"):
            C.compare_component_retention(beta, candidate, base, record["retained_components"], record["channel_variants"])

    def test_variant_must_increase_stable_version_and_have_owner_review(self):
        beta, candidate, base, review, record = component_fixture(self)
        pins = {}
        for channel, target in (("beta", beta), ("stable", candidate)):
            entry = next(c for c in M.read_json(target / "idrive-apps/catalog.json")["components"]
                         if c["id"] == "robertn_waze_cluster")
            pins[channel] = C.component_digest(entry)
        variants = {"idrive-apps": {"robertn_waze_cluster": pins}}
        with self.assertRaisesRegex(ValueError, "newer Stable version"):
            C.compare_component_retention(beta, candidate, base, record["retained_components"], variants)
        record.update(channel_variants=variants, method="owner-vehicle",
                      checks={c: "passed" for c in C.CHECKS})
        M.write_json(review, record)
        with self.assertRaisesRegex(ValueError, "explicit owner review"):
            C.promote(beta, review, self.root / "no-owner-review", base, candidate)
        self.assertFalse(C.channel_variants_valid(variants, {"idrive-apps": ["robertn_waze_cluster"]}))
        self.assertFalse(C.channel_variants_valid({"idrive-apps": {"robertn_waze_cluster": {"stable": "f" * 64}}}, {}))

    def test_shared_new_app_preserves_only_selected_stable_components(self):
        beta, candidate, base, review, record = component_fixture(self)
        target = self.root / "component-stable"
        promoted = C.promote(beta, review, target, base, candidate)
        self.assertTrue(C.owner_reviewed(promoted))
        entries = {c["id"]: c for c in M.read_json(target / "idrive-apps/catalog.json")["components"]}
        self.assertEqual(entries["cluster-render"]["version"], "1.0.0")
        self.assertIn("ambient_config", entries)
        record["stable_candidate_sha256"] = "f" * 64
        M.write_json(review, record)
        with self.assertRaisesRegex(ValueError, "candidate differs"):
            C.promote(beta, review, self.root / "wrong-candidate", base, candidate)
        with self.assertRaisesRegex(ValueError, "differs from its reviewed channel"):
            C.compare_component_retention(beta, beta, base, {"idrive-apps": ["cluster-render"]})

    def beta(self):
        return M.prepare(self.dirs["mgu-store"], self.dirs["idrive-apps"],
                         self.sources["mgu-store"], self.sources["idrive-apps"],
                         self.bootstrap, self.validation, self.output, channel="beta")

    def evidence(self):
        report = self.root / "synthetic-vehicle-report.txt"
        report.write_text("Synthetic test fixture, not actual vehicle validation.\n")
        record = {"schema": 1, "snapshot_sha256": M.digest(self.output / "cn-manifest.json"),
                  "state": "passed", "method": "owner-vehicle", "report": str(report),
                  "checks": {c: "passed" for c in C.CHECKS}}
        path = self.root / "review.json"
        M.write_json(path, record)
        return path, record

    def test_promotion_preserves_all_tested_payloads(self):
        beta = self.beta()
        path, record = self.evidence()
        target = self.root / "stable"
        stable = C.promote(self.output, path, target)
        self.assertTrue(stable["installReady"])
        self.assertEqual(stable["release_channel"], "stable")
        self.assertEqual(stable["promoted_from"], record["snapshot_sha256"])
        self.assertNotIn(record["report"], (target / "cn-manifest.json").read_text())
        for f in beta["files"]:
            if not f["path"].endswith("/catalog.json"):
                self.assertEqual(M.digest(target / f["path"]), f["sha256"])
        self.assertEqual(C.snapshot(self.output)["release_channel"], "beta")
        self.assertEqual(C.snapshot(target)["release_channel"], "stable")

    def test_owner_review_retains_stable_apps_and_requires_exact_authorization(self):
        self.beta()
        path, record = self.evidence()
        base_dir = self.root / "base-stable"
        C.promote(self.output, path, base_dir)
        base = C.snapshot(base_dir)
        record.update(method="owner-reviewed", owner_authorized=True,
                      checks={c: "passed" for c in C.OWNER_CHECKS},
                      retained_repositories=["idrive-apps"], retained_from=M.digest(base_dir / "cn-manifest.json"))
        M.write_json(path, record)
        target = self.root / "owner-stable"
        promoted = C.promote(self.output, path, target, base_dir)
        self.assertTrue(C.owner_reviewed(promoted))
        self.assertFalse(promoted["validation"]["fully_vehicle_validated"])
        self.assertEqual(C.payloads(base, ["idrive-apps"]), C.payloads(promoted, ["idrive-apps"]))
        self.assertEqual((base_dir / "idrive-apps/catalog.json").read_bytes(), (target / "idrive-apps/catalog.json").read_bytes())
        record["owner_authorized"] = False
        M.write_json(path, record)
        with self.assertRaisesRegex(ValueError, "exact Beta"):
            C.promote(self.output, path, self.root / "unauthorized", base_dir)
        record["owner_authorized"] = True
        record["retained_from"] = "f" * 64
        M.write_json(path, record)
        with self.assertRaisesRegex(ValueError, "differs"):
            C.promote(self.output, path, self.root / "stale", base_dir)

    def test_incomplete_self_update_evidence_blocks_promotion(self):
        self.beta()
        path, record = self.evidence()
        record["checks"]["self_update"] = "pending"
        M.write_json(path, record)
        with self.assertRaisesRegex(ValueError, "exact Beta"):
            C.promote(self.output, path, self.root / "stable")
        self.assertFalse((self.root / "stable").exists())

    def test_reviewed_upstream_keeps_runtime_validation_pending(self):
        beta = self.beta()
        path, record = self.evidence()
        record.update(method="reviewed-upstream",
                      checks={c: "passed" for c in C.UPSTREAM_CHECKS},
                      upstream_commits={repo: "a" * 40 for repo in M.REPOS})
        M.write_json(path, record)
        target = self.root / "stable"
        stable = C.promote(self.output, path, target)
        self.assertTrue(C.reviewed_upstream(stable))
        self.assertTrue(stable["installReady"])
        self.assertFalse(stable["validation"]["fully_vehicle_validated"])
        self.assertTrue(all(r["integration"]["state"] == "pending" for r in stable["repositories"].values()))
        for f in beta["files"]:
            if not f["path"].endswith("/catalog.json"):
                self.assertEqual(M.digest(target / f["path"]), f["sha256"])

    def test_upstream_release_requires_review_and_pinned_sources(self):
        self.beta()
        path, record = self.evidence()
        record.update(method="reviewed-upstream", checks={c: "passed" for c in C.UPSTREAM_CHECKS},
                      upstream_commits={repo: "a" * 40 for repo in M.REPOS})
        record["checks"]["upstream_review"] = "pending"
        M.write_json(path, record)
        with self.assertRaisesRegex(ValueError, "exact Beta"):
            C.promote(self.output, path, self.root / "stable")
        record["checks"]["upstream_review"] = "passed"
        record["upstream_commits"]["mgu-store"] = "main"
        M.write_json(path, record)
        with self.assertRaisesRegex(ValueError, "exact Beta"):
            C.promote(self.output, path, self.root / "stable")

    def test_another_candidate_cannot_reuse_vehicle_evidence(self):
        self.beta()
        path, record = self.evidence()
        record["snapshot_sha256"] = "0" * 64
        M.write_json(path, record)
        with self.assertRaisesRegex(ValueError, "exact Beta"):
            C.promote(self.output, path, self.root / "stable")

    def test_modified_payload_refuses_before_promotion(self):
        manifest = self.beta()
        path, _ = self.evidence()
        package = next(f["path"] for f in manifest["files"] if f["path"].endswith(".tgz"))
        with (self.output / package).open("ab") as stream:
            stream.write(b"tampered")
        with self.assertRaisesRegex(ValueError, "size mismatch"):
            C.promote(self.output, path, self.root / "stable")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(PromotionTests(name) for name in PromotionTests.__dict__
                              if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main()
