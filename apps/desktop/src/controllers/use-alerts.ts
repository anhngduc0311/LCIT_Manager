import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, Page, RequestApi } from '../models/api';
import { Alert, AlertKind, AppNotification, describeAlert, NotificationPage } from '../models/alerts';
import { errorText, useRemote } from './use-remote';

const pollMs = 60_000;
const maxPages = 20;
const shownKey = 'lcit.notifications.shown';

function readShown(userId: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(`${shownKey}.${userId}`) ?? '[]') as string[]); }
  catch { return new Set(); }
}
function writeShown(userId: string, ids: Set<string>) {
  try { localStorage.setItem(`${shownKey}.${userId}`, JSON.stringify([...ids].slice(-1000))); } catch { /* storage unavailable */ }
}

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Windows toast through the Tauri notification plugin; the browser Notification API outside Tauri. */
async function showSystemNotification(item: AppNotification) {
  const { title, body } = describeAlert(item.alert);
  if (inTauri()) {
    const plugin = await import('@tauri-apps/plugin-notification');
    let granted = await plugin.isPermissionGranted();
    if (!granted) granted = (await plugin.requestPermission()) === 'granted';
    if (granted) plugin.sendNotification({ title, body });
    return;
  }
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission === 'granted') new Notification(title, { body, tag: item.id });
}

/**
 * Keeps the caller's unread notifications in sync while the app runs (docs/NOTIFICATIONS_API.md, "Tích hợp T3.5"):
 * reads every page on start and on each poll, replaces the list with the API's current answer (so items that
 * left the caller's scope disappear), and raises each notification ID as a Windows notification at most once
 * per account. Showing a toast never marks it read.
 */
export function useNotifications(api: RequestApi, userId: string) {
  const [unread, setUnread] = useState<AppNotification[]>();
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState('');
  const shown = useRef<Set<string> | null>(null);
  const syncing = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      const byId = new Map<string, AppNotification>();
      let count = 0;
      for (let page = 1; page <= maxPages; page += 1) {
        const result = await api<NotificationPage>(`/notifications?read=unread&page=${page}&pageSize=100`, { signal });
        result.items.forEach((item) => byId.set(item.id, item));
        count = result.unreadCount;
        if (page * result.pageSize >= result.total) break;
      }
      const items = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      setUnread(items); setUnreadCount(count); setError('');
      shown.current ??= readShown(userId);
      const fresh = items.filter((item) => !shown.current!.has(item.id)).reverse();
      for (const item of fresh) {
        shown.current.add(item.id);
        await showSystemNotification(item).catch(() => undefined);
      }
      if (fresh.length) writeShown(userId, shown.current);
    } catch (failure) {
      if (!signal?.aborted) setError(errorText(failure));
    } finally {
      syncing.current = false;
    }
  }, [api, userId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), pollMs);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh]);

  async function setRead(item: AppNotification, read: boolean) {
    try { await api(`/notifications/${item.id}`, { method: 'PATCH', body: { read } }); }
    catch (failure) {
      // 404: the notification is no longer in scope; the refresh below drops it.
      if (!(failure instanceof ApiFailure && failure.status === 404)) setError(errorText(failure));
    }
    await refresh();
  }

  async function markAllRead() {
    // The full list is already loaded, so marking does not shift the pages being read.
    for (const item of unread ?? []) {
      try { await api(`/notifications/${item.id}`, { method: 'PATCH', body: { read: true } }); }
      catch (failure) { if (!(failure instanceof ApiFailure && failure.status === 404)) { setError(errorText(failure)); break; } }
    }
    await refresh();
  }

  return { unread, unreadCount, error, refresh, setRead, markAllRead };
}

export function useAlerts(api: RequestApi) {
  const [kind, setKind] = useState<AlertKind | ''>('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const result = useRemote<Page<Alert>>(api, `/alerts?${kind ? `kind=${kind}&` : ''}page=${page}&pageSize=20`, revision);
  return {
    result, kind, setPage,
    changeKind: (next: AlertKind | '') => { setKind(next); setPage(1); },
    reload: () => setRevision((value) => value + 1),
  };
}
