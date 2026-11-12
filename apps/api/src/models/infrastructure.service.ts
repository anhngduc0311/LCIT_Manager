import { Injectable } from '@nestjs/common';
import { isIP } from 'node:net';
import { PoolClient } from 'pg';
import { applicationScope, domainLinkedToApplication, domainScope, requireAdmin, serverScope, SessionRequest } from './access';
import { ApiError, bodyOf, choice, invalid, missing, paged, PageRow, pagination, requestId, stale, text, uuid, version } from '../shared/api-contract';
import { recordAudit } from './audit.service';
import { Database } from './database';
import { dateOnly, dnsOwner, domainName, host, port } from './network-input';

export type Collection = 'servers' | 'domains';
type Parser = (value: unknown, parent: Parent) => string | number | null;
export type Fields = Record<string, { column: string; parse: Parser; required?: boolean }>;
interface Parent { id: string; version: number; name?: string }
const optionalText = (field: string, limit: number): Parser => (value) => value === null ? null : text(value, field, limit);
export const roots: Record<Collection, Fields> = {
  servers: {
    code: { column: 'code', required: true, parse: (value) => {
      const code = text(value, 'code', 64).toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(code)) invalid('code', 'Use ASCII letters, numbers, dots, underscores or hyphens.');
      return code;
    } },
    hostname: { column: 'hostname', required: true, parse: (value) => host(value, 'hostname') },
    dataCenterId: { column: 'data_center_id', required: true, parse: (value) => uuid(value, 'dataCenterId') },
    operatingSystem: { column: 'operating_system', parse: optionalText('operatingSystem', 200) },
    configuration: { column: 'configuration', parse: optionalText('configuration', 4000) },
    notes: { column: 'notes', parse: optionalText('notes', 4000) },
  },
  domains: {
    name: { column: 'name', required: true, parse: domainName },
    renewalDate: { column: 'renewal_date', parse: (value) => dateOnly(value, 'renewalDate') },
  },
};
const dnsTypes = ['A', 'AAAA', 'CNAME', 'NS', 'PTR', 'MX', 'TXT', 'SRV', 'CAA'] as const;

export const children = {
  addresses: { root: 'servers', table: 'server_addresses', fk: 'server_id', fields: {
    address: { column: 'address', required: true, parse: (value: unknown) => {
      const ip = text(value, 'address', 45);
      if (!isIP(ip) || ip.includes('%')) invalid('address', 'Expected an IPv4 or IPv6 address.');
      return ip;
    } },
    networkScope: { column: 'network_scope', required: true, parse: (value: unknown) => text(value, 'networkScope', 100).toUpperCase() },
    kind: { column: 'kind', required: true, parse: (value: unknown) => choice(value, 'kind', ['private', 'public', 'nat'] as const) },
  } },
  'access-endpoints': { root: 'servers', table: 'access_endpoints', fk: 'server_id', fields: {
    protocol: { column: 'protocol', required: true, parse: (value: unknown) => choice(value, 'protocol', ['ssh', 'rdp'] as const) },
    host: { column: 'host', required: true, parse: (value: unknown) => host(value) },
    port: { column: 'port', required: true, parse: port },
  } },
  'dns-records': { root: 'domains', table: 'dns_records', fk: 'domain_id', fields: {
    host: { column: 'host', required: true, parse: (value: unknown, parent: Parent) => dnsOwner(value, parent.name!) },
    type: { column: 'type', required: true, parse: (value: unknown) => choice(value, 'type', dnsTypes) },
    target: { column: 'target', required: true, parse: (value: unknown) => text(value, 'target', 2048) },
  } },
  'tls-endpoints': { root: 'domains', table: 'tls_endpoints', fk: 'domain_id', fields: {
    host: { column: 'host', required: true, parse: (value: unknown) => host(value) },
    port: { column: 'port', required: true, parse: port },
    sni: { column: 'sni', parse: (value: unknown) => value === null || value === '' ? '' : domainName(value) },
    manualExpiryDate: { column: 'manual_expiry_date', parse: (value: unknown) => dateOnly(value, 'manualExpiryDate') },
  } },
} as const satisfies Record<string, { root: Collection; table: string; fk: string; fields: Fields }>;
export type Child = keyof typeof children;

export const links = {
  applicationServers: { root: 'applications', target: 'servers', table: 'app_servers', from: 'application_id', to: 'server_id', path: 'applications/:id/servers' },
  applicationDomains: { root: 'applications', target: 'domains', table: 'app_domains', from: 'application_id', to: 'domain_id', path: 'applications/:id/domains' },
  applicationDns: { root: 'applications', target: 'dns_records', table: 'app_dns_records', from: 'application_id', to: 'dns_record_id', path: 'applications/:id/dns-records' },
  domainServers: { root: 'domains', target: 'servers', table: 'domain_servers', from: 'domain_id', to: 'server_id', path: 'domains/:id/servers' },
} as const;
export type Link = keyof typeof links;

function parsedFields(fields: Fields, body: Record<string, unknown>, creating: boolean, parent: Parent) {
  return Object.entries(fields).flatMap(([key, field]) => {
    if (Object.hasOwn(body, key)) return [{ key, column: field.column, value: field.parse(body[key], parent) }];
    if (creating && field.required) invalid(key, 'Required.');
    return [];
  });
}
type Values = ReturnType<typeof parsedFields>;

function projection(kind: Collection, admin: boolean) {
  const fields = kind === 'servers' ? [
    'code', 'hostname', 'data_center_id AS "dataCenterId"', 'operating_system AS "operatingSystem"',
    ...(admin ? ['configuration', 'notes'] : []),
  ] : ['name', 'renewal_date::text AS "renewalDate"'];
  return ['id', ...fields, 'version', 'archived_at AS "archivedAt"'].join(', ');
}

function activeScope(kind: Collection, request: SessionRequest) {
  return (kind === 'servers' ? serverScope : domainScope)(request.actor.role, 'item', '$1');
}

async function lockParent(client: PoolClient, root: Collection | 'applications', id: string, expected: number) {
  const { rows: [parent] } = await client.query<Parent>(`
    SELECT id, version${root === 'domains' ? ', name' : ''} FROM lcit.${root}
    WHERE id = $1 AND archived_at IS NULL FOR UPDATE
  `, [id]);
  if (!parent) missing();
  if (parent.version !== expected) stale();
  return parent;
}

async function checkDataCenter(client: PoolClient, values: Values) {
  const dataCenter = values.find(({ key }) => key === 'dataCenterId');
  if (!dataCenter) return;
  const found = await client.query('SELECT id FROM lcit.data_centers WHERE id = $1 AND archived_at IS NULL FOR SHARE', [dataCenter.value]);
  if (!found.rowCount) invalid('dataCenterId', 'Choose a data center that is not archived.');
}

function dnsTarget(type: string, target: string) {
  if (type === 'A' || type === 'AAAA') {
    if (isIP(target) !== (type === 'A' ? 4 : 6) || target.includes('%')) invalid('target', `Expected an ${type === 'A' ? 'IPv4' : 'IPv6'} address.`);
    return host(target, 'target');
  }
  if (['CNAME', 'NS', 'PTR'].includes(type)) {
    const name = host(target, 'target');
    if (isIP(name)) invalid('target', 'Expected a DNS hostname.');
    return name;
  }
  if (type === 'MX' || type === 'SRV') {
    const parts = target.split(/\s+/);
    const expected = type === 'MX' ? 2 : 4;
    if (parts.length !== expected || parts.slice(0, -1).some((value) => !/^\d{1,5}$/.test(value) || Number(value) > 65_535)) {
      invalid('target', type === 'MX' ? 'Expected priority and hostname.' : 'Expected priority, weight, port and hostname.');
    }
    const destination = parts.at(-1)!;
    const name = destination === '.' ? '.' : host(destination, 'target');
    if (isIP(name)) invalid('target', 'Expected a DNS hostname.');
    return [...parts.slice(0, -1).map(Number), name].join(' ');
  }
  if (type === 'CAA') {
    const flags = target.match(/^(\d{1,3}) [a-z0-9]+ .+$/i)?.[1];
    if (flags === undefined || Number(flags) > 255) invalid('target', 'Expected flags (0–255), tag and value.');
  }
  return target;
}

function changeStatement(table: string, values: Values, id?: string, bumpVersion = false) {
  if (id) {
    const assignments = values.map(({ column }, index) => `${column} = $${index + 2}`);
    if (bumpVersion) assignments.push('version = version + 1');
    return {
      sql: `UPDATE lcit.${table} SET ${assignments.join(', ')} WHERE id = $1`,
      params: [id, ...values.map(({ value }) => value)],
    };
  }
  return {
    sql: `INSERT INTO lcit.${table} (${values.map(({ column }) => column).join(', ')}) VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})`,
    params: values.map(({ value }) => value),
  };
}

function relatedApps(kind: Collection, role: SessionRequest['actor']['role']) {
  const relation = kind === 'servers'
    ? 'EXISTS (SELECT 1 FROM lcit.app_servers rel WHERE rel.application_id = app.id AND rel.server_id = item.id)'
    : domainLinkedToApplication('item', 'app');
  return `ARRAY(SELECT app.id FROM lcit.applications app WHERE app.archived_at IS NULL
    AND ${applicationScope(role, 'app', '$1')} AND ${relation} ORDER BY app.name, app.id) AS "applicationIds"`;
}

@Injectable()
export class InfrastructureService {
  constructor(private readonly db: Database) {}

  async list(kind: Collection, request: SessionRequest, rawPage: unknown, rawSize: unknown) {
    const { page, pageSize, offset } = pagination(rawPage, rawSize);
    const order = kind === 'servers' ? 'hostname, id' : 'name, id';
    const { rows: [row] } = await this.db.query<PageRow>(`
      WITH data AS (SELECT ${projection(kind, request.actor.role === 'admin')} FROM lcit.${kind} item
        WHERE item.archived_at IS NULL AND ${activeScope(kind, request)}),
      slice AS (SELECT * FROM data ORDER BY ${order} LIMIT $2 OFFSET $3)
      SELECT (SELECT count(*) FROM data) AS total, COALESCE((SELECT json_agg(slice ORDER BY ${order}) FROM slice), '[]') AS items
    `, [request.actor.id, pageSize, offset]);
    return paged(row, page, pageSize);
  }

  async detail(kind: Collection, request: SessionRequest, rawId: string) {
    const id = uuid(rawId);
    const { role } = request.actor;
    const admin = role === 'admin';
    const details = kind === 'servers' ? `
      ARRAY(SELECT d.id FROM lcit.domains d JOIN lcit.domain_servers rel ON rel.domain_id = d.id
        WHERE rel.server_id = item.id AND d.archived_at IS NULL AND ${domainScope(role, 'd', '$1')}
        ORDER BY d.name, d.id) AS "domainIds",
      COALESCE((SELECT json_agg(a ORDER BY a.kind, a."networkScope", a.address, a.id) FROM (
        SELECT id, host(address) AS address, network_scope AS "networkScope", kind FROM lcit.server_addresses WHERE server_id = item.id
      ) a), '[]') AS addresses,
      ${admin ? `COALESCE((SELECT json_agg(e ORDER BY e.protocol, e.host, e.port, e.id) FROM (
        SELECT id, protocol, host, port FROM lcit.access_endpoints WHERE server_id = item.id
      ) e), '[]')` : "'[]'::json"} AS "accessEndpoints"` : `
      ARRAY(SELECT s.id FROM lcit.servers s JOIN lcit.domain_servers rel ON rel.server_id = s.id
        WHERE rel.domain_id = item.id AND s.archived_at IS NULL AND ${serverScope(role, 's', '$1')}
        ORDER BY s.hostname, s.id) AS "serverIds",
      COALESCE((SELECT json_agg(d ORDER BY d.host, d.type, d.target, d.id) FROM (
        SELECT dns.id, dns.host, dns.type, dns.target FROM lcit.dns_records dns WHERE dns.domain_id = item.id
        ${admin ? '' : `AND EXISTS (SELECT 1 FROM lcit.app_dns_records rel JOIN lcit.applications app ON app.id = rel.application_id
          WHERE rel.dns_record_id = dns.id AND app.archived_at IS NULL AND ${applicationScope(role, 'app', '$1')})`}
      ) d), '[]') AS "dnsRecords",
      ${admin ? `COALESCE((SELECT json_agg(t ORDER BY t.host, t.port, t.sni, t.id) FROM (
        SELECT id, host, port, sni, manual_expiry_date::text AS "manualExpiryDate", observed_expiry_at AS "observedExpiryAt"
        FROM lcit.tls_endpoints WHERE domain_id = item.id
      ) t), '[]')` : "'[]'::json"} AS "tlsEndpoints"`;
    const { rows: [row] } = await this.db.query(`
      SELECT ${projection(kind, admin)}, ${relatedApps(kind, role)}, ${details}
      FROM lcit.${kind} item WHERE item.id = $2 AND item.archived_at IS NULL AND ${activeScope(kind, request)}
    `, [request.actor.id, id]);
    if (!row) missing();
    return row;
  }

  async save(kind: Collection, request: SessionRequest, input: unknown, rawId?: string) {
    requireAdmin(request.actor);
    const fields = roots[kind];
    const body = bodyOf(input, [...Object.keys(fields), ...(rawId ? ['version'] : [])]);
    const id = rawId ? uuid(rawId) : undefined;
    const values = parsedFields(fields, body, !id, { id: '', version: 0 });
    if (!values.length) invalid('body', 'Provide a field to update.');
    return this.db.transaction(async (client) => {
      await checkDataCenter(client, values);
      if (id) {
        const parent = await lockParent(client, kind, id, version(body.version));
        const name = values.find(({ key }) => key === 'name')?.value;
        if (kind === 'domains' && name && name !== parent.name) {
          await client.query(`UPDATE lcit.dns_records SET host = left(host, length(host) - length($2::text)) || $3
            WHERE domain_id = $1 AND (host = $2 OR right(host, length($2::text) + 1) = '.' || $2)`, [id, parent.name, name]);
        }
      }
      const { sql, params } = changeStatement(kind, values, id, true);
      const { rows: [row] } = await client.query(`${sql} RETURNING ${projection(kind, true)}`, params);
      await this.audit(client, request, id ? 'update' : 'create', kind, row.id);
      return row;
    });
  }

  async archive(kind: Collection, request: SessionRequest, rawId: string, input: unknown) {
    requireAdmin(request.actor);
    const id = uuid(rawId);
    const expected = version(bodyOf(input, ['version']).version);
    return this.db.transaction(async (client) => {
      await lockParent(client, kind, id, expected);
      const { rows: [row] } = await client.query(`UPDATE lcit.${kind} SET archived_at = now(), version = version + 1
        WHERE id = $1 RETURNING ${projection(kind, true)}`, [id]);
      await this.audit(client, request, 'archive', kind, id);
      return row;
    });
  }

  async child(kind: Child, request: SessionRequest, rawParent: string, input: unknown, rawId?: string, remove = false) {
    requireAdmin(request.actor);
    const { root, table, fk, fields } = children[kind];
    const parentId = uuid(rawParent);
    const id = rawId ? uuid(rawId, 'childId') : undefined;
    const body = bodyOf(input, remove ? ['version'] : ['version', ...Object.keys(fields)]);
    const expected = version(body.version);
    return this.db.transaction(async (client) => {
      const parent = await lockParent(client, root, parentId, expected);
      let existing;
      if (id) {
        const result = await client.query(`SELECT * FROM lcit.${table} WHERE id = $1 AND ${fk} = $2`, [id, parentId]);
        existing = result.rows[0];
        if (!existing) missing();
      }
      let childId = id;
      if (remove) {
        if (kind === 'dns-records' && (await client.query('SELECT 1 FROM lcit.app_dns_records WHERE dns_record_id = $1 LIMIT 1', [id])).rowCount) {
          throw new ApiError(409, 'DNS_RECORD_LINKED', 'Unlink the DNS record from applications before deleting it.');
        }
        await client.query(`DELETE FROM lcit.${table} WHERE id = $1`, [id]);
      } else {
        const values = parsedFields(fields, body, !id, parent);
        if (!values.length) invalid('body', 'Provide a field to update.');
        if (kind === 'dns-records') {
          const targetField = values.find(({ key }) => key === 'target');
          const typeField = values.find(({ key }) => key === 'type');
          const target = dnsTarget(String(typeField?.value ?? existing.type), String(targetField?.value ?? existing.target));
          if (targetField) targetField.value = target;
          else if (typeField) values.push({ key: 'target', column: 'target', value: target });
        }
        if (!id) values.push({ key: fk, column: fk, value: parentId });
        const { sql, params } = changeStatement(table, values, id);
        const result = await client.query<{ id: string }>(`${sql} RETURNING id`, params);
        childId = result.rows[0].id;
      }
      await client.query(`UPDATE lcit.${root} SET version = version + 1 WHERE id = $1`, [parentId]);
      await this.audit(client, request, remove ? 'delete' : id ? 'update' : 'create', kind, childId!, parentId);
      return { id: childId, version: expected + 1 };
    });
  }

  async link(kind: Link, request: SessionRequest, rawId: string, rawTarget: string, input: unknown, link: boolean) {
    requireAdmin(request.actor);
    const id = uuid(rawId);
    const targetId = uuid(rawTarget, 'targetId');
    const expected = version(bodyOf(input, ['version']).version);
    const { root, target, table, from, to } = links[kind];
    return this.db.transaction(async (client) => {
      await lockParent(client, root, id, expected);
      if (link) {
        const result = target === 'dns_records'
          ? await client.query(`SELECT dns.id FROM lcit.dns_records dns JOIN lcit.domains domain ON domain.id = dns.domain_id
              WHERE dns.id = $1 AND domain.archived_at IS NULL FOR SHARE OF domain, dns`, [targetId])
          : await client.query(`SELECT id FROM lcit.${target} WHERE id = $1 AND archived_at IS NULL FOR SHARE`, [targetId]);
        if (!result.rowCount) missing();
      }
      const result = link
        ? await client.query(`INSERT INTO lcit.${table} (${from}, ${to}) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, targetId])
        : await client.query(`DELETE FROM lcit.${table} WHERE ${from} = $1 AND ${to} = $2`, [id, targetId]);
      if (!result.rowCount) return { version: expected };
      await client.query(`UPDATE lcit.${root} SET version = version + 1 WHERE id = $1`, [id]);
      const relation = links[kind].path.split('/:id/')[1];
      await this.audit(client, request, `${relation}.${link ? 'link' : 'unlink'}`, root, id, targetId);
      return { version: expected + 1 };
    });
  }

  private audit(client: PoolClient, request: SessionRequest, action: string, targetType: string, targetId: string, relatedId?: string) {
    return recordAudit(client, { actorId: request.actor.id, action: `catalog.${targetType}.${action}`, targetType, targetId, relatedId, requestId: requestId(request) });
  }
}
