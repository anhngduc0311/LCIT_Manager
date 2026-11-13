import { useDashboard, useInventory, useReportFilter } from '../controllers/use-reports';
import { RequestApi } from '../models/api';
import { Kind } from '../models/catalog';
import { ReportFilter, Renewal, serviceTypeNames, statusNames } from '../models/reports';
import { Pager, Picker } from './catalog';
import { Icon } from './icon';
import styles from './reports.module.css';

const number = new Intl.NumberFormat('vi-VN');
const date = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short' });

function Filters({ api, filter, change, reset, active }: {
  api: RequestApi; filter: ReportFilter; change: (key: keyof ReportFilter, value: string) => void; reset: () => void; active: boolean;
}) {
  return <div className={styles.filters} role="group" aria-label="Bộ lọc báo cáo">
    <label>Đơn vị<Picker api={api} kind="organizations" value={filter.organizationId} change={(value) => change('organizationId', value)} /></label>
    <label>Trung tâm dữ liệu<Picker api={api} kind="data-centers" value={filter.dataCenterId} change={(value) => change('dataCenterId', value)} /></label>
    <label>Hình thức dịch vụ<select value={filter.serviceType} onChange={(event) => change('serviceType', event.target.value)}>
      <option value="">Tất cả</option>{Object.entries(serviceTypeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Trạng thái<select value={filter.status} onChange={(event) => change('status', event.target.value)}>
      <option value="">Tất cả</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {active && <button type="button" className="secondary" onClick={reset}>Bỏ lọc</button>}
  </div>;
}

function Bars({ rows, empty }: { rows: { key: string; label: string; value: number; detail?: string }[]; empty: string }) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  const max = Math.max(...rows.map((row) => row.value), 1);
  return <ul className={styles.bars}>{rows.map((row) => <li key={row.key} title={`${row.label}: ${number.format(row.value)}${row.detail ? ` · ${row.detail}` : ''}`}>
    <span>{row.label}</span><span className={styles.value}>{number.format(row.value)}{row.detail && ` · ${row.detail}`}</span>
    <span className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: `${(row.value / max) * 100}%` }} /></span>
  </li>)}</ul>;
}

function dueBadge(item: Renewal) {
  if (item.daysLeft < 0) return <span className={styles.badgeCritical}>⚠ Quá hạn {-item.daysLeft} ngày</span>;
  if (item.daysLeft <= 30) return <span className={styles.badgeWarning}>◔ Còn {item.daysLeft} ngày</span>;
  return <span className={styles.badgeNotice}>○ Còn {item.daysLeft} ngày</span>;
}

const renewalLabel = (item: Renewal) => item.kind === 'domain' ? 'Tên miền'
  : item.source === 'observed' ? 'SSL quan sát được' : 'SSL nhập tay';

export function DashboardView({ api, open }: { api: RequestApi; open: (kind: Kind, id: string) => void }) {
  const filters = useReportFilter();
  const { result, reload } = useDashboard(api, filters.filter);
  const data = result?.data;
  return <section className="panel"><div className="section-title"><div><p className="eyebrow">TỔNG QUAN</p><h1>Dashboard</h1>
    <p className="page-description">Số liệu trong phạm vi bạn được xem. Mỗi ứng dụng chỉ tính một lần tại một trung tâm dữ liệu.</p></div>
    <button className="secondary" onClick={reload}>Tải lại</button></div>
    <Filters api={api} {...filters} />
    {!result && <p role="status">Đang tải số liệu…</p>}
    {result?.error && <p className="error" role="alert">{result.error}</p>}
    {data && <>
      <div className={styles.tiles}>
        {([['applications', 'Ứng dụng'], ['servers', 'Máy chủ'], ['domains', 'Tên miền']] as const).map(([key, label]) =>
          <div className={styles.tile} key={key}><span>{label}</span><strong>{number.format(data.totals[key])}</strong></div>)}
      </div>
      <div className={styles.grid}>
        <div className={styles.card}><h2>Hạn gia hạn tên miền và SSL</h2>
          <div className={styles.status}>
            <div className={styles.critical}><strong>{data.renewals.overdue}</strong>⚠ Quá hạn</div>
            <div className={styles.warning}><strong>{data.renewals.within30}</strong>◔ Trong 30 ngày</div>
            <div className={styles.notice}><strong>{data.renewals.within90}</strong>○ 31–90 ngày</div>
          </div>
          {data.upcomingRenewals.length === 0 ? <p className="muted">Không có hạn nào trong 90 ngày tới.</p> :
            <ul className="rows">{data.upcomingRenewals.map((item) => <li key={`${item.kind}:${item.source}:${item.name}:${item.dueDate}`}>
              <div><button className="text-button" onClick={() => open('domains', item.domainId)}>{item.name}</button>
                <span className={styles.small}>{renewalLabel(item)} · {date.format(new Date(`${item.dueDate}T00:00:00`))}</span></div>
              {dueBadge(item)}
            </li>)}</ul>}
        </div>
        <div className={styles.card}><h2>Ứng dụng theo trung tâm dữ liệu</h2>
          <Bars empty="Chưa có ứng dụng gắn máy chủ." rows={data.byDataCenter.map((row) => ({ key: row.id, label: row.name, value: row.applications, detail: `${row.servers} máy chủ` }))} />
        </div>
        <div className={styles.card}><h2>Ứng dụng theo đơn vị</h2>
          <Bars empty="Chưa có ứng dụng." rows={data.byOrganization.map((row) => ({ key: row.id, label: row.name, value: row.count }))} />
        </div>
        <div className={styles.card}><h2>Ứng dụng theo hình thức dịch vụ</h2>
          <Bars empty="Chưa có ứng dụng." rows={data.byServiceType.map((row) => ({ key: row.serviceType, label: serviceTypeNames[row.serviceType] ?? row.serviceType, value: row.count }))} />
        </div>
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
    {data && (data.items.length === 0 ? <p className="empty">Không có ứng dụng phù hợp bộ lọc.</p> : <div className={styles.tableWrap}>
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
        </tr>)}</tbody></table>
      <Pager {...data} change={setPage} />
    </div>)}
  </section>;
}
