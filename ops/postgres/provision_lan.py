"""Run as root on the designated fresh Ubuntu host; read credentials from SSH stdin, never argv/logs."""
import base64
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys

os.umask(0o077)
config = json.load(sys.stdin)
if os.geteuid() != 0 or config.get('host') != '192.168.251.126' or config.get('database') != 'lcit_manager':
    raise SystemExit('Unexpected deployment target.')
roles = config['passwords']
if set(roles) != {'lcit_owner', 'lcit_app', 'lcit_team'}:
    raise SystemExit('Unexpected database roles.')
for value in roles.values():
    if len(value) < 24 or not all(c.isalnum() or c in '_-' for c in value):
        raise SystemExit('Invalid generated password format.')


def run(args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Deployment step failed: ' + args[0])
    return result.stdout.strip()


def sql(statement, database='postgres'):
    return run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', database], statement)


marker = pathlib.Path('/root/lcit-postgres-credentials.json')
if marker.exists():
    if json.loads(marker.read_text()) != config:
        raise SystemExit('Existing deployment uses different credentials; refusing to overwrite.')
else:
    existing = sql("SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1');")
    if existing:
        raise SystemExit('Host contains existing databases; refusing fresh-host provisioning.')
    existing_roles = sql("SELECT rolname FROM pg_roles WHERE rolname IN ('lcit_owner','lcit_app','lcit_team','lcit_readwrite');")
    if existing_roles:
        raise SystemExit('Conflicting roles already exist.')
    marker.write_text(json.dumps(config))
    marker.chmod(0o600)

tls = pathlib.Path('/etc/postgresql/lcit-tls')
tls.mkdir(mode=0o755, exist_ok=True)
tls.chmod(0o755)
if not (tls / 'ca.crt').exists():
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '3650',
         '-subj', '/CN=LCIT-LAN-PostgreSQL-CA', '-addext', 'basicConstraints=critical,CA:TRUE',
         '-keyout', str(tls / 'ca.key'), '-out', str(tls / 'ca.crt')])
if not (tls / 'server.crt').exists():
    run(['openssl', 'req', '-new', '-newkey', 'rsa:3072', '-nodes', '-subj', '/CN=192.168.251.126',
         '-keyout', str(tls / 'server.key'), '-out', str(tls / 'server.csr')])
    (tls / 'server.ext').write_text('subjectAltName=IP:192.168.251.126,IP:127.0.0.1,DNS:lcittestapp,DNS:localhost\n'
        'basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n')
    run(['openssl', 'x509', '-req', '-in', str(tls / 'server.csr'), '-CA', str(tls / 'ca.crt'),
         '-CAkey', str(tls / 'ca.key'), '-CAcreateserial', '-days', '365', '-sha256',
         '-extfile', str(tls / 'server.ext'), '-out', str(tls / 'server.crt')])
postgres = pwd.getpwnam('postgres')
for name in ['server.key', 'server.crt']:
    os.chown(tls / name, postgres.pw_uid, postgres.pw_gid)
(tls / 'server.key').chmod(0o600)
(tls / 'ca.key').chmod(0o600)
for name in ['server.crt', 'ca.crt']:
    (tls / name).chmod(0o644)

conf = pathlib.Path('/etc/postgresql/16/main')
for name in ['postgresql.conf', 'pg_hba.conf']:
    backup = conf / (name + '.before-lcit')
    if not backup.exists():
        shutil.copy2(conf / name, backup)
(conf / 'conf.d').mkdir(exist_ok=True)
if "include_dir = 'conf.d'" not in (conf / 'postgresql.conf').read_text():
    raise SystemExit('Expected PostgreSQL conf.d include is missing.')
(conf / 'conf.d/lcit-lan.conf').write_text("listen_addresses = '127.0.0.1,192.168.251.126'\n"
    "ssl = on\nssl_min_protocol_version = 'TLSv1.2'\n"
    "ssl_cert_file = '/etc/postgresql/lcit-tls/server.crt'\n"
    "ssl_key_file = '/etc/postgresql/lcit-tls/server.key'\n"
    "password_encryption = 'scram-sha-256'\ntimezone = 'Asia/Ho_Chi_Minh'\n")
(conf / 'conf.d/lcit-lan.conf').chmod(0o644)
(conf / 'pg_hba.conf').write_text('# LCIT LAN/VPN; remote access requires TLS and SCRAM. Local administration uses peer.\n'
    'local all postgres peer\nlocal all all peer\n'
    'hostssl lcit_manager lcit_owner,lcit_app,lcit_team 127.0.0.1/32 scram-sha-256\n'
    'hostssl lcit_manager lcit_owner,lcit_app,lcit_team 192.168.251.0/24 scram-sha-256\n'
    'host all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n')
(conf / 'pg_hba.conf').chmod(0o640)
os.chown(conf / 'pg_hba.conf', postgres.pw_uid, postgres.pw_gid)

if not sql("SELECT 1 FROM pg_roles WHERE rolname='lcit_readwrite';"):
    sql('CREATE ROLE lcit_readwrite NOLOGIN;')
for role, password in roles.items():
    if not sql(f"SELECT 1 FROM pg_roles WHERE rolname='{role}';"):
        sql(f"SET password_encryption='scram-sha-256'; CREATE ROLE {role} LOGIN PASSWORD '{password}' "
            'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20;')
if not sql("SELECT 1 FROM pg_database WHERE datname='lcit_manager';"):
    sql('CREATE DATABASE lcit_manager OWNER lcit_owner;')
sql('REVOKE ALL ON DATABASE lcit_manager FROM PUBLIC; GRANT CONNECT ON DATABASE lcit_manager TO lcit_owner,lcit_app,lcit_team; '
    'GRANT lcit_readwrite TO lcit_app,lcit_team;')
sql('CREATE SCHEMA IF NOT EXISTS lcit AUTHORIZATION lcit_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC; '
    'GRANT USAGE ON SCHEMA lcit TO lcit_readwrite; '
    'ALTER DEFAULT PRIVILEGES FOR ROLE lcit_owner IN SCHEMA lcit GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO lcit_readwrite; '
    'ALTER DEFAULT PRIVILEGES FOR ROLE lcit_owner IN SCHEMA lcit GRANT USAGE,SELECT ON SEQUENCES TO lcit_readwrite; '
    'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA lcit TO lcit_readwrite; '
    'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA lcit TO lcit_readwrite;', 'lcit_manager')
run(['systemctl', 'enable', 'postgresql'])
run(['pg_ctlcluster', '16', 'main', 'restart'])
if sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;') != '0':
    raise SystemExit('Invalid PostgreSQL access rules.')
print(json.dumps({'database': 'lcit_manager', 'host': config['host'], 'port': 5432,
    'allowedCidr': '192.168.251.0/24', 'ca': base64.b64encode((tls / 'ca.crt').read_bytes()).decode()}))
