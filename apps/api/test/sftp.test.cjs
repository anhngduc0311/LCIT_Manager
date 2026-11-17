require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { Server, utils } = require('ssh2');
const { SftpService, SFTP_MAX_BYTES, remotePath } = require('../dist/models/sftp.service');
const { ApiError } = require('../dist/shared/api-contract');

const { STATUS_CODE: STATUS, OPEN_MODE: FLAGS } = utils.sftp;
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const matches = (code) => (error) => error instanceof ApiError && error.getResponse().code === code;

async function fixture(t, options = {}) {
  const files = new Map([['/home/deploy/hello.txt', Buffer.from('Xin chào LCIT\n')], ['/home/deploy/empty.txt', Buffer.alloc(0)]]);
  const sockets = new Set(); let passwords = 0, opens = 0; const answers = [];
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    sockets.add(connection); connection.on('error', () => {}); connection.on('close', () => sockets.delete(connection));
    connection.on('authentication', (ctx) => {
      if (ctx.method === 'password') passwords++;
      if (options.keyboard) {
        if (ctx.method !== 'keyboard-interactive') { ctx.reject(['publickey', 'keyboard-interactive']); return; }
        ctx.prompt([{ prompt: options.prompt ?? 'Password: ', echo: Boolean(options.echo) }], (values) => {
          answers.push(values);
          if (ctx.username === 'deploy' && values[0] === 'test-secret') ctx.accept();
          else ctx.reject(['publickey', 'keyboard-interactive']);
        });
        return;
      }
      if (ctx.method === 'password' && ctx.username === 'deploy' && ctx.password === 'test-secret') ctx.accept();
      else ctx.reject(['password']);
    });
    connection.on('ready', () => connection.on('session', (accept) => {
      accept().on('sftp', (acceptSftp, rejectSftp) => {
        if (options.rejectSftp) { rejectSftp(); return; }
        const sftp = acceptSftp(); const handles = new Map(); let next = 0;
        const handle = (entry) => { const id = Buffer.from(String(++next)); handles.set(id.toString(), entry); return id; };
        const attrs = (path) => ({ mode: path === '/home/deploy' ? 0o40755 : 0o100644, uid: 1000, gid: 1000, size: files.get(path)?.length ?? 0, atime: 1700000000, mtime: 1700000000 });
        sftp.on('REALPATH', (id) => sftp.name(id, [{ filename: '/home/deploy', longname: '/home/deploy', attrs: attrs('/home/deploy') }]));
        sftp.on('STAT', (id, path) => files.has(path) || path === '/home/deploy' ? sftp.attrs(id, attrs(path)) : sftp.status(id, STATUS.NO_SUCH_FILE));
        sftp.on('LSTAT', (id, path) => files.has(path) || path === '/home/deploy' ? sftp.attrs(id, attrs(path)) : sftp.status(id, STATUS.NO_SUCH_FILE));
        sftp.on('OPENDIR', (id, path) => path === '/home/deploy' ? sftp.handle(id, handle({ directory: true, sent: false })) : sftp.status(id, STATUS.NO_SUCH_FILE));
        sftp.on('READDIR', (id, key) => {
          const entry = handles.get(key.toString());
          if (entry.sent) return sftp.status(id, STATUS.EOF);
          entry.sent = true;
          sftp.name(id, [...files.keys()].map((path) => ({ filename: path.split('/').pop(), longname: path.split('/').pop(), attrs: attrs(path) })));
        });
        sftp.on('OPEN', (id, path, flags) => {
          opens++;
          if ((flags & FLAGS.EXCL) && files.has(path)) return sftp.status(id, STATUS.FAILURE);
          if ((flags & FLAGS.CREAT) && !files.has(path)) files.set(path, Buffer.alloc(0));
          if (!files.has(path)) return sftp.status(id, STATUS.NO_SUCH_FILE);
          sftp.handle(id, handle({ path }));
        });
        sftp.on('FSTAT', (id, key) => sftp.attrs(id, attrs(handles.get(key.toString()).path)));
        sftp.on('READ', (id, key, offset, length) => {
          const bytes = files.get(handles.get(key.toString()).path);
          if (offset >= bytes.length) return sftp.status(id, STATUS.EOF);
          sftp.data(id, bytes.subarray(offset, offset + length));
        });
        sftp.on('WRITE', (id, key, offset, data) => {
          const path = handles.get(key.toString()).path, old = files.get(path);
          const bytes = Buffer.alloc(Math.max(old.length, offset + data.length)); old.copy(bytes); data.copy(bytes, offset); files.set(path, bytes);
          sftp.status(id, STATUS.OK);
        });
        sftp.on('CLOSE', (id, key) => { handles.delete(key.toString()); sftp.status(id, STATUS.OK); });
      });
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = randomUUID();
  let permitted = true;
  const destination = { endpointId: endpoint, protocol: 'ssh', host: '127.0.0.1', port: server.address().port };
  const access = { async launch(request, id, body) {
    assert.equal(id, endpoint); assert.deepEqual(body, {});
    if (!permitted) throw new ApiError(403, 'CONNECTION_GRANT_REQUIRED', 'Revoked.');
    return { ...destination };
  } };
  const service = new SftpService(access);
  t.after(async () => { await service.onModuleDestroy(); for (const socket of sockets) socket.end(); await new Promise((resolve) => server.close(resolve)); });
  const request = { actor: { id: randomUUID() }, sessionHash: 'session-one' };
  const credentials = { username: 'deploy', password: 'test-secret' };
  async function open() {
    const challenge = await service.open(request, endpoint, { username: 'deploy', password: '' });
    assert.equal(challenge.requiresVerification, true);
    const session = await service.open(request, endpoint, { ...credentials, fingerprint: challenge.fingerprint });
    assert.equal(session.requiresVerification, false);
    return session;
  }
  return { service, request, endpoint, credentials, open, files, destination, answers, revoke: () => { permitted = false; }, passwords: () => passwords, opens: () => opens };
}

test('SFTP: host-key challenge authenticates only after explicit pin, rejects a different pin and bad credentials', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const challenge = await f.service.open(f.request, f.endpoint, { username: 'deploy', password: '' });
  assert.equal(challenge.requiresVerification, true); assert.match(challenge.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(f.passwords(), 0);
  await assert.rejects(f.service.open(f.request, f.endpoint, { ...f.credentials, fingerprint: `SHA256:${'A'.repeat(43)}` }), matches('SFTP_HOST_KEY_CHANGED'));
  assert.equal(f.passwords(), 0);
  await assert.rejects(f.service.open(f.request, f.endpoint, { ...f.credentials, password: 'wrong', fingerprint: challenge.fingerprint }), matches('SFTP_AUTH_FAILED'));
  const session = await f.open(); assert.equal(session.path, '/home/deploy'); await f.service.close(f.request, session.id);
});

test('SFTP: keyboard-interactive password authentication works when plain password is disabled', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { keyboard: true }); const session = await f.open();
  assert.deepEqual(f.answers, [['test-secret']]);
  assert.equal((await f.service.list(f.request, session.id, '/home/deploy')).items.length, 2);
  await f.service.close(f.request, session.id);
});

test('SFTP: password is not reused for OTP prompts or prompts that display typed answers', { timeout: 20000 }, async (t) => {
  for (const options of [{ keyboard: true, prompt: 'Verification code: ' }, { keyboard: true, prompt: 'One-time password: ' }, { keyboard: true, prompt: 'Password: ', echo: true }]) {
    const f = await fixture(t, options);
    const challenge = await f.service.open(f.request, f.endpoint, { username: 'deploy', password: '' });
    await assert.rejects(f.service.open(f.request, f.endpoint, { ...f.credentials, fingerprint: challenge.fingerprint }), matches('SFTP_INTERACTIVE_REQUIRED'));
    assert.deepEqual(f.answers, [['']]);
  }
});

test('SFTP: disabled subsystem has a distinct error after successful SSH authentication', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { rejectSftp: true });
  const challenge = await f.service.open(f.request, f.endpoint, { username: 'deploy', password: '' });
  await assert.rejects(f.service.open(f.request, f.endpoint, { ...f.credentials, fingerprint: challenge.fingerprint }), matches('SFTP_SUBSYSTEM_FAILED'));
});

test('SFTP: list, binary and empty transfers, exclusive upload and explicit disconnect', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); const session = await f.open();
  const listing = await f.service.list(f.request, session.id, '/home/deploy');
  assert.ok(listing.items.some((item) => item.name === 'hello.txt'));
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  await f.service.upload(f.request, session.id, '/home/deploy/dữ liệu.bin', bytes);
  assert.deepEqual((await f.service.download(f.request, session.id, '/home/deploy/dữ liệu.bin')).bytes, bytes);
  await f.service.upload(f.request, session.id, '/home/deploy/new-empty.txt', Buffer.alloc(0));
  assert.equal((await f.service.download(f.request, session.id, '/home/deploy/new-empty.txt')).bytes.length, 0);
  await assert.rejects(f.service.upload(f.request, session.id, '/home/deploy/hello.txt', Buffer.from('overwrite')), matches('SFTP_OPERATION_FAILED'));
  assert.equal(f.files.get('/home/deploy/hello.txt').toString(), 'Xin chào LCIT\n');
  const second = await f.open(); await f.service.close(f.request, second.id);
  await assert.rejects(f.service.list(f.request, second.id, '/home/deploy'), matches('SFTP_SESSION_CLOSED'));
});

test('SFTP: login-session ownership, revocation and endpoint changes block existing sessions', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); const session = await f.open();
  await assert.rejects(f.service.list({ ...f.request, sessionHash: 'different-login' }, session.id, '/home/deploy'), matches('SFTP_SESSION_CLOSED'));
  await assert.rejects(f.service.close({ ...f.request, actor: { id: randomUUID() } }, session.id), matches('SFTP_SESSION_CLOSED'));
  f.destination.port++;
  await assert.rejects(f.service.list(f.request, session.id, '/home/deploy'), matches('CONNECTION_GRANT_REQUIRED'));
  f.destination.port--; const second = await f.open(); f.revoke();
  const before = f.opens();
  await assert.rejects(f.service.download(f.request, second.id, '/home/deploy/hello.txt'), matches('CONNECTION_GRANT_REQUIRED'));
  assert.equal(f.opens(), before);
});

test('SFTP: expiry, invalid paths and file-size caps prevent transfers', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); const session = await f.open();
  assert.equal(remotePath('/home/deploy/../deploy'), '/home/deploy');
  for (const path of ['relative', '/home/\nuser', '']) assert.throws(() => remotePath(path), matches('INVALID_INPUT'));
  assert.throws(() => f.service.upload(f.request, session.id, '/home/deploy/large.bin', Buffer.alloc(SFTP_MAX_BYTES + 1)), matches('FILE_TOO_LARGE'));
  f.files.set('/home/deploy/large.bin', Buffer.alloc(SFTP_MAX_BYTES + 1));
  await assert.rejects(f.service.download(f.request, session.id, '/home/deploy/large.bin'), matches('FILE_TOO_LARGE'));
  const second = await f.open(); f.service.connections.get(second.id).used -= 6 * 60_000;
  await assert.rejects(f.service.list(f.request, second.id, '/home/deploy'), matches('SFTP_SESSION_CLOSED'));
});

test('SFTP HTTP: guarded routes, raw upload, binary download and session cleanup', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { SftpController } = require('../dist/controllers/sftp.controller');
  const { SessionGuard } = require('../dist/guards/session.guard');
  const { AuthService } = require('../dist/models/auth.service');
  const { sha256 } = require('../dist/models/access');
  const { ApiExceptionFilter } = require('../dist/shared/api-contract');
  const ownerToken = 'a'.repeat(43), otherToken = 'b'.repeat(43);
  f.request.sessionHash = sha256(ownerToken);
  class TestModule {}
  Module({ controllers: [SftpController], providers: [
    { provide: SftpService, useValue: f.service },
    SessionGuard,
    { provide: AuthService, useValue: { async findSessionActor(hash) { return [sha256(ownerToken), sha256(otherToken)].includes(hash) ? f.request.actor : undefined; } } },
  ] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false, abortOnError: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
  const owner = { Authorization: `Bearer ${ownerToken}` };
  const openPath = `${base}/access-endpoints/${f.endpoint}/sftp/sessions`;
  assert.equal((await fetch(openPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const open = (body) => fetch(openPath, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const challengeResponse = await open({ username: 'deploy', password: '' }); assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json(); assert.equal(challenge.requiresVerification, true);
  const connected = await open({ ...f.credentials, fingerprint: challenge.fingerprint }); assert.equal(connected.status, 200);
  const session = await connected.json();
  const root = `${base}/sftp/sessions/${session.id}`;
  assert.equal((await fetch(`${root}/files?path=/home/deploy`, { headers: { Authorization: `Bearer ${otherToken}` } })).status, 404);
  const listing = await fetch(`${root}/files?path=/home/deploy`, { headers: owner });
  assert.equal(listing.status, 200); assert.equal((await listing.json()).items.length, 2);
  const path = encodeURIComponent('/home/deploy/kiểm tra.bin'); const bytes = Buffer.from([0, 128, 255, 10]);
  const uploaded = await fetch(`${root}/upload?path=${path}`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.equal(uploaded.status, 201); assert.equal((await uploaded.json()).size, bytes.length);
  const downloaded = await fetch(`${root}/download?path=${path}`, { headers: owner });
  assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const oversized = await fetch(`${root}/upload?path=${encodeURIComponent('/home/deploy/too-large.bin')}`, {
    method: 'POST', headers: { ...owner, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(SFTP_MAX_BYTES + 1),
  });
  assert.equal(oversized.status, 413); assert.equal(f.files.has('/home/deploy/too-large.bin'), false);
  assert.equal((await fetch(root, { method: 'DELETE', headers: owner })).status, 204);
  assert.equal((await fetch(`${root}/files?path=/home/deploy`, { headers: owner })).status, 404);
});
