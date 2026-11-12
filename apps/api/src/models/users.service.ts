import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { accountStatuses, requireAdmin, roles, Role, SessionRequest, usernameOf } from './access';
import { ApiError, bodyOf, choice, invalid, missing, paged, PageRow, pagination, requestId, stale, text, uuid, version } from '../shared/api-contract';
import { recordAudit } from './audit.service';
import { Database } from './database';
import { hashPassword, newPassword } from './password';

const fields = ['username', 'displayName', 'password', 'role', 'status', 'version'];
const projection = 'id, username, display_name AS "displayName", role, status, version';

export const assignmentTypes = {
  organizations: { table: 'user_organizations', target: 'organizations', column: 'organization_id', role: 'leader' },
  applications: { table: 'app_assignments', target: 'applications', column: 'application_id', role: 'specialist' },
} as const;

async function lockUser(client: PoolClient, id: string) {
  const { rows: [row] } = await client.query<{ role: Role; version: number }>(
    'SELECT role, version FROM lcit.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id],
  );
  if (!row) missing();
  return row;
}

@Injectable()
export class UsersService {
  constructor(private readonly db: Database) {}

  async list(request: SessionRequest, rawPage: unknown, rawSize: unknown) {
    requireAdmin(request.actor);
    const { page, pageSize, offset } = pagination(rawPage, rawSize);
    const { rows: [row] } = await this.db.query<PageRow>(`
      WITH data AS (SELECT ${projection} FROM lcit.users WHERE deleted_at IS NULL),
      slice AS (SELECT * FROM data ORDER BY username LIMIT $1 OFFSET $2)
      SELECT (SELECT count(*) FROM data) AS total,
        COALESCE((SELECT json_agg(slice ORDER BY username) FROM slice), '[]') AS items
    `, [pageSize, offset]);
    return paged(row, page, pageSize);
  }

  async get(request: SessionRequest, id: string) {
    requireAdmin(request.actor);
    const { rows: [user] } = await this.db.query(`SELECT ${projection} FROM lcit.users WHERE id = $1 AND deleted_at IS NULL`, [uuid(id)]);
    if (!user) missing();
    return user;
  }

  async create(request: SessionRequest, input: unknown) {
    requireAdmin(request.actor);
    const body = bodyOf(input, fields.filter((field) => field !== 'version'));
    const username = usernameOf(body.username);
    const displayName = text(body.displayName, 'displayName', 160);
    const role = choice(body.role, 'role', roles);
    const status = body.status === undefined ? 'active' : choice(body.status, 'status', accountStatuses);
    const hash = await hashPassword(newPassword(body.password));
    return this.db.transaction(async (client) => {
      const { rows: [user] } = await client.query(`
        INSERT INTO lcit.users (username, display_name, password_hash, role, status)
        VALUES ($1, $2, $3, $4, $5) RETURNING ${projection}
      `, [username, displayName, hash, role, status]);
      await recordAudit(client, { actorId: request.actor.id, action: 'user.create', targetType: 'user', targetId: user.id, requestId: requestId(request) });
      return user;
    });
  }

  async update(request: SessionRequest, rawId: string, input: unknown) {
    requireAdmin(request.actor);
    const id = uuid(rawId);
    const body = bodyOf(input, fields);
    const expected = version(body.version);
    if (Object.keys(body).length === 1) invalid('body', 'Provide a field to update.');
    const username = body.username === undefined ? null : usernameOf(body.username);
    const displayName = body.displayName === undefined ? null : text(body.displayName, 'displayName', 160);
    const role = body.role === undefined ? null : choice(body.role, 'role', roles);
    const status = body.status === undefined ? null : choice(body.status, 'status', accountStatuses);
    const hash = body.password === undefined ? null : await hashPassword(newPassword(body.password));
    return this.db.transaction(async (client) => {
      const existing = await lockUser(client, id);
      if (existing.version !== expected) stale();
      const { rows: [user] } = await client.query(`
        UPDATE lcit.users SET username = COALESCE($2, username), display_name = COALESCE($3, display_name),
          role = COALESCE($4, role), status = COALESCE($5, status), password_hash = COALESCE($6, password_hash), version = version + 1
        WHERE id = $1 RETURNING ${projection}
      `, [id, username, displayName, role, status, hash]);

      if (role && role !== existing.role) {
        await client.query('DELETE FROM lcit.user_organizations WHERE user_id = $1', [id]);
        await client.query('DELETE FROM lcit.app_assignments WHERE user_id = $1', [id]);
        await recordAudit(client, { actorId: request.actor.id, action: 'user.role.change', targetType: 'user', targetId: id, requestId: requestId(request) });
      }
      if (hash || status === 'locked') {
        await client.query('UPDATE lcit.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      }
      await recordAudit(client, { actorId: request.actor.id, action: 'user.update', targetType: 'user', targetId: id, requestId: requestId(request) });
      return user;
    });
  }

  async remove(request: SessionRequest, rawId: string, input: unknown) {
    const { actor } = request;
    requireAdmin(actor);
    const id = uuid(rawId);
    if (id === actor.id) throw new ApiError(409, 'SELF_DELETE', 'You cannot delete the account you are signed in with.');
    const expected = version(bodyOf(input, ['version']).version);

    await this.db.transaction(async (client) => {
      // Lock both accounts in ID order so two administrators cannot delete each other.
      const { rows } = await client.query<{ id: string; role: Role; status: string; version: number }>(`
        SELECT id, role, status, version FROM lcit.users
        WHERE id IN ($1, $2) AND deleted_at IS NULL ORDER BY id FOR UPDATE
      `, [actor.id, id]);
      const administrator = rows.find((row) => row.id === actor.id);
      if (!administrator || administrator.role !== 'admin' || administrator.status !== 'active') {
        throw new ApiError(403, 'FORBIDDEN', 'Administrator access is required.');
      }
      const target = rows.find((row) => row.id === id);
      if (!target) missing();
      if (target.version !== expected) stale();

      await client.query("UPDATE lcit.users SET deleted_at = now(), status = 'locked', version = version + 1 WHERE id = $1", [id]);
      await client.query('UPDATE lcit.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await client.query('DELETE FROM lcit.user_organizations WHERE user_id = $1', [id]);
      await client.query('DELETE FROM lcit.app_assignments WHERE user_id = $1', [id]);
      await client.query('DELETE FROM lcit.user_permissions WHERE user_id = $1', [id]);
      await recordAudit(client, { actorId: actor.id, action: 'user.delete', targetType: 'user', targetId: id, requestId: requestId(request) });
    });
  }

  async assignments(request: SessionRequest, rawId: string) {
    requireAdmin(request.actor);
    const id = uuid(rawId);
    const { rows: [row] } = await this.db.query(`
      SELECT ARRAY(SELECT organization_id FROM lcit.user_organizations WHERE user_id = u.id ORDER BY organization_id) AS "organizationIds",
        ARRAY(SELECT application_id FROM lcit.app_assignments WHERE user_id = u.id ORDER BY application_id) AS "applicationIds"
      FROM lcit.users u WHERE id = $1 AND deleted_at IS NULL
    `, [id]);
    if (!row) missing();
    return row;
  }

  async assign(request: SessionRequest, rawId: string, rawType: string, rawTarget: string, grant: boolean) {
    requireAdmin(request.actor);
    const id = uuid(rawId);
    const target = uuid(rawTarget, 'targetId');
    const type = choice(rawType, 'assignmentType', ['organizations', 'applications'] as const);
    const { table, target: targetTable, column, role } = assignmentTypes[type];
    await this.db.transaction(async (client) => {
      const user = await lockUser(client, id);
      if (grant && user.role !== role) throw new ApiError(409, 'ASSIGNMENT_ROLE', `This assignment requires role ${role}.`);
      if (grant) {
        const { rowCount } = await client.query(`SELECT id FROM lcit.${targetTable} WHERE id = $1 AND archived_at IS NULL FOR SHARE`, [target]);
        if (!rowCount) missing();
      }
      const result = grant
        ? await client.query(`INSERT INTO lcit.${table} (user_id, ${column}) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, target])
        : await client.query(`DELETE FROM lcit.${table} WHERE user_id = $1 AND ${column} = $2`, [id, target]);
      if (result.rowCount) {
        await recordAudit(client, {
          actorId: request.actor.id, action: `${type}.assignment.${grant ? 'grant' : 'revoke'}`,
          targetType: 'user', targetId: id, relatedId: target, requestId: requestId(request),
        });
      }
    });
  }
}
