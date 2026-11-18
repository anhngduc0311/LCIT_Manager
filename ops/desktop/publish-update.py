"""Publish a completed LCIT release uploaded to a private staging directory."""

import fcntl
import hashlib
import json
import os
import pathlib
import re
import sys


stage = pathlib.Path(sys.argv[1]).resolve()
if stage.parent != pathlib.Path("/var/tmp") or not re.fullmatch(r"lcit-update-[a-f0-9]{32}", stage.name):
    raise SystemExit("Unexpected staging directory")

root = pathlib.Path("/var/www/lcit-desktop-updates")
latest = root / "latest.json"
manifest = json.loads((stage / "latest.json").read_text())
version = manifest["version"]
if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
    raise SystemExit("Expected a stable version")

filename = f"LCIT-Manager-{version}-x64-setup.exe"
artifact = manifest["platforms"]["windows-x86_64"]
if artifact["url"] != f"https://api.akatruyen.com/desktop-updates/{filename}" or not artifact["signature"].strip():
    raise SystemExit("Invalid updater manifest")

binary = stage / filename
with binary.open("rb") as stream:
    actual = hashlib.file_digest(stream, "sha256").hexdigest()
if actual != (stage / "sha256.txt").read_text().strip().lower():
    raise SystemExit("The uploaded installer checksum did not match")

with (root / ".publish.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if latest.exists():
        previous = json.loads(latest.read_text())["version"]
        if tuple(map(int, version.split("."))) <= tuple(map(int, previous.split("."))):
            raise SystemExit("Increase the version before publishing")
    # Move the complete installer into place before exposing it in latest.json.
    destination = root / filename
    if destination.exists():
        with destination.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != actual:
                raise SystemExit("This version already has a different installer")
    else:
        binary.chmod(0o644)
        os.replace(binary, destination)
    pending = stage / "latest.json"
    pending.chmod(0o644)
    os.replace(pending, latest)
print(f"Published LCIT Manager {version}")
