import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { requireAdmin, SessionRequest } from './access';
import { paged, PageRow, pagination } from '../shared/api-contract';
import { Database } from './database';

export interface AuditEvent {
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  relatedId?: string;
  outcome?: 'success' | 'denied' | 'failure';
  requestId: string;
}

export async function recordAudit(client: PoolClient, event: AuditEvent) {
  await client.query(`
    INSERT INTO lcit.audit_events (actor_id, action, target_type, target_id, related_id, outcome, request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [event.actorId, event.action, event.targetType, event.targetId, event.relatedId, event.outcome ?? 'success', event.requestId]);
}

@Injectable()
export class AuditService {
  constructor(private readonly db: Database) {}

  async list(request: SessionRequest, rawPage: unknown, rawSize: unknown) {
    requireAdmin(request.actor);
    const { page, pageSize, offset } = pagination(rawPage, rawSize);
    const { rows: [row] } = await this.db.query<PageRow>(`
      WITH slice AS (
        SELECT id::text, occurred_at AS "occurredAt", actor_id AS "actorId", action,
          target_type AS "targetType", target_id AS "targetId", related_id AS "relatedId", outcome, request_id AS "requestId"
        FROM lcit.audit_events ORDER BY lcit.audit_events.id DESC LIMIT $1 OFFSET $2
      )
      SELECT (SELECT count(*) FROM lcit.audit_events) AS total,
        COALESCE((SELECT json_agg(slice ORDER BY id::bigint DESC) FROM slice), '[]') AS items
    `, [pageSize, offset]);
    return paged(row, page, pageSize);
  }
}
