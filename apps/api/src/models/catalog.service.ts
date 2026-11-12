import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Actor, applicationDomainIds, applicationScope, requireAdmin, serverScope, SessionRequest } from './access';
import { ApiError, bodyOf, choice, invalid, missing, paged, PageRow, pagination, requestId, stale, text, uuid, version } from '../shared/api-contract';
import { recordAudit } from './audit.service';
import { Database } from './database';

const statuses = ['active', 'inactive'] as const;
const serviceTypes = ['ordered', 'monitoring', 'operations'] as const;

const sharedFields = {
  code: { column: 'code', schema: { type: 'string', maxLength: 64 }, parse: (value: unknown) => {
    const code = text(value, 'code', 64).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(code)) invalid('code', 'Use ASCII letters, numbers, dots, underscores or hyphens.');
    return code;
  } },
  name: { column: 'name', schema: { type: 'string', maxLength: 200 }, parse: (value: unknown) => text(value, 'name', 200) },
  description: { column: 'description', schema: { type: 'string', nullable: true, maxLength: 4000 }, parse: (value: unknown) => value === null ? null : text(value, 'description', 4000) },
};
const ownedFields = {
  ...sharedFields,
  organizationId: { column: 'organization_id', schema: { type: 'string', format: 'uuid' }, parse: (value: unknown) => uuid(value, 'organizationId') },
  ownerId: { column: 'owner_id', schema: { type: 'string', format: 'uuid', nullable: true }, parse: (value: unknown) => value === null ? null : uuid(value, 'ownerId') },
  status: { column: 'status', schema: { type: 'string', enum: [...statuses] }, parse: (value: unknown) => choice(value, 'status', statuses) },
};

export const collections = {
  organizations: { table: 'organizations', fields: sharedFields, required: ['code', 'name'] },
  'data-centers': { table: 'data_centers', fields: sharedFields, required: ['code', 'name'] },
  applications: {
    table: 'applications', required: ['code', 'name', 'organizationId', 'serviceType'],
    fields: { ...ownedFields, serviceType: {
      column: 'service_type', schema: { type: 'string', enum: [...serviceTypes] }, parse: (value: unknown) => choice(value, 'serviceType', serviceTypes),
    } },
  },
  databases: {
    table: 'databases', required: ['code', 'name', 'organizationId', 'engine'],
    fields: { ...ownedFields, engine: {
      column: 'engine', schema: { type: 'string', maxLength: 80 }, parse: (value: unknown) => text(value, 'engine', 80),
    } },
  },
};

export type Kind = keyof typeof collections;
type Values = { key: string; column: string; value: string | null }[];

function projection(kind: Kind, alias?: string) {
  const prefix = alias ? `${alias}.` : '';
  const fields = Object.entries(collections[kind].fields).map(([name, { column }]) => `${prefix}${column} AS "${name}"`);
  return [`${prefix}id`, ...fields, `${prefix}version`, `${prefix}archived_at AS "archivedAt"`].join(', ');
}

function scope(kind: Kind, actor: Actor, alias: string) {
  if (actor.role === 'admin' || kind === 'applications') return applicationScope(actor.role, alias, '$1');
  if (kind === 'data-centers') {
    return `EXISTS (SELECT 1 FROM lcit.servers srv WHERE srv.data_center_id = ${alias}.id
      AND srv.archived_at IS NULL AND ${serverScope(actor.role, 'srv', '$1')})`;
  }
  if (actor.role === 'leader') {
    const orgId = kind === 'organizations' ? `${alias}.id` : `${alias}.organization_id`;
    return `EXISTS (SELECT 1 FROM lcit.user_organizations uo
      JOIN lcit.organizations org ON org.id = uo.organization_id AND org.archived_at IS NULL
      WHERE uo.user_id = $1 AND uo.organization_id = ${orgId})`;
  }
  const relation = kind === 'databases'
    ? `EXISTS (SELECT 1 FROM lcit.app_databases rel WHERE rel.database_id = ${alias}.id AND rel.application_id = app.id)`
    : `app.organization_id = ${alias}.id`;
  return `EXISTS (SELECT 1 FROM lcit.applications app WHERE app.archived_at IS NULL
    AND ${applicationScope(actor.role, 'app', '$1')} AND ${relation})`;
}

function parseValues(kind: Kind, input: unknown, creating: boolean) {
  const { fields, required } = collections[kind];
  const entries = Object.entries(fields);
  const allowed = entries.map(([key]) => key);
  const body = bodyOf(input, creating ? allowed : [...allowed, 'version']);
  const values: Values = [];
  for (const [key, field] of entries) {
    if (Object.hasOwn(body, key)) values.push({ key, column: field.column, value: field.parse(body[key]) });
    else if (creating && required.includes(key)) invalid(key, 'Required.');
  }
  if (values.length === 0) invalid('body', 'Provide at least one catalog field.');
  return { values, body };
}

async function validateReferences(client: PoolClient, values: Values) {
  const org = values.find(({ key }) => key === 'organizationId');
  if (org) {
    const { rowCount } = await client.query('SELECT id FROM lcit.organizations WHERE id = $1 AND archived_at IS NULL FOR SHARE', [org.value]);
    if (!rowCount) invalid('organizationId', 'Choose an organization that is not archived.');
  }
  const owner = values.find(({ key }) => key === 'ownerId');
  if (owner?.value) {
    const { rowCount } = await client.query('SELECT id FROM lcit.users WHERE id = $1 FOR KEY SHARE', [owner.value]);
    if (!rowCount) invalid('ownerId', 'Choose an existing account.');
  }
}

async function lockCatalog(client: PoolClient, kind: Kind, actor: Actor, id: string, expected: number) {
  const { rows: [row] } = await client.query<{ version: number }>(`
    SELECT item.version FROM lcit.${collections[kind].table} item
    WHERE item.id = $2 AND item.archived_at IS NULL AND ${scope(kind, actor, 'item')} FOR UPDATE
  `, [actor.id, id]);
  if (!row) missing();
  if (row.version !== expected) stale();
}

@Injectable()
export class CatalogService {
  constructor(private readonly db: Database) {}

  async list(kind: Kind, request: SessionRequest, rawPage: unknown, rawSize: unknown) {
    const { page, pageSize, offset } = pagination(rawPage, rawSize);
    const { rows: [row] } = await this.db.query<PageRow>(`
      WITH data AS (SELECT ${projection(kind, 'item')} FROM lcit.${collections[kind].table} item
        WHERE item.archived_at IS NULL AND ${scope(kind, request.actor, 'item')}),
      slice AS (SELECT * FROM data ORDER BY name, id LIMIT $2 OFFSET $3)
      SELECT (SELECT count(*) FROM data) AS total,
        COALESCE((SELECT json_agg(slice ORDER BY name, id) FROM slice), '[]') AS items
    `, [request.actor.id, pageSize, offset]);
    return paged(row, page, pageSize);
  }

  async detail(kind: Kind, request: SessionRequest, rawId: string) {
    const id = uuid(rawId);
    const owner = kind === 'applications' || kind === 'databases' ? `,
      (SELECT u.display_name FROM lcit.users u WHERE u.id = item.owner_id) AS "ownerDisplayName"` : '';
    const databases = kind === 'applications' ? `, ARRAY(
      SELECT db.id FROM lcit.app_databases rel JOIN lcit.databases db ON db.id = rel.database_id
      WHERE rel.application_id = item.id AND db.archived_at IS NULL AND ${scope('databases', request.actor, 'db')}
      ORDER BY db.id) AS "databaseIds",
      ARRAY(SELECT s.id FROM lcit.app_servers rel JOIN lcit.servers s ON s.id = rel.server_id
        WHERE rel.application_id = item.id AND s.archived_at IS NULL ORDER BY s.hostname, s.id) AS "serverIds",
      ARRAY(SELECT d.id FROM (${applicationDomainIds('item')}) rel JOIN lcit.domains d ON d.id = rel.domain_id
        WHERE d.archived_at IS NULL ORDER BY d.name, d.id) AS "domainIds",
      ARRAY(SELECT d.id FROM lcit.app_domains rel JOIN lcit.domains d ON d.id = rel.domain_id
        WHERE rel.application_id = item.id AND d.archived_at IS NULL ORDER BY d.name, d.id) AS "directDomainIds",
      ARRAY(SELECT dns.id FROM lcit.app_dns_records rel JOIN lcit.dns_records dns ON dns.id = rel.dns_record_id
        JOIN lcit.domains d ON d.id = dns.domain_id AND d.archived_at IS NULL
        WHERE rel.application_id = item.id ORDER BY dns.host, dns.id) AS "dnsRecordIds"` : '';
    const { rows: [row] } = await this.db.query(`
      SELECT ${projection(kind, 'item')}${owner}${databases} FROM lcit.${collections[kind].table} item
      WHERE item.id = $2 AND item.archived_at IS NULL AND ${scope(kind, request.actor, 'item')}
    `, [request.actor.id, id]);
    if (!row) missing();
    return row;
  }

  async create(kind: Kind, request: SessionRequest, input: unknown) {
    requireAdmin(request.actor);
    const { values } = parseValues(kind, input, true);
    return this.db.transaction(async (client) => {
      await validateReferences(client, values);
      const { rows: [row] } = await client.query(`
        INSERT INTO lcit.${collections[kind].table} (${values.map(({ column }) => column).join(', ')})
        VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING ${projection(kind)}
      `, values.map(({ value }) => value));
      await recordAudit(client, { actorId: request.actor.id, action: 'catalog.create', targetType: kind, targetId: row.id, requestId: requestId(request) });
      return row;
    });
  }

  async update(kind: Kind, request: SessionRequest, rawId: string, input: unknown) {
    const { actor } = request;
    const specialistEdit = kind === 'applications' && actor.role === 'specialist';
    if (!specialistEdit) requireAdmin(actor);
    const id = uuid(rawId);
    const { values, body } = parseValues(kind, input, false);
    const expected = version(body.version);
    if (specialistEdit && values.some(({ key }) => !['name', 'description', 'status'].includes(key))) {
      throw new ApiError(403, 'FORBIDDEN_FIELDS', 'These fields require administrator access.');
    }
    return this.db.transaction(async (client) => {
      await validateReferences(client, values);
      await lockCatalog(client, kind, actor, id, expected);
      const updates = values.map(({ column }, index) => `${column} = $${index + 2}`).join(', ');
      const { rows: [row] } = await client.query(`
        UPDATE lcit.${collections[kind].table} SET ${updates}, version = version + 1
        WHERE id = $1 RETURNING ${projection(kind)}
      `, [id, ...values.map(({ value }) => value)]);
      await recordAudit(client, { actorId: actor.id, action: 'catalog.update', targetType: kind, targetId: id, requestId: requestId(request) });
      return row;
    });
  }

  async archive(kind: Kind, request: SessionRequest, rawId: string, input: unknown) {
    requireAdmin(request.actor);
    const id = uuid(rawId);
    const expected = version(bodyOf(input, ['version']).version);
    return this.db.transaction(async (client) => {
      await lockCatalog(client, kind, request.actor, id, expected);
      const { rows: [row] } = await client.query(`
        UPDATE lcit.${collections[kind].table} SET archived_at = now(), version = version + 1
        WHERE id = $1 RETURNING ${projection(kind)}
      `, [id]);
      await recordAudit(client, { actorId: request.actor.id, action: 'catalog.archive', targetType: kind, targetId: id, requestId: requestId(request) });
      return row;
    });
  }

  async linkDatabase(request: SessionRequest, rawApplication: string, rawDatabase: string, input: unknown, link: boolean) {
    requireAdmin(request.actor);
    const appId = uuid(rawApplication);
    const databaseId = uuid(rawDatabase, 'databaseId');
    const expected = version(bodyOf(input, ['version']).version);
    return this.db.transaction(async (client) => {
      await lockCatalog(client, 'applications', request.actor, appId, expected);
      if (link) {
        const { rowCount } = await client.query('SELECT id FROM lcit.databases WHERE id = $1 AND archived_at IS NULL FOR SHARE', [databaseId]);
        if (!rowCount) missing();
      }
      const changed = link
        ? await client.query('INSERT INTO lcit.app_databases (application_id, database_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [appId, databaseId])
        : await client.query('DELETE FROM lcit.app_databases WHERE application_id = $1 AND database_id = $2', [appId, databaseId]);
      if (!changed.rowCount) return { version: expected };
      await client.query('UPDATE lcit.applications SET version = version + 1 WHERE id = $1', [appId]);
      await recordAudit(client, {
        actorId: request.actor.id, action: link ? 'catalog.database.link' : 'catalog.database.unlink',
        targetType: 'applications', targetId: appId, relatedId: databaseId, requestId: requestId(request),
      });
      return { version: expected + 1 };
    });
  }
}
