import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from './database';

interface NamedItem { code: string; name: string }
interface Fixture {
  organizations: NamedItem[];
  dataCenters: NamedItem[];
  applications: (NamedItem & { organizationCode: string; serverCodes: string[]; domain: string })[];
  servers: { code: string; hostname: string; dataCenterCode: string; networkScope: string; privateIp: string }[];
}

async function seed() {
  const fixture = JSON.parse(await readFile(join(__dirname, '../../../fixtures/catalog.json'), 'utf8')) as Fixture;
  const db = new Database();
  try {
    await db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(1195590319)');
      for (const row of fixture.organizations) {
        await client.query('INSERT INTO lcit.organizations (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [row.code, row.name]);
      }
      for (const row of fixture.dataCenters) {
        await client.query('INSERT INTO lcit.data_centers (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [row.code, row.name]);
      }
      for (const row of fixture.servers) {
        await client.query(`
          INSERT INTO lcit.servers (code, hostname, data_center_id)
          VALUES ($1, $2, (SELECT id FROM lcit.data_centers WHERE code = $3)) ON CONFLICT (code) DO NOTHING
        `, [row.code, row.hostname, row.dataCenterCode]);
        await client.query(`
          INSERT INTO lcit.server_addresses (server_id, address, network_scope, kind)
          VALUES ((SELECT id FROM lcit.servers WHERE code = $1), $2, $3, 'private')
          ON CONFLICT (server_id, address, network_scope, kind) DO NOTHING
        `, [row.code, row.privateIp, row.networkScope]);
      }
      for (const row of fixture.applications) {
        await client.query(`
          INSERT INTO lcit.applications (code, name, organization_id, service_type)
          VALUES ($1, $2, (SELECT id FROM lcit.organizations WHERE code = $3), 'operations') ON CONFLICT (code) DO NOTHING
        `, [row.code, row.name, row.organizationCode]);
        const databaseCode = `${row.code}-DB`;
        await client.query(`
          INSERT INTO lcit.databases (code, name, organization_id, engine)
          VALUES ($1, $2, (SELECT id FROM lcit.organizations WHERE code = $3), 'PostgreSQL') ON CONFLICT (code) DO NOTHING
        `, [databaseCode, `${row.name} DB`, row.organizationCode]);
        await client.query(`
          INSERT INTO lcit.app_databases (application_id, database_id)
          SELECT a.id, d.id FROM lcit.applications a CROSS JOIN lcit.databases d WHERE a.code = $1 AND d.code = $2
          ON CONFLICT DO NOTHING
        `, [row.code, databaseCode]);
        await client.query(`
          INSERT INTO lcit.app_servers (application_id, server_id)
          SELECT a.id, s.id FROM lcit.applications a CROSS JOIN lcit.servers s WHERE a.code = $1 AND s.code = ANY($2::text[])
          ON CONFLICT DO NOTHING
        `, [row.code, row.serverCodes]);
        await client.query('INSERT INTO lcit.domains (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [row.domain]);
        await client.query(`
          INSERT INTO lcit.app_domains (application_id, domain_id)
          SELECT a.id, d.id FROM lcit.applications a CROSS JOIN lcit.domains d WHERE a.code = $1 AND d.name = $2
          ON CONFLICT DO NOTHING
        `, [row.code, row.domain]);
      }
    });
    console.log('Sample catalog is ready.');
  } finally {
    await db.onModuleDestroy();
  }
}

void seed().catch((error: unknown) => {
  const code = (error as { code?: string })?.code;
  console.error(`Seed failed${code ? ` (${code})` : ''}. Check DATABASE_URL, migration and fixture data.`);
  process.exitCode = 1;
});
