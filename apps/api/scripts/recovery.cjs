// Offline paired backup: pg_dump snapshot + verified available attachment contents.
const { Pool } = require('pg');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { requireDirectDatabaseUrl } = require('../dist/models/database-config');

const keyPattern = /^[a-f0-9]{64}$/;
function required(name) {
  if (!process.env[name]?.trim()) throw new Error(`Required: ${name}`);
  return process.env[name];
}
function pgEnv(connectionString) {
  const url = new URL(requireDirectDatabaseUrl(connectionString));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  Object.assign(env, { PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '5', PGSSLMODE: url.searchParams.get('sslmode') || 'prefer' });
  for (const [param, variable] of Object.entries({ sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', channel_binding: 'PGCHANNELBINDING' }))
    if (url.searchParams.has(param)) env[variable] = url.searchParams.get(param);
  return env;
}
function runPg(tool, args, url) {
  const program = process.env.LCIT_PG_BIN ? path.join(process.env.LCIT_PG_BIN, `${tool}${process.platform === 'win32' ? '.exe' : ''}`) : tool;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: pgEnv(url), windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error(`${tool} could not start; check LCIT_PG_BIN.`)));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${tool} failed; check PostgreSQL version, privileges, TLS and disk space.`)));
  });
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function filePath(root, key) {
  if (!keyPattern.test(key)) throw new Error('Invalid attachment storage key.');
  return path.join(root, key.slice(0, 2), key);
}
async function regular(file) {
  if (!(await fs.lstat(file)).isFile()) throw new Error('Expected a regular file, not a link or directory.');
}
async function absent(file) {
  try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Destination already exists; choose a new destination.');
}
const identifier = (name) => `"${name.replace(/"/g, '""')}"`;
async function tables(client) {
  return (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='lcit' ORDER BY tablename")).rows.map((r) => r.tablename);
}
async function counts(client, names) {
  const result = {};
  for (const name of names) result[name] = (await client.query(`SELECT count(*)::text AS n FROM lcit.${identifier(name)}`)).rows[0].n;
  return result;
}
async function verifyFile(file, expected) {
  await regular(file);
  if ((await fs.stat(file)).size !== Number(expected.size) || await digest(file) !== expected.sha256)
    throw new Error('Backup file size/hash verification failed.');
}
async function backup(destination) {
  if (process.env.LCIT_BACKUP_MAINTENANCE !== 'on') throw new Error('Stop all API/scheduler/SQL writers, then set LCIT_BACKUP_MAINTENANCE=on.');
  const url = required('LCIT_BACKUP_DATABASE_URL'), root = path.resolve(required('LCIT_BACKUP_ATTACHMENTS_DIR'));
  const output = path.resolve(destination);
  // Do not place the backup inside the store, or put the store inside the backup.
  for (const [parent, child] of [[root, output], [output, root]]) {
    const relative = path.relative(parent, child);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
      throw new Error('Backup and attachment directories must be separate.');
  }
  await fs.mkdir(output, { mode: 0o700 }); // exclusive: never overwrite a previous backup
  const db = new Pool({ connectionString: requireDirectDatabaseUrl(url), max: 1, connectionTimeoutMillis: 5000 });
  let client;
  try {
    client = await db.connect();
    const names = await tables(client);
    if (!names.includes('attachments') || !names.includes('schema_migrations')) throw new Error('Source schema is incomplete.');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(`LOCK TABLE ${names.map((name) => `lcit.${identifier(name)}`).join(',')} IN SHARE MODE`);
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const rows = (await client.query("SELECT storage_key,size_bytes::text,sha256 FROM lcit.attachments WHERE status='available' ORDER BY storage_key")).rows;
    const files = [];
    for (const row of rows) {
      const source = filePath(root, row.storage_key), target = filePath(path.join(output, 'attachments'), row.storage_key);
      const info = { key: row.storage_key, size: row.size_bytes, sha256: row.sha256 };
      await verifyFile(source, info);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(source, target, require('node:fs').constants.COPYFILE_EXCL);
      await verifyFile(target, info);
      files.push(info);
    }
    const dump = path.join(output, 'database.dump');
    // pg_trgm lives in public; a schema-only selection would omit the index dependency.
    await runPg('pg_dump', ['--format=custom', '--schema=lcit', '--extension=pg_trgm', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, '--file', dump], url);
    const manifest = { format: 'lcit-paired-backup-v1', createdAt: new Date().toISOString(),
      postgres: (await client.query('SHOW server_version')).rows[0].server_version,
      database: { size: (await fs.stat(dump)).size, sha256: await digest(dump) }, files,
      tableCounts: await counts(client, names),
      migrations: (await client.query('SELECT name FROM lcit.schema_migrations ORDER BY name')).rows.map((r) => r.name) };
    await client.query('COMMIT');
    // Completion marker written last; interrupted backups cannot be restored.
    await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { status: 'backed_up', tables: names.length, attachments: files.length };
  } finally {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release(true);
    }
    await db.end();
  }
}
async function restore(source) {
  const url = required('LCIT_RESTORE_DATABASE_URL'), root = path.resolve(required('LCIT_RESTORE_ATTACHMENTS_DIR'));
  const input = path.resolve(source), manifest = JSON.parse(await fs.readFile(path.join(input, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'lcit-paired-backup-v1' || !Array.isArray(manifest.files) || !manifest.tableCounts)
    throw new Error('Unsupported or incomplete backup manifest.');
  await absent(root);
  await verifyFile(path.join(input, 'database.dump'), manifest.database);
  const keys = new Set();
  for (const info of manifest.files) {
    if (keys.has(info.key)) throw new Error('Duplicate storage key.');
    keys.add(info.key);
    await verifyFile(filePath(path.join(input, 'attachments'), info.key), info);
  }
  const db = new Pool({ connectionString: requireDirectDatabaseUrl(url), max: 1, connectionTimeoutMillis: 5000 });
  const stage = `${root}.restore-${randomUUID()}`;
  try {
    const { rows: [state] } = await db.query(`SELECT to_regnamespace('lcit') IS NOT NULL OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
    ) AS occupied`);
    if (state.occupied) throw new Error('Restore requires an empty, separate database; existing objects will never be removed.');
    await fs.mkdir(stage, { mode: 0o700 });
    for (const info of manifest.files) {
      const target = filePath(stage, info.key);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(filePath(path.join(input, 'attachments'), info.key), target, require('node:fs').constants.COPYFILE_EXCL);
      await verifyFile(target, info);
    }
    await runPg('pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', pgEnv(url).PGDATABASE, path.join(input, 'database.dump')], url);
    const actual = await counts(db, await tables(db));
    if (JSON.stringify(actual) !== JSON.stringify(manifest.tableCounts)) throw new Error('Restored table counts do not match the backup.');
    const restoredFiles = (await db.query("SELECT storage_key FROM lcit.attachments WHERE status='available'")).rows;
    if (restoredFiles.length !== keys.size || restoredFiles.some((r) => !keys.has(r.storage_key))) throw new Error('Restored attachment references do not match the backup.');
    // Restoring a database must not reactivate old bearer tokens.
    await db.query('UPDATE lcit.sessions SET revoked_at=now() WHERE revoked_at IS NULL');
    await fs.rename(stage, root);
    return { status: 'restored', tables: Object.keys(actual).length, attachments: keys.size, sessionsRevoked: true };
  } finally { await db.end(); }
}
async function main() {
  const [action, directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || !['backup','restore'].includes(action)) throw new Error('Usage: recovery.cjs backup|restore DIRECTORY');
  console.log(JSON.stringify(await (action === 'backup' ? backup(directory) : restore(directory))));
}
if (require.main === module) main().catch((error) => {
  const safe = /^(Required:|Stop all|Destination|Backup and|Source schema|Expected a regular|Backup file|Unsupported|Duplicate|Restore requires|Restored|pg_dump|pg_restore|Usage:)/.test(error.message);
  console.error(safe ? error.message : 'Recovery operation failed. Check paths, database access and disk space. Incomplete outputs are retained for inspection.');
  process.exitCode = 1;
});
module.exports = { backup, restore, digest };
