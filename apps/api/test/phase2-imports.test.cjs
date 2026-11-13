const assert = require('node:assert/strict');
const test = require('node:test');
const { readFile } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');
const { parseWorkbook, normalizeSheet } = require('../dist/models/excel-import');
const { planRows } = require('../dist/models/import-plan');
const { sha256 } = require('../dist/models/access');

const root = path.resolve(__dirname, '..');
const fixture = path.resolve(root, '../../fixtures/import-sample.xlsx');
const columns = { organizationCode: 1, dataCenterCode: 2, applicationCode: 3, applicationName: 4,
  serverCode: 5, hostname: 6, networkScope: 7, privateIp: 8, domain: 9 };
const mapping = { sheet: 'Catalog', columns, previewVersion: 0 };
const emptyCatalog = () => ({ organizations: [{ id: 'org-a', code: 'ORG-A', version: 1 }, { id: 'org-b', code: 'ORG-B', version: 1 }],
  dataCenters: [{ id: 'dc-a', code: 'DC-A', version: 1 }, { id: 'dc-b', code: 'DC-B', version: 1 }], applications: [], servers: [], domains: [] });

test('sample Excel: sheet, row numbers, scoped IP duplicates and cell errors', async () => {
  const sheets = await parseWorkbook(await readFile(fixture));
  assert.equal(sheets[0].name, 'Catalog');
  const { rows } = normalizeSheet(sheets, mapping);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].data.applicationName, 'Cổng Mẫu A');
  const planned = planRows(rows, emptyCatalog());
  assert.deepEqual(planned.map((r) => r.status), ['new', 'new', 'duplicate', 'error']);
  assert.equal(planned[2].duplicateOf, 2);
  assert.deepEqual(rows[3].errors, [{ column: 8, field: 'privateIp', reason: 'Expected an IPv4 or IPv6 address.' }]);
  assert.throws(() => normalizeSheet(sheets, { ...mapping, columns: { ...columns, hostname: 5 } }));
  assert.throws(() => normalizeSheet(sheets, { ...mapping, sheet: 'Missing' }));
});

test('Excel normalization rejects formulas, handles dates and canonical hostnames', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Catalog');
  sheet.addRow(Object.keys(columns));
  sheet.addRow([' org-a ', 'dc-a', 'app-x', ' App X ', 'srv-x', 'APP.EXAMPLE.TEST.', 'lan-x', '2001:0db8::1', 'EXAMPLE.TEST.', 'operations', new Date('2028-02-29T00:00:00Z')]);
  sheet.addRow(['ORG-A', 'DC-A', 'APP-Y', { formula: '1+1', result: 2 }, 'SRV-Y', 'app.example.test', 'lan-y', '10.0.0.1', 'example.test']);
  const sheets = await parseWorkbook(Buffer.from(await book.xlsx.writeBuffer()));
  const { rows } = normalizeSheet(sheets, { ...mapping, columns: { ...columns, serviceType: 10, renewalDate: 11 } });
  assert.equal(rows[0].data.organizationCode, 'ORG-A');
  assert.equal(rows[0].data.hostname, 'app.example.test');
  assert.equal(rows[0].data.privateIp, '2001:db8::1');
  assert.equal(rows[0].data.renewalDate, '2028-02-29');
  assert.equal(rows[1].errors[0].field, 'applicationName');
  assert.match(rows[1].errors[0].reason, /Formula/);
  await assert.rejects(parseWorkbook(Buffer.from('not Excel')));
  await assert.rejects(parseWorkbook(Buffer.alloc(10 * 1024 * 1024 + 1)), (e) => e.getStatus() === 413);
  sheet.getCell('BM1').value = 'too many columns';
  await assert.rejects(parseWorkbook(Buffer.from(await book.xlsx.writeBuffer())));
});

test('matching requires code or scoped IP; conflicting identities cannot be silently merged', async () => {
  const { rows } = normalizeSheet(await parseWorkbook(await readFile(fixture)), mapping);
  const catalog = emptyCatalog();
  catalog.servers.push({ id: 'server-a', code: 'OTHER', version: 1, addresses: [{ address: '10.42.0.15', scope: 'LAN-A', kind: 'private' }] });
  let planned = planRows(rows, catalog);
  assert.equal(planned[0].status, 'match');
  assert.equal(planned[0].targets.serverId, 'server-a');
  assert.equal(planned[1].status, 'new');
  catalog.servers.push({ id: 'server-b', code: 'SRV-A', version: 1, addresses: [] });
  planned = planRows(rows, catalog);
  assert.equal(planned[0].status, 'conflict');
  catalog.applications.push({ id: 'app-other', code: 'OTHER', organization_id: 'org-b', name: 'Cổng Mẫu B', version: 1 });
  assert.equal(planRows(rows, catalog)[1].status, 'conflict');
});

test('Excel limits reject expanded ZIP payloads before workbook parsing', async () => {
  const { zipSync } = require('fflate');
  const buffer = zipSync({ 'large.xml': new Uint8Array(51 * 1024 * 1024) });
  await assert.rejects(parseWorkbook(Buffer.from(buffer)), (e) => e.getStatus() === 400);
});

const databaseUrl = process.env.LCIT_TEST_DATABASE_URL;
test('imports API: atomic confirmation, persisted decisions, stale previews, concurrent retries and access control', {
  skip: databaseUrl ? false : 'Set LCIT_TEST_DATABASE_URL to an empty disposable PostgreSQL database.', timeout: 120000,
}, async (context) => {
  const db = new Pool({ connectionString: databaseUrl });
  let app, ownsSchema = false;
  const previousUrl = process.env.DATABASE_URL;
  context.after(async () => {
    await app?.close();
    if (ownsSchema) await db.query('DROP SCHEMA IF EXISTS lcit CASCADE');
    await db.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
  });
  assert.equal((await db.query("SELECT to_regnamespace('lcit') AS schema")).rows[0].schema, null);
  ownsSchema = true;
  const migrated = spawnSync(process.execPath, ['dist/migrate.js'], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8' });
  assert.equal(migrated.status, 0, migrated.stderr);
  const again = spawnSync(process.execPath, ['dist/migrate.js'], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /up to date/);
  for (const code of ['ORG-A', 'ORG-B']) await db.query('INSERT INTO lcit.organizations(code,name) VALUES($1,$1)', [code]);
  for (const code of ['DC-A', 'DC-B']) await db.query('INSERT INTO lcit.data_centers(code,name) VALUES($1,$1)', [code]);
  const tokens = {};
  for (const [username, role] of [['admin-a', 'admin'], ['admin-b', 'admin'], ['leader-a', 'leader'], ['specialist-a', 'specialist']]) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query('INSERT INTO lcit.users(id,username,display_name,password_hash,role) VALUES($1,$2,$2,$3,$4)', [id, username, 'unused-test-hash', role]);
    await db.query("INSERT INTO lcit.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [sha256(token), id]);
    tokens[username] = token;
  }
  process.env.DATABASE_URL = databaseUrl;
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../dist/app.module');
  const { ApiExceptionFilter } = require('../dist/shared/api-contract');
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  async function call(route, body, expected = 200, user = 'admin-a', raw = false) {
    const response = await fetch(`${url}/api/v1${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${tokens[user]}`, ...(body !== undefined ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  const bytes = await readFile(fixture);
  const upload = () => call('/imports?fileName=sample.xlsx', bytes, 201, 'admin-a', true);
  const batch = await upload();
  assert.equal(batch.sheets[0].name, 'Catalog');
  for (const user of ['leader-a', 'specialist-a']) {
    await call('/imports?fileName=sample.xlsx', bytes, 403, user, true);
    await call(`/imports/${batch.id}`, undefined, 403, user);
    await call(`/imports/${batch.id}/preview`, mapping, 403, user);
    await call(`/imports/${batch.id}/confirm`, { previewVersion: 1, rowNumbers: [2] }, 403, user);
  }
  await call(`/imports/${batch.id}`, undefined, 404, 'admin-b');
  const preview = await call(`/imports/${batch.id}/preview`, mapping);
  assert.deepEqual(preview.rows.map((r) => r.status), ['new', 'new', 'duplicate', 'error']);
  assert.equal((await db.query('SELECT count(*) FROM lcit.applications')).rows[0].count, '0');
  await call(`/imports/${batch.id}/confirm`, { previewVersion: 1, rowNumbers: [5] }, 400);
  // Force a failure after all catalog writes, at the audit step, to verify rollback.
  await db.query(`CREATE FUNCTION lcit.reject_import_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='imports.confirm' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_import BEFORE INSERT ON lcit.audit_events FOR EACH ROW EXECUTE FUNCTION lcit.reject_import_audit()`);
  await call(`/imports/${batch.id}/confirm`, { previewVersion: 1, rowNumbers: [2, 3] }, 500);
  assert.equal((await db.query('SELECT count(*) FROM lcit.applications')).rows[0].count, '0');
  assert.equal((await call(`/imports/${batch.id}`)).status, 'previewed');
  await db.query('DROP TRIGGER reject_import ON lcit.audit_events');
  const receipts = await Promise.all([1, 2].map(() => call(`/imports/${batch.id}/confirm`, { previewVersion: 1, rowNumbers: [2, 3] })));
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(receipts[0].created, 2);
  assert.equal(receipts[0].skipped, 2);
  assert.equal((await db.query("SELECT count(*) FROM lcit.audit_events WHERE action='imports.confirm'")).rows[0].count, '1');
  assert.equal((await db.query('SELECT count(*) FROM lcit.server_addresses')).rows[0].count, '2');
  const retry = await call(`/imports/${batch.id}/confirm`, { previewVersion: 999, rowNumbers: [] });
  assert.deepEqual(retry, receipts[0]);
  const next = await upload();
  const matched = await call(`/imports/${next.id}/preview`, { ...mapping, decisions: [{ rowNumber: 2, action: 'merge' }] });
  assert.equal(matched.rows[0].status, 'match');
  assert.equal((await call(`/imports/${next.id}`)).rows[0].decision, 'merge');
  await call(`/imports/${next.id}/preview`, mapping, 409);
  await db.query("UPDATE lcit.servers SET hostname='changed.example.test',version=version+1 WHERE code='SRV-A'");
  const conflict = await call(`/imports/${next.id}/confirm`, { previewVersion: 1, rowNumbers: [2] }, 409);
  assert.equal(conflict.code, 'IMPORT_CONFLICT');
  await call(`/imports/${next.id}/preview`, { ...mapping, previewVersion: 1, decisions: [{ rowNumber: 2, action: 'merge' }] });
  const merged = await call(`/imports/${next.id}/confirm`, { previewVersion: 2, rowNumbers: [2] });
  assert.equal(merged.merged, 1);
  assert.equal((await db.query('SELECT count(*) FROM lcit.applications')).rows[0].count, '2');
});
