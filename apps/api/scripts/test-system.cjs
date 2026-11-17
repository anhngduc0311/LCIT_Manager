const { spawn } = require('node:child_process');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { requireDirectDatabaseUrl } = require('../dist/models/database-config');

async function main() {
  if (!process.env.LCIT_TEST_DATABASE_URL) throw new Error('Set LCIT_TEST_DATABASE_URL to a dedicated empty PostgreSQL database. T4.3 does not allow skipped database tests.');
  const db = new Pool({ connectionString: requireDirectDatabaseUrl(process.env.LCIT_TEST_DATABASE_URL), connectionTimeoutMillis: 5000 });
  try {
    if ((await db.query("SELECT to_regnamespace('lcit') AS schema")).rows[0].schema !== null)
      throw new Error('Refusing an existing lcit schema. Use a dedicated empty test database.');
  } finally { await db.end(); }
  const results = path.resolve(__dirname, '../../../test-results');
  await mkdir(results, { recursive: true });
  const files = ['phase1', 'phase2-attachments', 'phase2-imports', 'phase3-monitoring', 'phase3-expiry',
    'phase3-network', 'phase3-notifications', 'phase3-reports', 'phase4-access', 'phase4-system', 'phase4-performance'];
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec',
    '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${path.join(results, 't43-junit.xml')}`,
    ...files.map((name) => `test/${name}.test.cjs`)], {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
    env: { ...process.env, MONITORING_ENABLED: 'off', ATTACHMENT_CLEANUP: 'off', LCIT_PERFORMANCE_REPORT: path.join(results, 't43-performance.json') },
  });
  child.on('error', () => { console.error('Unable to start T4.3 tests.'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}
main().catch((error) => {
  // Never print a connection string or server error containing credentials.
  console.error(error.message.startsWith('Set ') || error.message.startsWith('Refusing ') ? error.message : 'T4.3 setup failed. Check the dedicated test database connection.');
  process.exitCode = 1;
});
