import { useState } from 'react';
import { useDashboard, useInventory, useReportFilter } from '../controllers/use-reports';
import { useLocalPage } from '../controllers/use-local-page';
import { RequestApi } from '../models/api';
import { Kind } from '../models/catalog';
import { Dashboard, ReportFilter, Renewal, serviceTypeNames, statusNames } from '../models/reports';
import { Pager, Picker } from './catalog';
import { Icon } from './icon';
import dashboard from './dashboard.module.css';
import styles from './reports.module.css';

const number = new Intl.NumberFormat('vi-VN');
const date = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short' });

function Filters({ api, filter, change, reset, active, className = styles.filters, label = 'Bộ lọc báo cáo' }: {
  api: RequestApi; filter: ReportFilter; change: (key: keyof ReportFilter, value: string) => void; reset: () => void; active: boolean;
  className?: string; label?: string;
}) {
  return <div className={className} role="group" aria-label={label}>
    <label>Đơn vị<Picker api={api} kind="organizations" value={filter.organizationId} change={(value) => change('organizationId', value)} /></label>
    <label>Trung tâm dữ liệu<Picker api={api} kind="data-centers" value={filter.dataCenterId} change={(value) => change('dataCenterId', value)} /></label>
    <label>Hình thức dịch vụ<select value={filter.serviceType} onChange={(event) => change('serviceType', event.target.value)}>
      <option value="">Tất cả</option>{Object.entries(serviceTypeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Trạng thái<select value={filter.status} onChange={(event) => change('status', event.target.value)}>
      <option value="">Tất cả</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {active && <button type="button" className="secondary" onClick={reset}>Bỏ lọc</button>}
  </div>;
}

type DistributionRow = { key: string; label: string; applications: number; detail?: string };
const distributionGroups = [
  ['byDataCenter', 'Trung tâm dữ liệu'],
  ['byOrganization', 'Đơn vị'],
  ['byServiceType', 'Hình thức dịch vụ'],
] as const;
type DistributionGroup = typeof distributionGroups[number][0];

function DistributionList({ rows, empty }: { rows: DistributionRow[]; empty: string }) {
  const page = useLocalPage(rows, 10);
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return <><ul className={dashboard.detailList}>{page.items.map((row) => <li key={row.key}>
    <div><strong>{row.label}</strong>{row.detail && <span className={styles.small}>{row.detail}</span>}</div>
    <span className={styles.badgeNotice}>{number.format(row.applications)} ứng dụng</span>
  </li>)}</ul>{page.total > page.pageSize && <Pager {...page} />}</>;
}

function ApplicationDistribution({ data, group, changeGroup }: {
  data: Dashboard; group: DistributionGroup; changeGroup: (group: DistributionGroup) => void;
}) {
  const rows: Record<DistributionGroup, DistributionRow[]> = {
    byDataCenter: data.byDataCenter.map((row) => ({ key: row.id, label: row.name, applications: row.applications, detail: `${number.format(row.servers)} máy chủ` })),
    byOrganization: data.byOrganization.map((row) => ({ key: row.id, label: row.name, applications: row.count })),
    byServiceType: data.byServiceType.map((row) => ({ key: row.serviceType, label: serviceTypeNames[row.serviceType] ?? row.serviceType, applications: row.count })),
  };
  const byDataCenter = group === 'byDataCenter';

  return <section className={dashboard.card} aria-labelledby="dashboard-distribution-title">
    <h2 id="dashboard-distribution-title">Phân bố ứng dụng</h2>
    <div className={dashboard.summary} role="group" aria-label="Nhóm phân bố ứng dụng">
      {distributionGroups.map(([key, label]) => <button key={key} type="button" aria-pressed={key === group}
        aria-controls="dashboard-distribution-list" onClick={() => changeGroup(key)}>
        <span>{label}</span><strong>{number.format(rows[key].length)}</strong>
      </button>)}
    </div>
    <div id="dashboard-distribution-list">
      <DistributionList key={group} rows={rows[group]} empty={byDataCenter ? 'Chưa có ứng dụng gắn máy chủ.' : 'Chưa có ứng dụng.'} />
      {byDataCenter && rows.byDataCenter.length > 0 && <p className={dashboard.distributionNote}>Mỗi ứng dụng được tính một lần tại mỗi trung tâm.</p>}
    </div>
  </section>;
}

function dueBadge(item: Renewal) {
  if (item.daysLeft <= 0) return <span className={styles.badgeCritical}>{item.daysLeft === 0 ? 'Đến hạn hôm nay' : `Quá hạn ${-item.daysLeft} ngày`}</span>;
  return <span className={item.daysLeft <= 30 ? styles.badgeWarning : styles.badgeNotice}>Còn {item.daysLeft} ngày</span>;
}

const renewalLabel = (item: Renewal) => item.kind === 'domain' ? 'Tên miền'
  : item.source === 'observed' ? 'SSL quan sát được' : 'SSL nhập tay';

function RenewalList({ rows, open }: { rows: Renewal[]; open: (kind: Kind, id: string) => void }) {
  const page = useLocalPage(rows, 10);
  if (rows.length === 0) return <p className="muted">Không có hạn nào trong 90 ngày tới.</p>;
  return <><ul className={dashboard.detailList}>{page.items.map((item) => <li key={`${item.domainId}:${item.kind}:${item.source}:${item.name}:${item.dueDate}`}>
    <div><button type="button" className="text-button" onClick={() => open('domains', item.domainId)}>{item.name}</button>
      <span className={styles.small}>{renewalLabel(item)} · {date.format(new Date(`${item.dueDate}T00:00:00`))}</span></div>
    {dueBadge(item)}
  </li>)}</ul>{page.total > page.pageSize && <Pager {...page} />}</>;
}

export function DashboardView({ api, open }: { api: RequestApi; open: (kind: Kind, id: string) => void }) {
  const [distributionGroup, setDistributionGroup] = useState<DistributionGroup>('byDataCenter');
  const filters = useReportFilter();
  const { result, reload } = useDashboard(api, filters.filter);
  const data = result?.data;
  return <section className={dashboard.layout} aria-labelledby="dashboard-title">
    <header className={dashboard.header}>
      <h1 id="dashboard-title">Tổng quan hệ thống</h1>
      <button type="button" className="secondary" onClick={reload} disabled={!result}><Icon name="refresh" size={16} />Tải lại</button>
    </header>
    <Filters api={api} {...filters} className={dashboard.filters} label="Bộ lọc tổng quan" />
    {!result && <p className="panel" role="status">Đang tải số liệu…</p>}
    {result?.error && <p className="error" role="alert">{result.error}</p>}
    {data && <>
      <ul className={dashboard.totals} aria-label="Tổng số tài nguyên">
        {([['applications', 'Ứng dụng'], ['servers', 'Máy chủ'], ['domains', 'Tên miền']] as const).map(([key, label]) =>
          <li className={dashboard.total} key={key} data-kind={key}>
            <span className={dashboard.totalIcon}><Icon name={key} size={22} /></span>
            <span className={dashboard.totalLabel}>{label}</span><strong>{number.format(data.totals[key])}</strong>
          </li>)}
      </ul>
      <div className={dashboard.content}>
        <section className={dashboard.card} aria-labelledby="dashboard-renewal-title">
          <h2 id="dashboard-renewal-title">Gia hạn tên miền và SSL</h2>
          <dl className={dashboard.summary}>
            <div data-tone="critical"><dt>Quá hạn</dt><dd>{number.format(data.renewals.overdue)}</dd></div>
            <div data-tone="warning"><dt>Trong 30 ngày</dt><dd>{number.format(data.renewals.within30)}</dd></div>
            <div><dt>31–90 ngày</dt><dd>{number.format(data.renewals.within90)}</dd></div>
          </dl>
          <RenewalList rows={data.upcomingRenewals} open={open} />
        </section>
        <ApplicationDistribution data={data} group={distributionGroup} changeGroup={setDistributionGroup} />
      </div>
    </>}
  </section>;
}

export function ReportsView({ api, open }: { api: RequestApi; open: (kind: Kind, id: string) => void }) {
  const filters = useReportFilter();
  const { result, setPage, reload, exportExcel, exporting, error, notice } = useInventory(api, filters.filter);
  const data = result?.data;
  return <section className="panel"><div className="section-title"><div><p className="eyebrow">BÁO CÁO</p><h1>Danh mục ứng dụng</h1>
    <p className="page-description">Tệp Excel dùng đúng bộ lọc và phạm vi đang hiển thị.</p></div>
    <div className="actions"><button className="secondary" onClick={reload}>Tải lại</button>
      {data?.canExport && <button disabled={exporting || data.total === 0} onClick={() => void exportExcel()}>
        <Icon name="reports" size={17} />{exporting ? 'Đang xuất…' : 'Xuất Excel'}</button>}</div></div>
    <Filters api={api} {...filters} />
    {data && !data.canExport && <p className="muted">Bạn cần Quản trị cấp quyền “Xuất báo cáo” để tải tệp Excel.</p>}
    {(result?.error || error) && <p className="error" role="alert">{result?.error || error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!result && <p role="status">Đang tải báo cáo…</p>}
    {data && <>{data.items.length === 0 ? <p className="empty">{data.total === 0 ? 'Không có ứng dụng phù hợp bộ lọc.' : 'Không có ứng dụng ở trang này.'}</p> : <div className={styles.tableWrap}>
      <table className={styles.table}><thead><tr><th>Ứng dụng</th><th>Đơn vị</th><th>Hình thức</th><th>Máy chủ</th><th>Tên miền</th></tr></thead>
        <tbody>{data.items.map((row) => <tr key={row.id}>
          <td><button className="text-button" onClick={() => open('applications', row.id)}>{row.name}</button>
            <span className={styles.small}>{row.code} · {statusNames[row.status] ?? row.status}{row.owner && ` · ${row.owner}`}</span></td>
          <td>{row.organization.name}</td>
          <td>{serviceTypeNames[row.serviceType] ?? row.serviceType}</td>
          <td>{row.servers.length === 0 ? <span className="muted">—</span> : row.servers.map((server) => <div key={server.id}>
            <button className="text-button" onClick={() => open('servers', server.id)}>{server.hostname}</button>
            <span className={styles.small}>{server.dataCenter}{server.addresses.length > 0 && ` · ${server.addresses.join(', ')}`}</span></div>)}</td>
          <td>{row.domains.length === 0 ? <span className="muted">—</span> : row.domains.join(', ')}</td>
        </tr>)}</tbody></table></div>}
      <Pager {...data} change={setPage} />
    </>}
  </section>;
}
