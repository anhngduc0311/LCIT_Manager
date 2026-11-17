const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');

// Each file owns only the schema it created. Never fall back to DATABASE_URL or local env files.
async function system(context) {
  const url = process.env.LCIT_TEST_DATABASE_URL;
  assert.ok(url, 'LCIT_TEST_DATABASE_URL is required.');
  const { requireDirectDatabaseUrl } = require('../../dist/models/database-config');
  const db = new Pool({ connectionString: requireDirectDatabaseUrl(url), connectionTimeoutMillis: 5000 });
  let app, ownsSchema = false, directory;
  const keys = ['DATABASE_URL', 'MONITORING_ENABLED', 'ATTACHMENT_CLEANUP', 'ATTACHMENTS_DIR'];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  context.after(async () => {
    try {
      await app?.close();
      if (ownsSchema) await db.query('DROP SCHEMA lcit CASCADE');
    } finally {
      await db.end();
      if (directory) await rm(directory, { recursive: true, force: true });
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
      }
    }
  });
  assert.equal((await db.query("SELECT to_regnamespace('lcit') AS schema")).rows[0].schema, null,
    'Use a dedicated empty test database; an existing lcit schema will never be removed.');
  ownsSchema = true;
  directory = await mkdtemp(path.join(tmpdir(), 'lcit-t43-'));
  Object.assign(process.env, { DATABASE_URL: url, MONITORING_ENABLED: 'off', ATTACHMENT_CLEANUP: 'off', ATTACHMENTS_DIR: directory });
  const migration = spawnSync(process.execPath, ['dist/migrate.js'], {
    cwd: path.resolve(__dirname, '../..'), env: process.env, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(migration.status, 0, migration.stderr || 'Migration failed.');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../../dist/app.module');
  const { ApiExceptionFilter } = require('../../dist/shared/api-contract');
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function call(route, { token, method = 'GET', body, status = 200, binary = false } = {}) {
    const raw = Buffer.isBuffer(body);
    const response = await fetch(`${base}/api/v1${route}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const value = response.status === 204 ? null : binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    if (status !== null) assert.equal(response.status, status, `${method} ${route}: ${response.status} ${binary ? '' : JSON.stringify(value)}`);
    return { value, status: response.status };
  }
  return { app, db, base, call };
}
module.exports = { system };
