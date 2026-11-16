const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');

const databaseUrl = process.env.LCIT_TEST_DATABASE_URL;
test('T4.1: endpoint grants, assignment scope, exact stored destinations and committed authorization audit', {
  skip: databaseUrl ? false : 'Set LCIT_TEST_DATABASE_URL to an empty disposable PostgreSQL database.', timeout: 180000,
}, async (context) => {
  const db = new Pool({ connectionString: databaseUrl });
  let app, ownsSchema = false;
  const oldEnv = { DATABASE_URL: process.env.DATABASE_URL, MONITORING_ENABLED: process.env.MONITORING_ENABLED };
  context.after(async () => {
    await app?.close();
    if (ownsSchema) await db.query('DROP SCHEMA IF EXISTS lcit CASCADE');
    await db.end();
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  assert.equal((await db.query("SELECT to_regnamespace('lcit') AS schema")).rows[0].schema, null, 'Use an empty disposable test database.');
  ownsSchema = true;
  for (let i = 0; i < 2; i++) {
    const migration = spawnSync(process.execPath, ['dist/migrate.js'], { cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60000 });
    assert.equal(migration.status, 0, migration.stderr || migration.error?.code);
    assert.match(migration.stdout, i ? /up to date/ : /008_access_endpoint_grants.sql/);
  }
  process.env.DATABASE_URL = databaseUrl;
  process.env.MONITORING_ENABLED = 'off';
  const { sha256 } = require('../dist/models/access');
  const users = {};
  for (const [name, role, status] of [['admin','admin','active'],['admin-other','admin','active'],['specialist-a','specialist','active'],
    ['specialist-b','specialist','active'],['leader','leader','active'],['locked','specialist','locked'],['deleted','specialist','active']]) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO lcit.users(id,username,display_name,password_hash,role,status,deleted_at) VALUES($1,$2,$2,'test-hash',$3,$4,CASE WHEN $2='deleted' THEN now() ELSE NULL END)", [id, name, role, status]);
    await db.query("INSERT INTO lcit.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [sha256(token), id]);
    users[name] = { id, token };
  }
  const { rows: [orgA] } = await db.query("INSERT INTO lcit.organizations(code,name) VALUES('A','A') RETURNING id");
  const { rows: [orgB] } = await db.query("INSERT INTO lcit.organizations(code,name) VALUES('B','B') RETURNING id");
  const { rows: [appA] } = await db.query("INSERT INTO lcit.applications(code,name,organization_id,service_type) VALUES('A','A',$1,'operations') RETURNING id", [orgA.id]);
  const { rows: [appB] } = await db.query("INSERT INTO lcit.applications(code,name,organization_id,service_type) VALUES('B','B',$1,'operations') RETURNING id", [orgB.id]);
  await db.query('INSERT INTO lcit.app_assignments(user_id,application_id) VALUES($1,$2),($3,$4)', [users['specialist-a'].id, appA.id, users['specialist-b'].id, appB.id]);
  await db.query('INSERT INTO lcit.user_organizations(user_id,organization_id) VALUES($1,$2)', [users.leader.id, orgA.id]);
  const { rows: [dc] } = await db.query("INSERT INTO lcit.data_centers(code,name) VALUES('DC','DC') RETURNING id");
  async function server(code, applications) {
    const { rows: [row] } = await db.query('INSERT INTO lcit.servers(code,hostname,data_center_id) VALUES($1,$2,$3) RETURNING id', [code, `${code.toLowerCase()}.example.test`, dc.id]);
    for (const application of applications) await db.query('INSERT INTO lcit.app_servers(application_id,server_id) VALUES($1,$2)', [application, row.id]);
    return row.id;
  }
  async function endpoint(serverId, protocol, host, port) {
    const { rows: [row] } = await db.query('INSERT INTO lcit.access_endpoints(server_id,protocol,host,port) VALUES($1,$2,$3,$4) RETURNING id', [serverId, protocol, host, port]);
    return row.id;
  }
  const serverA = await server('SRV-A', [appA.id]), serverB = await server('SRV-B', [appB.id]), shared = await server('SHARED', [appA.id,appB.id]);
  const sshA = await endpoint(serverA, 'ssh', '10.42.0.15', 2222), sshB = await endpoint(serverB, 'ssh', '10.42.0.15', 2222);
  const rdpA = await endpoint(serverA, 'rdp', '2001:db8::22', 3390), notGranted = await endpoint(serverA, 'ssh', 'srv-a.example.test', 22);
  const sharedRdp = await endpoint(shared, 'rdp', 'shared.example.test', 3389);
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../dist/app.module');
  const { ApiExceptionFilter } = require('../dist/shared/api-contract');
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  async function call(route, user = 'admin', method = 'GET', body, expected = 200) {
    const response = await fetch(`${await app.getUrl()}/api/v1${route}`, { method,
      headers: { ...(users[user] ? { Authorization: `Bearer ${users[user].token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(), result = text ? JSON.parse(text) : null;
    assert.equal(response.status, expected, text);
    if (route.endsWith('/launch') && expected === 200) {
      assert.equal(result.authorizationId, response.headers.get('x-request-id'));
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    return result;
  }
  const launch = (id, user = 'specialist-a', expected = 200, body) => call(`/access-endpoints/${id}/launch`, user, 'POST', body, expected);
  const grant = (user, id, expected = 204) => call(`/users/${users[user].id}/access-endpoints/${id}`, 'admin', 'PUT', undefined, expected);
  const revoke = (user, id) => call(`/users/${users[user].id}/access-endpoints/${id}`, 'admin', 'DELETE', undefined, 204);
  await launch(sshA, 'anonymous', 401);
  await launch(sshA, 'admin', 403);
  await launch(sshA, 'specialist-a', 403);
  const outside = await launch(sshA, 'specialist-b', 404);
  const unknown = await launch(randomUUID(), 'specialist-b', 404);
  assert.equal(outside.code, unknown.code); assert.equal(outside.message, unknown.message);
  assert.doesNotMatch(JSON.stringify(outside), /10\.42|2222|SRV/);
  await launch(sshA, 'leader', 403);
  await launch(sshA, 'locked', 401);
  await launch(sshA, 'deleted', 401);
  await grant('leader', sshA, 409);
  await grant('locked', sshA, 409);
  await grant('deleted', sshA, 404);
  await grant('specialist-b', sshA, 409);
  await call(`/users/${users['specialist-a'].id}/access-endpoints/${sshA}`, 'specialist-a', 'PUT', undefined, 403);
  assert.equal((await call(`/servers/${serverA}/access-endpoints`, 'specialist-a')).total, 0);
  const adminList = await call(`/servers/${serverA}/access-endpoints`);
  assert.equal(adminList.total, 3); assert.ok(adminList.items.every((e) => !e.canLaunch));
  await call(`/servers/${serverA}/access-endpoints`, 'specialist-b', 'GET', undefined, 404);
  await call(`/servers/${serverA}/access-endpoints`, 'leader', 'GET', undefined, 403);
  await grant('admin', sshA);
  await grant('specialist-a', sshA);
  await grant('specialist-a', sshA); // Idempotent: no second grant audit.
  await grant('specialist-a', rdpA);
  await grant('specialist-b', sshB);
  const received = await launch(sshA);
  assert.deepEqual({ serverId: received.serverId, protocol: received.protocol, host: received.host, port: received.port }, { serverId: serverA, protocol: 'ssh', host: '10.42.0.15', port: 2222 });
  assert.ok(received.authorizedAt);
  const rdp = await launch(rdpA);
  assert.deepEqual([rdp.protocol,rdp.host,rdp.port], ['rdp','2001:db8::22',3390]);
  await launch(sshA, 'admin');
  await launch(sshA, 'admin-other', 403);
  await launch(sshB, 'specialist-a', 404, undefined); // Same IP/cross-scope must not grant access.
  await launch(notGranted, 'specialist-a', 403);
  assert.equal((await call(`/servers/${serverA}/access-endpoints`, 'specialist-a')).total, 2);
  for (const body of [{ host: 'evil.test' }, { port: 22 }, { protocol: 'rdp' }, { command: 'powershell' }, { authorizationId: received.authorizationId }]) await launch(sshA, 'specialist-a', 400, body);
  await launch('bad-id', 'specialist-a', 400);
  const authorization = (await db.query("SELECT actor_id,target_id,related_id,outcome FROM lcit.audit_events WHERE request_id=$1 AND action='access.launch.authorize'", [received.authorizationId])).rows[0];
  assert.deepEqual(authorization, { actor_id: users['specialist-a'].id, target_id: sshA, related_id: serverA, outcome: 'success' });
  assert.equal((await db.query("SELECT count(*) FROM lcit.audit_events WHERE action='access.grant.grant' AND target_id=$1 AND related_id=$2", [users['specialist-a'].id, sshA])).rows[0].count, '1');
  assert.ok(Number((await db.query("SELECT count(*) FROM lcit.audit_events WHERE action='access.launch.authorize' AND outcome='denied'")).rows[0].count) >= 8);
  // Refuse to release a destination when recording its authorization fails.
  await db.query(`CREATE FUNCTION lcit.reject_access_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='access.launch.authorize' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_access BEFORE INSERT ON lcit.audit_events FOR EACH ROW EXECUTE FUNCTION lcit.reject_access_audit()`);
  const failed = await launch(sshA, 'specialist-a', 500);
  assert.equal(failed.host, undefined);
  await db.query('DROP TRIGGER reject_access ON lcit.audit_events');
  await revoke('specialist-a', sshA); await revoke('specialist-a', sshA);
  await launch(sshA, 'specialist-a', 403);
  await grant('specialist-a', sshA);
  // Editing a destination invalidates its bound grant, even though its ID is unchanged.
  await db.query('UPDATE lcit.access_endpoints SET port=2223 WHERE id=$1', [sshA]);
  await launch(sshA, 'specialist-a', 403);
  assert.equal((await call(`/users/${users['specialist-a'].id}/access-endpoints`)).items.find((e) => e.endpointId === sshA).isCurrent, false);
  await grant('specialist-a', sshA);
  assert.equal((await launch(sshA)).port, 2223);
  // Shared server access still requires a separate explicit grant for each account.
  await grant('specialist-a', sharedRdp); await grant('specialist-b', sharedRdp);
  await launch(sharedRdp, 'specialist-a'); await launch(sharedRdp, 'specialist-b');
  await db.query('DELETE FROM lcit.app_assignments WHERE user_id=$1', [users['specialist-a'].id]);
  await launch(sshA, 'specialist-a', 404); await launch(sharedRdp, 'specialist-a', 404);
  await launch(sharedRdp, 'specialist-b');
  await db.query('INSERT INTO lcit.app_assignments(user_id,application_id) VALUES($1,$2)', [users['specialist-a'].id, appA.id]);
  await db.query('UPDATE lcit.applications SET archived_at=now() WHERE id=$1', [appA.id]);
  await launch(sshA, 'specialist-a', 404);
  await db.query('UPDATE lcit.applications SET archived_at=NULL WHERE id=$1', [appA.id]);
  await db.query('UPDATE lcit.servers SET archived_at=now() WHERE id=$1', [serverA]);
  await launch(sshA, 'specialist-a', 404); await launch(sshA, 'admin', 404);
  await db.query('UPDATE lcit.servers SET archived_at=NULL WHERE id=$1', [serverA]);
  // Defend against invalid legacy stored data even if it has a matching raw grant.
  await db.query("UPDATE lcit.access_endpoints SET host='-oProxyCommand=evil' WHERE id=$1", [sshA]);
  await db.query(`UPDATE lcit.access_endpoint_grants SET endpoint_config=jsonb_build_object('serverId',$3::uuid,'protocol','ssh','host','-oProxyCommand=evil','port',2223)
    WHERE user_id=$1 AND endpoint_id=$2`, [users['specialist-a'].id, sshA, serverA]);
  await launch(sshA, 'specialist-a', 503);
  assert.equal((await db.query("SELECT outcome FROM lcit.audit_events WHERE target_id=$1 AND action='access.launch.authorize' ORDER BY id DESC LIMIT 1", [sshA])).rows[0].outcome, 'failure');
  await db.query("UPDATE lcit.access_endpoints SET host='10.42.0.15' WHERE id=$1", [sshA]);
  await grant('specialist-a', sshA);
  // Role changes clear grants, preventing them from reappearing after another role change.
  const version = (await db.query('SELECT version FROM lcit.users WHERE id=$1', [users['specialist-a'].id])).rows[0].version;
  await call(`/users/${users['specialist-a'].id}`, 'admin', 'PATCH', { version, role: 'leader' });
  assert.equal((await call(`/users/${users['specialist-a'].id}/access-endpoints`)).total, 0);
  await launch(rdpA, 'specialist-a', 403);
  await call(`/users/${users['specialist-b'].id}`, 'admin', 'DELETE', { version: 1 }, 204);
  assert.equal((await db.query('SELECT count(*) FROM lcit.access_endpoint_grants WHERE user_id=$1', [users['specialist-b'].id])).rows[0].count, '0');
  await launch(sharedRdp, 'specialist-b', 401);
  const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
  const docs = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
  assert.ok(docs.paths['/api/v1/access-endpoints/{id}/launch'].post);
  assert.ok(docs.paths['/api/v1/servers/{id}/access-endpoints'].get);
});
