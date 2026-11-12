const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const { once } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const { hashPassword, verifyPassword } = require('../dist/models/password');
const { dateOnly, dnsOwner, domainName, host, port } = require('../dist/models/network-input');

test('password hashes are salted and only verify the original password', async () => {
  const password = randomBytes(24).toString('hex');
  const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('incorrect', first), false);
  assert.equal(await verifyPassword(password), false);
});

test('network fields normalize DNS and IPv6 and reject URLs, bad ports and impossible dates', () => {
  assert.equal(domainName('BÜCHER.Example.'), 'xn--bcher-kva.example');
  assert.equal(host('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(dnsOwner('_sip._tcp', 'example.test'), '_sip._tcp.example.test');
  assert.equal(dnsOwner('@', 'example.test'), 'example.test');
  assert.equal(dateOnly('2028-02-29', 'renewalDate'), '2028-02-29');
  assert.throws(() => dnsOwner('other.test.', 'example.test'));
  assert.throws(() => host('https://host.example'));
  assert.throws(() => host('host.example:443'));
  assert.throws(() => port(65_536));
  assert.throws(() => dateOnly('2026-02-29', 'renewalDate'));
});

const databaseUrl = process.env.LCIT_TEST_DATABASE_URL;
test('phase 1 migration, catalog permissions, sessions and audit', {
  skip: databaseUrl ? false : 'Set LCIT_TEST_DATABASE_URL to an empty disposable PostgreSQL database.',
  timeout: 120_000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const db = new Pool({ connectionString: databaseUrl, enableChannelBinding: true, connectionTimeoutMillis: 5000 });
  context.after(() => db.end());
  const existing = await db.query("SELECT to_regnamespace('lcit') AS schema");
  assert.equal(existing.rows[0].schema, null, 'Use a disposable database without an lcit schema.');

  const password = randomBytes(24).toString('hex');
  const env = { ...process.env, DATABASE_URL: databaseUrl, LCIT_ADMIN_USERNAME: 'test-admin', LCIT_ADMIN_PASSWORD: password };
  function run(script) {
    const result = spawnSync(process.execPath, [`dist/${script}.js`], { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, `${script} failed: ${result.stderr || result.error?.code || 'no output'}`);
    return result.stdout;
  }
  assert.match(run('migrate'), /002_accounts_catalog\.sql/);
  const migrations = await db.query('SELECT name FROM lcit.schema_migrations ORDER BY name');
  assert(migrations.rows.some((row) => row.name === '003_catalog_search.sql'));
  assert.match(run('migrate'), /up to date/);
  run('seed');
  run('seed');
  run('bootstrap-admin');
  assert.match(run('bootstrap-admin'), /already exists/);

  const { rows: addresses } = await db.query('SELECT host(address) AS ip, network_scope FROM lcit.server_addresses ORDER BY network_scope');
  assert.equal(addresses.length, 2);
  assert.equal(addresses[0].ip, addresses[1].ip);
  assert.notEqual(addresses[0].network_scope, addresses[1].network_scope);
  await assert.rejects(db.query('INSERT INTO lcit.app_databases VALUES ($1, $2)', [randomUUID(), randomUUID()]), { code: '23503' });
  await assert.rejects(db.query('INSERT INTO lcit.app_databases SELECT * FROM lcit.app_databases LIMIT 1'), { code: '23505' });

  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: root, env: { ...env, API_HOST: '127.0.0.1', API_PORT: String(port) }, stdio: 'ignore',
  });
  context.after(() => { child.kill(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`${base}/health/live`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {
      if (i === 39 || child.exitCode !== null) assert.fail('Test API did not start.');
    }
    await delay(200);
  }

  async function call(method, route, { token, body, status = 200 } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}/api/v1${route}`, {
      method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    const payload = response.status === 204 ? undefined : await response.json();
    assert.equal(response.status, status, `${method} ${route} returned ${payload?.code ?? response.status}`);
    if (status >= 400) assert.equal(payload.requestId, response.headers.get('x-request-id'));
    return payload;
  }
  const login = (username, suppliedPassword = password, status = 200) => call('POST', '/auth/login', {
    body: { username, password: suppliedPassword }, status,
  });
  const admin = (await login('TEST-ADMIN')).token;
  const { items: apps, total } = await call('GET', '/applications', { token: admin });
  assert.equal(total, 2);
  const [appA, appB] = ['APP-A', 'APP-B'].map((code) => apps.find((app) => app.code === code));
  const createUser = (username, role, status = 'active') => call('POST', '/users', {
    token: admin, status: 201, body: { username, displayName: username, role, password, status },
  });
  const leader = await createUser('test-leader', 'leader');
  const specialist = await createUser('test-specialist', 'specialist');
  await createUser('test-locked', 'specialist', 'locked');
  await login('test-locked', password, 401);
  for (let i = 0; i < 5; i += 1) await login('test-unknown', 'incorrect', 401);
  await login('test-unknown', 'incorrect', 429);

  const leaderToken = (await login(leader.username)).token;
  const specialistToken = (await login(specialist.username)).token;
  const leaderGrant = `/users/${leader.id}/assignments/organizations/${appA.organizationId}`;
  const specialistGrant = `/users/${specialist.id}/assignments/applications/${appA.id}`;
  await call('PUT', leaderGrant, { token: admin, status: 204 });
  await call('PUT', specialistGrant, { token: admin, status: 204 });
  for (const token of [leaderToken, specialistToken]) {
    assert.deepEqual((await call('GET', '/applications', { token })).items.map((item) => item.id), [appA.id]);
    await call('GET', `/applications/${appB.id}`, { token, status: 404 });
    await call('GET', `/organizations/${appB.organizationId}`, { token, status: 404 });
    await call('GET', '/audit-events', { token, status: 403 });
  }
  const application = await call('GET', `/applications/${appA.id}`, { token: specialistToken });
  assert.equal(application.databaseIds.length, 1);
  const applicationB = await call('GET', `/applications/${appB.id}`, { token: admin });
  const serverA = await call('GET', `/servers/${application.serverIds[0]}`, { token: admin });
  await call('GET', `/servers/${applicationB.serverIds[0]}`, { token: specialistToken, status: 404 });
  const ipSearch = await call('GET', '/search?q=10.42.0.15', { token: admin });
  assert.equal(ipSearch.total, 2);
  assert.deepEqual(new Set(ipSearch.items.flatMap((item) => item.servers.flatMap((server) => server.addresses.map((address) => address.networkScope)))), new Set(['LAN-A', 'LAN-B']));
  for (const q of ['10.42.0.15', 'APP-A.EXAMPLE.TEST.', 'PORTAL-A.EXAMPLE.TEST.', 'Cổng Mẫu A', 'Đơn vị Mẫu A']) {
    const found = await call('GET', `/search?q=${encodeURIComponent(q)}`, { token: specialistToken });
    assert.deepEqual(found.items.map((item) => item.id), [appA.id]);
  }
  assert.equal((await call('GET', '/search?q=portal-b.example.test', { token: specialistToken })).total, 0);
  assert.equal((await call('GET', '/search?q=10.42.0.15&page=3&pageSize=1', { token: admin })).total, 2);
  const serverPath = `/servers/${serverA.id}`;
  await call('POST', `${serverPath}/access-endpoints`, { token: admin, status: 400,
    body: { version: serverA.version, protocol: 'ssh', host: 'https://host.example', port: 22 } });
  await call('POST', `${serverPath}/access-endpoints`, { token: admin, status: 400,
    body: { version: serverA.version, protocol: 'ssh', host: 'host.example', port: 65536 } });
  await call('POST', `${serverPath}/addresses`, { token: admin, status: 409,
    body: { version: serverA.version, address: '10.42.0.15', networkScope: 'LAN-A', kind: 'private' } });
  const endpoint = await call('POST', `${serverPath}/access-endpoints`, { token: admin, status: 201,
    body: { version: serverA.version, protocol: 'ssh', host: 'HOST.EXAMPLE.', port: 22 } });
  assert.equal(endpoint.version, serverA.version + 1);
  assert.equal((await call('GET', serverPath, { token: admin })).accessEndpoints[0].host, 'host.example');
  assert.deepEqual((await call('GET', serverPath, { token: specialistToken })).accessEndpoints, []);
  assert.deepEqual((await call('GET', '/search?q=10.42.0.15', { token: specialistToken })).items[0].servers[0].accessMethods, []);

  const domainA = await call('GET', `/domains/${application.domainIds[0]}`, { token: admin });
  const domainPath = `/domains/${domainA.id}`;
  await call('PUT', `/applications/${appB.id}/domains/${domainA.id}`, { token: admin, body: { version: applicationB.version } });
  const dns = await call('POST', `${domainPath}/dns-records`, { token: admin, status: 201,
    body: { version: domainA.version, host: '@', type: 'A', target: '10.42.0.15' } });
  const renamed = await call('PATCH', domainPath, { token: admin, body: { version: dns.version, name: 'PORTAL-SHARED.EXAMPLE.TEST.' } });
  assert.equal(renamed.name, 'portal-shared.example.test');
  assert.equal((await call('GET', domainPath, { token: admin })).dnsRecords[0].host, renamed.name);
  const scopedDomain = await call('GET', domainPath, { token: specialistToken });
  assert.deepEqual(scopedDomain.applicationIds, [appA.id]);
  assert.deepEqual(scopedDomain.dnsRecords, []);
  assert.equal((await call('GET', `/search?q=${renamed.name}`, { token: admin })).total, 2);

  await call('PATCH', `/applications/${appA.id}`, { token: specialistToken, status: 403, body: { version: appA.version, serviceType: 'ordered' } });
  const edited = await call('PATCH', `/applications/${appA.id}`, { token: specialistToken, body: { version: appA.version, description: 'Updated' } });
  await call('PATCH', `/applications/${appA.id}`, { token: admin, status: 409, body: { version: appA.version, description: 'Stale' } });
  await call('DELETE', specialistGrant, { token: admin, status: 204 });
  await call('GET', `/applications/${appA.id}`, { token: specialistToken, status: 404 });
  await call('GET', `/databases/${application.databaseIds[0]}`, { token: specialistToken, status: 404 });

  const link = `/applications/${appA.id}/databases/${application.databaseIds[0]}`;
  const unlinked = await call('DELETE', link, { token: admin, body: { version: edited.version } });
  await call('PUT', link, { token: admin, body: { version: unlinked.version } });
  const unit = await call('POST', '/organizations', { token: admin, status: 201, body: { code: 'TEST-UNIT', name: 'Unit' } });
  await call('POST', '/organizations', { token: admin, status: 409, body: { code: unit.code, name: 'Duplicate' } });
  await call('POST', `/organizations/${unit.id}/archive`, { token: admin, body: { version: unit.version } });
  await call('GET', `/organizations/${unit.id}`, { token: admin, status: 404 });

  await db.query("UPDATE lcit.sessions SET expires_at = now() WHERE user_id = $1", [leader.id]);
  await call('GET', '/me', { token: leaderToken, status: 401 });
  await call('POST', '/auth/logout', { token: specialistToken, status: 204 });
  await call('GET', '/me', { token: specialistToken, status: 401 });
  const { items: events } = await call('GET', '/audit-events?pageSize=100', { token: admin });
  assert(events.some((event) => event.action === 'applications.assignment.revoke' && event.relatedId === appA.id));
  assert(events.some((event) => event.action === 'catalog.update' && event.actorId === specialist.id && event.targetId === appA.id));
  assert(events.some((event) => event.action === 'catalog.access-endpoints.create' && event.targetId === endpoint.id && event.relatedId === serverA.id));
  assert(events.some((event) => event.action === 'auth.login' && event.outcome === 'failure'));
  assert(!JSON.stringify(events).includes(password));
});
