const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { ExpiryMonitorService } = require('../dist/models/expiry-monitor.service');

test('expiry worker registers the scheduled handler and forwards its run context', async () => {
  let registered;
  const worker = new ExpiryMonitorService({ register: (key, handler) => { registered = { key, handler }; } });
  const context = { runId: randomUUID(), client: {} };
  let received;
  worker.reconcile = async (ctx) => { received = ctx; return { alertsCreated: 1, notificationsCreated: 1 }; };
  worker.onModuleInit();
  assert.equal(registered.key, 'expiry');
  await registered.handler(context);
  assert.equal(received, context);
});

const databaseUrl = process.env.LCIT_TEST_DATABASE_URL;
test('T3.2: all expiry thresholds, timezone, skipped schedules, renewal, scoped notifications and atomic retries', {
  skip: databaseUrl ? false : 'Set LCIT_TEST_DATABASE_URL to an empty disposable PostgreSQL database.', timeout: 120000,
}, async (context) => {
  const db = new Pool({ connectionString: databaseUrl });
  let ownsSchema = false, app;
  const envKeys = ['DATABASE_URL', 'MONITORING_ENABLED', 'MONITORING_TIME_ZONE', 'MONITORING_EXPIRY_CRON', 'MONITORING_DNS_TLS_CRON'];
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  context.after(async () => {
    await app?.close();
    if (ownsSchema) await db.query('DROP SCHEMA IF EXISTS lcit CASCADE');
    await db.end();
    for (const key of envKeys) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
  });
  assert.equal((await db.query("SELECT to_regnamespace('lcit') AS schema")).rows[0].schema, null, 'Use an empty disposable PostgreSQL database.');
  ownsSchema = true;
  const migrated = spawnSync(process.execPath, ['dist/migrate.js'], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 20000 });
  assert.equal(migrated.status, 0, migrated.stderr);
  const worker = new ExpiryMonitorService({ config: { timeZone: 'Asia/Ho_Chi_Minh' } });
  // Local Nov 13, despite Nov 12 in UTC. No dependence on the machine's date/timezone.
  const at = new Date('2026-11-12T18:45:00Z');
  const date = (days) => new Date(Date.UTC(2026, 10, 13 + days)).toISOString().slice(0, 10);
  async function reconcile() {
    const client = await db.connect();
    try { return await worker.reconcile({ client, runId: randomUUID() }, at); }
    finally { client.release(); }
  }
  async function makeUser(name, role, status = 'active', deleted = false) {
    const { rows: [row] } = await db.query(`INSERT INTO lcit.users(username,display_name,password_hash,role,status,deleted_at)
      VALUES($1,$1,'test-only-hash',$2,$3,CASE WHEN $4 THEN now() ELSE NULL END) RETURNING id`, [name, role, status, deleted]);
    return row.id;
  }
  const users = {
    admin: await makeUser('admin', 'admin'), leaderA: await makeUser('leader-a', 'leader'), leaderB: await makeUser('leader-b', 'leader'),
    specialistA: await makeUser('specialist-a', 'specialist'), specialistB: await makeUser('specialist-b', 'specialist'),
    leaderNone: await makeUser('leader-none', 'leader'), specialistNone: await makeUser('specialist-none', 'specialist'),
    locked: await makeUser('locked-admin', 'admin', 'locked'), deleted: await makeUser('deleted-admin', 'admin', 'active', true),
    lockedSpecialist: await makeUser('locked-specialist', 'specialist', 'locked'),
  };
  const { rows: [orgA] } = await db.query("INSERT INTO lcit.organizations(code,name) VALUES('A','A') RETURNING id");
  const { rows: [orgB] } = await db.query("INSERT INTO lcit.organizations(code,name) VALUES('B','B') RETURNING id");
  const { rows: [appA] } = await db.query("INSERT INTO lcit.applications(code,name,organization_id,service_type) VALUES('A','A',$1,'operations') RETURNING id", [orgA.id]);
  const { rows: [appB] } = await db.query("INSERT INTO lcit.applications(code,name,organization_id,service_type) VALUES('B','B',$1,'operations') RETURNING id", [orgB.id]);
  await db.query('INSERT INTO lcit.user_organizations(user_id,organization_id) VALUES($1,$2),($3,$4)', [users.leaderA, orgA.id, users.leaderB, orgB.id]);
  await db.query('INSERT INTO lcit.app_assignments(user_id,application_id) VALUES($1,$2),($3,$4),($5,$2)', [users.specialistA, appA.id, users.specialistB, appB.id, users.lockedSpecialist]);
  let sequence = 0;
  async function makeDomain(expiry, applicationId = appA.id, archived = false) {
    const { rows: [row] } = await db.query(`INSERT INTO lcit.domains(name,renewal_date,archived_at)
      VALUES($1,$2,CASE WHEN $3 THEN now() ELSE NULL END) RETURNING id,name`, [`expiry-${++sequence}.example.test`, expiry, archived]);
    if (applicationId) await db.query('INSERT INTO lcit.app_domains(application_id,domain_id) VALUES($1,$2)', [applicationId, row.id]);
    return row;
  }
  async function alerts(domainId, source = 'manual_domain') {
    return (await db.query(`SELECT a.id,a.threshold_days,a.expiry_date::text FROM lcit.alerts a
      LEFT JOIN lcit.tls_endpoints t ON t.id=a.tls_endpoint_id
      WHERE COALESCE(a.domain_id,t.domain_id)=$1 AND a.source=$2 ORDER BY expiry_date,threshold_days DESC`, [domainId, source])).rows;
  }
  async function recipients(alertId) {
    return (await db.query('SELECT recipient_id FROM lcit.notifications WHERE alert_id=$1 ORDER BY recipient_id', [alertId])).rows.map((row) => row.recipient_id);
  }
  const boundaries = [[91, null], [90, 90], [89, 90], [31, 90], [30, 30], [29, 30], [15, 30], [14, 14], [13, 14], [8, 14], [7, 7], [6, 7], [1, 7], [0, 7], [-1, 0], [-90, 0]];
  const domains = [];
  for (const [days, threshold] of boundaries) domains.push({ ...(await makeDomain(date(days))), days, threshold });
  const noDate = await makeDomain(null);
  const archived = await makeDomain(date(7), appA.id, true);
  const unlinked = await makeDomain(date(30), null);
  const dnsLinked = await makeDomain(date(14), null);
  const { rows: [dns] } = await db.query("INSERT INTO lcit.dns_records(domain_id,host,type,target) VALUES($1,$2,'A','192.0.2.1') RETURNING id", [dnsLinked.id, dnsLinked.name]);
  await db.query('INSERT INTO lcit.app_dns_records(application_id,dns_record_id) VALUES($1,$2)', [appB.id, dns.id]);
  const shared = await makeDomain(date(7), null);
  const { rows: [dc] } = await db.query("INSERT INTO lcit.data_centers(code,name) VALUES('DC','DC') RETURNING id");
  const { rows: [server] } = await db.query("INSERT INTO lcit.servers(code,hostname,data_center_id) VALUES('SHARED','shared.example.test',$1) RETURNING id", [dc.id]);
  await db.query('INSERT INTO lcit.app_servers(application_id,server_id) VALUES($1,$3),($2,$3)', [appA.id, appB.id, server.id]);
  await db.query('INSERT INTO lcit.domain_servers(domain_id,server_id) VALUES($1,$2)', [shared.id, server.id]);
  const { rows: [oldApp] } = await db.query("INSERT INTO lcit.applications(code,name,organization_id,service_type,archived_at) VALUES('OLD','OLD',$1,'operations',now()) RETURNING id", [orgA.id]);
  const oldAppDomain = await makeDomain(date(7), oldApp.id);
  const tlsDomain = await makeDomain(null);
  await db.query(`INSERT INTO lcit.tls_endpoints(domain_id,host,port,manual_expiry_date,observed_expiry_at)
    VALUES($1,$2,443,$3,'2026-11-26T18:30:00Z')`, [tlsDomain.id, tlsDomain.name, date(14)]);
  const tlsToday = await makeDomain(null);
  await db.query(`INSERT INTO lcit.tls_endpoints(domain_id,host,port,observed_expiry_at)
    VALUES($1,$2,443,'2026-11-12T18:30:00Z')`, [tlsToday.id, tlsToday.name]);
  // Archived parents suppress manual and observed TLS as well as domain expiry.
  await db.query(`INSERT INTO lcit.tls_endpoints(domain_id,host,port,manual_expiry_date,observed_expiry_at)
    VALUES($1,$2,443,$3,'2026-11-26T18:30:00Z')`, [archived.id, archived.name, date(14)]);
  const first = await reconcile();
  assert.equal(first.alertsCreated, 22); // 15 boundaries + 4 extra domains + 3 TLS sources.
  assert.ok(first.notificationsCreated > first.alertsCreated);
  for (const domain of domains) {
    const rows = await alerts(domain.id);
    assert.deepEqual(rows.map((r) => r.threshold_days), domain.threshold === null ? [] : [domain.threshold], `days remaining: ${domain.days}`);
    if (rows.length) assert.deepEqual(await recipients(rows[0].id), [users.admin, users.leaderA, users.specialistA].sort());
  }
  assert.deepEqual(await alerts(noDate.id), []);
  assert.deepEqual(await alerts(archived.id), []);
  assert.deepEqual(await alerts(archived.id, 'manual_tls'), []);
  assert.deepEqual(await alerts(archived.id, 'observed_tls'), []);
  assert.deepEqual(await recipients((await alerts(unlinked.id))[0].id), [users.admin]);
  assert.deepEqual(await recipients((await alerts(oldAppDomain.id))[0].id), [users.admin]);
  assert.deepEqual(await recipients((await alerts(dnsLinked.id))[0].id), [users.admin, users.leaderB, users.specialistB].sort());
  assert.deepEqual(await recipients((await alerts(shared.id))[0].id), [users.admin, users.leaderA, users.leaderB, users.specialistA, users.specialistB].sort());
  assert.equal((await alerts(tlsDomain.id, 'manual_tls'))[0].threshold_days, 14);
  const observed = (await alerts(tlsDomain.id, 'observed_tls'))[0];
  assert.equal(observed.threshold_days, 14);
  assert.equal(observed.expiry_date, date(14), 'Observed UTC timestamp must use the business timezone for its calendar date.');
  assert.equal((await alerts(tlsToday.id, 'observed_tls'))[0].threshold_days, 7, 'Local day zero must not be treated as an overdue UTC date.');
  assert.deepEqual(await reconcile(), { alertsCreated: 0, notificationsCreated: 0 });
  // A renewed period gets its own alert; prior alerts stay intact and do not suppress it.
  const renewed = domains.find((d) => d.days === 7);
  await db.query('UPDATE lcit.domains SET renewal_date=$2 WHERE id=$1', [renewed.id, date(30)]);
  assert.deepEqual(await reconcile(), { alertsCreated: 1, notificationsCreated: 3 });
  assert.deepEqual((await alerts(renewed.id)).map((r) => r.threshold_days), [7, 30]);
  assert.deepEqual(await reconcile(), { alertsCreated: 0, notificationsCreated: 0 });
  // Current permissions are used for new alerts, without resending old ones.
  await db.query('DELETE FROM lcit.app_assignments WHERE user_id=$1', [users.specialistA]);
  await db.query('DELETE FROM lcit.user_organizations WHERE user_id=$1', [users.leaderA]);
  await db.query('UPDATE lcit.domains SET renewal_date=$2 WHERE id=$1', [renewed.id, date(14)]);
  assert.deepEqual(await reconcile(), { alertsCreated: 1, notificationsCreated: 1 });
  const current = (await alerts(renewed.id)).find((r) => r.expiry_date === date(14));
  assert.deepEqual(await recipients(current.id), [users.admin]);
  // Atomicity: notification failure rolls back the alert as well, leaving a retry possible.
  const rollbackDomain = await makeDomain(date(7), null);
  await db.query(`CREATE FUNCTION lcit.reject_expiry_notification() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'forced notification failure'; END $$;
    CREATE TRIGGER reject_expiry BEFORE INSERT ON lcit.notifications FOR EACH ROW EXECUTE FUNCTION lcit.reject_expiry_notification()`);
  await assert.rejects(reconcile(), /forced notification failure/);
  assert.deepEqual(await alerts(rollbackDomain.id), []);
  await db.query('DROP TRIGGER reject_expiry ON lcit.notifications');
  assert.deepEqual(await reconcile(), { alertsCreated: 1, notificationsCreated: 1 });
  // Unique constraints still protect concurrent direct attempts, in addition to the runner's advisory lock.
  await makeDomain(date(7), null);
  const concurrent = await Promise.all([reconcile(), reconcile()]);
  assert.equal(concurrent.reduce((sum, r) => sum + r.alertsCreated, 0), 1);
  assert.equal(concurrent.reduce((sum, r) => sum + r.notificationsCreated, 0), 1);

  // Verify actual Nest registration and execution through the production job runner.
  for (const key of envKeys) delete process.env[key];
  process.env.DATABASE_URL = databaseUrl;
  process.env.MONITORING_EXPIRY_CRON = '0 0 0 1 1 *';
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../dist/app.module');
  const { MonitoringService } = require('../dist/models/monitoring.service');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  const actual = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS today")).rows[0].today;
  const live = await makeDomain(actual, null);
  const run = await app.get(MonitoringService).run('expiry');
  assert.equal(run.status, 'succeeded');
  assert.equal((await alerts(live.id))[0].threshold_days, 7);
  const again = await app.get(MonitoringService).run('expiry');
  assert.equal(again.status, 'succeeded');
  assert.equal((await alerts(live.id)).length, 1);
});
