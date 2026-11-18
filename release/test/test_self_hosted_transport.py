import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
import publication_transport as T


class SelfHostedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.driver = self.root / "driver.py"
        self.cfg = self.root / "config.json"
        self.config = dict(schema=1, mode="self-hosted", driver=str(self.driver),
                           lock=str(self.root / "lock"), result=str(self.root / "accepted.json"))
        self.cfg.write_text(json.dumps(self.config))
        self.cfg.chmod(0o600)
        patch = mock.patch.dict(os.environ, MGU_PUBLICATION_TRANSPORT=str(self.cfg))
        patch.start()
        self.addCleanup(patch.stop)
        self.package = "mgu/cn/idrive-apps/packages/" + "b" * 64 + "/app@1.0.0.tgz"
        self.base = {"snapshot": "a" * 64, "files": [
            {"path": "mgu/cn/cn-manifest.json", "size": 3, "sha256": hashlib.sha256(b"old").hexdigest()},
            {"path": self.package, "size": 3, "sha256": hashlib.sha256(b"pkg").hexdigest()},
        ]}
        self.driver.write_text(
            "import sys,json,pathlib\n"
            "assert sys.argv[1]=='--begin'\n"
            "pathlib.Path(sys.argv[2]).write_text(" +
            repr(json.dumps({"schema": 1, "transaction_id": "c" * 32, "base": self.base})) + ")\n"
        )

    def tx(self, prefix="mgu/cn/"):
        folder = self.root / ("work-" + str(len(list(self.root.glob("work-*")))))
        folder.mkdir()
        return T.Transaction(prefix, folder)

    def test_self_hosted_reads_public_without_storage_rewrite(self):
        self.assertTrue(T.self_hosted())
        self.assertEqual(T.storage_url(T.PUBLIC + "cn/catalog.json"), T.PUBLIC + "cn/catalog.json")

    def test_staging_does_not_call_upload_or_change_live_data(self):
        tx = self.tx()
        source = self.root / "source"
        source.mkdir()
        (source / "cn-manifest.json").write_bytes(b"new")
        tx.put("cn-manifest.json", source)
        with mock.patch.object(T.subprocess, "run", side_effect=AssertionError("Unexpected remote mutation")):
            with mock.patch.object(T, "settings", return_value=self.config):
                headers = tx.get("cn-manifest.json", self.root / "read", mock.Mock(side_effect=AssertionError()))
        self.assertEqual((self.root / "read/cn-manifest.json").read_bytes(), b"new")
        self.assertEqual(headers["cache-control"], "no-cache")

    def test_pin_rejects_concurrent_or_corrupt_live_bytes(self):
        tx = self.tx()
        def changed(url, path):
            path.write_bytes(b"bad")
            return {}
        with self.assertRaisesRegex(ValueError, "pinned"):
            tx.get("cn-manifest.json", self.root / "read", changed)

    def test_missing_resource_does_not_download_an_unpinned_url(self):
        tx = self.tx()
        fetch = mock.Mock(side_effect=AssertionError())
        self.assertIsNone(tx.get("missing.json", self.root / "read", fetch))

    def test_prefix_and_traversal_cannot_escape_channel(self):
        for prefix, invalid in [
            ("mgu/", "cn/cn-manifest.json"),
            ("mgu/cn/", "beta/cn-manifest.json"),
            ("mgu/cn/beta/", "../cn-manifest.json"),
            ("mgu/cn/", "/x"),
            ("mgu/", "x//y"),
            ("mgu/", "x/.hidden"),
        ]:
            with self.assertRaises(ValueError):
                self.tx(prefix).key(invalid)

    def test_immutable_bytes_cannot_be_replaced(self):
        tx = self.tx()
        rel = self.package[len("mgu/cn/"):]
        source = self.root / "source"
        file = source / rel
        file.parent.mkdir(parents=True)
        file.write_bytes(b"bad")
        with self.assertRaisesRegex(ValueError, "immutable"):
            tx.put(rel, source)
        file.write_bytes(b"pkg")
        tx.put(rel, source)

    def test_commit_failure_never_reports_public_success(self):
        tx = self.tx()
        result = {"channel": "stable", "manifest_sha256": "d" * 64, "public_verified": True}
        with mock.patch.object(tx, "commit", side_effect=RuntimeError("Origin B offline")):
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                T.replicate(result, tx.work, tx)
        saved = json.loads((tx.work / "result.json").read_text())
        self.assertFalse(saved["public_verified"])
        self.assertFalse(saved["oss_used"])
        self.assertEqual(saved["status"], "self-hosted-pending")

    def test_acceptance_must_be_for_this_transaction_and_manifest(self):
        tx = self.tx()
        accepted = dict(public_verified=True, backend="self-hosted", oss_used=False,
                        transaction_id="c" * 32, manifests={"mgu/cn/cn-manifest.json": "d" * 64})
        for field, wrong in [("transaction_id", "e" * 32), ("oss_used", True),
                             ("backend", "oss"), ("public_verified", False), ("manifests", {})]:
            Path(self.config["result"]).write_text(json.dumps(dict(accepted, **{field: wrong})))
            with mock.patch.object(T.subprocess, "run", return_value=mock.Mock(returncode=0)):
                with self.assertRaisesRegex(RuntimeError, "match"):
                    tx.commit("mgu/cn/cn-manifest.json", "d" * 64)
        Path(self.config["result"]).write_text(json.dumps(accepted))
        with mock.patch.object(T.subprocess, "run", return_value=mock.Mock(returncode=0)):
            self.assertEqual(tx.commit("mgu/cn/cn-manifest.json", "d" * 64), accepted)


if __name__ == "__main__":
    unittest.main()
