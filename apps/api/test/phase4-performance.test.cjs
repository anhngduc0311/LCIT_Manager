const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { system } = require('./helpers/system.cjs');

const percentile = (sorted, p) => sorted[Math.ceil(sorted.length * p) - 1];
function stats(samples) {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  return { requests: sorted.length, errors: samples.filter((s) => s.error).length,
    p50Ms: +percentile(sorted, 0.5).toFixed(2), p95Ms: +percentile(sorted, 0.95).toFixed(2), maxMs: +sorted.at(-1).toFixed(2) };
}

test('T4.3 NFR-03: HTTP search p95 ≤ 1s; 10,000 applications, 20,000 servers, 20 concurrent users', {
  skip: process.env.LCIT_TEST_DATABASE_URL ? false : 'Requires LCIT_TEST_DATABASE_URL; use npm run test:t43 for acceptance.',
  timeout: 300000,
}, async (context) => {
  const { db, base } = await system(context);
  const { sha256 } = require('../dist/models/access');
  await db.query(`
    INSERT INTO lcit.organizations(code,name) VALUES('PERF-A','Performance A'),('PERF-B','Performance B');
    INSERT INTO lcit.data_centers(code,name) VALUES('PERF-DC-A','DC A'),('PERF-DC-B','DC B');
    INSERT INTO lcit.applications(code,name,organization_id,service_type)
      SELECT 'APP-'||g,'Benchmark application '||lpad(g::text,5,'0'),o.id,'operations'
      FROM generate_series(1,10000) g JOIN lcit.organizations o ON o.code=CASE WHEN g%2=0 THEN 'PERF-A' ELSE 'PERF-B' END;
    INSERT INTO lcit.servers(code,hostname,data_center_id)
      SELECT 'SRV-'||g,'srv'||g||'.perf.test',d.id FROM generate_series(1,20000) g
      JOIN lcit.data_centers d ON d.code=CASE WHEN g%2=0 THEN 'PERF-DC-A' ELSE 'PERF-DC-B' END;
    INSERT INTO lcit.server_addresses(server_id,address,network_scope,kind)
      SELECT s.id,'10.80.0.0'::inet+g,'PERF-LAN','private' FROM generate_series(1,20000) g JOIN lcit.servers s ON s.code='SRV-'||g;
    INSERT INTO lcit.app_servers(application_id,server_id)
      SELECT a.id,s.id FROM generate_series(1,20000) g JOIN lcit.servers s ON s.code='SRV-'||g
      JOIN lcit.applications a ON a.code='APP-'||((g+1)/2);
    INSERT INTO lcit.domains(name) SELECT 'app'||g||'.perf.test' FROM generate_series(1,10000) g;
    INSERT INTO lcit.app_domains(application_id,domain_id)
      SELECT a.id,d.id FROM generate_series(1,10000) g JOIN lcit.applications a ON a.code='APP-'||g
      JOIN lcit.domains d ON d.name='app'||g||'.perf.test';
  `);
  const actors = [];
  for (let i = 0; i < 20; i++) {
    const role = ['admin', 'leader', 'specialist'][i % 3], token = randomBytes(32).toString('base64url');
    const { rows: [user] } = await db.query(`INSERT INTO lcit.users(username,display_name,password_hash,role)
      VALUES($1,$1,'synthetic-session-only',$2) RETURNING id`, [`perf-user-${i}`, role]);
    await db.query("INSERT INTO lcit.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [sha256(token), user.id]);
    if (role === 'leader') await db.query("INSERT INTO lcit.user_organizations SELECT $1,id FROM lcit.organizations WHERE code='PERF-A'", [user.id]);
    if (role === 'specialist') await db.query("INSERT INTO lcit.app_assignments SELECT $1,id FROM lcit.applications WHERE substring(code from 5)::int%2=0", [user.id]);
    actors.push({ role, token });
  }
  await db.query('ANALYZE');
  const counts = (await db.query(`SELECT (SELECT count(*)::int FROM lcit.applications) AS applications,
    (SELECT count(*)::int FROM lcit.servers) AS servers,(SELECT count(*)::int FROM lcit.domains) AS domains`)).rows[0];
  assert.deepEqual(counts, { applications: 10000, servers: 20000, domains: 10000 });
  const cases = [
    { name: 'ip', q: '10.80.0.2', total: 1, scoped: 0, code: 'APP-1' },
    { name: 'hostname', q: 'srv1002.perf.test', total: 1, scoped: 0, code: 'APP-501' },
    { name: 'domain', q: 'APP500.PERF.TEST.', total: 1, scoped: 1, code: 'APP-500' },
    { name: 'application', q: 'Benchmark', total: 10000, scoped: 5000 },
    { name: 'organization', q: 'Performance A', total: 5000, scoped: 5000 },
    { name: 'no-match', q: 'does-not-exist.perf.test', total: 0, scoped: 0 },
    { name: 'pagination', q: 'Benchmark', total: 10000, scoped: 5000, page: 2 },
  ];
  async function request(actor, sample) {
    const start = performance.now();
    let error;
    try {
      const response = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(sample.q)}&page=${sample.page ?? 1}&pageSize=25`, {
        headers: { Authorization: `Bearer ${actor.token}` }, signal: AbortSignal.timeout(15000),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      const expected = actor.role === 'admin' ? sample.total : sample.scoped;
      assert.equal(body.total, expected);
      assert.equal(body.items.length, Math.min(expected, 25));
      assert.equal(body.page, sample.page ?? 1);
      if (sample.page === 2) assert.equal(body.items[0].code, actor.role === 'admin' ? 'APP-26' : 'APP-52');
      assert.equal(new Set(body.items.map((item) => item.id)).size, body.items.length);
      for (const item of body.items) {
        if (sample.code) assert.equal(item.code, sample.code);
        if (actor.role !== 'admin') assert.equal(Number(item.code.slice(4)) % 2, 0);
        assert.equal(item.servers.length, 2);
      }
    } catch (failure) { error = failure.code || failure.name || 'RequestFailed'; }
    return { kind: sample.name, role: actor.role, ms: performance.now() - start, ...(error ? { error } : {}) };
  }
  // Warm each shape for each authenticated user, outside the measured interval.
  for (const sample of cases) {
    const warm = await Promise.all(actors.map((actor) => request(actor, sample)));
    assert.ok(warm.every((r) => !r.error), `Warm-up failed: ${sample.name}`);
  }
  const started = new Date().toISOString(), clock = performance.now();
  const samples = (await Promise.all(actors.map(async (actor, index) => {
    const results = [];
    // Closed loop: every user keeps one request in flight, with no artificial think time.
    for (let j = 0; j < 35; j++) results.push(await request(actor, cases[(j + index) % cases.length]));
    return results;
  }))).flat();
  const elapsedMs = performance.now() - clock;
  const settings = (await db.query(`SELECT name,setting,unit FROM pg_settings WHERE name IN
    ('server_version','shared_buffers','max_connections','work_mem','effective_cache_size','jit') ORDER BY name`)).rows;
  const total = stats(samples);
  const byQuery = Object.fromEntries(cases.map((sample) => [sample.name, stats(samples.filter((s) => s.kind === sample.name))]));
  const report = { startedAt: started, revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout?.trim(),
    environment: { os: `${os.type()} ${os.release()}`, architecture: os.arch(), cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length, memoryGiB: +(os.totalmem() / 1024 ** 3).toFixed(2), node: process.version,
      postgres: settings, topology: 'API and PostgreSQL on the same Windows host, HTTP loopback, no TLS', apiPoolMax: 5 },
    workload: { ...counts, concurrentUsers: 20, roles: { admin: 7, leader: 7, specialist: 6 },
      warmupRequests: 140, measuredRequests: samples.length, pageSize: 25, model: 'closed-loop, one in-flight request per user, zero think time' },
    elapsedMs: +elapsedMs.toFixed(2), requestsPerSecond: +(samples.length * 1000 / elapsedMs).toFixed(2),
    total, byQuery, byRole: Object.fromEntries(['admin','leader','specialist'].map((role) => [role, stats(samples.filter((s) => s.role === role))])),
    passed: total.errors === 0 && total.p95Ms <= 1000 && Object.values(byQuery).every((group) => group.p95Ms <= 1000) };
  if (process.env.LCIT_PERFORMANCE_REPORT) await writeFile(process.env.LCIT_PERFORMANCE_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  context.diagnostic(JSON.stringify({ p95Ms: total.p95Ms, errors: total.errors, requests: total.requests, byQuery }));
  assert.equal(total.errors, 0, 'All timed requests must return correct, scoped results.');
  assert.ok(report.passed, `Search p95 exceeds 1000ms: ${JSON.stringify(byQuery)}`);
});
