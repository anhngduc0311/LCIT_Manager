const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { mkdtemp, readdir, rm, stat, utimes, writeFile, mkdir } = require('node:fs/promises');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '..');
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(8192)]);

async function withStore(context, env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lcit-attachments-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  Object.assign(process.env, { ATTACHMENTS_DIR: dir, ...env });
  delete require.cache[require.resolve('../dist/models/file-store')];
  const { FileStore } = require('../dist/models/file-store');
  return { dir, store: new FileStore() };
}

test('file names are validated and Content-Disposition keeps the UTF-8 name', () => {
  const { contentDisposition, fileNameOf } = require('../dist/models/attachments.service');
  assert.equal(fileNameOf('Hồ sơ thiết kế.PDF').type.mediaType, 'application/pdf');
  for (const bad of ['..\\secret.pdf', 'a/b.pdf', 'report.exe', 'noextension', 'name.pdf.', 'x:y.pdf', 'tab\t.pdf']) {
    assert.throws(() => fileNameOf(bad), undefined, bad);
  }
  const header = contentDisposition('Hồ sơ "Đồng ý" (v2).pdf');
  assert.match(header, /^attachment; filename="Ho so _Dong y_ \(v2\)\.pdf"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(header.split("UTF-8''")[1]), 'Hồ sơ "Đồng ý" (v2).pdf');
  assert.doesNotMatch(header.split("UTF-8''")[1], /['()*]/);
});

test('file signatures must match the extension', () => {
  const { attachmentTypes } = require('../dist/models/file-store');
  assert.equal(attachmentTypes.pdf.signature(pdf), true);
  assert.equal(attachmentTypes.pdf.signature(Buffer.from('MZ\x90\x00')), false);
  assert.equal(attachmentTypes.xlsx.signature(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0])), true);
  assert.equal(attachmentTypes.png.signature(Buffer.from([0xff, 0xd8, 0xff])), false);
  assert.equal(attachmentTypes.txt.signature(Buffer.from('xin chào')), true);
  assert.equal(attachmentTypes.txt.signature(Buffer.from([0x61, 0x00, 0x62])), false);
});

test('the file store writes atomically, enforces the size limit and leaves no partial file', async (context) => {
  const { dir, store } = await withStore(context);
  const key = store.newKey();
  const written = await store.write(key, Readable.from([pdf.subarray(0, 100), pdf.subarray(100)]), pdf.length);
  assert.equal(written.size, pdf.length);
  assert.equal(written.head.subarray(0, 5).toString(), '%PDF-');
  const { stream, size } = await store.open(key);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(size, pdf.length);
  assert.deepEqual(Buffer.concat(chunks), pdf);

  const big = store.newKey();
  const { FileTooLargeError } = require('../dist/models/file-store');
  await assert.rejects(store.write(big, Readable.from([pdf, pdf]), pdf.length), FileTooLargeError);
  assert.deepEqual(await readdir(path.join(dir, big.slice(0, 2))).catch(() => []), []);
  await assert.rejects(store.open(big));
  await assert.rejects(store.write(key, Readable.from([pdf]), pdf.length), { code: 'EEXIST' });
  await store.remove(key);
  await assert.rejects(store.open(key), { code: 'ENOENT' });
});

const databaseUrl = process.env.LCIT_TEST_DATABASE_URL;
test('phase 2 attachments: permissions, limits, audit and recovery between write steps', {
  skip: databaseUrl ? false : 'Set LCIT_TEST_DATABASE_URL to an empty disposable PostgreSQL database.',
  timeout: 120_000,
}, async (context) => {
  const db = new Pool({ connectionString: databaseUrl, enableChannelBinding: true, connectionTimeoutMillis: 5000 });
  context.after(() => db.end());
  const existing = await db.query("SELECT to_regnamespace('lcit') AS schema");
  assert.equal(existing.rows[0].schema, null, 'Use a disposable database without an lcit schema.');

  const { dir } = await withStore(context);
  const password = randomBytes(24).toString('hex');
  const env = {
    ...process.env, DATABASE_URL: databaseUrl, LCIT_ADMIN_USERNAME: 'test-admin', LCIT_ADMIN_PASSWORD: password,
    ATTACHMENTS_DIR: dir, ATTACHMENT_MAX_BYTES: '4096', ATTACHMENT_CLEANUP: 'off',
  };
  function run(script) {
    const result = spawnSync(process.execPath, [`dist/${script}.js`], { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, `${script} failed: ${result.stderr || result.error?.code || 'no output'}`);
    return result.stdout;
  }
  assert.match(run('migrate'), /004_attachments\.sql/);
  run('seed');
  run('bootstrap-admin');

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

  async function call(method, route, { token, body, raw, status = 200 } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/json';
    if (raw) headers['content-type'] = 'application/octet-stream';
    const response = await fetch(`${base}/api/v1${route}`, {
      method, headers, body: raw ?? (body && JSON.stringify(body)), signal: AbortSignal.timeout(8000),
    });
    const isJson = response.headers.get('content-type')?.startsWith('application/json');
    const payload = response.status === 204 ? undefined : isJson ? await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, status, `${method} ${route} returned ${payload?.code ?? response.status}`);
    if (status >= 400) assert.equal(payload.requestId, response.headers.get('x-request-id'));
    return { payload, response };
  }
  const json = async (...args) => (await call(...args)).payload;
  const login = async (username) => (await json('POST', '/auth/login', { body: { username, password } })).token;
  const admin = await login('test-admin');
  const { items: apps } = await json('GET', '/applications', { token: admin });
  const [appA, appB] = ['APP-A', 'APP-B'].map((code) => apps.find((app) => app.code === code));
  const createUser = (username, role) => json('POST', '/users', {
    token: admin, status: 201, body: { username, displayName: username, role, password },
  });
  const leader = await createUser('test-leader', 'leader');
  const specialist = await createUser('test-specialist', 'specialist');
  await call('PUT', `/users/${leader.id}/assignments/organizations/${appA.organizationId}`, { token: admin, status: 204 });
  await call('PUT', `/users/${specialist.id}/assignments/applications/${appA.id}`, { token: admin, status: 204 });
  const leaderToken = await login(leader.username);
  const specialistToken = await login(specialist.username);
  const upload = (token, appId, fileName, raw, status = 201) => json('POST',
    `/attachments?applicationId=${appId}&fileName=${encodeURIComponent(fileName)}`, { token, raw, status });

  // Valid upload by an assigned specialist; leaders cannot upload; other applications are hidden.
  const file = await upload(specialistToken, appA.id, 'Hồ sơ A.pdf', pdf.subarray(0, 3000));
  assert.equal(file.sizeBytes, 3000);
  assert.equal(file.mediaType, 'application/pdf');
  await upload(leaderToken, appA.id, 'leader.pdf', pdf.subarray(0, 100), 403);
  await upload(specialistToken, appB.id, 'other.pdf', pdf.subarray(0, 100), 404);

  // Oversized, wrong type, mismatched content and empty files are rejected without leftovers.
  await upload(admin, appA.id, 'big.pdf', pdf.subarray(0, 4097), 413);
  const streamed = new ReadableStream({ start(controller) { for (let i = 0; i < 3; i += 1) controller.enqueue(pdf.subarray(0, 2000)); controller.close(); } });
  const chunked = await fetch(`${base}/api/v1/attachments?applicationId=${appA.id}&fileName=big2.pdf`, {
    method: 'POST', duplex: 'half', body: streamed, signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/octet-stream' },
  }).catch((error) => ({ status: error.cause?.code ?? 'aborted' }));
  assert(chunked.status === 413 || typeof chunked.status === 'string', `chunked upload returned ${chunked.status}`);
  await upload(admin, appA.id, 'tool.exe', pdf.subarray(0, 100), 415);
  await upload(admin, appA.id, 'fake.pdf', Buffer.from('MZ not a pdf'), 415);
  await upload(admin, appA.id, 'empty.txt', Buffer.alloc(0), 400);
  const { rows: [{ count: pendingAfterRejects }] } = await db.query("SELECT count(*)::int AS count FROM lcit.attachments WHERE status = 'pending'");
  assert.equal(pendingAfterRejects, 0);

  // Listing follows application scope; downloading needs the explicit grant.
  const listed = await json('GET', `/attachments?applicationId=${appA.id}`, { token: leaderToken });
  assert.deepEqual(listed.items.map((item) => item.id), [file.id]);
  assert.equal(listed.canDownload, false);
  assert.equal(listed.canUpload, false);
  await json('GET', `/attachments?applicationId=${appB.id}`, { token: specialistToken, status: 404 });
  await call('GET', `/attachments/${file.id}/download`, { token: leaderToken, status: 403 });
  await call('PUT', `/users/${leader.id}/permissions/attachments.download`, { token: admin, status: 204 });
  await call('PUT', `/users/${leader.id}/permissions/not-a-permission`, { token: admin, status: 400 });
  await call('PUT', `/users/${leader.id}/permissions/attachments.download`, { token: leaderToken, status: 403 });
  assert.deepEqual((await json('GET', `/users/${leader.id}/permissions`, { token: admin })).items.map((item) => item.permission), ['attachments.download']);
  const { payload: content, response } = await call('GET', `/attachments/${file.id}/download`, { token: leaderToken });
  assert.deepEqual(content, pdf.subarray(0, 3000));
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''H%E1%BB%93%20s%C6%A1%20A\.pdf/);
  await call('GET', `/attachments/${file.id}/download`, { token: admin });
  await call('GET', `/attachments/${randomUUID()}/download`, { token: admin, status: 404 });

  // Revoking the assignment or the grant applies to the next request.
  await call('DELETE', `/users/${leader.id}/permissions/attachments.download`, { token: admin, status: 204 });
  await call('GET', `/attachments/${file.id}/download`, { token: leaderToken, status: 403 });
  await call('DELETE', `/users/${specialist.id}/assignments/applications/${appA.id}`, { token: admin, status: 204 });
  await call('GET', `/attachments/${file.id}/download`, { token: specialistToken, status: 404 });
  await call('POST', `/attachments/${file.id}/archive`, { token: specialistToken, status: 404 });

  // A file missing from the store is reported, not served.
  const second = await upload(admin, appA.id, 'notes.txt', Buffer.from('ghi chú'));
  const { rows: [{ storage_key: secondKey }] } = await db.query('SELECT storage_key FROM lcit.attachments WHERE id = $1', [second.id]);
  await rm(path.join(dir, secondKey.slice(0, 2), secondKey));
  await call('GET', `/attachments/${second.id}/download`, { token: admin, status: 503 });
  await call('POST', `/attachments/${second.id}/archive`, { token: admin, status: 204 });
  await call('GET', `/attachments/${second.id}/download`, { token: admin, status: 404 });

  // Failure between the two writes: a pending row with or without content, and a file without a row.
  const stalePending = randomBytes(32).toString('hex');
  const freshPending = randomBytes(32).toString('hex');
  const orphan = randomBytes(32).toString('hex');
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (const key of [stalePending, freshPending, orphan]) {
    await mkdir(path.join(dir, key.slice(0, 2)), { recursive: true });
    await writeFile(path.join(dir, key.slice(0, 2), key === orphan ? key : `${key}.part`), pdf.subarray(0, 50));
    if (key !== freshPending) await utimes(path.join(dir, key.slice(0, 2), key === orphan ? key : `${key}.part`), old, old);
  }
  await db.query(`INSERT INTO lcit.attachments (application_id, storage_key, file_name, media_type, uploaded_by, created_at)
    VALUES ($1, $2, 'stale.pdf', 'application/pdf', $3, now() - interval '2 hours'),
           ($1, $4, 'fresh.pdf', 'application/pdf', $3, now())`, [appA.id, stalePending, specialist.id, freshPending]);
  await call('GET', `/attachments?applicationId=${appA.id}`, { token: admin }).then(({ payload }) => {
    assert(!payload.items.some((item) => ['stale.pdf', 'fresh.pdf'].includes(item.fileName)), 'pending files are not listed');
  });
  assert.match(run('attachments-cleanup'), /Removed 1 expired pending attachment\(s\) and 1 orphan file\(s\)/);
  const { rows: remaining } = await db.query("SELECT storage_key FROM lcit.attachments WHERE status = 'pending'");
  assert.deepEqual(remaining.map((row) => row.storage_key), [freshPending]);
  await assert.rejects(stat(path.join(dir, stalePending.slice(0, 2), `${stalePending}.part`)), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(dir, orphan.slice(0, 2), orphan)), { code: 'ENOENT' });
  await stat(path.join(dir, freshPending.slice(0, 2), `${freshPending}.part`));
  const { rows: [{ storage_key: keptKey }] } = await db.query('SELECT storage_key FROM lcit.attachments WHERE id = $1', [file.id]);
  await stat(path.join(dir, keptKey.slice(0, 2), keptKey));

  const { items: events } = await json('GET', '/audit-events?pageSize=100', { token: admin });
  const has = (action, outcome, actorId) => events.some((event) => event.action === action && event.outcome === outcome
    && (!actorId || event.actorId === actorId));
  assert(has('attachment.upload', 'success', specialist.id));
  assert(has('attachment.download', 'success', leader.id));
  assert(has('attachment.download', 'denied', leader.id));
  assert(has('attachment.archive', 'success', undefined));
  assert(has('users.permission.grant.attachments.download', 'success', undefined));
  assert(has('users.permission.revoke.attachments.download', 'success', undefined));
});
