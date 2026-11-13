/**
 * Demo data for the alert and notification screens, used only when NEXT_PUBLIC_DEMO_FIXTURES=1.
 * The expiry job runs once a day and network checks need approved targets, so a fresh development database
 * has no alerts yet. This stand-in serves fixtures/notifications.json (person A's sample, T3.4 response shape)
 * and adds one more unread notification shortly after start to exercise the Windows notification.
 * Every other path, including /imports, goes to the real API.
 */
import fixture from '../../../../fixtures/notifications.json';
import { ApiFailure, RequestOptions } from './api';
import { Alert, AppNotification, NotificationPage } from './alerts';

export const demoFixturesEnabled = process.env.NEXT_PUBLIC_DEMO_FIXTURES === '1';
const demoPaths = /^\/(alerts|notifications)(?:[/?]|$)/;
export const isDemoPath = (path: string) => demoFixturesEnabled && demoPaths.test(path);

const notifications: AppNotification[] = structuredClone(fixture.items) as AppNotification[];
const startedAt = Date.now();
let arrived = false;

function arrival(): AppNotification {
  const now = new Date().toISOString();
  return { id: '43000000-0000-4000-8000-000000000003', createdAt: now, readAt: null, alert: {
    id: '42000000-0000-4000-8000-000000000003', createdAt: now, kind: 'expiry', source: 'manual_domain', resourceType: 'domain',
    resourceId: '41000000-0000-4000-8000-000000000001', domainId: '41000000-0000-4000-8000-000000000001',
    domainName: 'portal-a.example.test', resourceLabel: 'portal-a.example.test',
    expiryDate: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10), thresholdDays: 7, check: null,
  } };
}

function page<T>(items: T[], query: URLSearchParams) {
  const pageNumber = Number(query.get('page') ?? 1);
  const pageSize = Number(query.get('pageSize') ?? 25);
  return { items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize), page: pageNumber, pageSize, total: items.length };
}

function respond(path: string, options: RequestOptions): unknown {
  if (!arrived && Date.now() - startedAt > 15_000) { arrived = true; notifications.unshift(arrival()); }
  const url = new URL(path, 'http://demo');
  const [collection, id] = url.pathname.split('/').filter(Boolean);
  const kind = url.searchParams.get('kind');
  const matches = (alert: Alert) => !kind || alert.kind === kind;

  if (collection === 'alerts') {
    const alerts = [...new Map(notifications.map((item) => [item.alert.id, item.alert])).values()].filter(matches);
    return page(alerts, url.searchParams);
  }
  if ((options.method ?? 'GET') === 'GET') {
    const read = url.searchParams.get('read') ?? 'all';
    const list = notifications.filter((item) => matches(item.alert) && (read === 'all' || (read === 'unread') === !item.readAt));
    return { ...page(list, url.searchParams), unreadCount: notifications.filter((item) => matches(item.alert) && !item.readAt).length } satisfies NotificationPage;
  }
  const item = notifications.find((notification) => notification.id === id);
  if (!item) throw new ApiFailure(404, 'NOT_FOUND', 'Không tìm thấy dữ liệu trong phạm vi được cấp.');
  item.readAt = (options.body as { read?: boolean }).read ? item.readAt ?? new Date().toISOString() : null;
  return { id: item.id, createdAt: item.createdAt, readAt: item.readAt };
}

export async function demoRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return structuredClone(respond(path, options)) as T;
}
