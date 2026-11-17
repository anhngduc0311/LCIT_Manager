const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { Workbook } = require('exceljs');
const { system } = require('./helpers/system.cjs');

test('T4.3: login → import → assign → search → files → expiry → export → connect → revoke', {
  skip: process.env.LCIT_TEST_DATABASE_URL ? false : 'Requires LCIT_TEST_DATABASE_URL; use npm run test:t43 for acceptance.',
  timeout: 180000,
}, async (context) => {
  const { app, db, call } = await system(context);
  const { hashPassword } = require('../dist/models/password');
  const password = randomBytes(24).toString('hex');
  await db.query("INSERT INTO lcit.users(username,display_name,password_hash,role) VALUES('system-admin','System admin',$1,'admin')", [await hashPassword(password)]);
  const login = async (username) => (await call('/auth/login', { method: 'POST', body: { username, password } })).value.token;
  const admin = await login('system-admin');
  const json = async (route, token = admin, method = 'GET', body, status = 200) =>
    (await call(route, { token, method, body, status })).value;
  const users = {};
  for (const [username, role] of [['system-a', 'specialist'], ['system-b', 'specialist'], ['system-leader', 'leader']]) {
    users[username] = await json('/users', admin, 'POST', { username, displayName: username, password, role }, 201);
  }
  const specialistA = await login('system-a'), specialistB = await login('system-b'), leader = await login('system-leader');
  const orgs = [], centers = [];
  for (const letter of ['A', 'B']) {
    orgs.push(await json('/organizations', admin, 'POST', { code: `ORG-${letter}`, name: `Unit ${letter}` }, 201));
    centers.push(await json('/data-centers', admin, 'POST', { code: `DC-${letter}`, name: `DC ${letter}` }, 201));
  }
  const bytes = await readFile(path.resolve(__dirname, '../../../fixtures/import-sample.xlsx'));
  const batch = await json('/imports?fileName=sample.xlsx', admin, 'POST', bytes, 201);
  const preview = await json(`/imports/${batch.id}/preview`, admin, 'POST', {
    sheet: 'Catalog', previewVersion: 0, columns: { organizationCode: 1, dataCenterCode: 2, applicationCode: 3,
      applicationName: 4, serverCode: 5, hostname: 6, networkScope: 7, privateIp: 8, domain: 9 },
  });
  assert.deepEqual(preview.rows.map((row) => row.status), ['new', 'new', 'duplicate', 'error']);
  assert.equal((await json('/applications')).total, 0);
  const receipts = await Promise.all(Array.from({ length: 4 }, () => json(`/imports/${batch.id}/confirm`, admin, 'POST', { previewVersion: 1, rowNumbers: [2, 3] })));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  assert.equal(receipts[0].created, 2);
  const applications = (await json('/applications')).items;
  const [a, b] = ['APP-A', 'APP-B'].map((code) => applications.find((item) => item.code === code));
  const assignment = `/users/${users['system-a'].id}/assignments/applications/${a.id}`;
  await json(assignment, admin, 'PUT', undefined, 204);
  await json(`/users/${users['system-b'].id}/assignments/applications/${b.id}`, admin, 'PUT', undefined, 204);
  await json(`/users/${users['system-leader'].id}/assignments/organizations/${orgs[0].id}`, admin, 'PUT', undefined, 204);
  for (const [token, expected] of [[admin, [a.id, b.id]], [specialistA, [a.id]], [specialistB, [b.id]], [leader, [a.id]]]) {
    const results = await json('/search?q=10.42.0.15', token);
    assert.deepEqual(results.items.map((row) => row.id).sort(), expected.sort());
    assert.equal(results.total, expected.length);
  }
  await json(`/applications/${b.id}`, specialistA, 'GET', undefined, 404);
  const detail = await json(`/applications/${a.id}`, specialistA);
  const [serverId] = detail.serverIds, [domainId] = detail.domainIds;
  const foundDomain = (await json(`/domains/${domainId}`)).name;
  assert.equal((await json(`/search?q=${foundDomain}`, specialistA)).items[0].id, a.id);
  // Both writes start with the same version: exactly one wins and only one audit commits.
  const updates = await Promise.all(['First', 'Second'].map((description) => call(`/applications/${a.id}`, {
    token: specialistA, method: 'PATCH', body: { version: detail.version, description }, status: null,
  })));
  assert.deepEqual(updates.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM lcit.audit_events WHERE action='catalog.update' AND target_id=$1", [a.id])).rows[0].n, 1);
  const pdf = Buffer.from('%PDF-1.4\nT4.3 synthetic attachment\n%%EOF');
  const attachment = await json(`/attachments?applicationId=${a.id}&fileName=system.pdf`, specialistA, 'POST', pdf, 201);
  await call(`/attachments/${attachment.id}/download`, { token: specialistA, binary: true, status: 403 });
  await json(`/users/${users['system-a'].id}/permissions/attachments.download`, admin, 'PUT', undefined, 204);
  assert.deepEqual((await call(`/attachments/${attachment.id}/download`, { token: specialistA, binary: true })).value, pdf);
  await call(`/attachments/${attachment.id}/download`, { token: specialistB, binary: true, status: 404 });
  await db.query("UPDATE lcit.domains SET renewal_date='2026-11-24' WHERE id=$1", [domainId]);
  const { ExpiryMonitorService } = require('../dist/models/expiry-monitor.service');
  const worker = app.get(ExpiryMonitorService), client = await db.connect();
  try {
    await worker.reconcile({ client }, new Date('2026-11-17T05:00:00Z'));
    const again = await worker.reconcile({ client }, new Date('2026-11-17T05:00:00Z'));
    assert.deepEqual(again, { alertsCreated: 0, notificationsCreated: 0 });
  } finally { client.release(); }
  // A fresh login represents reconnecting after the server created notifications without a desktop session.
  const reopened = await login('system-a');
  const notifications = await json('/notifications', reopened);
  assert.equal(notifications.total, 1);
  assert.equal((await json('/notifications', specialistB)).total, 0);
  await json(`/notifications/${notifications.items[0].id}`, reopened, 'PATCH', { read: true });
  await json('/reports/inventory.xlsx', leader, 'GET', undefined, 403);
  await json(`/users/${users['system-leader'].id}/permissions/reports.export`, admin, 'PUT', undefined, 204);
  const filter = `organizationId=${orgs[0].id}&dataCenterId=${centers[0].id}`;
  const inventory = await json(`/reports/inventory?${filter}`, leader);
  assert.equal(inventory.total, 1);
  const book = new Workbook();
  await book.xlsx.load((await call(`/reports/inventory.xlsx?${filter}`, { token: leader, binary: true })).value);
  const sheet = book.getWorksheet('Danh mục ứng dụng');
  assert.equal(sheet.actualRowCount - 1, inventory.total);
  assert.equal(sheet.getCell('B2').value, a.code);
  const srv = await json(`/servers/${serverId}`);
  const endpoint = await json(`/servers/${serverId}/access-endpoints`, admin, 'POST', {
    version: srv.version, protocol: 'ssh', host: '10.42.0.15', port: 2222,
  }, 201);
  await json(`/access-endpoints/${endpoint.id}/launch`, specialistA, 'POST', undefined, 403);
  await json(`/users/${users['system-a'].id}/access-endpoints/${endpoint.id}`, admin, 'PUT', undefined, 204);
  const launch = await json(`/access-endpoints/${endpoint.id}/launch`, specialistA, 'POST');
  assert.deepEqual([launch.protocol, launch.host, launch.port], ['ssh', '10.42.0.15', 2222]);
  await json(assignment, admin, 'DELETE', undefined, 204);
  await json(`/applications/${a.id}`, reopened, 'GET', undefined, 404);
  assert.equal((await json('/search?q=10.42.0.15', reopened)).total, 0);
  assert.equal((await json('/notifications', reopened)).total, 0);
  await call(`/attachments/${attachment.id}/download`, { token: reopened, binary: true, status: 404 });
  await json(`/access-endpoints/${endpoint.id}/launch`, reopened, 'POST', undefined, 404);
  const audits = (await db.query('SELECT * FROM lcit.audit_events')).rows;
  for (const action of ['imports.confirm', 'attachment.upload', 'report.export.inventory', 'access.launch.authorize'])
    assert.ok(audits.some((event) => event.action === action && event.outcome === 'success'), action);
  const serialized = JSON.stringify(audits);
  for (const secret of [password, admin, specialistA, specialistB, leader, reopened, pdf.toString()]) assert.ok(!serialized.includes(secret));
  await json('/auth/logout', reopened, 'POST', undefined, 204);
  await json('/me', reopened, 'GET', undefined, 401);
});
