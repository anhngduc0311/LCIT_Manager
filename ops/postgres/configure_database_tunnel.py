"""Add the LCIT database route only after its Access application is configured.

Run as root, with JSON {teamName, audience} on stdin. No credentials are needed.
"""
import datetime
import json
import pathlib
import re
import shutil
import subprocess
import sys

data = json.load(sys.stdin)
team = data['teamName']
audience = data['audience']
if not re.fullmatch(r'[a-z0-9-]+', team) or not re.fullmatch(r'[a-f0-9]{64}', audience):
    raise SystemExit('Invalid Access team or audience.')
config = pathlib.Path('/etc/cloudflared/config.yml')
original = config.read_text()
if 'b58edd72-5593-4923-b9ca-08cf5e2aaa4b' not in original:
    raise SystemExit('Not the LCIT tunnel.')
if 'hostname: db.akatruyen.com' in original:
    raise SystemExit('Database route already exists; inspect before changing it.')
catchall = '  - service: http_status:404\n'
if original.count(catchall) != 1 or not original.endswith(catchall):
    raise SystemExit('Unexpected ingress structure; refusing to overwrite.')
route = ('  - hostname: db.akatruyen.com\n'
         '    service: tcp://127.0.0.1:5432\n'
         '    originRequest:\n'
         '      access:\n'
         '        required: true\n'
         f'        teamName: {team}\n'
         '        audTag:\n'
         f'          - {audience}\n')
backup = config.with_name('config.yml.before-db-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
shutil.copy2(config, backup)
try:
    config.write_text(original.removesuffix(catchall) + route + catchall)
    subprocess.run(['cloudflared', '--config', str(config), 'tunnel', 'ingress', 'validate'], check=True)
    subprocess.run(['systemctl', 'restart', 'lcit-tunnel'], check=True)
    subprocess.run(['systemctl', 'is-active', '--quiet', 'lcit-tunnel'], check=True)
except BaseException:
    shutil.copy2(backup, config)
    subprocess.run(['systemctl', 'restart', 'lcit-tunnel'], check=False)
    raise
print('Database TCP route configured with required Access JWT validation.')
