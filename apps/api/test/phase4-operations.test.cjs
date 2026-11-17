const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes, createHash } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { createServer } = require('node:net');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const { backup, restore } = require('../scripts/recovery.cjs');
const root = path.resolve(__dirname, '..');

test('T4.4: HTTP logs correlate requests without bodies, headers, query strings or unmatched URLs', () => {
  const { httpLogging } = require('../dist/shared/http-logging');
  const lines = [], response = new EventEmitter();
  response.setHeader = (key, value) => { response[key] = value; };
  response.statusCode = 401;
  response.writableFinished = true;
  const request = { method: 'POST', url: '/login?password=private-query', headers: { authorization: 'Bearer private-token' },
    body: { password: 'private-password' }, requestId: 'untrusted-value', route: { path: '/api/v1/auth/login' } };
  let called = false;
  httpLogging((line) => lines.push(line))(request, response, () => { called = true; });
  response.emit('finish'); response.emit('close');
  assert.ok(called); assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.requestId, response['X-Request-Id']);
  assert.notEqual(event.requestId, 'untrusted-value');
  assert.equal(event.route, '/api/v1/auth/login');
  assert.equal(event.status, 401);
  assert.doesNotMatch(lines[0], /private-|untrusted-value/);
});

async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function stop(child) {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
}
function cli(file, env) {
  const result = spawnSync(process.execPath, [`dist/${file}.js`], { cwd: root, env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, `${file} failed`);
  return result.stdout;
}
async function api(url, store, children) {
  const listenPort = await port(), logs = [];
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, DATABASE_URL: url, API_HOST: '127.0.0.1', API_PORT: String(listenPort),
      ATTACHMENTS_DIR: store, MONITORING_ENABLED: 'off', ATTACHMENT_CLEANUP: 'off', API_DOCS_ENABLED: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const base = `http://127.0.0.1:${listenPort}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, 'Test API must become ready.');
  return { child, logs, base, listenPort };
}
function tlsGet(url, ca) {
  return new Promise((resolve, reject) => {
    https.get(url, { ca, rejectUnauthorized: true }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    }).once('error', reject);
  });
}

test('T4.4: paired backup → empty database restore → revoke old sessions → download identical attachment', { timeout: 180000 }, async (context) => {
  const sourceUrl = process.env.LCIT_TEST_DATABASE_URL, targetUrl = process.env.LCIT_TEST_RESTORE_DATABASE_URL;
  assert.ok(sourceUrl && targetUrl && process.env.LCIT_PG_BIN,
    'Set LCIT_TEST_DATABASE_URL, LCIT_TEST_RESTORE_DATABASE_URL to two empty disposable DBs, and LCIT_PG_BIN.');
  const directory = await mkdtemp(path.join(tmpdir(), 'lcit-t44-'));
  const source = new Pool({ connectionString: sourceUrl, connectionTimeoutMillis: 5000 });
  const target = new Pool({ connectionString: targetUrl, connectionTimeoutMillis: 5000 });
  const children = [], envNames = ['LCIT_BACKUP_DATABASE_URL','LCIT_BACKUP_ATTACHMENTS_DIR','LCIT_BACKUP_MAINTENANCE',
    'LCIT_RESTORE_DATABASE_URL','LCIT_RESTORE_ATTACHMENTS_DIR'];
  const before = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  let ownsSource = false, ownsTarget = false;
  context.after(async () => {
    for (const child of children.reverse()) await stop(child);
    try {
      if (ownsSource) await source.query('DROP SCHEMA IF EXISTS lcit CASCADE');
      if (ownsTarget) await target.query('DROP SCHEMA IF EXISTS lcit CASCADE');
    } finally {
      await source.end(); await target.end();
      await rm(directory, { recursive: true, force: true });
      for (const name of envNames) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
    }
  });
  for (const db of [source, target]) assert.equal((await db.query("SELECT to_regnamespace('lcit') AS schema")).rows[0].schema, null, 'Use empty disposable DBs.');
  ownsSource = true;
  cli('migrate', { DATABASE_URL: sourceUrl }); cli('seed', { DATABASE_URL: sourceUrl });
  const password = randomBytes(24).toString('hex');
  cli('bootstrap-admin', { DATABASE_URL: sourceUrl, LCIT_ADMIN_USERNAME: 'ops-admin', LCIT_ADMIN_PASSWORD: password });
  const store = path.join(directory, 'source-files'), sourceApi = await api(sourceUrl, store, children);
  const call = async (base, route, token, method = 'GET', body, expected = 200, binary = false) => {
    const response = await fetch(`${base}${route}`, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}) },
      body: body ? Buffer.isBuffer(body) ? body : JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const value = binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    assert.equal(response.status, expected, `${method} ${route}`);
    assert.match(response.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
    if (expected >= 400 && !binary && value.requestId) assert.equal(value.requestId, response.headers.get('x-request-id'));
    return value;
  };
  const login = async (base) => (await call(base, '/api/v1/auth/login', null, 'POST', { username: 'ops-admin', password })).token;
  const token = await login(sourceApi.base);
  const application = (await call(sourceApi.base, '/api/v1/applications', token)).items[0];
  const pdf = Buffer.from('%PDF-1.4\nT4.4 restore fixture\n%%EOF');
  const attachment = await call(sourceApi.base, `/api/v1/attachments?applicationId=${application.id}&fileName=recovery.pdf`, token, 'POST', pdf, 201);
  const secret = randomBytes(16).toString('hex');
  await call(sourceApi.base, `/health/live?token=${secret}`);
  await stop(sourceApi.child); // Freeze files and all server-side writers before the snapshot.
  const logs = sourceApi.logs.join('');
  for (const hidden of [token, password, secret, pdf.toString()]) assert.ok(!logs.includes(hidden));
  assert.ok(logs.includes('"event":"http.request"'));
  Object.assign(process.env, { LCIT_BACKUP_DATABASE_URL: sourceUrl, LCIT_BACKUP_ATTACHMENTS_DIR: store,
    LCIT_RESTORE_DATABASE_URL: targetUrl, LCIT_RESTORE_ATTACHMENTS_DIR: path.join(directory, 'restored-files') });
  await assert.rejects(backup(path.join(directory, 'no-maintenance')), /Stop all/);
  process.env.LCIT_BACKUP_MAINTENANCE = 'on';
  const bundle = path.join(directory, 'backup'), result = await backup(bundle);
  assert.equal(result.attachments, 1);
  const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
  const file = manifest.files[0], backedFile = path.join(bundle, 'attachments', file.key.slice(0, 2), file.key);
  const dumpFile = path.join(bundle, 'database.dump'), originalDump = await readFile(dumpFile);
  await writeFile(dumpFile, 'damaged dump');
  await assert.rejects(restore(bundle), /verification failed/);
  await writeFile(dumpFile, originalDump);
  await writeFile(backedFile, 'damaged');
  await assert.rejects(restore(bundle), /verification failed/);
  assert.equal((await target.query("SELECT to_regnamespace('lcit') AS schema")).rows[0].schema, null);
  await writeFile(backedFile, pdf);
  process.env.LCIT_RESTORE_DATABASE_URL = sourceUrl;
  await assert.rejects(restore(bundle), /empty, separate database/);
  process.env.LCIT_RESTORE_DATABASE_URL = targetUrl;
  ownsTarget = true;
  const restored = await restore(bundle);
  assert.equal(restored.attachments, 1); assert.equal(restored.sessionsRevoked, true);
  assert.match(cli('migrate', { DATABASE_URL: targetUrl }), /up to date/);
  const targetApi = await api(targetUrl, process.env.LCIT_RESTORE_ATTACHMENTS_DIR, children);
  await call(targetApi.base, '/api/v1/me', token, 'GET', undefined, 401);
  const freshToken = await login(targetApi.base);
  const downloaded = await call(targetApi.base, `/api/v1/attachments/${attachment.id}/download`, freshToken, 'GET', undefined, 200, true);
  assert.deepEqual(downloaded, pdf);
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), file.sha256);
  assert.equal((await call(targetApi.base, '/api/v1/applications', freshToken)).total, 2);
  const docs = await fetch(`${targetApi.base}/docs`); assert.equal(docs.status, 404);
  let tls = 'not_requested';
  if (process.env.LCIT_TEST_CADDY_BIN) {
    const tlsPort = await port(), site = `https://localhost:${tlsPort}`;
    const proxy = spawn(process.env.LCIT_TEST_CADDY_BIN, ['run','--adapter','caddyfile','--config',path.resolve(root, '../../deploy/pilot/Caddyfile')], {
      windowsHide: true, stdio: 'ignore', env: { ...process.env, LCIT_API_SITE: site, LCIT_API_PORT: String(targetApi.listenPort),
        LCIT_TLS_CERT: process.env.LCIT_TEST_TLS_CERT, LCIT_TLS_KEY: process.env.LCIT_TEST_TLS_KEY } });
    children.push(proxy);
    const ca = await readFile(process.env.LCIT_TEST_TLS_CA);
    let health;
    for (let i = 0; i < 50; i++) {
      try { health = await tlsGet(`${site}/health/ready`, ca); break; } catch {}
      await delay(100);
    }
    assert.equal(health?.status, 200, 'HTTPS must verify the supplied CA and reach restored API.');
    assert.equal(health.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal((await tlsGet(`${site}/docs`, ca)).status, 404);
    await assert.rejects(tlsGet(`${site}/health/live`, undefined)); // no global trust-store change
    tls = 'verified_ca_https_proxy';
  }
  context.diagnostic(JSON.stringify({ sourcePostgres: manifest.postgres, tables: restored.tables, migrations: manifest.migrations.length,
    attachments: restored.attachments, attachmentSha256: file.sha256, sessionsRevoked: restored.sessionsRevoked,
    corruptionRejected: true, occupiedDatabaseRejected: true, downloadedViaRestoredApi: true, tls }));
});
