"""Install the official Node 22 Linux x64 runtime after verifying its vendor SHA-256 manifest."""
import hashlib
import pathlib
import re
import subprocess
import tarfile
import urllib.request

base = 'https://nodejs.org/dist/latest-v22.x/'
manifest = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30).read().decode()
match = re.search(r'^([a-f0-9]{64})\s+(node-v22\.\d+\.\d+-linux-x64\.tar\.xz)$', manifest, re.M)
if not match:
    raise SystemExit('Official runtime manifest is missing the expected platform.')
expected, filename = match.groups()
archive = pathlib.Path('/var/tmp') / filename
urllib.request.urlretrieve(base + filename, archive)
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit('Runtime checksum verification failed.')
with tarfile.open(archive) as bundle:
    bundle.extractall('/opt', filter='data')
runtime = pathlib.Path('/opt') / filename.removesuffix('.tar.xz')
for name in ['node', 'npm', 'npx']:
    link = pathlib.Path('/usr/local/bin') / name
    if link.is_symlink() and link.resolve() == (runtime / 'bin' / name).resolve():
        continue
    if link.exists() or link.is_symlink():
        raise SystemExit('Existing runtime command must be reviewed before replacing: ' + name)
    link.symlink_to(runtime / 'bin' / name)
subprocess.run(['/usr/local/bin/node', '--version'], check=True)
subprocess.run(['/usr/local/bin/npm', '--version'], check=True)
