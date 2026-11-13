import { Injectable, OnModuleInit } from '@nestjs/common';
import { domainNotificationScope } from './access';
import { MonitoringRunContext, MonitoringService } from './monitoring.service';
import { liveTargetsSql, MonitoringTarget, readLiveTarget, sameConfig } from './monitoring-targets.service';
import { NetworkProbe, ProbeResult, probeFailure } from './network-probe';

@Injectable()
export class NetworkMonitorService implements OnModuleInit {
  constructor(private readonly monitoring: MonitoringService, private readonly probe: NetworkProbe) {}

  onModuleInit() { this.monitoring.register('dns_tls', (context) => this.run(context)); }

  async run(context: MonitoringRunContext) {
    const { rows: targets } = await context.client.query<MonitoringTarget>(`${liveTargetsSql} AND mt.enabled ORDER BY mt.id`);
    // Network work is bounded and takes place outside all database transactions.
    for (let offset = 0; offset < targets.length; offset += this.probe.config.concurrency) {
      const batch = await Promise.all(targets.slice(offset, offset + this.probe.config.concurrency).map(async (target) => {
        const startedAt = new Date();
        const result = sameConfig(target.config, target.approved_config) ? await this.probe.check(target.config) :
          probeFailure('blocked', 'CONFIG_CHANGED');
        return { target, result, startedAt, finishedAt: new Date() };
      }));
      // The supplied connection owns the job lock; never overlap transactions on it.
      for (const item of batch) await this.save(context, item.target, item.result, item.startedAt, item.finishedAt);
    }
  }

  async save({ client, runId }: MonitoringRunContext, target: MonitoringTarget, result: ProbeResult, startedAt: Date, finishedAt: Date) {
    await client.query('BEGIN');
    try {
      const endpointId = target.dns_record_id ?? target.tls_endpoint_id!;
      const live = await readLiveTarget(client, target.check_type, endpointId, true);
      const { rows: [current] } = await client.query<MonitoringTarget>('SELECT * FROM lcit.monitoring_targets WHERE id=$1 FOR UPDATE', [target.id]);
      // Ignore a result if an administrator edited/disabled/archived the target while the request was in flight.
      if (!live || !current?.enabled || current.version !== target.version || !sameConfig(live.config, target.config)) {
        await client.query('COMMIT'); return;
      }
      const { rows: [check] } = await client.query<{ id: string }>(`INSERT INTO lcit.check_runs
        (job_run_id,check_type,dns_record_id,tls_endpoint_id,started_at,finished_at,status,resolved_addresses,observed_expiry_at,error_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
      [runId, target.check_type, target.dns_record_id, target.tls_endpoint_id, startedAt, finishedAt,
        result.status, result.addresses, result.observedExpiryAt, result.errorCode]);
      if (!check) { await client.query('COMMIT'); return; }
      const success = result.status === 'success', blocked = result.status === 'blocked';
      const failures = success || blocked ? 0 : Math.min(2, current.consecutive_failures + 1);
      const health = success ? 'up' : !blocked && failures === 2 ? 'down' : current.health;
      const kind = current.health !== 'down' && health === 'down' ? 'outage' : current.health === 'down' && success ? 'recovery' : null;
      await client.query(`UPDATE lcit.monitoring_targets SET health=$2,consecutive_failures=$3,last_check_run_id=$4 WHERE id=$1`, [target.id, health, failures, check.id]);
      if (target.check_type === 'tls' && result.observedExpiryAt && ['success','expired'].includes(result.status)) {
        await client.query('UPDATE lcit.tls_endpoints SET observed_expiry_at=$2 WHERE id=$1', [target.tls_endpoint_id, result.observedExpiryAt]);
      }
      if (kind) await client.query(`WITH event AS (
        INSERT INTO lcit.alerts(kind,source,dns_record_id,tls_endpoint_id,check_run_id,transition_key)
        VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING RETURNING id
      ) INSERT INTO lcit.notifications(alert_id,recipient_id)
        SELECT event.id,u.id FROM event JOIN lcit.domains d ON d.id=$6
        JOIN lcit.users u ON ${domainNotificationScope('d', 'u')}
        ON CONFLICT (alert_id,recipient_id) DO NOTHING`,
      [kind, target.check_type, target.dns_record_id, target.tls_endpoint_id, check.id, live.domain_id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
}
