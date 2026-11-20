import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("online_build", Path(__file__).parents[1] / "online_build.py")
online = importlib.util.module_from_spec(spec)
spec.loader.exec_module(online)


class OnlineBuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.repo = "Wallezy/mgu-store-cn"
        self.sha = "a" * 40
        data = b"test release package"
        (self.source / "example.tgz").write_bytes(data)
        catalog = {"commit": self.sha, "components": [
            {"id": "example", "artifact": {"name": "example.tgz",
                                         "size": len(data), "sha256": online.digest(data)}}]}
        (self.source / "catalog.json").write_text(json.dumps(catalog))
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}):
            online.seal(self.source, self.repo, self.sha)
        self.zip = self.root / "build.zip"
        with zipfile.ZipFile(self.zip, "w") as z:
            for p in self.source.iterdir():
                z.write(p, p.name)
        self.run = {
            "id": 123, "run_attempt": 1, "path": online.WORKFLOWS[self.repo],
            "head_sha": self.sha, "head_branch": "main", "event": "push",
            "head_repository": {"full_name": self.repo},
            "status": "completed", "conclusion": "success",
        }
        self.artifact = {
            "id": 456, "name": "cn-release-" + self.sha + "-a", "expired": False,
            "digest": "sha256:" + online.digest(self.zip.read_bytes()),
        }

    def fetch(self):
        def api(url):
            return {"artifacts": [self.artifact]} if "/artifacts?" in url else self.run
        with patch.object(online, "api", side_effect=api):
            return online.fetch(self.repo, self.sha, self.root / "output", 123, self.zip)

    def test_accept_exact_successful_run(self):
        self.assertEqual(self.fetch()["run_id"], 123)
        self.assertEqual((self.root / "output/example.tgz").read_bytes(), b"test release package")

    def test_reject_failed_pr_and_wrong_commit(self):
        for field, value in [("conclusion", "failure"), ("event", "pull_request"),
                             ("head_sha", "b" * 40), ("head_branch", "feature")]:
            with self.subTest(field=field):
                with patch.dict(self.run, {field: value}):
                    with self.assertRaises(ValueError):
                        self.fetch()

    def test_reject_wrong_attempt_and_hash(self):
        with patch.dict(self.run, {"run_attempt": 2}):
            with self.assertRaises(ValueError):
                self.fetch()
        with patch.dict(self.artifact, {"digest": "sha256:" + "0" * 64}):
            with self.assertRaises(ValueError):
                self.fetch()

    def test_tampered_file_and_extra_file(self):
        (self.source / "example.tgz").write_bytes(b"replacement")
        with self.assertRaises(ValueError):
            online.validate(self.source, self.repo, self.sha)
        (self.source / "extra").write_bytes(b"extra")
        with self.assertRaises(ValueError):
            online.validate(self.source, self.repo, self.sha)

    def test_reject_zip_escape_and_duplicate(self):
        for names in [("../outside",), ("same", "same")]:
            with self.subTest(names=names):
                archive = self.root / "bad.zip"
                with zipfile.ZipFile(archive, "w") as z:
                    for name in names:
                        z.writestr(name, "bad")
                with self.assertRaises(ValueError):
                    online.extract(archive, self.root / "bad-output")
                self.assertFalse((self.root / "outside").exists())


if __name__ == "__main__":
    unittest.main()
