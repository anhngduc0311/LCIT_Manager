import { useState } from 'react';
import { useAlerts, useNotifications } from '../controllers/use-alerts';
import { useLocalPage } from '../controllers/use-local-page';
import { RequestApi } from '../models/api';
import { Alert, AlertKind, describeAlert, kindText } from '../models/alerts';
import { Kind } from '../models/catalog';
import { Pager } from './catalog';
import { Icon } from './icon';
import layout from './alerts.module.css';
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

function AlertRow({ alert, createdAt, open, markRead }: {
  alert: Alert; createdAt: string; open: (kind: Kind, id: string) => void; markRead?: () => void;
}) {
  const { title, context } = describeAlert(alert);
  const detail = context.filter((part) => part !== alert.domainName);
  return <li className={layout.row}>
    <div className={layout.event}><strong>{title}</strong>
      <div className={layout.details}>
        <button type="button" className="text-button" onClick={() => open('domains', alert.domainId)}>{alert.domainName}</button>
        {detail.length > 0 && <span>{detail.join(' · ')}</span>}
      </div>
    </div>
    <div className={layout.status}><AlertBadge alert={alert} />
      <time dateTime={createdAt}>{dateTime.format(new Date(createdAt))}</time>
    </div>
    {markRead && <button type="button" className={`secondary ${layout.read}`} aria-label={`Đánh dấu đã đọc: ${title} · ${alert.domainName}`} onClick={markRead}>Đã đọc</button>}
  </li>;
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
  const unreadPage = useLocalPage(unread ?? [], 20);
  const [showHistory, setShowHistory] = useState(false);
  const history = result?.data;
  return <section className={`panel ${layout.panel}`} aria-labelledby="alerts-title">
    <header className={layout.header}>
      <div><h1 id="alerts-title">Cảnh báo</h1><p className="page-description">Hạn tên miền, SSL và trạng thái DNS/TLS.</p></div>
      <button type="button" className="secondary" onClick={() => { reload(); void notifications.refresh(); }}><Icon name="refresh" size={16} /> Tải lại</button>
    </header>

    <div className={layout.inbox}>
      <div className={layout.toolbar}>
        <div className={layout.views} role="group" aria-label="Chế độ xem cảnh báo">
          <button type="button" aria-pressed={!showHistory} onClick={() => setShowHistory(false)}>Chưa đọc <span>{unreadCount}</span></button>
          <button type="button" aria-pressed={showHistory} onClick={() => setShowHistory(true)}>Lịch sử</button>
        </div>
        {showHistory ? <select aria-label="Loại cảnh báo" value={kind} onChange={(event) => changeKind(event.target.value as AlertKind | '')}>
          <option value="">Tất cả loại cảnh báo</option>
          {Object.entries(kindText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select> : Boolean(unread?.length) && <button type="button" className="secondary" onClick={() => void notifications.markAllRead()}>Đánh dấu tất cả đã đọc</button>}
      </div>

      {showHistory ? <div className={layout.body} aria-label="Lịch sử cảnh báo">
        {!result && <p className={layout.message} role="status">Đang tải cảnh báo…</p>}
        {result?.error && <p className="error" role="alert">{result.error}</p>}
        {history && <>
          {history.items.length > 0 ? <ul className={layout.list}>{history.items.map((alert) =>
            <AlertRow key={alert.id} alert={alert} createdAt={alert.createdAt} open={open} />)}</ul>
            : <p className={layout.message}>{history.total === 0 ? 'Chưa có cảnh báo.' : 'Chưa có cảnh báo ở trang này.'}</p>}
          {history.total > history.pageSize && <Pager {...history} change={setPage} />}
        </>}
      </div> : <div className={layout.body} aria-label="Thông báo chưa đọc">
        {notifications.error && <p className="error" role="alert">{notifications.error}</p>}
        {!unread && !notifications.error && <p className={layout.message} role="status">Đang tải thông báo…</p>}
        {unread && (unread.length === 0 ? <p className={layout.message}>Không có thông báo chưa đọc.</p> :
          <ul className={layout.list}>{unreadPage.items.map((item) =>
            <AlertRow key={item.id} alert={item.alert} createdAt={item.createdAt} open={open} markRead={() => void notifications.setRead(item, true)} />)}</ul>)}
        {unreadPage.total > unreadPage.pageSize && <Pager {...unreadPage} />}
      </div>}
    </div>
  </section>;
}
