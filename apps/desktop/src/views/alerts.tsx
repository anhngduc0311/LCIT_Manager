import { useAlerts, useNotifications } from '../controllers/use-alerts';
import { RequestApi } from '../models/api';
import { Alert, AlertKind, describeAlert, kindText, sourceText } from '../models/alerts';
import { Kind } from '../models/catalog';
import { Pager } from './catalog';
import styles from './reports.module.css';

const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

function AlertBadge({ alert }: { alert: Alert }) {
  if (alert.kind === 'recovery') return <span className={styles.badgeNotice}>✓ Phục hồi</span>;
  if (alert.kind === 'outage') return <span className={styles.badgeCritical}>⚠ Gián đoạn</span>;
  if (alert.thresholdDays === 0) return <span className={styles.badgeCritical}>⚠ Quá hạn</span>;
  return alert.thresholdDays !== null && alert.thresholdDays <= 30
    ? <span className={styles.badgeWarning}>◔ Mốc {alert.thresholdDays} ngày</span>
    : <span className={styles.badgeNotice}>○ Mốc {alert.thresholdDays} ngày</span>;
}

function AlertLine({ alert, open }: { alert: Alert; open: (kind: Kind, id: string) => void }) {
  const { title, body } = describeAlert(alert);
  return <div><strong>{title}</strong>
    <span className={styles.small}><button className="text-button" onClick={() => open('domains', alert.domainId)}>{alert.domainName}</button>
      {' · '}{body}</span></div>;
}

export function NotificationBell({ count, open }: { count: number; open: () => void }) {
  return <button className="secondary" onClick={open} aria-label={`Thông báo chưa đọc: ${count}`} title="Cảnh báo và thông báo">
    🔔{count > 0 && <strong style={{ marginLeft: '.3rem' }}>{count}</strong>}
  </button>;
}

export function AlertsView({ api, notifications, open }: {
  api: RequestApi; notifications: ReturnType<typeof useNotifications>; open: (kind: Kind, id: string) => void;
}) {
  const { result, kind, changeKind, setPage, reload } = useAlerts(api);
  const { unread, unreadCount } = notifications;
  return <section className="panel"><div className="section-title"><div><p className="eyebrow">GIÁM SÁT</p><h1>Cảnh báo</h1>
    <p className="page-description">Hạn tên miền và SSL theo mốc 90, 30, 14, 7 ngày, cùng gián đoạn và phục hồi DNS/TLS quan sát từ máy chạy lịch, trong phạm vi của bạn.
      Đóng cửa sổ thì ứng dụng chạy tiếp dưới khay Windows và vẫn hiện thông báo mới; chọn “Thoát” trong menu khay để tắt hẳn.
      Thông báo đến lúc ứng dụng tắt sẽ hiện khi mở lại. Danh sách được tải lại đầy đủ mỗi phút.</p></div>
    <button className="secondary" onClick={() => { reload(); void notifications.refresh(); }}>Tải lại</button></div>

    <div className="subpanel"><div className="section-title"><h3>Thông báo chưa đọc ({unreadCount})</h3>
      {(unread?.length ?? 0) > 0 && <button className="secondary" onClick={() => void notifications.markAllRead()}>Đánh dấu tất cả đã đọc</button>}</div>
      {notifications.error && <p className="error" role="alert">{notifications.error}</p>}
      {!unread && !notifications.error && <p role="status">Đang tải thông báo…</p>}
      {unread && (unread.length === 0 ? <p className="muted">Không có thông báo mới.</p> :
        <ul className="rows">{unread.map((item) => <li key={item.id}>
          <div><AlertLine alert={item.alert} open={open} /><span className={styles.small}>{dateTime.format(new Date(item.createdAt))}</span></div>
          <div className="actions"><AlertBadge alert={item.alert} />
            <button className="secondary" onClick={() => void notifications.setRead(item, true)}>Đã đọc</button></div></li>)}</ul>)}
    </div>

    <div className="subpanel"><div className="section-title"><h3>Lịch sử cảnh báo</h3><div className="actions">
      <button className={kind === '' ? undefined : 'secondary'} onClick={() => changeKind('')}>Tất cả</button>
      {(Object.keys(kindText) as AlertKind[]).map((value) =>
        <button key={value} className={kind === value ? undefined : 'secondary'} onClick={() => changeKind(value)}>{kindText[value]}</button>)}
    </div></div>
      {!result && <p role="status">Đang tải cảnh báo…</p>}
      {result?.error && <p className="error" role="alert">{result.error}</p>}
      {result?.data && (result.data.items.length === 0 ? <p className="muted">Chưa có cảnh báo.</p> : <>
        <ul className="rows">{result.data.items.map((alert) => <li key={alert.id}>
          <div><AlertLine alert={alert} open={open} />
            <span className={styles.small}>{sourceText[alert.source]} · {dateTime.format(new Date(alert.createdAt))}</span></div>
          <AlertBadge alert={alert} /></li>)}</ul>
        <Pager {...result.data} change={setPage} /></>)}
    </div>
  </section>;
}
