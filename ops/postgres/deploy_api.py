"""Deploy a prebuilt API archive. Receive archive + app credentials over SSH stdin, not process arguments."""
import base64
import hashlib
import io
import json
import os
import pathlib
import pwd
import subprocess
import sys
import tarfile
from urllib.parse import urlencode, quote

os.umask(0o027)
payload = json.load(sys.stdin)
archive = base64.b64decode(payload['archive'])
if hashlib.sha256(archive).hexdigest() != payload['sha256']:
    raise SystemExit('Archive checksum mismatch.')
release_name = payload['release']
if not release_name.isdigit():
    raise SystemExit('Invalid release identifier.')
release = pathlib.Path('/opt/lcit-manager/releases') / release_name
release.mkdir(parents=True, exist_ok=False)
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
    bundle.extractall(release, filter='data')
result = subprocess.run(['/usr/local/bin/npm', 'ci', '--omit=dev', '--workspace', '@lcit/api', '--ignore-scripts', '--no-audit', '--no-fund'],
    cwd=release, capture_output=True, text=True)
if result.returncode:
    raise SystemExit('Production dependency installation failed.')
try:
    user = pwd.getpwnam('lcit-api')
except KeyError:
    subprocess.run(['useradd', '--system', '--user-group', '--home-dir', '/var/lib/lcit-manager', '--shell', '/usr/sbin/nologin', 'lcit-api'], check=True)
    user = pwd.getpwnam('lcit-api')
for item in [pathlib.Path('/opt/lcit-manager'), release.parent, release, *release.rglob('*')]:
    if item.is_symlink():
        continue
    os.chown(item, 0, user.pw_gid)
    item.chmod(item.stat().st_mode | (0o050 if item.is_dir() else 0o040))
state = pathlib.Path('/var/lib/lcit-manager')
state.mkdir(exist_ok=True)
os.chown(state, 0, user.pw_gid)
state.chmod(0o750)
attachments = state / 'attachments'
attachments.mkdir(exist_ok=True)
for item in [attachments, *attachments.rglob('*')]:
    os.chown(item, user.pw_uid, user.pw_gid)
    item.chmod(0o750 if item.is_dir() else 0o640)
config_dir = pathlib.Path('/etc/lcit-manager')
config_dir.mkdir(mode=0o750, exist_ok=True)
os.chown(config_dir, 0, user.pw_gid)
url = 'postgresql://lcit_app:' + quote(payload['password'], safe='') + '@127.0.0.1:5432/lcit_manager?'
url += urlencode({'sslmode': 'verify-full', 'sslrootcert': '/etc/postgresql/lcit-tls/ca.crt'})
env = config_dir / 'api.env'
env.write_text('NODE_ENV=production\nAPI_HOST=127.0.0.1\nAPI_PORT=4000\nDATABASE_URL=' + url + '\n'
    'API_CORS_ORIGINS=http://127.0.0.1:3000,http://localhost:3000,http://tauri.localhost,tauri://localhost,https://akatruyen.com,https://api.akatruyen.com\n'
    'MONITORING_ENABLED=on\nMONITORING_TIME_ZONE=Asia/Ho_Chi_Minh\n'
    'MONITORING_EXPIRY_CRON="0 0 2 * * *"\nMONITORING_DNS_TLS_CRON="0 */30 * * * *"\n'
    'MONITORING_ALLOWED_HOSTS=\nMONITORING_ALLOWED_CIDRS=\nMONITORING_ALLOWED_TLS_PORTS=443\n'
    'ATTACHMENTS_DIR=/var/lib/lcit-manager/attachments\nATTACHMENT_MAX_BYTES=20971520\nATTACHMENT_PENDING_TTL_MINUTES=60\n')
os.chown(env, 0, user.pw_gid)
env.chmod(0o640)
current = pathlib.Path('/opt/lcit-manager/current')
if current.exists() and not current.is_symlink():
    raise SystemExit('Unexpected deployment current path.')
if current.is_symlink():
    current.unlink()
current.symlink_to(release, target_is_directory=True)
unit = pathlib.Path('/etc/systemd/system/lcit-api.service')
unit.write_text('''[Unit]
Description=LCIT Manager API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=lcit-api
Group=lcit-api
WorkingDirectory=/opt/lcit-manager/current/apps/api
EnvironmentFile=/etc/lcit-manager/api.env
ExecStart=/usr/local/bin/node dist/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/lcit-manager/attachments

[Install]
WantedBy=multi-user.target
''')
unit.chmod(0o644)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'lcit-api'], check=True, capture_output=True)
print(json.dumps({'release': release_name, 'service': 'lcit-api', 'origin': 'http://127.0.0.1:4000', 'database': 'lcit_manager'}))
