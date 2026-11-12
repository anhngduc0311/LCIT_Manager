import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PoolClient } from 'pg';
import { accountStatuses, actorSchema, requireAdmin, roles, Role, SessionGuard, SessionRequest, usernameOf } from './access';
import { ApiError, bodyOf, choice, invalid, missing, paged, PageRow, pageSchema, pagination, requestId, stale, text, uuid, version } from './api-contract';
import { recordAudit } from './audit';
import { Database } from './database';
import { hashPassword, newPassword } from './password';

const fields = ['username', 'displayName', 'password', 'role', 'status', 'version'];
const projection = 'id, username, display_name AS "displayName", role, status, version';
const properties = {
  username: { type: 'string' }, displayName: { type: 'string' },
  password: { type: 'string', format: 'password', minLength: 12, maxLength: 256 },
  role: { type: 'string', enum: [...roles] }, status: { type: 'string', enum: [...accountStatuses] },
};
const userSchema = { ...actorSchema, required: [...actorSchema.required, 'status', 'version'], properties: {
  ...actorSchema.properties, status: properties.status, version: { type: 'integer' },
} };
const assignmentTypes = {
  organizations: { table: 'user_organizations', target: 'organizations', column: 'organization_id', role: 'leader' },
  applications: { table: 'app_assignments', target: 'applications', column: 'application_id', role: 'specialist' },
} as const;

async function lockUser(client: PoolClient, id: string) {
  const { rows: [row] } = await client.query<{ role: Role; version: number }>(
    'SELECT role, version FROM lcit.users WHERE id = $1 FOR UPDATE', [id],
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
      WITH data AS (SELECT ${projection} FROM lcit.users),
      slice AS (SELECT * FROM data ORDER BY username LIMIT $1 OFFSET $2)
      SELECT (SELECT count(*) FROM data) AS total,
        COALESCE((SELECT json_agg(slice ORDER BY username) FROM slice), '[]') AS items
    `, [pageSize, offset]);
    return paged(row, page, pageSize);
  }

  async get(request: SessionRequest, id: string) {
    requireAdmin(request.actor);
    const { rows: [user] } = await this.db.query(`SELECT ${projection} FROM lcit.users WHERE id = $1`, [uuid(id)]);
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

  async assignments(request: SessionRequest, rawId: string) {
    requireAdmin(request.actor);
    const id = uuid(rawId);
    const { rows: [row] } = await this.db.query(`
      SELECT ARRAY(SELECT organization_id FROM lcit.user_organizations WHERE user_id = u.id ORDER BY organization_id) AS "organizationIds",
        ARRAY(SELECT application_id FROM lcit.app_assignments WHERE user_id = u.id ORDER BY application_id) AS "applicationIds"
      FROM lcit.users u WHERE id = $1
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

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ schema: pageSchema(userSchema) })
  list(@Req() request: SessionRequest, @Query('page') page: unknown, @Query('pageSize') size: unknown) {
    return this.users.list(request, page, size);
  }

  @Get(':id')
  @ApiOkResponse({ schema: userSchema })
  get(@Req() request: SessionRequest, @Param('id') id: string) {
    return this.users.get(request, id);
  }

  @Post()
  @ApiBody({ schema: { type: 'object', properties, required: ['username', 'displayName', 'password', 'role'] } })
  @ApiCreatedResponse({ schema: userSchema })
  create(@Req() request: SessionRequest, @Body() body: unknown) {
    return this.users.create(request, body);
  }

  @Patch(':id')
  @ApiBody({ schema: { type: 'object', properties: { ...properties, version: { type: 'integer' } }, required: ['version'] } })
  @ApiOkResponse({ schema: userSchema })
  update(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.users.update(request, id, body);
  }

  @Get(':id/assignments')
  @ApiOkResponse({ schema: { type: 'object', required: ['organizationIds', 'applicationIds'], properties: {
    organizationIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
    applicationIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
  } } })
  assignments(@Req() request: SessionRequest, @Param('id') id: string) {
    return this.users.assignments(request, id);
  }

  @Put(':id/assignments/:type/:targetId')
  @HttpCode(204)
  @ApiParam({ name: 'type', enum: Object.keys(assignmentTypes) })
  grant(@Req() request: SessionRequest, @Param('id') id: string, @Param('type') type: string, @Param('targetId') target: string) {
    return this.users.assign(request, id, type, target, true);
  }

  @Delete(':id/assignments/:type/:targetId')
  @HttpCode(204)
  @ApiParam({ name: 'type', enum: Object.keys(assignmentTypes) })
  revoke(@Req() request: SessionRequest, @Param('id') id: string, @Param('type') type: string, @Param('targetId') target: string) {
    return this.users.assign(request, id, type, target, false);
  }
}
