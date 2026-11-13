import { Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { Actor, applicationDomainIds, applicationScope, domainLinkedToApplication, domainScope, serverScope, SessionRequest } from './access';
import { ApiError, choice, paged, PageRow, pagination, requestId, uuid } from '../shared/api-contract';
import { recordAudit } from './audit.service';
import { Database } from './database';
import { holdsPermission } from './permissions.service';

export const serviceTypes = ['ordered', 'monitoring', 'operations'] as const;
export const appStatuses = ['active', 'inactive'] as const;
export const serviceTypeNames: Record<string, string> = { ordered: 'Đặt hàng', monitoring: 'Giám sát', operations: 'Quản trị vận hành' };
const statusNames: Record<string, string> = { active: 'Đang hoạt động', inactive: 'Ngừng hoạt động' };
/** Renewal windows follow the alert milestones in SPEC (90/30 days), counted in the business time zone. */
const today = `(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
export const maxExportRows = 10_000;

export interface ReportFilter {
  organizationId: string | null;
  dataCenterId: string | null;
  serviceType: string | null;
  status: string | null;
}

export function reportFilter(query: Record<string, unknown>): ReportFilter {
  const optional = <T>(value: unknown, parse: (value: unknown) => T) => value === undefined || value === '' ? null : parse(value);
  return {
    organizationId: optional(query.organizationId, (value) => uuid(value, 'organizationId')),
    dataCenterId: optional(query.dataCenterId, (value) => uuid(value, 'dataCenterId')),
    serviceType: optional(query.serviceType, (value) => choice(value, 'serviceType', serviceTypes)),
    status: optional(query.status, (value) => choice(value, 'status', appStatuses)),
  };
}

/**
 * The one place that decides which applications, servers and domains a report covers.
 * Parameters: $1 actor id, $2 organization, $3 service type, $4 status, $5 data center.
 * `apps` holds the applications in scope that match the filter. Servers and domains follow the
 * viewer's scope; when any filter is set they are limited to those linked to `apps`
 * (and servers to the chosen data center).
 */
function scopedSets(actor: Actor) {
  const filtered = `($2::uuid IS NOT NULL OR $3::text IS NOT NULL OR $4::text IS NOT NULL OR $5::uuid IS NOT NULL)`;
  return `
    apps AS (
      SELECT a.* FROM lcit.applications a
      WHERE a.archived_at IS NULL AND ${applicationScope(actor.role, 'a', '$1')}
        AND ($2::uuid IS NULL OR a.organization_id = $2)
        AND ($3::text IS NULL OR a.service_type = $3)
        AND ($4::text IS NULL OR a.status = $4)
        AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM lcit.app_servers r
          JOIN lcit.servers s ON s.id = r.server_id AND s.archived_at IS NULL
          WHERE r.application_id = a.id AND s.data_center_id = $5))
    ),
    srv AS (
      SELECT s.* FROM lcit.servers s
      WHERE s.archived_at IS NULL AND ${serverScope(actor.role, 's', '$1')}
        AND ($5::uuid IS NULL OR s.data_center_id = $5)
        AND (NOT ${filtered} OR EXISTS (SELECT 1 FROM lcit.app_servers r JOIN apps ON apps.id = r.application_id WHERE r.server_id = s.id))
    ),
    dom AS (
      SELECT d.* FROM lcit.domains d
      WHERE d.archived_at IS NULL AND ${domainScope(actor.role, 'd', '$1')}
        AND (NOT ${filtered} OR EXISTS (SELECT 1 FROM apps WHERE ${domainLinkedToApplication('d', 'apps')}))
    )`;
}

const params = (actor: Actor, filter: ReportFilter) =>
  [actor.id, filter.organizationId, filter.serviceType, filter.status, filter.dataCenterId];

/** One row per application, shared by the report screen and the Excel export. */
function inventoryRows(actor: Actor, limit: string, offset: string) {
  return `
    WITH ${scopedSets(actor)},
    rows AS (
      SELECT apps.id, apps.code, apps.name, apps.service_type AS "serviceType", apps.status,
        json_build_object('id', org.id, 'name', org.name) AS organization,
        (SELECT u.display_name FROM lcit.users u WHERE u.id = apps.owner_id) AS owner,
        COALESCE((SELECT json_agg(json_build_object(
            'id', s.id, 'hostname', s.hostname, 'dataCenter', dc.name,
            'addresses', ARRAY(SELECT host(sa.address) || ' (' || sa.network_scope || ')' FROM lcit.server_addresses sa
              WHERE sa.server_id = s.id ORDER BY sa.kind, sa.address)
          ) ORDER BY dc.name, s.hostname)
          FROM lcit.app_servers r JOIN lcit.servers s ON s.id = r.server_id AND s.archived_at IS NULL
          JOIN lcit.data_centers dc ON dc.id = s.data_center_id
          WHERE r.application_id = apps.id AND ($5::uuid IS NULL OR s.data_center_id = $5)), '[]') AS servers,
        ARRAY(SELECT d.name FROM (${applicationDomainIds('apps')}) rel JOIN lcit.domains d ON d.id = rel.domain_id
          WHERE d.archived_at IS NULL ORDER BY d.name) AS domains
      FROM apps JOIN lcit.organizations org ON org.id = apps.organization_id
    ),
    slice AS (SELECT * FROM rows ORDER BY name, id LIMIT ${limit} OFFSET ${offset})
    SELECT (SELECT count(*) FROM rows) AS total,
      COALESCE((SELECT json_agg(slice ORDER BY name, id) FROM slice), '[]') AS items`;
}

/** Applications are counted once per data center even when they run on several servers there. */
const byDataCenterSql = `
  SELECT dc.id, dc.name, count(DISTINCT apps.id)::int AS applications, count(DISTINCT s.id)::int AS servers
  FROM apps JOIN lcit.app_servers r ON r.application_id = apps.id
  JOIN lcit.servers s ON s.id = r.server_id AND s.archived_at IS NULL
  JOIN lcit.data_centers dc ON dc.id = s.data_center_id
  WHERE $5::uuid IS NULL OR dc.id = $5
  GROUP BY dc.id, dc.name`;

interface InventoryRow {
  code: string; name: string; serviceType: string; status: string; owner: string | null;
  organization: { name: string }; domains: string[];
  servers: { hostname: string; dataCenter: string; addresses: string[] }[];
}

@Injectable()
export class ReportsService {
  constructor(private readonly db: Database) {}

  async dashboard(request: SessionRequest, query: Record<string, unknown>) {
    const { actor } = request;
    const filter = reportFilter(query);
    const { rows: [row] } = await this.db.query(`
      WITH ${scopedSets(actor)},
      renewals AS (
        SELECT 'domain' AS kind, NULL::text AS source, dom.id AS "domainId", dom.name AS name, dom.renewal_date AS "dueDate"
        FROM dom WHERE dom.renewal_date IS NOT NULL
        UNION ALL
        SELECT 'tls', 'manual', dom.id, t.host || ':' || t.port, t.manual_expiry_date
        FROM dom JOIN lcit.tls_endpoints t ON t.domain_id = dom.id WHERE t.manual_expiry_date IS NOT NULL
        UNION ALL
        SELECT 'tls', 'observed', dom.id, t.host || ':' || t.port, (t.observed_expiry_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        FROM dom JOIN lcit.tls_endpoints t ON t.domain_id = dom.id WHERE t.observed_expiry_at IS NOT NULL
      ),
      due AS (SELECT *, ("dueDate" - ${today})::int AS "daysLeft" FROM renewals WHERE "dueDate" <= ${today} + 90)
      SELECT json_build_object(
          'applications', (SELECT count(*)::int FROM apps),
          'servers', (SELECT count(*)::int FROM srv),
          'domains', (SELECT count(*)::int FROM dom)) AS totals,
        COALESCE((SELECT json_agg(json_build_object('serviceType', t.service_type, 'count', t.count) ORDER BY t.service_type)
          FROM (SELECT service_type, count(*)::int AS count FROM apps GROUP BY service_type) t), '[]') AS "byServiceType",
        COALESCE((SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'count', o.count) ORDER BY o.count DESC, o.name)
          FROM (SELECT org.id, org.name, count(*)::int AS count FROM apps JOIN lcit.organizations org ON org.id = apps.organization_id
            GROUP BY org.id, org.name) o), '[]') AS "byOrganization",
        COALESCE((SELECT json_agg(d ORDER BY d.applications DESC, d.name) FROM (${byDataCenterSql}) d), '[]') AS "byDataCenter",
        json_build_object(
          'overdue', (SELECT count(*)::int FROM due WHERE "daysLeft" < 0),
          'within30', (SELECT count(*)::int FROM due WHERE "daysLeft" BETWEEN 0 AND 30),
          'within90', (SELECT count(*)::int FROM due WHERE "daysLeft" BETWEEN 31 AND 90)) AS renewals,
        COALESCE((SELECT json_agg(u ORDER BY u."dueDate", u.name) FROM (SELECT * FROM due ORDER BY "dueDate", name LIMIT 20) u), '[]') AS "upcomingRenewals"
    `, params(actor, filter));
    return { filter, ...row };
  }

  async inventory(request: SessionRequest, query: Record<string, unknown>) {
    const { actor } = request;
    const filter = reportFilter(query);
    const { page, pageSize, offset } = pagination(query.page, query.pageSize);
    const { rows: [row] } = await this.db.query<PageRow>(inventoryRows(actor, '$6', '$7'), [...params(actor, filter), pageSize, offset]);
    const { rows: [rights] } = await this.db.query<{ canExport: boolean }>(
      `SELECT ${holdsPermission('reports.export', '$1', '$2')} AS "canExport"`, [actor.id, actor.role === 'admin']);
    return { ...paged(row, page, pageSize), filter, canExport: rights.canExport };
  }

  /** Builds the workbook from the same query as `inventory`, then records the export. */
  async exportInventory(request: SessionRequest, query: Record<string, unknown>) {
    const { actor } = request;
    const filter = reportFilter(query);
    const event = { actorId: actor.id, action: 'report.export.inventory', targetType: 'reports', requestId: requestId(request) };
    const { rows: [rights] } = await this.db.query<{ allowed: boolean }>(
      `SELECT ${holdsPermission('reports.export', '$1', '$2')} AS allowed`, [actor.id, actor.role === 'admin']);
    if (!rights.allowed) {
      await this.db.transaction((client) => recordAudit(client, { ...event, outcome: 'denied' }));
      throw new ApiError(403, 'EXPORT_NOT_PERMITTED', 'Exporting reports requires a grant from an administrator.');
    }
    const { rows: [row] } = await this.db.query<PageRow>(inventoryRows(actor, String(maxExportRows + 1), '0'), params(actor, filter));
    if (Number(row.total) > maxExportRows) {
      throw new ApiError(413, 'REPORT_TOO_LARGE', `Narrow the filter to at most ${maxExportRows} applications.`);
    }
    const { rows: byDataCenter } = await this.db.query<{ name: string; applications: number; servers: number }>(
      `WITH ${scopedSets(actor)} ${byDataCenterSql} ORDER BY applications DESC, name`, params(actor, filter));
    const labels = await this.filterLabels(filter);
    const buffer = await inventoryWorkbook(row.items as InventoryRow[], byDataCenter, labels, actor.displayName);
    await this.db.transaction((client) => recordAudit(client, event));
    return buffer;
  }

  private async filterLabels(filter: ReportFilter) {
    const { rows: [names] } = await this.db.query<{ organization: string | null; dataCenter: string | null }>(`
      SELECT (SELECT name FROM lcit.organizations WHERE id = $1) AS organization,
        (SELECT name FROM lcit.data_centers WHERE id = $2) AS "dataCenter"
    `, [filter.organizationId, filter.dataCenterId]);
    return [
      ['Đơn vị', names.organization ?? 'Tất cả'],
      ['Trung tâm dữ liệu', names.dataCenter ?? 'Tất cả'],
      ['Hình thức dịch vụ', filter.serviceType ? serviceTypeNames[filter.serviceType] : 'Tất cả'],
      ['Trạng thái', filter.status ? statusNames[filter.status] : 'Tất cả'],
    ];
  }
}

/**
 * Every value is written as a plain string or number cell, never as a formula, so text such as
 * "=HYPERLINK(...)" entered by a user stays text in Excel (NFR-01).
 */
export async function inventoryWorkbook(rows: InventoryRow[], byDataCenter: { name: string; applications: number; servers: number }[],
  filters: string[][], exportedBy: string, now = new Date()) {
  const book = new Workbook();
  book.creator = 'LCIT Manager';
  book.created = now;
  const header = (sheet: ReturnType<Workbook['addWorksheet']>) => {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  };

  const inventory = book.addWorksheet('Danh mục ứng dụng');
  inventory.columns = [
    { header: 'STT', width: 6 }, { header: 'Mã', width: 14 }, { header: 'Tên ứng dụng', width: 32 },
    { header: 'Đơn vị', width: 28 }, { header: 'Hình thức dịch vụ', width: 20 }, { header: 'Trạng thái', width: 18 },
    { header: 'Người phụ trách', width: 22 }, { header: 'Máy chủ (DC)', width: 40 }, { header: 'Địa chỉ IP', width: 34 },
    { header: 'Tên miền', width: 34 },
  ];
  rows.forEach((item, index) => {
    const added = inventory.addRow([
      index + 1, item.code, item.name, item.organization.name, serviceTypeNames[item.serviceType] ?? item.serviceType,
      statusNames[item.status] ?? item.status, item.owner ?? '',
      item.servers.map((server) => `${server.hostname} (${server.dataCenter})`).join('\n'),
      item.servers.flatMap((server) => server.addresses).join('\n'),
      item.domains.join('\n'),
    ]);
    added.alignment = { vertical: 'top', wrapText: true };
  });
  header(inventory);

  const centers = book.addWorksheet('Theo trung tâm dữ liệu');
  centers.columns = [{ header: 'Trung tâm dữ liệu', width: 34 }, { header: 'Số ứng dụng', width: 14 }, { header: 'Số máy chủ', width: 14 }];
  for (const center of byDataCenter) centers.addRow([center.name, center.applications, center.servers]);
  header(centers);

  const about = book.addWorksheet('Thông tin xuất');
  about.columns = [{ header: 'Mục', width: 22 }, { header: 'Giá trị', width: 40 }];
  about.addRows([
    ...filters,
    ['Số ứng dụng', rows.length],
    ['Người xuất', exportedBy],
    ['Thời điểm xuất', new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Ho_Chi_Minh' }).format(now)],
  ]);
  about.getRow(1).font = { bold: true };

  return Buffer.from(await book.xlsx.writeBuffer());
}
