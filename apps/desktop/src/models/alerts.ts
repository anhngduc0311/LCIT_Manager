import { Page } from './api';

/**
 * Types for the alert and notification API of T3.4 (person A). Contract: docs/NOTIFICATIONS_API.md.
 *   GET   /alerts?kind=&source=&domainId=&page=&pageSize=                  -> Page<Alert>
 *   GET   /notifications?read=all|unread|read&kind=&source=&page=&pageSize= -> NotificationPage
 *   PATCH /notifications/{id}  { "read": true | false }                      -> { id, createdAt, readAt }
 * Everything is filtered by the caller's current scope; times are UTC.
 */
export type AlertKind = 'expiry' | 'outage' | 'recovery';
export type AlertSource = 'manual_domain' | 'manual_tls' | 'observed_tls' | 'dns' | 'tls';
export interface Alert {
  id: string;
  createdAt: string;
  kind: AlertKind;
  source: AlertSource;
  resourceType: 'domain' | 'dns_record' | 'tls_endpoint';
  resourceId: string;
  domainId: string;
  domainName: string;
  resourceLabel: string;
  expiryDate: string | null;
  /** 90/30/14/7; 0 means overdue; null for network events. */
  thresholdDays: number | null;
  check: { status: string; errorCode: string | null; finishedAt: string } | null;
}
export interface AppNotification { id: string; createdAt: string; readAt: string | null; alert: Alert }
export interface NotificationPage extends Page<AppNotification> { unreadCount: number }

export const kindText: Record<AlertKind, string> = { expiry: 'Sắp/đã hết hạn', outage: 'Gián đoạn', recovery: 'Phục hồi' };
export const sourceText: Record<AlertSource, string> = {
  manual_domain: 'Hạn tên miền nhập tay', manual_tls: 'Hạn SSL nhập tay', observed_tls: 'Hạn TLS quan sát được',
  dns: 'Kiểm tra DNS', tls: 'Kiểm tra TLS',
};

const checkStatusText: Record<string, string> = {
  dns_error: 'lỗi phân giải DNS', tls_error: 'lỗi bắt tay TLS', timeout: 'hết thời gian chờ', expired: 'chứng thư đã hết hạn',
  certificate_expired: 'chứng thư đã hết hạn', blocked: 'đích bị chặn theo cấu hình', ok: 'thành công', success: 'thành công',
};

/** One-line title and body used in the list and for the Windows notification. */
export function describeAlert(alert: Alert) {
  const date = alert.expiryDate ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short' }).format(new Date(`${alert.expiryDate}T00:00:00`)) : '';
  if (alert.kind === 'expiry') {
    const what = alert.source === 'manual_domain' ? 'Tên miền' : 'Chứng thư SSL';
    const title = alert.thresholdDays === 0 ? `${what} đã quá hạn` : `${what} hết hạn trong ${alert.thresholdDays} ngày`;
    return { title, body: `${alert.resourceLabel} · ${sourceText[alert.source]} · hạn ${date}` };
  }
  const status = alert.check ? checkStatusText[alert.check.status] ?? alert.check.status : '';
  const title = alert.kind === 'outage' ? `${sourceText[alert.source]}: gián đoạn` : `${sourceText[alert.source]}: đã phục hồi`;
  return { title, body: `${alert.resourceLabel}${status ? ` · ${status}` : ''}` };
}
