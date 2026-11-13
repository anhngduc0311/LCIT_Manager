const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const tls = require('node:tls');
const net = require('node:net');
const { Pool } = require('pg');
const { networkMonitorConfig, allowedAddress, allowedHost } = require('../dist/models/network-monitor-config');
const { NetworkProbe, probeFailure } = require('../dist/models/network-probe');
const { NetworkMonitorService } = require('../dist/models/network-monitor.service');
const { liveTargetsSql } = require('../dist/models/monitoring-targets.service');

const policy = (extra = {}) => networkMonitorConfig({ MONITORING_ALLOWED_HOSTS: '*.example.test', MONITORING_ALLOWED_CIDRS: '10.0.0.0/8,2001:db8::/32', ...extra });
function fakeResolver(overrides = {}) {
  return { resolve: async () => ['10.1.2.3'], resolve4: async () => ['10.1.2.3'],
    resolve6: async () => { throw Object.assign(new Error(), { code: 'ENODATA' }); }, cancel() {}, ...overrides };
}
function probeWith(resolver, config = policy()) {
  const probe = new NetworkProbe();
  probe.config = config;
  probe.createResolver = () => resolver;
  return probe;
}

test('network policy is deny-by-default and handles exact hosts, CIDRs and IPv4-mapped IPv6', () => {
  const config = policy();
  assert.equal(allowedHost('monitor.example.test', config), true);
  assert.equal(allowedHost('evil-example.test', config), false);
  assert.equal(allowedHost('example.test', config), false);
  assert.equal(allowedAddress('10.1.2.3', config), true);
  assert.equal(allowedAddress('::ffff:10.1.2.3', config), true);
  assert.equal(allowedAddress('::ffff:169.254.169.254', config), false);
  assert.equal(allowedAddress('2001:db8::1', config), true);
  assert.equal(allowedAddress('10.1.2.3', networkMonitorConfig({})), false);
  const broad = policy({ MONITORING_ALLOWED_CIDRS: '0.0.0.0/0,::/0' });
  for (const address of ['0.0.0.0', '169.254.169.254', '224.0.0.1', '::', 'fe80::1', 'ff02::1']) assert.equal(allowedAddress(address, broad), false, address);
  for (const env of [{ MONITORING_CHECK_CONCURRENCY: '0' }, { MONITORING_CHECK_TIMEOUT_MS: '999999' },
    { MONITORING_ALLOWED_HOSTS: 'https://example.test' }, { MONITORING_ALLOWED_CIDRS: 'bad' }, { MONITORING_ALLOWED_TLS_PORTS: '0' }]) assert.throws(() => networkMonitorConfig(env));
});

test('DNS probes classify errors and timeout; policy rejects mixed answers before opening a TLS connection', async () => {
  const target = { type: 'dns', host: 'monitor.example.test', recordType: 'A' };
  assert.equal((await probeWith(fakeResolver()).check(target)).status, 'success');
  assert.equal((await probeWith(fakeResolver({ resolve: async () => [] })).check(target)).status, 'dns_error');
  assert.equal((await probeWith(fakeResolver({ resolve: async () => { throw Object.assign(new Error('secret'), { code: 'ENOTFOUND' }); } })).check(target)).errorCode, 'DNS_LOOKUP_FAILED');
  assert.equal((await probeWith(fakeResolver({ resolve: async () => { throw Object.assign(new Error(), { code: 'ETIMEOUT' }); } })).check(target)).status, 'timeout');
  let cancelled = false;
  const hanging = probeWith(fakeResolver({ resolve: () => new Promise(() => {}), cancel: () => { cancelled = true; } }), { ...policy(), timeoutMs: 20 });
  assert.equal((await hanging.check(target)).status, 'timeout');
  assert.equal(cancelled, true);
  const mixed = probeWith(fakeResolver({ resolve4: async () => ['10.1.2.3', '169.254.169.254'] }));
  mixed.openTls = () => assert.fail('A forbidden resolved address must never reach a socket.');
  assert.equal((await mixed.check({ type: 'tls', host: target.host, port: 443 })).status, 'blocked');
  assert.equal((await mixed.check({ type: 'tls', host: target.host, port: 22 })).status, 'blocked');
  assert.equal((await mixed.check({ type: 'tls', host: 'other.invalid', port: 443 })).status, 'blocked');
});

test('real local TLS fixtures distinguish valid, untrusted, wrong hostname, expired and stalled handshakes', async (context) => {
  const fixture = path.join(__dirname, 'fixtures/tls');
  const [key, ca, valid, expired] = await Promise.all(['test-only-key.pem','ca.pem','valid.pem','expired.pem'].map((name) => readFile(path.join(fixture, name))));
  const sockets = new Set(), servers = [];
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });
  async function serverFor(cert) {
    const server = cert ? tls.createServer({ key, cert }, (socket) => socket.end()) : net.createServer(() => {});
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('tlsClientError', () => {});
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
  }
  async function check(cert, trust = true, identity = 'monitor.example.test') {
    const port = await serverFor(cert);
    const probe = probeWith(fakeResolver({ resolve4: async () => ['127.0.0.1'] }),
      { ...policy({ MONITORING_ALLOWED_CIDRS: '127.0.0.1/32' }), ports: [port], timeoutMs: cert ? 1000 : 40 });
    probe.openTls = (options) => {
      assert.equal(options.host, '127.0.0.1', 'The socket must use the validated IP, never re-resolve the hostname.');
      assert.equal(options.servername, identity);
      return tls.connect({ ...options, ...(trust ? { ca } : {}) });
    };
    return probe.check({ type: 'tls', host: 'monitor.example.test', sni: identity, port });
  }
  const good = await check(valid);
  assert.equal(good.status, 'success');
  assert.equal(good.observedExpiryAt, '2120-01-01T00:00:00.000Z');
  assert.equal((await check(valid, false)).errorCode, 'TLS_UNTRUSTED');
  assert.equal((await check(valid, true, 'wrong.example.test')).errorCode, 'TLS_IDENTITY_INVALID');
  assert.equal((await check(expired)).status, 'expired');
  assert.equal((await check(null)).status, 'timeout');
});

test('network worker bounds simultaneous probes and does not overlap saves on the job connection', async () => {
  let active = 0, maximum = 0, saves = 0;
  const config = { type: 'dns', host: 'monitor.example.test', recordType: 'A' };
  const targets = Array.from({ length: 9 }, (_, i) => ({ id: i, config, approved_config: config }));
  const probe = { config: { concurrency: 3 }, check: async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--; return { status: 'success', addresses: [], observedExpiryAt: null, errorCode: null };
  } };
  const worker = new NetworkMonitorService({}, probe);
  worker.save = async () => { saves++; assert.equal(active, 0); };
  await worker.run({ client: { query: async () => ({ rows: targets }) } });
  assert.equal(maximum, 3);
  assert.equal(saves, 9);
});

const databaseUrl = process.env.LCIT_TEST_DATABASE_URL;
test('T3.3: approval permissions, durable outage/recovery, atomic notifications, changed config and repeated runs', {
  skip: databaseUrl ? false : 'Set LCIT_TEST_DATABASE_URL to an empty disposable PostgreSQL database.', timeout: 120000,
}, async (context) => {
  const db = new Pool({ connectionString: databaseUrl });
  const envKeys = ['DATABASE_URL','MONITORING_EXPIRY_CRON','MONITORING_DNS_TLS_CRON','MONITORING_ENABLED'];
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let app, ownsSchema = false;
  context.after(async () => {
    await app?.close();
    if (ownsSchema) await db.query('DROP SCHEMA IF EXISTS lcit CASCADE');
    await db.end();
    for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
  });
  assert.equal((await db.query("SELECT to_regnamespace('lcit') AS schema")).rows[0].schema, null);
  ownsSchema = true;
  for (let i = 0; i < 2; i++) {
    const migrated = spawnSync(process.execPath, ['dist/migrate.js'], { cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 20000 });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.match(migrated.stdout, i ? /up to date/ : /007_network_monitoring.sql/);
  }
  process.env.DATABASE_URL = databaseUrl;
  process.env.MONITORING_ENABLED = 'on';
  process.env.MONITORING_EXPIRY_CRON = '0 0 0 1 1 *';
  process.env.MONITORING_DNS_TLS_CRON = '0 0 0 1 1 *';
  const { sha256 } = require('../dist/models/access');
  const tokens = {};
  for (const role of ['admin','leader','specialist']) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO lcit.users(id,username,display_name,password_hash,role) VALUES($1,$2,$2,'test-hash',$2)", [id, role]);
    await db.query("INSERT INTO lcit.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [sha256(token), id]);
    tokens[role] = token;
  }
  const { rows: [domain] } = await db.query("INSERT INTO lcit.domains(name) VALUES('example.test') RETURNING id");
  const { rows: [dns] } = await db.query("INSERT INTO lcit.dns_records(domain_id,host,type,target) VALUES($1,'monitor.example.test','A','10.1.2.3') RETURNING id", [domain.id]);
  const { rows: [endpoint] } = await db.query("INSERT INTO lcit.tls_endpoints(domain_id,host,port) VALUES($1,'monitor.example.test',443) RETURNING id", [domain.id]);
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../dist/app.module');
  const { MonitoringService } = require('../dist/models/monitoring.service');
  const { ApiExceptionFilter } = require('../dist/shared/api-contract');
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  async function call(route, body, expected = 200, role = 'admin') {
    const response = await fetch(`${await app.getUrl()}/api/v1/monitoring/targets${route}`, {
      method: body === undefined ? 'GET' : 'PUT', headers: { Authorization: `Bearer ${tokens[role]}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  assert.equal((await call('')).total, 0);
  for (const role of ['leader','specialist']) {
    await call('', undefined, 403, role);
    await call(`/dns/${dns.id}`, { version: 0, enabled: true }, 403, role);
    await call(`/dns/${dns.id}/checks`, undefined, 403, role);
  }
  const approved = await call(`/dns/${dns.id}`, { version: 0, enabled: true });
  await call(`/dns/${dns.id}`, { version: 0, enabled: true }, 409);
  await call(`/tls/${endpoint.id}`, { version: 0, enabled: true });
  let outcome = probeFailure('dns_error', 'DNS_LOOKUP_FAILED');
  let count = 0;
  const probe = app.get(NetworkProbe);
  probe.check = async () => { count++; return outcome; };
  const runner = app.get(MonitoringService);
  const run = () => runner.run('dns_tls');
  const state = async () => (await call('')).items.find((item) => item.type === 'dns');
  const events = async () => (await db.query("SELECT kind FROM lcit.alerts WHERE dns_record_id=$1 ORDER BY created_at,id", [dns.id])).rows.map((r) => r.kind);
  await run();
  assert.equal((await state()).consecutiveFailures, 1);
  assert.deepEqual(await events(), []);
  outcome = { status: 'success', addresses: ['10.1.2.3'], observedExpiryAt: null, errorCode: null };
  await run();
  assert.equal((await state()).consecutiveFailures, 0);
  assert.deepEqual(await events(), []);
  outcome = probeFailure('timeout', 'CHECK_TIMEOUT');
  await run();
  assert.equal((await state()).health, 'up');
  await run();
  assert.equal((await state()).health, 'down');
  assert.deepEqual(await events(), ['outage']);
  await run();
  assert.deepEqual(await events(), ['outage']);
  outcome = { status: 'success', addresses: ['10.1.2.3'], observedExpiryAt: '2028-01-01T00:00:00Z', errorCode: null };
  // DNS result must never carry a TLS date; return an appropriate observation for each type.
  probe.check = async (target) => { count++; return target.type === 'dns' ? { ...outcome, observedExpiryAt: null } : outcome; };
  await run();
  assert.deepEqual(await events(), ['outage','recovery']);
  await run();
  assert.deepEqual(await events(), ['outage','recovery']);
  assert.equal((await db.query('SELECT observed_expiry_at FROM lcit.tls_endpoints WHERE id=$1', [endpoint.id])).rows[0].observed_expiry_at.toISOString(), '2028-01-01T00:00:00.000Z');
  assert.equal((await db.query('SELECT count(*) FROM lcit.notifications')).rows[0].count, '4', 'Only admin has scope to these unlinked endpoints.');

  // Replaying a recorded job/target pair must not advance its streak or duplicate a transition.
  const worker = app.get(NetworkMonitorService);
  const client = await db.connect();
  try {
    const target = (await client.query(`${liveTargetsSql} AND mt.id=$1`, [approved.id])).rows[0];
    const last = (await client.query('SELECT job_run_id FROM lcit.check_runs WHERE id=$1', [target.last_check_run_id])).rows[0];
    await worker.save({ client, runId: last.job_run_id }, target, probeFailure('timeout','CHECK_TIMEOUT'), new Date(), new Date());
    assert.equal((await state()).health, 'up');
  } finally { client.release(); }
  await db.query("UPDATE lcit.dns_records SET host='changed.example.test' WHERE id=$1", [dns.id]);
  const before = count;
  await run();
  assert.equal(count, before + 1, 'Changed DNS config is blocked without a network call; unchanged TLS still runs.');
  assert.equal((await state()).needsApproval, true);
  assert.equal((await state()).lastCheck.status, 'blocked');
  assert.equal((await state()).lastCheck.errorCode, 'CONFIG_CHANGED');
  assert.deepEqual(await events(), ['outage','recovery']);
  const refreshed = await call(`/dns/${dns.id}`, { version: 1, enabled: true });
  assert.equal(refreshed.version, 2);
  assert.equal((await state()).health, 'unknown');
  // Disable while a probe is in flight: its result is discarded when persistence rechecks the version.
  probe.check = async (target) => {
    if (target.type === 'dns') await call(`/dns/${dns.id}`, { version: 2, enabled: false });
    return target.type === 'dns' ? probeFailure('dns_error','DNS_LOOKUP_FAILED') : outcome;
  };
  await run();
  assert.equal((await state()).enabled, false);
  assert.equal((await state()).lastCheck, null);
  // Notification failure must roll back the transition, state and its check result together.
  await call(`/dns/${dns.id}`, { version: 3, enabled: true });
  probe.check = async (target) => target.type === 'dns' ? probeFailure('dns_error','DNS_LOOKUP_FAILED') : outcome;
  await run();
  await db.query(`CREATE FUNCTION lcit.reject_network_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
    CREATE TRIGGER reject_network BEFORE INSERT ON lcit.notifications FOR EACH ROW EXECUTE FUNCTION lcit.reject_network_notification()`);
  const failed = await run();
  assert.equal(failed.status, 'failed');
  assert.equal((await state()).consecutiveFailures, 1);
  assert.equal((await state()).health, 'unknown');
  await db.query('DROP TRIGGER reject_network ON lcit.notifications');
  await run();
  assert.equal((await state()).health, 'down');
  assert.deepEqual(await events(), ['outage','recovery','outage']);
  const history = await call(`/dns/${dns.id}/checks?pageSize=2`);
  assert.equal(history.items.length, 2);
  assert.ok(history.total > 2);
  await db.query('UPDATE lcit.domains SET archived_at=now() WHERE id=$1', [domain.id]);
  assert.equal((await call('')).total, 0);
  await call(`/dns/${dns.id}/checks`, undefined, 404);
});
