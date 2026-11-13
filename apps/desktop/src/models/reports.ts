import { Page } from './api';

export interface ReportFilter { organizationId: string; dataCenterId: string; serviceType: string; status: string }
export const emptyFilter: ReportFilter = { organizationId: '', dataCenterId: '', serviceType: '', status: '' };

export const serviceTypeNames: Record<string, string> = { ordered: 'Đặt hàng', monitoring: 'Giám sát', operations: 'Quản trị vận hành' };
export const statusNames: Record<string, string> = { active: 'Đang hoạt động', inactive: 'Ngừng hoạt động' };

export interface Renewal {
  kind: 'domain' | 'tls'; source: 'manual' | 'observed' | null; domainId: string; name: string; dueDate: string; daysLeft: number;
}
export interface Dashboard {
  totals: { applications: number; servers: number; domains: number };
  byServiceType: { serviceType: string; count: number }[];
  byOrganization: { id: string; name: string; count: number }[];
  byDataCenter: { id: string; name: string; applications: number; servers: number }[];
  renewals: { overdue: number; within30: number; within90: number };
  upcomingRenewals: Renewal[];
}
export interface InventoryRow {
  id: string; code: string; name: string; serviceType: string; status: string; owner: string | null;
  organization: { id: string; name: string }; domains: string[];
  servers: { id: string; hostname: string; dataCenter: string; addresses: string[] }[];
}
export interface InventoryPage extends Page<InventoryRow> { canExport: boolean }

/** Query string shared by the dashboard, the report screen and the Excel export. */
export function filterQuery(filter: ReportFilter, extra: Record<string, string | number> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filter, ...extra })) if (value !== '') params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
}
