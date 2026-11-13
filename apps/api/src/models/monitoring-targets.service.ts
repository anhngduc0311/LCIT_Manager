import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { requireAdmin, SessionRequest } from './access';
import { recordAudit } from './audit.service';
import { Database } from './database';
import { ProbeTarget } from './network-probe';
import { bodyOf, choice, invalid, missing, pagination, requestId, stale, uuid, version } from '../shared/api-contract';

export type CheckType = 'dns' | 'tls';
export const checkType = (value: unknown) => choice(value, 'type', ['dns', 'tls'] as const);
export const targetDefinition = (type: CheckType) => type === 'dns' ? { table: 'dns_records', fk: 'dns_record_id' } : { table: 'tls_endpoints', fk: 'tls_endpoint_id' };
const dnsConfig = (alias: string) => `jsonb_build_object('type','dns','host',${alias}.host,'recordType',${alias}.type,'target',${alias}.target)`;
const tlsConfig = (alias: string) => `jsonb_build_object('type','tls','host',${alias}.host,'port',${alias}.port,'sni',${alias}.sni)`;
export const liveTargetsSql = `SELECT mt.*,d.id AS domain_id,
  CASE WHEN mt.check_type='dns' THEN ${dnsConfig('dns')} ELSE ${tlsConfig('tls')} END AS config
  FROM lcit.monitoring_targets mt
  LEFT JOIN lcit.dns_records dns ON dns.id=mt.dns_record_id
  LEFT JOIN lcit.tls_endpoints tls ON tls.id=mt.tls_endpoint_id
  JOIN lcit.domains d ON d.id=COALESCE(dns.domain_id,tls.domain_id)
  WHERE d.archived_at IS NULL`;

export interface MonitoringTarget {
  id: string; check_type: CheckType; dns_record_id: string | null; tls_endpoint_id: string | null;
  enabled: boolean; version: number; config: ProbeTarget; approved_config: ProbeTarget; domain_id: string;
  health: 'unknown' | 'up' | 'down'; consecutive_failures: number; last_check_run_id: string | null;
}
export async function readLiveTarget(client: PoolClient, type: CheckType, id: string, lock = false) {
  const definition = targetDefinition(type);
  const { rows: [row] } = await client.query<{ config: ProbeTarget; domain_id: string }>(`SELECT d.id AS domain_id,
    ${type === 'dns' ? dnsConfig('e') : tlsConfig('e')} AS config
    FROM lcit.${definition.table} e JOIN lcit.domains d ON d.id=e.domain_id
    WHERE e.id=$1 AND d.archived_at IS NULL ${lock ? 'FOR SHARE OF e,d' : ''}`, [id]);
  return row;
}
export const sameConfig = (a: ProbeTarget, b: ProbeTarget) =>
  ['type', 'host', 'recordType', 'target', 'port', 'sni'].every((key) => a[key as keyof ProbeTarget] === b[key as keyof ProbeTarget]);

@Injectable()
export class MonitoringTargetsService {
  constructor(private readonly db: Database) {}

  async approve(request: SessionRequest, rawType: unknown, rawId: unknown, input: unknown) {
    requireAdmin(request.actor);
    const type = checkType(rawType), id = uuid(rawId), definition = targetDefinition(type);
    const body = bodyOf(input, ['version', 'enabled']);
    if (typeof body.enabled !== 'boolean') invalid('enabled', 'Expected a boolean.');
    const expected = body.version === 0 ? 0 : version(body.version);
    return this.db.transaction(async (client) => {
      const live = await readLiveTarget(client, type, id, true);
      if (!live) missing();
      const { rows: [existing] } = await client.query(`SELECT id,version FROM lcit.monitoring_targets WHERE ${definition.fk}=$1 FOR UPDATE`, [id]);
      if ((existing?.version ?? 0) !== expected) stale();
      const { rows: [target] } = existing ? await client.query(`UPDATE lcit.monitoring_targets SET enabled=$2,approved_config=$3,
        approved_by=$4,approved_at=now(),version=version+1,health='unknown',consecutive_failures=0,last_check_run_id=NULL
        WHERE id=$1 RETURNING id,version,enabled`, [existing.id, body.enabled, JSON.stringify(live.config), request.actor.id]) :
        await client.query(`INSERT INTO lcit.monitoring_targets(check_type,${definition.fk},enabled,approved_config,approved_by)
          VALUES($1,$2,$3,$4,$5) RETURNING id,version,enabled`, [type, id, body.enabled, JSON.stringify(live.config), request.actor.id]);
      await recordAudit(client, { actorId: request.actor.id, action: 'monitoring.targets.update', targetType: 'monitoring_targets',
        targetId: target.id, relatedId: id, requestId: requestId(request) });
      return { ...target, config: live.config };
    });
  }

  async list(request: SessionRequest, rawPage: unknown, rawSize: unknown) {
    requireAdmin(request.actor);
    const { page, pageSize, offset } = pagination(rawPage, rawSize);
    const { rows: [row] } = await this.db.query(`WITH targets AS (${liveTargetsSql}), slice AS (
      SELECT t.id,t.check_type AS type,COALESCE(t.dns_record_id,t.tls_endpoint_id) AS "endpointId",t.enabled,t.version,
        t.config,t.approved_by AS "approvedBy",t.approved_at AS "approvedAt",(t.config<>t.approved_config) AS "needsApproval",
        t.health,t.consecutive_failures AS "consecutiveFailures",
        CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'status',c.status,'errorCode',c.error_code,
          'finishedAt',c.finished_at,'observedExpiryAt',c.observed_expiry_at) END AS "lastCheck"
      FROM targets t LEFT JOIN lcit.check_runs c ON c.id=t.last_check_run_id ORDER BY t.id LIMIT $1 OFFSET $2
    ) SELECT (SELECT count(*)::integer FROM targets) AS total,
      COALESCE((SELECT json_agg(slice ORDER BY id) FROM slice),'[]') AS items`, [pageSize, offset]);
    return { ...row, page, pageSize };
  }

  async history(request: SessionRequest, rawType: unknown, rawId: unknown, rawPage: unknown, rawSize: unknown) {
    requireAdmin(request.actor);
    const type = checkType(rawType), id = uuid(rawId), { fk } = targetDefinition(type);
    const { page, pageSize, offset } = pagination(rawPage, rawSize);
    return this.db.transaction(async (client) => {
      if (!await readLiveTarget(client, type, id)) missing();
      const { rows: [row] } = await client.query(`WITH checks AS (SELECT id,status,error_code AS "errorCode",job_run_id AS "jobRunId",
        started_at AS "startedAt",finished_at AS "finishedAt",observed_expiry_at AS "observedExpiryAt",
        resolved_addresses AS "resolvedAddresses" FROM lcit.check_runs WHERE ${fk}=$1), slice AS (
        SELECT * FROM checks ORDER BY "finishedAt" DESC,id DESC LIMIT $2 OFFSET $3
      ) SELECT (SELECT count(*)::integer FROM checks) AS total,
        COALESCE((SELECT json_agg(slice ORDER BY "finishedAt" DESC,id DESC) FROM slice),'[]') AS items`, [id, pageSize, offset]);
      return { ...row, page, pageSize };
    });
  }
}
