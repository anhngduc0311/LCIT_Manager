import { Injectable } from '@nestjs/common';
import { applicationScope, domainScope, Role, SessionRequest } from './access';
import { Database } from './database';
import { bodyOf, choice, invalid, missing, pagination, uuid } from '../shared/api-contract';

const kinds = ['expiry', 'outage', 'recovery'] as const;
const sources = ['manual_domain', 'manual_tls', 'observed_tls', 'dns', 'tls'] as const;

// Use current assignments and current catalog links, even for alerts/notifications created long ago.
function visibleAlerts(role: Role) {
  const dnsScope = role === 'admin' ? '$1::uuid IS NOT NULL' : `EXISTS (
    SELECT 1 FROM lcit.app_dns_records rel JOIN lcit.applications app ON app.id=rel.application_id
    WHERE rel.dns_record_id=a.dns_record_id AND app.archived_at IS NULL AND ${applicationScope(role, 'app', '$1')})`;
  return `SELECT a.id,a.created_at AS "createdAt",a.kind,a.source,a.resource_type AS "resourceType",
    a.resource_id AS "resourceId",d.id AS "domainId",d.name AS "domainName",
    COALESCE(dns.host,d.name) AS "resourceLabel",a.expiry_date::text AS "expiryDate",a.threshold_days AS "thresholdDays",
    CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('status',c.status,'errorCode',c.error_code,'finishedAt',c.finished_at) END AS "check"
    FROM lcit.alerts a
    LEFT JOIN lcit.dns_records dns ON dns.id=a.dns_record_id
    LEFT JOIN lcit.tls_endpoints tls ON tls.id=a.tls_endpoint_id
    JOIN lcit.domains d ON d.id=COALESCE(a.domain_id,dns.domain_id,tls.domain_id)
    LEFT JOIN lcit.check_runs c ON c.id=a.check_run_id
    WHERE d.archived_at IS NULL AND (
      (a.dns_record_id IS NOT NULL AND ${dnsScope})
      OR (a.dns_record_id IS NULL AND ${domainScope(role, 'd', '$1')}))`;
}

function filters(query: Record<string, unknown>) {
  return {
    kind: query.kind === undefined ? null : choice(query.kind, 'kind', kinds),
    source: query.source === undefined ? null : choice(query.source, 'source', sources),
    domainId: query.domainId === undefined ? null : uuid(query.domainId, 'domainId'),
  };
}

@Injectable()
export class NotificationsService {
  constructor(private readonly db: Database) {}

  async alerts(request: SessionRequest, query: Record<string, unknown>) {
    const { page, pageSize, offset } = pagination(query.page, query.pageSize);
    const { kind, source, domainId } = filters(query);
    const { rows: [row] } = await this.db.query(`WITH visible AS (${visibleAlerts(request.actor.role)}), filtered AS (
      SELECT * FROM visible WHERE ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR source=$3)
        AND ($4::uuid IS NULL OR "domainId"=$4)
    ), slice AS (SELECT * FROM filtered ORDER BY "createdAt" DESC,id DESC LIMIT $5 OFFSET $6)
    SELECT (SELECT count(*)::integer FROM filtered) AS total,
      COALESCE((SELECT json_agg(slice ORDER BY "createdAt" DESC,id DESC) FROM slice),'[]') AS items`,
    [request.actor.id, kind, source, domainId, pageSize, offset]);
    return { ...row, page, pageSize };
  }

  async alert(request: SessionRequest, rawId: unknown) {
    const id = uuid(rawId);
    const { rows: [row] } = await this.db.query(`WITH visible AS (${visibleAlerts(request.actor.role)}) SELECT * FROM visible WHERE id=$2`, [request.actor.id, id]);
    if (!row) missing();
    return row;
  }

  async list(request: SessionRequest, query: Record<string, unknown>) {
    const { page, pageSize, offset } = pagination(query.page, query.pageSize);
    const read = query.read === undefined ? 'all' : choice(query.read, 'read', ['all', 'unread', 'read'] as const);
    const { kind, source, domainId } = filters(query);
    const { rows: [row] } = await this.db.query(`WITH visible AS (${visibleAlerts(request.actor.role)}), owned AS (
      SELECT n.id,n.created_at AS "createdAt",n.read_at AS "readAt",to_jsonb(a) AS alert
      FROM lcit.notifications n JOIN visible a ON a.id=n.alert_id
      WHERE n.recipient_id=$1 AND ($2::text IS NULL OR a.kind=$2) AND ($3::text IS NULL OR a.source=$3)
        AND ($4::uuid IS NULL OR a."domainId"=$4)
    ), filtered AS (SELECT * FROM owned WHERE $5='all' OR ($5='unread' AND "readAt" IS NULL) OR ($5='read' AND "readAt" IS NOT NULL)),
    slice AS (SELECT * FROM filtered ORDER BY "createdAt" DESC,id DESC LIMIT $6 OFFSET $7)
    SELECT (SELECT count(*)::integer FROM filtered) AS total,
      (SELECT count(*)::integer FROM owned WHERE "readAt" IS NULL) AS "unreadCount",
      COALESCE((SELECT json_agg(slice ORDER BY "createdAt" DESC,id DESC) FROM slice),'[]') AS items`,
    [request.actor.id, kind, source, domainId, read, pageSize, offset]);
    return { ...row, page, pageSize };
  }

  async detail(request: SessionRequest, rawId: unknown) {
    const id = uuid(rawId);
    const { rows: [row] } = await this.db.query(`WITH visible AS (${visibleAlerts(request.actor.role)})
      SELECT n.id,n.created_at AS "createdAt",n.read_at AS "readAt",to_jsonb(a) AS alert
      FROM lcit.notifications n JOIN visible a ON a.id=n.alert_id WHERE n.recipient_id=$1 AND n.id=$2`, [request.actor.id, id]);
    if (!row) missing();
    return row;
  }

  async markRead(request: SessionRequest, rawId: unknown, input: unknown) {
    const id = uuid(rawId), body = bodyOf(input, ['read']);
    if (typeof body.read !== 'boolean') invalid('read', 'Expected a boolean.');
    const { rows: [row] } = await this.db.query(`WITH visible AS (${visibleAlerts(request.actor.role)})
      UPDATE lcit.notifications n SET read_at=CASE WHEN $3 THEN COALESCE(n.read_at,now()) ELSE NULL END
      WHERE n.id=$2 AND n.recipient_id=$1 AND EXISTS (SELECT 1 FROM visible a WHERE a.id=n.alert_id)
      RETURNING n.id,n.created_at AS "createdAt",n.read_at AS "readAt"`, [request.actor.id, id, body.read]);
    if (!row) missing();
    return row;
  }
}
