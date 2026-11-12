# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic release lifecycle fixtures; no vehicle or public publication."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
import promote_cn as C
from test_prepare_cn import PreparationTests, M


class PromotionTests(PreparationTests):
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
