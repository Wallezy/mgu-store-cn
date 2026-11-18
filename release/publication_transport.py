# SPDX-License-Identifier: GPL-3.0-only
"""Maintainer-only transport for pinned reads and verified publication."""
import contextlib
import json
import os
import pathlib
import subprocess
import sys
import hashlib
import re
import shutil
import mimetypes

PUBLIC = "https://mgu.walle.pw/mgu/"
STORAGE = "https://walle-mgu.oss-cn-hangzhou.aliyuncs.com/mgu/"

def settings():
    name = os.environ.get("MGU_PUBLICATION_TRANSPORT")
    file = pathlib.Path(name) if name else pathlib.Path.home()/".config/mgu-mirror/publication-transport.json"
    if not file.exists():
        return None
    if os.name != "nt" and file.stat().st_mode & 0o077:
        raise ValueError("Publication transport settings must be private")
    config = json.loads(file.read_text())
    if config.get("schema") != 1 or config.get("mode") not in ("oss-with-edge", "self-hosted"):
        raise ValueError("Unsupported publication transport")
    for key in ("driver", "lock", "result"):
        if not pathlib.Path(config[key]).is_absolute():
            raise ValueError("Transport paths must be absolute")
    if not pathlib.Path(config["driver"]).is_file():
        raise ValueError("Edge publication driver missing")
    return config

def storage_url(url):
    config = settings()
    return STORAGE + url[len(PUBLIC):] if config and config["mode"] == "oss-with-edge" and url.startswith(PUBLIC) else url

def self_hosted():
    config = settings()
    return bool(config and config["mode"] == "self-hosted")

def file_digest(file):
    value = hashlib.sha256()
    with pathlib.Path(file).open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            value.update(block)
    return value.hexdigest()

def relative(value):
    if (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_@./+-]+", value)
            or any(p in ("", ".", "..") or p.startswith(".") for p in value.split("/"))):
        raise ValueError("Invalid publication path")
    return value

def cache_control(path):
    return ("public, max-age=31536000, immutable"
            if any("/" + p + "/" in "/" + path for p in ("packages", "icons", "source", "candidates"))
            else "no-cache")

def content_headers(path):
    kind = ("application/gzip" if path.endswith((".tgz", ".gz")) else
            "application/json" if path.endswith(".json") else
            "image/png" if path.endswith(".png") else
            "application/javascript" if path.endswith(".js") else
            mimetypes.guess_type(path)[0] or "text/plain; charset=utf-8")
    return {"cache-control": cache_control(path), "content-type": kind}

class Transaction:
    """Local, verified overlay; public data changes only after both origins are ready."""
    def __init__(self, prefix, work):
        self.config = settings()
        if not self.config or self.config["mode"] != "self-hosted":
            raise ValueError("Self-hosted transport required")
        if prefix not in ("mgu/", "mgu/cn/", "mgu/cn/beta/"):
            raise ValueError("Unsupported publication prefix")
        self.prefix, self.work = prefix, pathlib.Path(work)
        self.folder = self.work / "self-hosted-transaction"
        self.folder.mkdir()
        self.overlay = self.folder / "overlay"
        self.overlay.mkdir()
        self.record = self.folder / "transaction.json"
        with (self.work / "self-hosted-begin.log").open("w") as log:
            result = subprocess.run([sys.executable, self.config["driver"], "--begin", str(self.record)],
                                    stdout=log, stderr=subprocess.STDOUT, timeout=120)
        if result.returncode:
            raise RuntimeError("Cannot pin self-hosted snapshot; inspect self-hosted-begin.log")
        value = json.loads(self.record.read_text())
        base = value.get("base", {})
        if (value.get("schema") != 1 or not re.fullmatch("[a-f0-9]{64}", base.get("snapshot", ""))
                or not isinstance(base.get("files"), list)):
            raise ValueError("Invalid source snapshot response")
        value["prefix"] = prefix
        self.record.write_text(json.dumps(value, indent=2) + "\n")
        self.base = base
        self.files = {e["path"]: e for e in base["files"]}

    def key(self, path):
        relative(path)
        if self.prefix == "mgu/" and path.startswith("cn/"):
            raise ValueError("Official publication cannot write CN")
        if self.prefix == "mgu/cn/" and path.startswith("beta/"):
            raise ValueError("Stable publication cannot write Beta")
        return self.prefix + path

    def put(self, path, root):
        key = self.key(path)
        source = pathlib.Path(root) / path
        if source.is_symlink() or not source.is_file():
            raise ValueError("Expected regular publication file")
        sha, size = file_digest(source), source.stat().st_size
        old = self.files.get(key)
        if (old and "immutable" in cache_control(key)
                and (old["sha256"], old["size"]) != (sha, size)):
            raise ValueError("Refusing immutable resource replacement: " + path)
        target = self.overlay / key
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        if file_digest(target) != sha:
            raise ValueError("Staged bytes differ")

    def get(self, path, root, downloader):
        key = self.key(path)
        output = pathlib.Path(root) / path
        staged = self.overlay / key
        output.parent.mkdir(parents=True, exist_ok=True)
        if staged.exists():
            shutil.copyfile(staged, output)
            return content_headers(path)
        expected = self.files.get(key)
        if expected is None:
            return None
        headers = downloader("https://mgu.walle.pw/" + key, output)
        if (headers is None or output.stat().st_size != expected["size"]
                or file_digest(output) != expected["sha256"]):
            raise ValueError("Live entry differs from pinned snapshot: " + path)
        return headers

    def commit(self, expected_path, expected_sha):
        with (self.work / "edge.log").open("w") as log:
            process = subprocess.run([sys.executable, self.config["driver"],
                                      "--publish", str(self.folder), "--expect-path", expected_path,
                                      "--expect-sha256", expected_sha],
                                     stdout=log, stderr=subprocess.STDOUT)
        if process.returncode:
            raise RuntimeError("Self-hosted publication failed; inspect edge.log")
        accepted = json.loads(pathlib.Path(self.config["result"]).read_text())
        request = json.loads(self.record.read_text())
        if (not accepted.get("public_verified") or accepted.get("backend") != "self-hosted"
                or accepted.get("oss_used") is not False
                or accepted.get("transaction_id") != request["transaction_id"]
                or accepted.get("manifests", {}).get(expected_path) != expected_sha):
            raise RuntimeError("Self-hosted acceptance does not match this transaction")
        return accepted

@contextlib.contextmanager
def lock(execute):
    config = settings() if execute else None
    if not config:
        yield
        return
    if os.name == "nt":
        raise RuntimeError("Edge publication requires a POSIX maintainer host")
    import fcntl
    with open(config["lock"], "a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another official/CN publication or edge sync is active")
        yield

def replicate(result, work, transaction=None):
    config = settings()
    if not config:
        return result
    if config["mode"] == "self-hosted":
        if transaction is None:
            raise ValueError("Self-hosted publication requires a pinned transaction")
        result["staged_verified"] = True
        result["backend"], result["oss_used"] = "self-hosted", False
        for field in ("public_verified", "remote_verified"):
            if field in result:
                result[field] = False
        manifest = ("mgu/mirror-manifest.json" if "channel" not in result else
                    "mgu/cn/" + ("beta/" if result["channel"] == "beta" else "") + "cn-manifest.json")
        try:
            result["edge"] = transaction.commit(manifest, result["manifest_sha256"])
        except (OSError, ValueError, RuntimeError) as error:
            result.update(status="self-hosted-pending", error=str(error))
            (pathlib.Path(work) / "result.json").write_text(json.dumps(result, indent=2) + "\n")
            raise RuntimeError("Self-hosted publication incomplete: " + str(error)) from error
        for field in ("public_verified", "remote_verified"):
            if field in result:
                result[field] = True
        return result
    # OSS has committed. Failed edge acceptance must not claim a public release
    # or roll OSS back behind an already committed edge snapshot.
    result["storage_verified"] = True
    for field in ("public_verified", "remote_verified"):
        if field in result:
            result[field] = False
    work = pathlib.Path(work)
    expected = ({"manifest": "mgu/mirror-manifest.json"} if "channel" not in result else
                {"manifest": "mgu/cn/" + ("beta/" if result["channel"] == "beta" else "") + "cn-manifest.json"})
    expected["sha256"] = result["manifest_sha256"]
    try:
        with (work/"edge.log").open("w") as log:
            run = subprocess.run([sys.executable, config["driver"], "--expect-path", expected["manifest"],
                                  "--expect-sha256", expected["sha256"]],
                                 stdout=log, stderr=subprocess.STDOUT)
        if run.returncode:
            raise RuntimeError("Edge driver failed; inspect edge.log")
        accepted = json.loads(pathlib.Path(config["result"]).read_text())
        if not accepted.get("public_verified") or accepted.get("manifests", {}).get(expected["manifest"]) != expected["sha256"]:
            raise RuntimeError("Edge acceptance does not match this publication")
    except (OSError, ValueError, RuntimeError) as error:
        result.update(status="edge-pending", error="OSS verified; edge publication incomplete: " + str(error))
        (work/"result.json").write_text(json.dumps(result, indent=2)+"\n")
        raise RuntimeError(result["error"]) from error
    result["edge"] = accepted
    for field in ("public_verified", "remote_verified"):
        if field in result:
            result[field] = True
    return result
