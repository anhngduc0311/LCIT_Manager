const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:net');
const { once } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Workbook } = require('exceljs');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '..');

async function readBook(buffer) {
  const book = new Workbook();
  await book.xlsx.load(buffer);
  return book;
}

test('report filters are validated', () => {
  const { reportFilter } = require('../dist/models/reports.service');
  assert.deepEqual(reportFilter({}), { organizationId: null, dataCenterId: null, serviceType: null, status: null });
  assert.equal(reportFilter({ serviceType: 'ordered', organizationId: '' }).serviceType, 'ordered');
  assert.throws(() => reportFilter({ serviceType: 'other' }));
  assert.throws(() => reportFilter({ dataCenterId: 'not-a-uuid' }));
});

test('the Excel workbook keeps formula-like text as text', async () => {
  const { inventoryWorkbook } = require('../dist/models/reports.service');
  const buffer = await inventoryWorkbook([{
    code: 'APP-X', name: '=HYPERLINK("http://evil.test","x")', serviceType: 'ordered', status: 'active', owner: '+cmd',
    organization: { name: '@SUM(A1)' }, domains: ['a.example.test', 'b.example.test'],
    servers: [{ hostname: 'srv.example.test', dataCenter: 'DC Mẫu', addresses: ['10.0.0.1 (LAN)'] }],
  }], [{ name: 'DC Mẫu', applications: 1, servers: 1 }], [['Đơn vị', 'Tất cả']], 'Người xuất');
  const book = await readBook(buffer);
  const sheet = book.getWorksheet('Danh mục ứng dụng');
  assert.equal(sheet.getCell('C2').value, '=HYPERLINK("http://evil.test","x")');
  for (const cell of ['C2', 'D2', 'G2']) assert.equal(sheet.getCell(cell).formula, undefined, cell);
  assert.equal(sheet.getCell('J2').value, 'a.example.test\nb.example.test');
  assert.equal(book.getWorksheet('Theo trung tâm dữ liệu').getCell('B2').value, 1);
  const info = book.getWorksheet('Thông tin xuất');
  assert.equal(info.getCell('A4').value, 'Người xuất');
  assert.equal(info.getCell('B4').value, 'Người xuất');
});

const databaseUrl = process.env.LCIT_TEST_DATABASE_URL;
test('phase 3 dashboard, inventory report and Excel export share scope and filters', {
  skip: databaseUrl ? false : 'Set LCIT_TEST_DATABASE_URL to an empty disposable PostgreSQL database.',
  timeout: 120_000,
}, async (context) => {
  const db = new Pool({ connectionString: databaseUrl, enableChannelBinding: true, connectionTimeoutMillis: 5000 });
  context.after(() => db.end());
  const existing = await db.query("SELECT to_regnamespace('lcit') AS schema");
  assert.equal(existing.rows[0].schema, null, 'Use a disposable database without an lcit schema.');
  // Registered only after the check above, so the test never drops a schema it did not create.
  context.after(async () => {
    const cleanup = new Pool({ connectionString: databaseUrl, enableChannelBinding: true, connectionTimeoutMillis: 5000 });
    try { await cleanup.query('DROP SCHEMA IF EXISTS lcit CASCADE'); } finally { await cleanup.end(); }
  });

  const password = randomBytes(24).toString('hex');
  const env = { ...process.env, DATABASE_URL: databaseUrl, LCIT_ADMIN_USERNAME: 'test-admin', LCIT_ADMIN_PASSWORD: password, ATTACHMENT_CLEANUP: 'off' };
  for (const script of ['migrate', 'seed', 'bootstrap-admin']) {
    const result = spawnSync(process.execPath, [`dist/${script}.js`], { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, `${script} failed: ${result.stderr}`);
  }
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: root, env: { ...env, API_HOST: '127.0.0.1', API_PORT: String(port) }, stdio: 'ignore' });
  context.after(() => { child.kill(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`${base}/health/live`, { signal: AbortSignal.timeout(1000) })).ok) break; }
    catch { if (i === 39 || child.exitCode !== null) assert.fail('Test API did not start.'); }
    await delay(200);
  }

  async function call(method, route, { token, body, status = 200 } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}/api/v1${route}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const isJson = response.headers.get('content-type')?.startsWith('application/json');
    const payload = response.status === 204 ? undefined : isJson ? await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, status, `${method} ${route} returned ${payload?.code ?? response.status}`);
    return { payload, response };
  }
  const json = async (...args) => (await call(...args)).payload;
  const login = async (username) => (await json('POST', '/auth/login', { body: { username, password } })).token;
  const admin = await login('test-admin');

  const { items: apps } = await json('GET', '/applications', { token: admin });
  const [appA, appB] = ['APP-A', 'APP-B'].map((code) => apps.find((app) => app.code === code));
  const { items: centers } = await json('GET', '/data-centers', { token: admin });
  const [dcA, dcB] = ['DC-A', 'DC-B'].map((code) => centers.find((center) => center.code === code));
  const appADetail = await json('GET', `/applications/${appA.id}`, { token: admin });

  // APP-A runs on a second server in DC-A: it must still count once for DC-A.
  const extra = await json('POST', '/servers', { token: admin, status: 201, body: { code: 'SRV-A2', hostname: 'app-a2.example.test', dataCenterId: dcA.id } });
  await json('PUT', `/applications/${appA.id}/servers/${extra.id}`, { token: admin, body: { version: appADetail.version } });
  // A user-entered name that looks like a formula.
  const renamed = await json('PATCH', `/applications/${appB.id}`, { token: admin, body: { version: appB.version, name: '=1+1 Cổng B' } });
  // Renewals: a domain due in 10 days and a manual TLS expiry already past.
  const day = (offset) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(Date.now() + offset * 86_400_000));
  const domain = await json('GET', `/domains/${appADetail.domainIds[0]}`, { token: admin });
  const dated = await json('PATCH', `/domains/${domain.id}`, { token: admin, body: { version: domain.version, renewalDate: day(10) } });
  await json('POST', `/domains/${domain.id}/tls-endpoints`, { token: admin, status: 201,
    body: { version: dated.version, host: domain.name, port: 443, manualExpiryDate: day(-3) } });

  const all = await json('GET', '/dashboard', { token: admin });
  assert.deepEqual(all.totals, { applications: 2, servers: 3, domains: 2 });
  const byDc = Object.fromEntries(all.byDataCenter.map((row) => [row.name, row]));
  assert.equal(byDc[dcA.name].applications, 1, 'APP-A counted once in DC-A');
  assert.equal(byDc[dcA.name].servers, 2);
  assert.equal(byDc[dcB.name].applications, 1);
  assert.deepEqual(all.renewals, { overdue: 1, within30: 1, within90: 0 });
  assert.deepEqual(all.upcomingRenewals.map((item) => [item.kind, item.source, item.daysLeft]), [['tls', 'manual', -3], ['domain', null, 10]]);

  const inDcA = await json('GET', `/dashboard?dataCenterId=${dcA.id}`, { token: admin });
  assert.deepEqual(inDcA.totals, { applications: 1, servers: 2, domains: 1 });
  const ordered = await json('GET', '/dashboard?serviceType=ordered', { token: admin });
  assert.equal(ordered.totals.applications, 0);
  await call('GET', '/dashboard?serviceType=bad', { token: admin, status: 400 });

  const report = await json('GET', `/reports/inventory?dataCenterId=${dcA.id}`, { token: admin });
  assert.equal(report.total, 1);
  assert.equal(report.canExport, true);
  assert.deepEqual(report.items[0].servers.map((server) => server.hostname).sort(), ['app-a.example.test', 'app-a2.example.test']);

  // A leader of organization A sees only APP-A and cannot export until granted.
  const leader = await json('POST', '/users', { token: admin, status: 201, body: { username: 'test-leader', displayName: 'Lãnh đạo', role: 'leader', password } });
  await call('PUT', `/users/${leader.id}/assignments/organizations/${appA.organizationId}`, { token: admin, status: 204 });
  const leaderToken = await login('test-leader');
  const scoped = await json('GET', '/dashboard', { token: leaderToken });
  assert.deepEqual(scoped.totals, { applications: 1, servers: 2, domains: 1 });
  assert.deepEqual(scoped.byDataCenter.map((row) => row.name), [dcA.name]);
  const leaderReport = await json('GET', '/reports/inventory', { token: leaderToken });
  assert.deepEqual(leaderReport.items.map((item) => item.id), [appA.id]);
  assert.equal(leaderReport.canExport, false);
  assert.equal((await json('GET', `/reports/inventory?organizationId=${appB.organizationId}`, { token: leaderToken })).total, 0);
  await call('GET', '/reports/inventory.xlsx', { token: leaderToken, status: 403 });
  await call('PUT', `/users/${leader.id}/permissions/reports.export`, { token: admin, status: 204 });
  const { payload: leaderFile, response } = await call('GET', '/reports/inventory.xlsx', { token: leaderToken });
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="Bao-cao-danh-muc-\d{4}-\d{2}-\d{2}\.xlsx"/);
  const leaderSheet = (await readBook(leaderFile)).getWorksheet('Danh mục ứng dụng');
  assert.equal(leaderSheet.rowCount, 2, 'header plus APP-A only');
  assert.equal(leaderSheet.getCell('B2').value, 'APP-A');

  // The admin export uses the same filter and keeps the formula-like name as text.
  const { payload: adminFile } = await call('GET', '/reports/inventory.xlsx?serviceType=operations', { token: admin });
  const adminBook = await readBook(adminFile);
  const sheet = adminBook.getWorksheet('Danh mục ứng dụng');
  assert.equal(sheet.rowCount, 3);
  const nameCell = [2, 3].map((row) => sheet.getCell(`C${row}`)).find((cell) => cell.value === renamed.name);
  assert(nameCell, 'formula-like name exported as text');
  assert.equal(nameCell.formula, undefined);
  const info = Object.fromEntries(adminBook.getWorksheet('Thông tin xuất').getSheetValues().slice(2).map((row) => [row[1], row[2]]));
  assert.equal(info['Hình thức dịch vụ'], 'Quản trị vận hành');
  assert.equal(info['Số ứng dụng'], 2);

  const { items: events } = await json('GET', '/audit-events?pageSize=100', { token: admin });
  const exports = events.filter((event) => event.action === 'report.export.inventory');
  assert(exports.some((event) => event.actorId === leader.id && event.outcome === 'denied'));
  assert(exports.some((event) => event.actorId === leader.id && event.outcome === 'success'));
  assert.equal(exports.filter((event) => event.outcome === 'success').length, 2);
});
