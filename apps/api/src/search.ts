import { Controller, Get, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { isIP } from 'node:net';
import { applicationDomainIds, applicationScope, SessionGuard, SessionRequest } from './access';
import { paged, PageRow, pageSchema, pagination, text } from './api-contract';
import { Database } from './database';
import { dnsName } from './network-input';

// All branches return application IDs; visibility is applied before counting and pagination.
function candidates(raw: string, admin: boolean) {
  if (isIP(raw) && !raw.includes('%')) {
    return {
      sql: `SELECT DISTINCT rel.application_id FROM lcit.server_addresses address
        JOIN lcit.servers srv ON srv.id = address.server_id AND srv.archived_at IS NULL
        JOIN lcit.app_servers rel ON rel.server_id = srv.id WHERE address.address = $2::inet`,
      values: [raw],
    };
  }
  const name = dnsName(raw, true);
  const pattern = `%${raw.replace(/[\\%_]/g, '\\$&')}%`;
  const byName = `SELECT app.id AS application_id FROM lcit.applications app WHERE app.archived_at IS NULL AND app.name ILIKE $2
    UNION SELECT app.id FROM lcit.organizations org JOIN lcit.applications app ON app.organization_id = org.id
      WHERE org.archived_at IS NULL AND org.name ILIKE $2`;
  if (!name) return { sql: byName, values: [pattern] };
  const sql = `SELECT rel.application_id FROM lcit.servers srv JOIN lcit.app_servers rel ON rel.server_id = srv.id
      WHERE srv.archived_at IS NULL AND lower(srv.hostname) = $3
    UNION SELECT rel.application_id FROM lcit.domains dom JOIN lcit.app_domains rel ON rel.domain_id = dom.id
      WHERE dom.archived_at IS NULL AND dom.name = $3
    UNION SELECT rel.application_id FROM lcit.domains dom JOIN lcit.dns_records dns ON dns.domain_id = dom.id
      JOIN lcit.app_dns_records rel ON rel.dns_record_id = dns.id
      WHERE dom.archived_at IS NULL AND (dom.name = $3 OR dns.host = $3)
    UNION SELECT rel.application_id FROM lcit.domains dom JOIN lcit.domain_servers ds ON ds.domain_id = dom.id
      JOIN lcit.servers srv ON srv.id = ds.server_id AND srv.archived_at IS NULL JOIN lcit.app_servers rel ON rel.server_id = srv.id
      WHERE dom.archived_at IS NULL AND dom.name = $3
    ${admin ? `UNION SELECT rel.application_id FROM lcit.dns_records dns
      JOIN lcit.domains dom ON dom.id = dns.domain_id AND dom.archived_at IS NULL
      JOIN lcit.app_domains rel ON rel.domain_id = dom.id WHERE dns.host = $3` : ''}`;
  return { sql: `${byName} UNION ${sql}`, values: [pattern, name] };
}

@Injectable()
export class SearchService {
  constructor(private readonly db: Database) {}

  async search(request: SessionRequest, query: unknown, rawPage: unknown, rawSize: unknown) {
    const term = text(query, 'q', 253);
    const { page, pageSize, offset } = pagination(rawPage, rawSize);
    const { actor } = request;
    const admin = actor.role === 'admin';
    const match = candidates(term, admin);
    const limit = match.values.length + 2;
    const { rows: [row] } = await this.db.query<PageRow>(`
      WITH candidates AS (${match.sql}),
      visible AS (
        SELECT app.id, app.name, app.code, app.organization_id, app.owner_id
        FROM candidates c JOIN lcit.applications app ON app.id = c.application_id
        WHERE app.archived_at IS NULL AND ${applicationScope(actor.role, 'app', '$1')}
      ), slice AS (SELECT * FROM visible ORDER BY name, id LIMIT $${limit} OFFSET $${limit + 1}),
      results AS (
        SELECT app.id, app.name, app.code,
          json_build_object('id', org.id, 'name', org.name) AS organization,
          CASE WHEN owner.id IS NOT NULL THEN json_build_object('id', owner.id, 'displayName', owner.display_name) END AS owner,
          COALESCE((SELECT json_agg(s ORDER BY s.hostname, s.id) FROM (
            SELECT srv.id, srv.hostname, json_build_object('id', dc.id, 'name', dc.name) AS "dataCenter",
              COALESCE((SELECT json_agg(json_build_object('address', host(addr.address), 'networkScope', addr.network_scope, 'kind', addr.kind)
                ORDER BY addr.network_scope, addr.address, addr.kind, addr.id) FROM lcit.server_addresses addr WHERE addr.server_id = srv.id), '[]') AS addresses,
              ${admin ? 'ARRAY(SELECT DISTINCT ep.protocol FROM lcit.access_endpoints ep WHERE ep.server_id = srv.id ORDER BY ep.protocol)' : 'ARRAY[]::text[]'} AS "accessMethods"
            FROM lcit.app_servers rel JOIN lcit.servers srv ON srv.id = rel.server_id AND srv.archived_at IS NULL
            JOIN lcit.data_centers dc ON dc.id = srv.data_center_id WHERE rel.application_id = app.id
          ) s), '[]') AS servers,
          COALESCE((SELECT json_agg(json_build_object('id', dom.id, 'name', dom.name) ORDER BY dom.name, dom.id)
            FROM (${applicationDomainIds('app')}) rel JOIN lcit.domains dom ON dom.id = rel.domain_id AND dom.archived_at IS NULL), '[]') AS domains
        FROM slice app JOIN lcit.organizations org ON org.id = app.organization_id
        LEFT JOIN lcit.users owner ON owner.id = app.owner_id
      )
      SELECT (SELECT count(*) FROM visible) AS total,
        COALESCE((SELECT json_agg(results ORDER BY name, id) FROM results), '[]') AS items
    `, [actor.id, ...match.values, pageSize, offset]);
    return paged(row, page, pageSize);
  }
}

@ApiTags('search')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ schema: pageSchema({ type: 'object', required: ['id', 'name', 'code', 'organization', 'owner', 'servers', 'domains'], properties: {
    id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, code: { type: 'string' },
    organization: { type: 'object' }, owner: { type: 'object', nullable: true },
    servers: { type: 'array', items: { type: 'object' } }, domains: { type: 'array', items: { type: 'object' } },
  } }) })
  search(@Req() request: SessionRequest, @Query('q') query: unknown, @Query('page') page: unknown, @Query('pageSize') size: unknown) {
    return this.searchService.search(request, query, page, size);
  }
}
