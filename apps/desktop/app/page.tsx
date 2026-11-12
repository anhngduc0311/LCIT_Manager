'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiFailure, apiUrl, Page, requestApi, RequestApi, Session } from './api';
import { Catalog, catalogs, Detail, Kind, Pager, roleNames, useRemote } from './catalog-ui';

const healthMessages = {
  checking: 'Đang kiểm tra kết nối', ready: 'API và cơ sở dữ liệu đang hoạt động',
  unavailable: 'API đang chạy, cơ sở dữ liệu chưa sẵn sàng', offline: 'Không kết nối được API',
};

function Health() {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<keyof typeof healthMessages>('checking');
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiUrl}/health/ready`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) })
      .then(async (response) => {
        const body = await response.json();
        if (!controller.signal.aborted) setStatus(response.ok && body.database === 'up' ? 'ready' : response.status === 503 ? 'unavailable' : 'offline');
      }).catch(() => { if (!controller.signal.aborted) setStatus('offline'); });
    return () => controller.abort();
  }, [attempt]);
  return <aside className="health"><div><p role="status" className={status}><span className="status-dot" />{healthMessages[status]}</p><code>{apiUrl}</code></div>
    <button className="secondary" disabled={status === 'checking'} onClick={() => { setStatus('checking'); setAttempt((value) => value + 1); }}>Kiểm tra lại</button></aside>;
}

function SignIn({ onLogin, notice }: { onLogin: (session: Session) => void; notice: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try { onLogin(await requestApi<Session>('/auth/login', { method: 'POST', body: { username: data.get('username'), password: data.get('password') } })); }
    catch (error) { setError(error instanceof Error ? error.message : 'Không thể đăng nhập.'); }
    finally { setBusy(false); }
  }
  return <main className="login-shell"><header className="brand"><span className="brand-mark" aria-hidden="true">L</span> LCIT Manager</header>
    <section className="panel login-panel"><h1>Đăng nhập</h1>
      <form onSubmit={submit}><label>Tên đăng nhập<input name="username" autoComplete="username" maxLength={64} required /></label>
        <label>Mật khẩu<input name="password" type="password" autoComplete="current-password" maxLength={256} required /></label>
        {(error || notice) && <p className="error" role="alert">{error || notice}</p>}
        <button disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button></form>
    </section><Health /></main>;
}

interface SearchResult {
  id: string; name: string; code: string;
  organization: { id: string; name: string };
  owner: { id: string; displayName: string } | null;
  servers: { id: string; hostname: string; dataCenter: { id: string; name: string };
    addresses: { address: string; networkScope: string; kind: string }[]; accessMethods: string[] }[];
  domains: { id: string; name: string }[];
}

function Search({ api, open }: { api: RequestApi; open: (kind: Kind, id: string) => void }) {
  const [value, setValue] = useState('');
  const [search, setSearch] = useState({ term: '', page: 1, revision: 0 });
  const result = useRemote<Page<SearchResult>>(api, search.term ? `/search?q=${encodeURIComponent(search.term)}&page=${search.page}` : '', search.revision);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) setSearch((previous) => ({ term: value.trim(), page: 1, revision: previous.revision + 1 }));
  }
  return <section className="panel search-panel"><h1>Tra cứu hệ thống</h1>
    <form className="search-form" onSubmit={submit}><label>Từ khóa<input value={value} maxLength={253} placeholder="IP, hostname, tên miền, ứng dụng hoặc đơn vị" onChange={(event) => setValue(event.target.value)} required /></label>
      <button disabled={!value.trim()}>Tìm kiếm</button></form>
    {search.term && !result && <p role="status">Đang tra cứu…</p>}
    {result?.error && <p className="error" role="alert">{result.error}</p>}
    {result?.data && <>
      {result.data.items.length === 0 && <p className="empty">Không tìm thấy kết quả cho “{search.term}”.</p>}
      {result.data.items.map((item) => <article className="search-result" key={item.id}>
        <div className="section-title"><h2><button className="text-button" onClick={() => open('applications', item.id)}>{item.name}</button></h2><span className="muted">{item.code}</span></div>
        <p>{item.organization.name}{item.owner && ` · Phụ trách: ${item.owner.displayName}`}</p>
        {item.servers.length > 0 && <ul className="rows">{item.servers.map((server) => <li key={server.id}><div>
          <button className="text-button" onClick={() => open('servers', server.id)}>{server.hostname}</button> <span className="muted">· {server.dataCenter.name}</span>
          {server.addresses.map((address) => <div key={`${address.address}:${address.networkScope}:${address.kind}`}><code>{address.address}</code> <span className="muted">· {address.networkScope}</span></div>)}
        </div>{server.accessMethods.length > 0 && <span>{server.accessMethods.map((method) => method.toUpperCase()).join(' · ')}</span>}</li>)}</ul>}
        {item.domains.length > 0 && <div className="actions domain-links">{item.domains.map((domain) =>
          <button key={domain.id} className="text-button" onClick={() => open('domains', domain.id)}>{domain.name}</button>)}</div>}
      </article>)}
      <Pager {...result.data} change={(page) => setSearch((previous) => ({ ...previous, page }))} />
    </>}
  </section>;
}

type View = { kind: Kind | 'search' | 'health'; id?: string };
function readView(): View {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get('view') ?? '';
  const id = params.get('id');
  if (kind === 'health') return { kind };
  if (!Object.hasOwn(catalogs, kind)) return { kind: 'search' };
  return { kind: kind as Kind, ...(id && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) && { id }) };
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<View>({ kind: 'search' });
  const [loggingOut, setLoggingOut] = useState(false);
  const token = session?.token;
  const api: RequestApi = useCallback(async <T,>(path: string, options?: Parameters<RequestApi>[1]) => {
    try { return await requestApi<T>(path, options, token); }
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

  if (!session) return <SignIn notice={notice} onLogin={(signedIn) => {
    setNotice(''); setSession(signedIn); setView(readView());
  }} />;

  const role = session.user.role;
  const current = view.kind === 'users' && role !== 'admin' ? { kind: 'search' as const } : view;
  const nav = (Object.keys(catalogs) as Kind[]).filter((kind) => kind !== 'users' || role === 'admin');
  async function logout() {
    setLoggingOut(true);
    let message = '';
    try { await api('/auth/logout', { method: 'POST' }); }
    catch (error) { if (!(error instanceof ApiFailure && error.status === 401)) message = 'Đã đóng phiên trên thiết bị. API chưa xác nhận thu hồi phiên.'; }
    finally { navigate({ kind: 'search' }); setSession(null); setNotice(message); setLoggingOut(false); }
  }
  return <div className="workspace"><aside className="sidebar"><div className="brand"><span className="brand-mark" aria-hidden="true">L</span> LCIT Manager</div>
    <nav aria-label="Điều hướng chính">
      <button aria-current={current.kind === 'search' ? 'page' : undefined} onClick={() => navigate({ kind: 'search' })}>Tra cứu</button>
      {nav.map((kind) => <button key={kind} aria-current={current.kind === kind ? 'page' : undefined} onClick={() => navigate({ kind })}>{catalogs[kind].title}</button>)}
      <button aria-current={current.kind === 'health' ? 'page' : undefined} onClick={() => navigate({ kind: 'health' })}>Kết nối hệ thống</button>
    </nav></aside><div className="work-area"><header className="account"><div><strong>{session.user.displayName}</strong><span>{roleNames[role]}</span></div>
      <button className="secondary" disabled={loggingOut} onClick={() => void logout()}>Đăng xuất</button></header>
    <main><div hidden={current.kind !== 'search'}><Search api={api} open={open} /></div>
      {current.kind === 'search' ? null : current.kind === 'health' ? <section className="panel"><h1>Kết nối hệ thống</h1><Health /></section> :
      current.id ? <Detail key={`${current.kind}:${current.id}`} kind={current.kind} id={current.id} api={api} role={role} open={open} back={() => navigate({ kind: current.kind as Kind })} /> :
      <Catalog key={current.kind} kind={current.kind} api={api} role={role} open={open} />}</main></div></div>;
}
