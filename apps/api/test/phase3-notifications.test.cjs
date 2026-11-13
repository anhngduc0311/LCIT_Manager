const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');

const databaseUrl = process.env.LCIT_TEST_DATABASE_URL;
test('T3.4: own read state, scope-filtered counts, exact DNS access, revocation and persisted notifications', {
  skip: databaseUrl ? false : 'Set LCIT_TEST_DATABASE_URL to an empty disposable PostgreSQL database.', timeout: 120000,
}, async (context) => {
  const db = new Pool({ connectionString: databaseUrl });
  let app, ownsSchema = false;
  const oldEnv = { DATABASE_URL: process.env.DATABASE_URL, MONITORING_ENABLED: process.env.MONITORING_ENABLED, MONITORING_TIME_ZONE: process.env.MONITORING_TIME_ZONE };
  context.after(async () => {
    await app?.close();
    if (ownsSchema) await db.query('DROP SCHEMA IF EXISTS lcit CASCADE');
    await db.end();
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  assert.equal((await db.query("SELECT to_regnamespace('lcit') AS schema")).rows[0].schema, null, 'Use an empty disposable test database.');
  ownsSchema = true;
  const migrated = spawnSync(process.execPath, ['dist/migrate.js'], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 20000 });
  assert.equal(migrated.status, 0, migrated.stderr);
  process.env.DATABASE_URL = databaseUrl;
  process.env.MONITORING_ENABLED = 'off';
  process.env.MONITORING_TIME_ZONE = 'Asia/Ho_Chi_Minh';
  const { sha256 } = require('../dist/models/access');
  const { ExpiryMonitorService } = require('../dist/models/expiry-monitor.service');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../dist/app.module');
  const { ApiExceptionFilter } = require('../dist/shared/api-contract');
  const users = {};
  for (const [name, role] of [['admin','admin'],['admin-two','admin'],['leader-a','leader'],['leader-b','leader'],['specialist-a','specialist'],['specialist-b','specialist'],['new-specialist','specialist']]) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO lcit.users(id,username,display_name,password_hash,role) VALUES($1,$2,$2,'test-hash',$3)", [id, name, role]);
    await db.query("INSERT INTO lcit.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [sha256(token), id]);
    users[name] = { id, token };
  }
  const { rows: [orgA] } = await db.query("INSERT INTO lcit.organizations(code,name) VALUES('A','A') RETURNING id");
  const { rows: [orgB] } = await db.query("INSERT INTO lcit.organizations(code,name) VALUES('B','B') RETURNING id");
  const { rows: [appA] } = await db.query("INSERT INTO lcit.applications(code,name,organization_id,service_type) VALUES('A','A',$1,'operations') RETURNING id", [orgA.id]);
  const { rows: [appB] } = await db.query("INSERT INTO lcit.applications(code,name,organization_id,service_type) VALUES('B','B',$1,'operations') RETURNING id", [orgB.id]);
  await db.query('INSERT INTO lcit.user_organizations(user_id,organization_id) VALUES($1,$2),($3,$4)', [users['leader-a'].id, orgA.id, users['leader-b'].id, orgB.id]);
  await db.query('INSERT INTO lcit.app_assignments(user_id,application_id) VALUES($1,$2),($3,$4)', [users['specialist-a'].id, appA.id, users['specialist-b'].id, appB.id]);
  async function domain(name, applicationIds, archived = false) {
    const { rows: [row] } = await db.query(`INSERT INTO lcit.domains(name,renewal_date,archived_at)
      VALUES($1,'2026-11-20',CASE WHEN $2 THEN now() ELSE NULL END) RETURNING id,name`, [name, archived]);
    for (const applicationId of applicationIds) await db.query('INSERT INTO lcit.app_domains(application_id,domain_id) VALUES($1,$2)', [applicationId, row.id]);
    return row;
  }
  const domainA = await domain('a.example.test', [appA.id]);
  const domainB = await domain('b.example.test', [appB.id]);
  const shared = await domain('shared.example.test', [appA.id,appB.id]);
  await domain('unlinked.example.test', []);
  await domain('archived.example.test', [appA.id], true);
  await db.query("INSERT INTO lcit.tls_endpoints(domain_id,host,port,manual_expiry_date) VALUES($1,'private-endpoint.example.test',8443,'2026-11-20')", [shared.id]);
  const worker = new ExpiryMonitorService({ config: { timeZone: 'Asia/Ho_Chi_Minh' } });
  const at = new Date('2026-11-13T03:00:00Z');
  async function generate() {
    const client = await db.connect();
    try { return await worker.reconcile({ client, runId: randomUUID() }, at); }
    finally { client.release(); }
  }
  assert.equal((await generate()).alertsCreated, 5);
  assert.deepEqual(await generate(), { alertsCreated: 0, notificationsCreated: 0 });
  const { rows: [job] } = await db.query("INSERT INTO lcit.monitoring_job_runs(job_key,status,finished_at) VALUES('dns_tls','succeeded',now()) RETURNING id");
  const dnsAlerts = {};
  for (const [suffix, applicationId, recipients] of [
    ['a', appA.id, ['admin','admin-two','leader-a','specialist-a']],
    ['b', appB.id, ['admin','admin-two','leader-b','specialist-b','specialist-a']],
  ]) {
    const { rows: [record] } = await db.query("INSERT INTO lcit.dns_records(domain_id,host,type,target) VALUES($1,$2,'A','10.1.2.3') RETURNING id", [shared.id, `${suffix}.shared.example.test`]);
    await db.query('INSERT INTO lcit.app_dns_records(application_id,dns_record_id) VALUES($1,$2)', [applicationId, record.id]);
    const { rows: [check] } = await db.query("INSERT INTO lcit.check_runs(job_run_id,check_type,dns_record_id,status,error_code) VALUES($1,'dns',$2,'dns_error','DNS_LOOKUP_FAILED') RETURNING id", [job.id, record.id]);
    const { rows: [alert] } = await db.query("INSERT INTO lcit.alerts(kind,source,dns_record_id,check_run_id,transition_key) VALUES('outage','dns',$1,$2,$2) RETURNING id", [record.id, check.id]);
    dnsAlerts[suffix] = alert.id;
    // The extra B notification for specialist A models a stale/legacy delivery: read-time filtering must still hide it.
    for (const name of recipients) await db.query('INSERT INTO lcit.notifications(alert_id,recipient_id) VALUES($1,$2)', [alert.id, users[name].id]);
  }
  async function start() {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1');
  }
  await start();
  async function call(route, user = 'admin', body, expected = 200) {
    const response = await fetch(`${await app.getUrl()}/api/v1${route}`, {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: { ...(users[user] ? { Authorization: `Bearer ${users[user].token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  await call('/notifications', 'anonymous', undefined, 401);
  await call('/alerts', 'anonymous', undefined, 401);
  for (const [name, total] of [['admin',7],['admin-two',7],['leader-a',4],['leader-b',4],['specialist-a',4],['specialist-b',4],['new-specialist',0]]) {
    const inbox = await call('/notifications', name);
    assert.equal(inbox.total, total, name);
    assert.equal(inbox.unreadCount, total, name);
    assert.equal((await call('/alerts', name)).total, total, name);
    assert.ok(inbox.items.every((n) => n.readAt === null));
    assert.doesNotMatch(JSON.stringify(inbox), /private-endpoint|8443|10\.1\.2\.3/, 'Notification payload must not disclose administrative TLS configuration or resolved addresses.');
  }
  await call(`/alerts/${dnsAlerts.b}`, 'specialist-a', undefined, 404);
  const legacy = (await db.query('SELECT id FROM lcit.notifications WHERE alert_id=$1 AND recipient_id=$2', [dnsAlerts.b, users['specialist-a'].id])).rows[0];
  await call(`/notifications/${legacy.id}`, 'specialist-a', undefined, 404);
  await call(`/notifications/${legacy.id}`, 'specialist-a', { read: true }, 404);
  const own = (await call('/notifications', 'specialist-a')).items.find((n) => n.alert.kind === 'expiry' && n.alert.domainId === domainA.id);
  const other = (await call('/notifications', 'admin')).items[0];
  await call(`/notifications/${own.id}`, 'admin', undefined, 404);
  await call(`/notifications/${own.id}`, 'admin', { read: true }, 404);
  await call(`/notifications/${other.id}`, 'specialist-a', { read: true }, 404);
  const marked = await Promise.all(Array.from({ length: 4 }, () => call(`/notifications/${own.id}`, 'specialist-a', { read: true })));
  assert.ok(marked[0].readAt);
  assert.ok(marked.every((n) => n.readAt === marked[0].readAt));
  assert.equal((await call(`/notifications/${own.id}`, 'specialist-a')).readAt, marked[0].readAt);
  assert.equal((await call('/notifications?read=unread', 'specialist-a')).total, 3);
  assert.equal((await call('/notifications?read=read', 'specialist-a')).total, 1);
  assert.equal((await call('/notifications?read=read', 'specialist-a')).unreadCount, 3);
  assert.equal((await call('/notifications', 'admin')).unreadCount, 7, 'One user reading must not mark any other recipient read.');
  assert.equal((await call(`/notifications/${own.id}`, 'specialist-a', { read: false })).readAt, null);
  assert.equal((await call('/notifications?source=dns', 'specialist-a')).total, 1);
  assert.equal((await call(`/notifications?domainId=${shared.id}`, 'specialist-a')).total, 3);
  assert.equal((await call('/alerts?kind=outage', 'specialist-a')).total, 1);
  assert.equal((await call(`/alerts?domainId=${domainB.id}`, 'specialist-a')).total, 0);
  for (const query of ['page=0','pageSize=101','read=maybe','source=bad','kind=bad','domainId=bad']) await call(`/notifications?${query}`, 'admin', undefined, 400);
  for (const body of [{}, { read: 'true' }, { read: true, recipientId: users.admin.id }]) await call(`/notifications/${own.id}`, 'specialist-a', body, 400);
  await call('/notifications/bad-id', 'admin', { read: true }, 400);
  await call(`/notifications/${randomUUID()}`, 'admin', { read: true }, 404);
  // Tied timestamps must have a deterministic ID tie-breaker, without duplicates across pages.
  await db.query("UPDATE lcit.notifications SET created_at='2026-11-13T00:00:00Z'");
  const page1 = await call('/notifications?pageSize=3&page=1');
  const page2 = await call('/notifications?pageSize=3&page=2');
  const page3 = await call('/notifications?pageSize=3&page=3');
  const ids = [...page1.items,...page2.items,...page3.items].map((n) => n.id);
  assert.equal(new Set(ids).size, 7);
  assert.deepEqual(ids, [...ids].sort().reverse());
  // Revoking an assignment immediately hides old delivery, detail, alert history, counts and updates.
  await db.query('DELETE FROM lcit.app_assignments WHERE user_id=$1', [users['specialist-a'].id]);
  assert.equal((await call('/notifications', 'specialist-a')).total, 0);
  assert.equal((await call('/notifications', 'specialist-a')).unreadCount, 0);
  assert.equal((await call('/alerts', 'specialist-a')).total, 0);
  await call(`/notifications/${own.id}`, 'specialist-a', undefined, 404);
  await call(`/notifications/${own.id}`, 'specialist-a', { read: true }, 404);
  await call(`/alerts/${own.alert.id}`, 'specialist-a', undefined, 404);
  await db.query('DELETE FROM lcit.user_organizations WHERE user_id=$1', [users['leader-a'].id]);
  assert.equal((await call('/notifications', 'leader-a')).total, 0);
  // Newly granted users see alert history but do not inherit another user's inbox or old deliveries.
  await db.query('INSERT INTO lcit.app_assignments(user_id,application_id) VALUES($1,$2)', [users['new-specialist'].id, appA.id]);
  assert.equal((await call('/alerts', 'new-specialist')).total, 4);
  assert.equal((await call('/notifications', 'new-specialist')).total, 0);
  await db.query('UPDATE lcit.domains SET renewal_date=$2 WHERE id=$1', [domainA.id, '2026-11-27']);
  await generate();
  const delivered = await call('/notifications', 'new-specialist');
  assert.equal(delivered.total, 1);
  const fresh = delivered.items[0];
  const receipt = await call(`/notifications/${fresh.id}`, 'new-specialist', { read: true });
  await app.close(); app = undefined;
  await start();
  const persisted = await call(`/notifications/${fresh.id}`, 'new-specialist');
  assert.equal(persisted.readAt, receipt.readAt);
  assert.equal(persisted.alert.id, fresh.alert.id);
  assert.equal((await call('/notifications?read=unread', 'new-specialist')).total, 0);
  // Current role, current links and archived resources are checked rather than trusting historical recipients.
  await db.query("UPDATE lcit.users SET role='leader' WHERE id=$1", [users['new-specialist'].id]);
  assert.equal((await call('/notifications', 'new-specialist')).total, 0);
  await db.query('DELETE FROM lcit.app_domains WHERE application_id=$1 AND domain_id=$2', [appB.id, domainB.id]);
  assert.equal((await call(`/alerts?domainId=${domainB.id}`, 'leader-b')).total, 0);
  await db.query('UPDATE lcit.domains SET archived_at=now() WHERE id=$1', [shared.id]);
  assert.equal((await call(`/notifications?domainId=${shared.id}`, 'admin')).total, 0);
  await call(`/alerts/${dnsAlerts.a}`, 'admin', undefined, 404);
  await db.query("UPDATE lcit.users SET status='locked' WHERE id=$1", [users['specialist-b'].id]);
  await call('/notifications', 'specialist-b', undefined, 401);
  const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
  const docs = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
  for (const route of ['/api/v1/notifications','/api/v1/notifications/{id}','/api/v1/alerts','/api/v1/alerts/{id}']) assert.ok(docs.paths[route]);
});
