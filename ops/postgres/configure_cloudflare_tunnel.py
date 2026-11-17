"""Configure only the explicitly created LCIT API tunnel; database traffic is not routed."""
import json
import os
import pathlib
import pwd
import re
import shutil
import subprocess
import sys

data = json.load(sys.stdin)
existing_config = pathlib.Path('/etc/cloudflared/config.yml')
if existing_config.is_file() and 'hostname: db.akatruyen.com' in existing_config.read_text():
    raise SystemExit('Protected database route already exists; do not overwrite with API-only bootstrap.')
tunnel_id = data['tunnelId']
if not re.fullmatch('[a-f0-9-]{36}', tunnel_id):
    raise SystemExit('Invalid tunnel ID.')
source = pathlib.Path('/root/.cloudflared') / (tunnel_id + '.json')
if not source.is_file():
    raise SystemExit('Tunnel credentials have not been created.')
try:
    user = pwd.getpwnam('cloudflared')
except KeyError:
    subprocess.run(['useradd', '--system', '--user-group', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'cloudflared'], check=True)
    user = pwd.getpwnam('cloudflared')
directory = pathlib.Path('/etc/cloudflared')
directory.mkdir(mode=0o750, exist_ok=True)
directory.chmod(0o750)
os.chown(directory, 0, user.pw_gid)
credential = directory / (tunnel_id + '.json')
shutil.copyfile(source, credential)
credential.chmod(0o640)
os.chown(credential, 0, user.pw_gid)
config = directory / 'config.yml'
config.write_text('tunnel: ' + tunnel_id + '\ncredentials-file: ' + str(credential) + '\n'
    'protocol: http2\nmetrics: 127.0.0.1:20241\n'
    'ingress:\n  - hostname: api.akatruyen.com\n    service: http://127.0.0.1:4000\n  - service: http_status:404\n')
config.chmod(0o640)
os.chown(config, 0, user.pw_gid)
subprocess.run(['cloudflared', '--config', str(config), 'tunnel', 'ingress', 'validate'], check=True)
unit = pathlib.Path('/etc/systemd/system/lcit-tunnel.service')
unit.write_text('''[Unit]
Description=LCIT API Cloudflare Tunnel
After=network-online.target lcit-api.service
Wants=network-online.target lcit-api.service

[Service]
Type=simple
User=cloudflared
Group=cloudflared
ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
''')
unit.chmod(0o644)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'lcit-tunnel'], check=True)
print('LCIT tunnel service configured.')
