import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Actor, requireAdmin, Role, serverScope, SessionRequest } from './access';
import { recordAudit } from './audit.service';
import { Database } from './database';
import { host, port } from './network-input';
import { ApiError, bodyOf, choice, missing, pagination, requestId, uuid } from '../shared/api-contract';

const endpointConfig = (alias: string) => `jsonb_build_object('serverId',${alias}.server_id,'protocol',${alias}.protocol,'host',${alias}.host,'port',${alias}.port)`;
const grantMatches = (endpoint: string, user: string) => `EXISTS (SELECT 1 FROM lcit.access_endpoint_grants g
  WHERE g.endpoint_id=${endpoint}.id AND g.user_id=${user} AND g.endpoint_config=${endpointConfig(endpoint)})`;

/** Lock the actual account/session until the authorization audit commits; account and assignment changes serialize on the user. */
async function currentActor(client: PoolClient, request: SessionRequest): Promise<Actor> {
  const { rows: [actor] } = await client.query<Actor>(`SELECT u.id,u.username,u.display_name AS "displayName",u.role
    FROM lcit.users u JOIN lcit.sessions s ON s.user_id=u.id
    WHERE u.id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
      AND u.status='active' AND u.deleted_at IS NULL FOR SHARE OF u,s`, [request.actor.id, request.sessionHash]);
  if (!actor) throw new ApiError(401, 'INVALID_SESSION', 'Sign in to continue.');
  return actor;
}

@Injectable()
export class AccessLaunchService {
  constructor(private readonly db: Database) {}

  async launch(request: SessionRequest, rawId: unknown, input: unknown) {
    let id: string;
    try { id = uuid(rawId); bodyOf(input === undefined ? {} : input, []); }
    catch (error) {
      await this.db.transaction((client) => recordAudit(client, { actorId: request.actor.id,
        action: 'access.launch.authorize', targetType: 'access_endpoints', outcome: 'denied', requestId: requestId(request) }));
      throw error;
    }
    const decision = await this.db.transaction(async (client) => {
      const actor = await currentActor(client, request);
      let error: ApiError | undefined;
      let endpoint: { id: string; serverId: string; protocol: string; host: string; port: number } | undefined;
      let outcome: 'success' | 'denied' | 'failure' = 'denied';
      if (actor.role === 'leader') error = new ApiError(403, 'CONNECTION_NOT_PERMITTED', 'This role cannot launch connections.');
      else {
        const { rows: [row] } = await client.query(`SELECT e.id,e.server_id AS "serverId",e.protocol,e.host,e.port
          FROM lcit.access_endpoints e JOIN lcit.servers srv ON srv.id=e.server_id
          WHERE e.id=$2 AND srv.archived_at IS NULL AND ${serverScope(actor.role, 'srv', '$1')}
          FOR SHARE OF e,srv`, [actor.id, id]);
        if (!row) error = new ApiError(404, 'NOT_FOUND', 'Resource not found.');
        else {
          const { rowCount } = await client.query(`SELECT endpoint_id FROM lcit.access_endpoint_grants
            WHERE user_id=$1 AND endpoint_id=$2 AND endpoint_config=$3::jsonb FOR SHARE`,
          [actor.id, id, JSON.stringify({ serverId: row.serverId, protocol: row.protocol, host: row.host, port: row.port })]);
          if (!rowCount) error = new ApiError(403, 'CONNECTION_GRANT_REQUIRED', 'An administrator must grant access to the current endpoint configuration.');
          else {
            try {
              endpoint = { id, serverId: row.serverId, protocol: choice(row.protocol, 'protocol', ['ssh','rdp']), host: host(row.host), port: port(row.port) };
              outcome = 'success';
            } catch {
              outcome = 'failure';
              error = new ApiError(503, 'ACCESS_ENDPOINT_INVALID', 'The stored endpoint configuration must be corrected by an administrator.');
            }
          }
        }
      }
      await recordAudit(client, { actorId: actor.id, action: 'access.launch.authorize', targetType: 'access_endpoints',
        targetId: id, relatedId: endpoint?.serverId, outcome, requestId: requestId(request) });
      return { error, endpoint, authorizedAt: new Date().toISOString() };
    });
    // Throw only after the denial audit has committed. Audit failure prevents releasing the destination.
    if (decision.error) throw decision.error;
    return { authorizationId: requestId(request), endpointId: decision.endpoint!.id, serverId: decision.endpoint!.serverId,
      protocol: decision.endpoint!.protocol, host: decision.endpoint!.host, port: decision.endpoint!.port, authorizedAt: decision.authorizedAt };
  }

  async listEndpoints(request: SessionRequest, rawServer: unknown, rawPage: unknown, rawSize: unknown) {
    if (request.actor.role === 'leader') throw new ApiError(403, 'CONNECTION_NOT_PERMITTED', 'This role cannot launch connections.');
    const serverId = uuid(rawServer), { page, pageSize, offset } = pagination(rawPage, rawSize);
    const { rows: [row] } = await this.db.query(`WITH server AS (
      SELECT srv.id FROM lcit.servers srv WHERE srv.id=$2 AND srv.archived_at IS NULL AND ${serverScope(request.actor.role, 'srv', '$1')}
    ), endpoints AS (SELECT e.id,e.server_id AS "serverId",e.protocol,e.host,e.port,${grantMatches('e', '$1')} AS "canLaunch"
      FROM lcit.access_endpoints e JOIN server ON server.id=e.server_id
      ${request.actor.role === 'admin' ? '' : `WHERE ${grantMatches('e', '$1')}`}
    ), slice AS (SELECT * FROM endpoints ORDER BY protocol,id LIMIT $3 OFFSET $4)
    SELECT EXISTS(SELECT 1 FROM server) AS visible,(SELECT count(*)::integer FROM endpoints) AS total,
      COALESCE((SELECT json_agg(slice ORDER BY protocol,id) FROM slice),'[]') AS items`, [request.actor.id, serverId, pageSize, offset]);
    if (!row.visible) missing();
    return { items: row.items, total: row.total, page, pageSize };
  }

  async grants(request: SessionRequest, rawUser: unknown, rawPage: unknown, rawSize: unknown) {
    requireAdmin(request.actor);
    const userId = uuid(rawUser), { page, pageSize, offset } = pagination(rawPage, rawSize);
    const { rows: [row] } = await this.db.query(`WITH account AS (SELECT id FROM lcit.users WHERE id=$1 AND deleted_at IS NULL),
      grants AS (SELECT e.id AS "endpointId",e.server_id AS "serverId",e.protocol,e.host,e.port,
        g.granted_by AS "grantedBy",g.granted_at AS "grantedAt",(g.endpoint_config=${endpointConfig('e')}) AS "isCurrent"
        FROM lcit.access_endpoint_grants g JOIN lcit.access_endpoints e ON e.id=g.endpoint_id WHERE g.user_id=$1),
      slice AS (SELECT * FROM grants ORDER BY "endpointId" LIMIT $2 OFFSET $3)
    SELECT EXISTS(SELECT 1 FROM account) AS visible,(SELECT count(*)::integer FROM grants) AS total,
      COALESCE((SELECT json_agg(slice ORDER BY "endpointId") FROM slice),'[]') AS items`, [userId, pageSize, offset]);
    if (!row.visible) missing();
    return { items: row.items, total: row.total, page, pageSize };
  }

  async changeGrant(request: SessionRequest, rawUser: unknown, rawEndpoint: unknown, grant: boolean, input: unknown) {
    requireAdmin(request.actor);
    bodyOf(input === undefined ? {} : input, []);
    const userId = uuid(rawUser, 'userId'), endpointId = uuid(rawEndpoint, 'endpointId');
    await this.db.transaction(async (client) => {
      requireAdmin(await currentActor(client, request));
      const { rows: [user] } = await client.query<{ role: Role; status: string }>('SELECT role,status FROM lcit.users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [userId]);
      if (!user) missing();
      const { rows: [endpoint] } = await client.query(`SELECT ${endpointConfig('e')} AS config,srv.archived_at,
        ${serverScope(user.role, 'srv', '$2')} AS visible
        FROM lcit.access_endpoints e JOIN lcit.servers srv ON srv.id=e.server_id WHERE e.id=$1 FOR SHARE OF e,srv`, [endpointId, userId]);
      if (!endpoint) missing();
      if (grant) {
        if (user.role === 'leader' || user.status !== 'active') throw new ApiError(409, 'CONNECTION_ACCOUNT_INELIGIBLE', 'Choose an active administrator or specialist.');
        if (endpoint.archived_at || !endpoint.visible) throw new ApiError(409, 'CONNECTION_TARGET_OUT_OF_SCOPE', 'Choose an active server within the account scope.');
        choice(endpoint.config.protocol, 'protocol', ['ssh','rdp']); host(endpoint.config.host); port(endpoint.config.port);
      }
      const result = grant ? await client.query(`INSERT INTO lcit.access_endpoint_grants(user_id,endpoint_id,endpoint_config,granted_by)
        VALUES($1,$2,$3,$4) ON CONFLICT(user_id,endpoint_id) DO UPDATE SET endpoint_config=excluded.endpoint_config,
          granted_by=excluded.granted_by,granted_at=now()
        WHERE lcit.access_endpoint_grants.endpoint_config<>excluded.endpoint_config RETURNING endpoint_id`,
      [userId, endpointId, JSON.stringify(endpoint.config), request.actor.id]) :
        await client.query('DELETE FROM lcit.access_endpoint_grants WHERE user_id=$1 AND endpoint_id=$2 RETURNING endpoint_id', [userId, endpointId]);
      if (result.rowCount) await recordAudit(client, { actorId: request.actor.id, action: `access.grant.${grant ? 'grant' : 'revoke'}`,
        targetType: 'users', targetId: userId, relatedId: endpointId, requestId: requestId(request) });
    });
  }
}
