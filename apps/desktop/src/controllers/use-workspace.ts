import { useCallback, useEffect, useState } from 'react';
import { ApiFailure, requestApi, RequestApi, Session } from '../models/api';
import { catalogKinds, Kind } from '../models/catalog';
import { demoRequest, isDemoPath } from '../models/demo-fixtures';

export const toolViews = ['dashboard', 'alerts', 'reports', 'imports'] as const;
export type ToolView = typeof toolViews[number];
type View = { kind: Kind | ToolView | 'search' | 'health'; id?: string };
function readView(): View {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get('view') ?? '';
  const id = params.get('id');
  if (kind === 'health' || toolViews.includes(kind as ToolView)) return { kind: kind as ToolView | 'health' };
  if (!catalogKinds.includes(kind as Kind)) return { kind: 'search' };
  return { kind: kind as Kind, ...(id && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) && { id }) };
}

export function useWorkspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<View>({ kind: 'search' });
  const [loggingOut, setLoggingOut] = useState(false);
  const token = session?.token;
  const api: RequestApi = useCallback(async <T,>(path: string, options?: Parameters<RequestApi>[1]) => {
    try { return isDemoPath(path) ? await demoRequest<T>(path, options) : await requestApi<T>(path, options, token); }
    catch (error) {
      if (error instanceof ApiFailure && error.status === 401 && !options?.signal?.aborted) {
        setNotice('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
        setSession((current) => current?.token === token ? null : current);
      }
      throw error;
    }
  }, [token]);

  useEffect(() => {
    const pop = () => setView(readView());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (!session) return;
    const timeout = window.setTimeout(() => {
      setNotice('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.'); setSession(null);
    }, Math.max(0, new Date(session.expiresAt).getTime() - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [session]);

  function navigate(next: View) {
    const url = new URL(window.location.href);
    if (next.kind === 'search') url.searchParams.delete('view');
    else url.searchParams.set('view', next.kind);
    if (next.id) url.searchParams.set('id', next.id);
    else url.searchParams.delete('id');
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
    setView(next);
  }
  const open = (kind: Kind, id: string) => navigate({ kind, id });

  function login(signedIn: Session) {
    setNotice(''); setSession(signedIn); setView(readView());
  }

  const role = session?.user.role;
  const current = view.kind === 'users' && role !== 'admin' ? { kind: 'search' as const } : view;
  const nav = catalogKinds.filter((kind) => kind !== 'users' || role === 'admin');
  async function logout() {
    setLoggingOut(true);
    let message = '';
    try { await api('/auth/logout', { method: 'POST' }); }
    catch (error) { if (!(error instanceof ApiFailure && error.status === 401)) message = 'Đã đóng phiên trên thiết bị. API chưa xác nhận thu hồi phiên.'; }
    finally { navigate({ kind: 'search' }); setSession(null); setNotice(message); setLoggingOut(false); }
  }

  return { session, notice, current, nav, loggingOut, api, open, navigate, login, logout };
}
