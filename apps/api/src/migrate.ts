import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool } from './database';

async function migrate() {
  const directory = join(__dirname, '../migrations');
  const files = (await readdir(directory)).filter((file) => /^\d{3,}_.+\.sql$/.test(file)).sort();
  const pool = createPool();

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(1195590317)');
      const { rows: [ledger] } = await client.query<{ present: boolean }>(
        "SELECT to_regclass('lcit.schema_migrations') IS NOT NULL AS present",
      );
      const applied = ledger.present
        ? new Set((await client.query<{ name: string }>('SELECT name FROM lcit.schema_migrations'))
            .rows.map(({ name }) => name))
        : new Set<string>();

      const pending = files.filter((name) => !applied.has(name));
      for (const name of pending) {
        await client.query(await readFile(join(directory, name), 'utf8'));
        await client.query('INSERT INTO lcit.schema_migrations (name) VALUES ($1)', [name]);
      }
      await client.query('COMMIT');
      console.log(pending.length ? `Applied: ${pending.join(', ')}` : 'Database is up to date.');
    } finally {
      // Closing the connection also rolls back an incomplete transaction.
      client.release(true);
    }
  } finally {
    await pool.end();
  }
}

void migrate().catch((error: unknown) => {
  const code = (error as { code?: string })?.code;
  console.error(`Migration failed${code ? ` (${code})` : ''}. Check DATABASE_URL and PostgreSQL access.`);
  process.exitCode = 1;
});
