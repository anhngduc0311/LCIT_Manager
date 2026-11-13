const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { CronTime } = require('cron');
const { monitoringConfig } = require('../dist/models/monitoring-config');

test('monitoring schedules use Vietnam time and reject invalid configuration', () => {
  const config = monitoringConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.timeZone, 'Asia/Ho_Chi_Minh');
  const daily = new CronTime(config.schedules.expiry, config.timeZone);
  const halfHourly = new CronTime(config.schedules.dns_tls, config.timeZone);
  // 01:59 local time on Nov 13, despite the host's own timezone.
  const now = new Date('2026-11-12T18:59:00Z');
  assert.equal(daily.getNextDateFrom(now, config.timeZone).toUTC().toISO(), '2026-11-12T19:00:00.000Z');
  assert.equal(halfHourly.getNextDateFrom(now, config.timeZone).toUTC().toISO(), '2026-11-12T19:00:00.000Z');
  assert.equal(monitoringConfig({ MONITORING_ENABLED: 'off' }).enabled, false);
  assert.throws(() => monitoringConfig({ MONITORING_ENABLED: 'maybe' }), /MONITORING_ENABLED/);
  assert.throws(() => monitoringConfig({ MONITORING_EXPIRY_CRON: 'invalid' }), /schedule/);
  assert.throws(() => monitoringConfig({ MONITORING_TIME_ZONE: 'invalid/timezone' }), /time zone/);
  const custom = monitoringConfig({ MONITORING_DNS_TLS_CRON: '0 */15 * * * *', MONITORING_TIME_ZONE: 'UTC' });
  assert.equal(custom.schedules.dns_tls, '0 */15 * * * *');
});

const databaseUrl = process.env.LCIT_TEST_DATABASE_URL;
test('T3.1: migration integrity, duplicate protection, persistent job status, locks and recovery', {
  skip: databaseUrl ? false : 'Set LCIT_TEST_DATABASE_URL to an empty disposable PostgreSQL database.', timeout: 120000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const db = new Pool({ connectionString: databaseUrl });
  let app, ownsSchema = false, secondService;
  const envKeys = ['DATABASE_URL', 'MONITORING_ENABLED', 'MONITORING_TIME_ZONE', 'MONITORING_EXPIRY_CRON', 'MONITORING_DNS_TLS_CRON'];
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  context.after(async () => {
    await secondService?.onModuleDestroy();
    await app?.close();
    if (ownsSchema) await db.query('DROP SCHEMA IF EXISTS lcit CASCADE');
    await db.end();
    for (const key of envKeys) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
  });
  assert.equal((await db.query("SELECT to_regnamespace('lcit') AS schema")).rows[0].schema, null, 'Use an empty disposable test database.');
  ownsSchema = true;
  for (let i = 0; i < 2; i++) {
    const migrated = spawnSync(process.execPath, ['dist/migrate.js'], { cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 20000 });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.match(migrated.stdout, i === 0 ? /006_monitoring.sql/ : /up to date/);
  }
  for (const key of envKeys) delete process.env[key];
  process.env.DATABASE_URL = databaseUrl;
  const { NestFactory } = require('@nestjs/core');
  const { SchedulerRegistry } = require('@nestjs/schedule');
  const { AppModule } = require('../dist/app.module');
  const { Database } = require('../dist/models/database');
  const { MonitoringService } = require('../dist/models/monitoring.service');
  const { ApiExceptionFilter } = require('../dist/shared/api-contract');
  const { sha256 } = require('../dist/models/access');
  const tokens = {}, userIds = {};
  for (const role of ['admin', 'leader', 'specialist']) {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    userIds[role] = id;
    tokens[role] = token;
    await db.query('INSERT INTO lcit.users(id,username,display_name,password_hash,role) VALUES($1,$2,$2,$3,$2)', [id, role, 'test-hash']);
    await db.query("INSERT INTO lcit.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [sha256(token), id]);
  }
  async function startApp() {
    const instance = await NestFactory.create(AppModule, { logger: false });
    instance.useGlobalFilters(new ApiExceptionFilter());
    await instance.listen(0, '127.0.0.1');
    return instance;
  }
  app = await startApp();
  async function getJobs(role = 'admin', expected = 200) {
    const response = await fetch(`${await app.getUrl()}/api/v1/monitoring/jobs`, {
      headers: role === 'anonymous' ? {} : { Authorization: `Bearer ${tokens[role]}` },
    });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body;
  }
  await getJobs('anonymous', 401);
  await getJobs('leader', 403);
  await getJobs('specialist', 403);
  let jobs = await getJobs();
  assert.equal(jobs.items.length, 2);
  assert.ok(jobs.items.every((j) => j.state === 'waiting_handler' && j.lastRun === null && j.nextRunAt === null));
  const monitoring = app.get(MonitoringService);
  assert.deepEqual(await monitoring.run('dns_tls'), { status: 'skipped_unregistered' });
  assert.equal((await db.query('SELECT count(*) FROM lcit.monitoring_job_runs')).rows[0].count, '0');

  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let behavior = async () => { entered(); await gate; };
  monitoring.register('expiry', (ctx) => behavior(ctx));
  assert.throws(() => monitoring.register('expiry', async () => {}), /duplicate/);
  secondService = new MonitoringService(app.get(Database), new SchedulerRegistry());
  secondService.register('expiry', async () => { assert.fail('Must not run while another process holds the job lock.'); });
  const running = monitoring.run('expiry');
  try {
    await started;
    jobs = await getJobs();
    assert.equal(jobs.items.find((j) => j.key === 'expiry').lastRun.status, 'running');
    assert.equal(jobs.items.find((j) => j.key === 'expiry').state, 'scheduled');
    assert.ok(jobs.items.find((j) => j.key === 'expiry').nextRunAt);
    assert.deepEqual(await secondService.run('expiry'), { status: 'skipped_running' });
    await secondService.onApplicationBootstrap();
    assert.equal((await getJobs()).items.find((j) => j.key === 'expiry').lastRun.status, 'running', 'An active replica must not be marked interrupted.');
  } finally { release(); }
  const succeeded = await running;
  assert.equal(succeeded.status, 'succeeded');
  const lastSuccess = (await getJobs()).items.find((j) => j.key === 'expiry').lastSuccessAt;
  assert.ok(lastSuccess);
  behavior = async () => { throw new Error('secret token and database URL must never be persisted'); };
  assert.equal((await monitoring.run('expiry')).status, 'failed');
  jobs = await getJobs();
  const failed = jobs.items.find((j) => j.key === 'expiry');
  assert.equal(failed.lastRun.status, 'failed');
  assert.equal(failed.lastRun.errorCode, 'JOB_FAILED');
  assert.equal(failed.lastSuccessAt, lastSuccess);
  assert.doesNotMatch(JSON.stringify(jobs), /secret token/);
  // A failed SQL statement inside a worker transaction must not poison the status update or leak its lock.
  behavior = async ({ client }) => { await client.query('BEGIN'); await client.query('SELECT 1/0'); };
  assert.equal((await monitoring.run('expiry')).status, 'failed');
  behavior = async () => {};
  assert.equal((await monitoring.run('expiry')).status, 'succeeded');

  monitoring.register('dns_tls', async () => {});
  // Exercise the actual registered cron callback without waiting for wall-clock time.
  await app.get(SchedulerRegistry).getCronJob('monitoring:dns_tls').fireOnTick();
  const checkJob = (await getJobs()).items.find((j) => j.key === 'dns_tls');
  assert.equal(checkJob.lastRun.status, 'succeeded');

  const { rows: [domain] } = await db.query("INSERT INTO lcit.domains(name) VALUES('monitoring.example.test') RETURNING id");
  const { rows: [dns] } = await db.query("INSERT INTO lcit.dns_records(domain_id,host,type,target) VALUES($1,'monitoring.example.test','A','192.0.2.1') RETURNING id", [domain.id]);
  const { rows: [tls] } = await db.query("INSERT INTO lcit.tls_endpoints(domain_id,host,port) VALUES($1,'monitoring.example.test',443) RETURNING id", [domain.id]);
  const { rows: [otherTls] } = await db.query("INSERT INTO lcit.tls_endpoints(domain_id,host,port) VALUES($1,'other.example.test',443) RETURNING id", [domain.id]);
  const { rows: [observation] } = await db.query(`INSERT INTO lcit.check_runs(job_run_id,check_type,tls_endpoint_id,status,observed_expiry_at)
    VALUES($1,'tls',$2,'success','2027-02-01T00:00:00Z') RETURNING id`, [checkJob.lastRun.id, tls.id]);
  await assert.rejects(db.query(`INSERT INTO lcit.check_runs(job_run_id,check_type,tls_endpoint_id,status)
    VALUES($1,'tls',$2,'timeout')`, [checkJob.lastRun.id, tls.id]), { code: '23505' });
  await assert.rejects(db.query(`INSERT INTO lcit.check_runs(job_run_id,check_type,dns_record_id,status)
    VALUES($1,'dns',$2,'tls_error')`, [checkJob.lastRun.id, dns.id]), { code: '23514' });
  await assert.rejects(db.query(`INSERT INTO lcit.check_runs(job_run_id,check_type,tls_endpoint_id,status)
    VALUES($1,'tls',$2,'expired')`, [checkJob.lastRun.id, otherTls.id]), { code: '23514' });
  const expirySql = `INSERT INTO lcit.alerts(kind,source,domain_id,expiry_date,threshold_days)
    VALUES('expiry','manual_domain',$1,$2,$3) RETURNING id`;
  const { rows: [alert] } = await db.query(expirySql, [domain.id, '2027-02-01', 30]);
  await assert.rejects(db.query(expirySql, [domain.id, '2027-02-01', 30]), { code: '23505' });
  await db.query(expirySql, [domain.id, '2027-02-01', 7]);
  await db.query(expirySql, [domain.id, '2027-02-01', 0]);
  await assert.rejects(db.query(expirySql, [domain.id, '2027-02-01', 0]), { code: '23505' });
  await db.query(expirySql, [domain.id, '2028-02-01', 30]);
  await assert.rejects(db.query(expirySql, [domain.id, null, 30]), { code: '23514' });
  await assert.rejects(db.query(expirySql, [domain.id, '2027-02-01', 13]), { code: '23514' });
  for (const source of ['manual_tls', 'observed_tls']) {
    await db.query("INSERT INTO lcit.alerts(kind,source,tls_endpoint_id,expiry_date,threshold_days) VALUES('expiry',$1,$2,'2027-02-01',30)", [source, tls.id]);
  }
  const transition = randomUUID();
  const transitionSql = `INSERT INTO lcit.alerts(kind,source,tls_endpoint_id,check_run_id,transition_key) VALUES($1,'tls',$2,$3,$4)`;
  await db.query(transitionSql, ['outage', tls.id, observation.id, transition]);
  await assert.rejects(db.query(transitionSql, ['outage', tls.id, observation.id, transition]), { code: '23505' });
  await db.query(transitionSql, ['recovery', tls.id, observation.id, randomUUID()]);
  await assert.rejects(db.query(transitionSql, ['outage', otherTls.id, observation.id, randomUUID()]), { code: '23503' });
  const notificationSql = 'INSERT INTO lcit.notifications(alert_id,recipient_id) VALUES($1,$2) RETURNING id';
  const { rows: [notification] } = await db.query(notificationSql, [alert.id, userIds.admin]);
  await assert.rejects(db.query(notificationSql, [alert.id, userIds.admin]), { code: '23505' });
  await db.query(notificationSql, [alert.id, userIds.leader]);
  await db.query('UPDATE lcit.notifications SET read_at=now() WHERE id=$1', [notification.id]);
  assert.ok((await db.query('SELECT read_at FROM lcit.notifications WHERE id=$1', [notification.id])).rows[0].read_at);

  process.env.MONITORING_ENABLED = 'off';
  const disabled = new MonitoringService(app.get(Database), new SchedulerRegistry());
  disabled.register('expiry', async () => { assert.fail('Disabled worker must not execute'); });
  assert.deepEqual(await disabled.run('expiry'), { status: 'skipped_disabled' });
  assert.equal((await disabled.list({ actor: { role: 'admin' } })).items[0].state, 'disabled');
  delete process.env.MONITORING_ENABLED;
  await secondService.onModuleDestroy();
  secondService = undefined;
  await app.close();
  app = undefined;
  assert.deepEqual(await monitoring.run('expiry'), { status: 'skipped_stopping' });
  // Simulate a process that disappeared after committing its start record.
  const { rows: [interrupted] } = await db.query(`WITH started AS (
    INSERT INTO lcit.monitoring_job_runs(job_key) VALUES('expiry') RETURNING id
  ) UPDATE lcit.monitoring_jobs SET last_run_id=started.id FROM started WHERE key='expiry' RETURNING started.id`);
  app = await startApp();
  const recovered = (await getJobs()).items.find((j) => j.key === 'expiry');
  assert.equal(recovered.lastRun.id, interrupted.id);
  assert.equal(recovered.lastRun.status, 'interrupted');
  assert.equal(recovered.lastRun.errorCode, 'PROCESS_INTERRUPTED');
  assert.equal(recovered.state, 'waiting_handler');
  assert.ok(recovered.lastSuccessAt);
});
