import { Injectable, OnModuleInit } from '@nestjs/common';
import { domainNotificationScope } from './access';
import { MonitoringRunContext, MonitoringService } from './monitoring.service';

interface ExpiryResult { alertsCreated: number; notificationsCreated: number }

@Injectable()
export class ExpiryMonitorService implements OnModuleInit {
  constructor(private readonly monitoring: MonitoringService) {}

  onModuleInit() {
    this.monitoring.register('expiry', async (context) => { await this.reconcile(context); });
  }

  /** One statement gives the expiry snapshot, alerts and scoped recipients a single atomic boundary. */
  async reconcile({ client }: MonitoringRunContext, at = new Date()): Promise<ExpiryResult> {
    const { rows: [result] } = await client.query<ExpiryResult>(`
      WITH business_day AS (
        SELECT ($1::timestamptz AT TIME ZONE $2)::date AS today
      ), deadlines AS (
        SELECT d.id AS domain_id, NULL::uuid AS tls_endpoint_id, 'manual_domain'::text AS source,
          d.renewal_date AS expiry_date
        FROM lcit.domains d WHERE d.archived_at IS NULL AND d.renewal_date IS NOT NULL
        UNION ALL
        SELECT NULL::uuid, t.id, 'manual_tls', t.manual_expiry_date
        FROM lcit.tls_endpoints t JOIN lcit.domains d ON d.id=t.domain_id
        WHERE d.archived_at IS NULL AND t.manual_expiry_date IS NOT NULL
        UNION ALL
        SELECT NULL::uuid, t.id, 'observed_tls', (t.observed_expiry_at AT TIME ZONE $2)::date
        FROM lcit.tls_endpoints t JOIN lcit.domains d ON d.id=t.domain_id
        WHERE d.archived_at IS NULL AND t.observed_expiry_at IS NOT NULL
      ), due AS (
        SELECT deadlines.*, expiry_date - today AS days_remaining
        FROM deadlines CROSS JOIN business_day WHERE expiry_date - today <= 90
      ), new_alerts AS (
        INSERT INTO lcit.alerts (kind,source,domain_id,tls_endpoint_id,expiry_date,threshold_days)
        SELECT 'expiry',source,domain_id,tls_endpoint_id,expiry_date,
          CASE WHEN days_remaining < 0 THEN 0 WHEN days_remaining <= 7 THEN 7
            WHEN days_remaining <= 14 THEN 14 WHEN days_remaining <= 30 THEN 30 ELSE 90 END
        FROM due
        ON CONFLICT DO NOTHING
        RETURNING id,domain_id,tls_endpoint_id
      ), new_notifications AS (
        INSERT INTO lcit.notifications (alert_id,recipient_id)
        SELECT a.id,u.id FROM new_alerts a
        JOIN lcit.domains d ON d.id=COALESCE(a.domain_id,
          (SELECT t.domain_id FROM lcit.tls_endpoints t WHERE t.id=a.tls_endpoint_id))
        JOIN lcit.users u ON ${domainNotificationScope('d', 'u')}
        ON CONFLICT (alert_id,recipient_id) DO NOTHING
        RETURNING id
      )
      SELECT (SELECT count(*)::integer FROM new_alerts) AS "alertsCreated",
        (SELECT count(*)::integer FROM new_notifications) AS "notificationsCreated"
    `, [at.toISOString(), this.monitoring.config.timeZone]);
    return result;
  }
}
