import { createHash } from 'node:crypto';
import { ApiError, ApiRequest, invalid, text } from '../shared/api-contract';

export const roles = ['admin', 'leader', 'specialist'] as const;
export const accountStatuses = ['active', 'locked'] as const;
export type Role = typeof roles[number];

export interface Actor {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

export const actorSchema = { type: 'object', required: ['id', 'username', 'displayName', 'role'], properties: {
  id: { type: 'string', format: 'uuid' }, username: { type: 'string' }, displayName: { type: 'string' },
  role: { type: 'string', enum: [...roles] },
} };

export interface SessionRequest extends ApiRequest {
  actor: Actor;
  sessionHash: string;
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function usernameOf(value: unknown) {
  const username = text(value, 'username', 64, 3).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) invalid('username', 'Use ASCII letters, numbers, dots, underscores or hyphens.');
  return username;
}

export function requireAdmin(actor: Actor) {
  if (actor.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Administrator access is required.');
}

// Aliases and parameter positions are supplied by API code. The UUID is always a query parameter.
export function applicationScope(role: Role, alias: string, actorParam: string) {
  if (role === 'admin') return `${actorParam}::uuid IS NOT NULL`;
  if (role === 'leader') return `EXISTS (SELECT 1 FROM lcit.user_organizations uo
    JOIN lcit.organizations org ON org.id = uo.organization_id AND org.archived_at IS NULL
    WHERE uo.user_id = ${actorParam} AND uo.organization_id = ${alias}.organization_id)`;
  return `EXISTS (SELECT 1 FROM lcit.app_assignments aa
    WHERE aa.user_id = ${actorParam} AND aa.application_id = ${alias}.id)`;
}

export function serverScope(role: Role, alias: string, actorParam: string) {
  if (role === 'admin') return `${actorParam}::uuid IS NOT NULL`;
  return `EXISTS (SELECT 1 FROM lcit.app_servers rel JOIN lcit.applications app ON app.id = rel.application_id
    WHERE rel.server_id = ${alias}.id AND app.archived_at IS NULL AND ${applicationScope(role, 'app', actorParam)})`;
}

export function domainScope(role: Role, alias: string, actorParam: string) {
  if (role === 'admin') return `${actorParam}::uuid IS NOT NULL`;
  return `EXISTS (SELECT 1 FROM lcit.applications app
    WHERE app.archived_at IS NULL AND ${applicationScope(role, 'app', actorParam)} AND ${domainLinkedToApplication(alias, 'app')})`;
}

export function domainLinkedToApplication(domain: string, app: string) {
  return `(EXISTS (SELECT 1 FROM lcit.app_domains rel WHERE rel.application_id = ${app}.id AND rel.domain_id = ${domain}.id)
      OR EXISTS (SELECT 1 FROM lcit.app_dns_records rel JOIN lcit.dns_records dns ON dns.id = rel.dns_record_id
        WHERE rel.application_id = ${app}.id AND dns.domain_id = ${domain}.id)
      OR EXISTS (SELECT 1 FROM lcit.app_servers rel JOIN lcit.domain_servers ds ON ds.server_id = rel.server_id
        JOIN lcit.servers srv ON srv.id = ds.server_id AND srv.archived_at IS NULL
        WHERE rel.application_id = ${app}.id AND ds.domain_id = ${domain}.id))`;
}

export function applicationDomainIds(app: string) {
  return `SELECT rel.domain_id FROM lcit.app_domains rel WHERE rel.application_id = ${app}.id
    UNION SELECT dns.domain_id FROM lcit.app_dns_records rel JOIN lcit.dns_records dns ON dns.id = rel.dns_record_id
      WHERE rel.application_id = ${app}.id
    UNION SELECT ds.domain_id FROM lcit.app_servers rel
      JOIN lcit.servers srv ON srv.id = rel.server_id AND srv.archived_at IS NULL
      JOIN lcit.domain_servers ds ON ds.server_id = srv.id WHERE rel.application_id = ${app}.id`;
}
