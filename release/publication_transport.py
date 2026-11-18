# SPDX-License-Identifier: GPL-3.0-only
"""Maintainer-only origin reads and verified edge publication after OSS commit."""
import contextlib
import json
import os
import pathlib
import subprocess
import sys

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
    if config.get("schema") != 1 or config.get("mode") != "oss-with-edge":
        raise ValueError("Unsupported publication transport")
    for key in ("driver", "lock", "result"):
        if not pathlib.Path(config[key]).is_absolute():
            raise ValueError("Transport paths must be absolute")
    if not pathlib.Path(config["driver"]).is_file():
        raise ValueError("Edge publication driver missing")
    return config

def storage_url(url):
    return STORAGE + url[len(PUBLIC):] if settings() and url.startswith(PUBLIC) else url

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

def replicate(result, work):
    config = settings()
    if not config:
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
