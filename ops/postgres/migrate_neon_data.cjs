// Preserve source data. Credentials and snapshots remain in the user's private directory, outside Git.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const root = path.resolve(__dirname, '../..');
const accessDir = path.join(os.homedir(), '.codex/private/lcit-postgres-192.168.251.126');
const ident = (name) => '"' + name.replaceAll('"', '""') + '"';
const table = (name) => 'lcit.' + ident(name);
function connection(file) {
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((s) => s.startsWith('DATABASE_URL='));
  if (!line) throw Error('Missing connection configuration.');
  return line.slice('DATABASE_URL='.length).trim().replace(/^"|"$/g, '');
}
async function snapshot(client, names) {
  const data = {};
  for (const name of names) {
    data[name] = (await client.query(`SELECT to_jsonb(t)::text AS document FROM ${table(name)} t ORDER BY to_jsonb(t)::text`)).rows.map((r) => r.document);
  }
  const sequences = [];
  for (const { sequencename } of (await client.query("SELECT sequencename FROM pg_sequences WHERE schemaname='lcit' ORDER BY sequencename")).rows) {
    const state = (await client.query(`SELECT last_value::text,is_called FROM ${table(sequencename)}`)).rows[0];
    sequences.push({ name: sequencename, ...state });
  }
  return { data, sequences };
}
// Compare independently of the databases' locale/collation (Neon and Ubuntu may order text differently).
const digest = (rows) => crypto.createHash('sha256').update([...rows].sort().join('\n')).digest('hex');

async function main() {
  const sourceUrl = connection(path.join(root, 'apps/api/.env.example'));
  const targetUrl = connection(path.join(accessDir, 'owner.env'));
  if (!new URL(sourceUrl).hostname.endsWith('.neon.tech') || new URL(targetUrl).hostname !== '192.168.251.126') throw Error('Unexpected migration endpoints.');
  const source = new Client({ connectionString: sourceUrl, connectionTimeoutMillis: 10000 });
  const target = new Client({ connectionString: targetUrl, connectionTimeoutMillis: 10000 });
  const backupDir = path.join(accessDir, 'migration-' + new Date().toISOString().replaceAll(':', '-'));
  fs.mkdirSync(backupDir, { recursive: true });
  let sourceOpen = false, targetOpen = false, commitAttempted = false, targetBefore;
  try {
    await source.connect(); await target.connect();
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); sourceOpen = true;
    await source.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL lock_timeout='10s'");
    const names = (await source.query("SELECT tablename FROM pg_tables WHERE schemaname='lcit' ORDER BY tablename")).rows.map((r) => r.tablename);
    const targetNames = (await target.query("SELECT tablename FROM pg_tables WHERE schemaname='lcit' ORDER BY tablename")).rows.map((r) => r.tablename);
    if (JSON.stringify(names) !== JSON.stringify(targetNames)) throw Error('Source and target tables differ.');
    await source.query('LOCK TABLE ' + names.map(table).join(',') + ' IN SHARE MODE');
    const sourceData = await snapshot(source, names);
    fs.writeFileSync(path.join(backupDir, 'neon-snapshot.json'), JSON.stringify(sourceData));
    await target.query('BEGIN'); targetOpen = true;
    await target.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL lock_timeout='10s'");
    await target.query('LOCK TABLE ' + names.map(table).join(',') + ' IN ACCESS EXCLUSIVE MODE');
    targetBefore = await snapshot(target, names);
    fs.writeFileSync(path.join(backupDir, 'target-before.json'), JSON.stringify(targetBefore));
    for (const name of names) {
      if (!['schema_migrations', 'monitoring_jobs'].includes(name) && targetBefore.data[name].length) throw Error('Target contains business data; refusing to overwrite.');
    }
    if (JSON.stringify(sourceData.data.schema_migrations) !== JSON.stringify(targetBefore.data.schema_migrations)) {
      const versions = (rows) => rows.map((r) => JSON.parse(r).name).sort().join(',');
      if (versions(sourceData.data.schema_migrations) !== versions(targetBefore.data.schema_migrations)) throw Error('Migration versions differ.');
    }
    const edges = (await target.query(`SELECT child.relname AS child,parent.relname AS parent
      FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
      WHERE c.contype='f' AND c.connamespace='lcit'::regnamespace`)).rows;
    const ordered = [], pending = new Set(names);
    while (pending.size) {
      const ready = [...pending].filter((name) => edges.every((e) => e.child !== name ||
        (e.child === 'monitoring_jobs' && e.parent === 'monitoring_job_runs') || !pending.has(e.parent)));
      if (!ready.length) throw Error('Unsupported dependency cycle.');
      for (const name of ready) { pending.delete(name); ordered.push(name); }
    }
    // All LCIT foreign keys stay enabled. Only the nullable job-history back-reference is staged as NULL.
    await target.query('TRUNCATE TABLE ' + names.map(table).join(','));
    for (const name of ordered) {
      const columns = (await target.query(`SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass
        AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`, [table(name)])).rows.map((r) => r.attname);
      for (const document of sourceData.data[name]) {
        await target.query(`INSERT INTO ${table(name)} (${columns.map(ident).join(',')}) OVERRIDING SYSTEM VALUE
          SELECT ${columns.map((col) => name === 'monitoring_jobs' && col === 'last_run_id' ? 'NULL::uuid' : 'r.' + ident(col)).join(',')}
          FROM jsonb_populate_record(NULL::${table(name)},$1::jsonb) r`, [document]);
      }
    }
    for (const document of sourceData.data.monitoring_jobs) {
      await target.query(`UPDATE lcit.monitoring_jobs SET last_run_id=($1::jsonb->>'last_run_id')::uuid WHERE key=$1::jsonb->>'key'`, [document]);
    }
    for (const sequence of sourceData.sequences) await target.query('SELECT setval($1::regclass,$2::bigint,$3::boolean)', [table(sequence.name), sequence.last_value, sequence.is_called]);
    const after = await snapshot(target, names);
    const report = { createdAt: new Date().toISOString(), tables: [], sequencesVerified: false, filesCopied: 0, missingArchivedFiles: 0 };
    for (const name of names) {
      const same = digest(sourceData.data[name]) === digest(after.data[name]);
      report.tables.push({ table: name, sourceRows: sourceData.data[name].length, targetRows: after.data[name].length, exactMatch: same });
      if (!same) throw Error('Table verification failed: ' + name);
    }
    if (JSON.stringify(sourceData.sequences) !== JSON.stringify(after.sequences)) throw Error('Sequence verification failed.');
    report.sequencesVerified = true;
    const files = [];
    const attachmentRoot = path.resolve(root, 'apps/api/storage/attachments');
    for (const document of sourceData.data.attachments) {
      const attachment = JSON.parse(document);
      if (!/^[a-f0-9]{64}$/.test(attachment.storage_key)) throw Error('Invalid attachment storage key.');
      const file = path.join(attachmentRoot, attachment.storage_key.slice(0, 2), attachment.storage_key);
      if (!fs.existsSync(file)) {
        if (!attachment.archived_at && attachment.status === 'available') throw Error('Active attachment content is missing.');
        report.missingArchivedFiles++; continue;
      }
      const content = fs.readFileSync(file);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      if (attachment.sha256 && hash !== attachment.sha256) throw Error('Attachment checksum mismatch.');
      const backupFile = path.join(backupDir, 'attachments', attachment.storage_key.slice(0, 2), attachment.storage_key);
      fs.mkdirSync(path.dirname(backupFile), { recursive: true }); fs.writeFileSync(backupFile, content);
      files.push({ key: attachment.storage_key, sha256: hash, content: content.toString('base64') });
    }
    const remoteCode = `import sys,json,pathlib,base64,hashlib,os,re
os.umask(0o077)
root=pathlib.Path('/var/lib/lcit-manager/attachments'); root.mkdir(parents=True,exist_ok=True)
for f in json.load(sys.stdin):
 if not re.fullmatch('[a-f0-9]{64}',f['key']): raise SystemExit('Invalid key')
 data=base64.b64decode(f['content'])
 if hashlib.sha256(data).hexdigest()!=f['sha256']: raise SystemExit('Invalid hash')
 p=root/f['key'][:2]/f['key']; p.parent.mkdir(exist_ok=True)
 if p.exists() and hashlib.sha256(p.read_bytes()).hexdigest()!=f['sha256']: raise SystemExit('Conflicting attachment')
 p.write_bytes(data)
print('Attachment content verified on server.')`;
    const encoded = Buffer.from(remoteCode).toString('base64');
    const transfer = spawnSync('C:/Program Files (x86)/Bitvise SSH Client/sexec.exe',
      ['-profile=' + path.join(os.homedir(), 'Downloads/lcit_test_app_251.126.tlp'), '-unat=y', '-exitZero', '-inputEOL=lf',
        `-cmd=python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`], { input: JSON.stringify(files), encoding: 'utf8', timeout: 30000 });
    if (transfer.status !== 0) throw Error('Attachment transfer failed.');
    report.filesCopied = files.length;
    commitAttempted = true;
    await target.query('COMMIT'); targetOpen = false;
    await source.query('ROLLBACK'); sourceOpen = false;
    fs.writeFileSync(path.join(backupDir, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ tablesVerified: report.tables.length, rowsCopied: report.tables.reduce((s, r) => s + r.sourceRows, 0),
      filesCopied: report.filesCopied, missingArchivedFiles: report.missingArchivedFiles, sequencesVerified: true, backupDir }));
  } catch (error) {
    if (targetOpen) { await target.query('ROLLBACK').catch(() => {}); targetOpen = false; }
    if (targetBefore && !commitAttempted) for (const s of targetBefore.sequences) await target.query('SELECT setval($1::regclass,$2::bigint,$3::boolean)', [table(s.name), s.last_value, s.is_called]).catch(() => {});
    throw error;
  } finally {
    if (sourceOpen) await source.query('ROLLBACK').catch(() => {});
    await source.end().catch(() => {}); await target.end().catch(() => {});
  }
}
main().catch((error) => { console.error('Data migration failed: ' + (error.code || error.message)); process.exitCode = 1; });
