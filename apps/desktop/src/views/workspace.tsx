'use client';

import { useWorkspace } from '../controllers/use-workspace';
import { Kind } from '../models/catalog';
import { Catalog, Detail } from './catalog';
import { catalogs, roleNames } from './catalog-config';
import { Search } from './search';
import { Health, SignIn } from './sign-in';
import styles from './sign-in.module.css';

export function Workspace() {
  const { session, notice, current, nav, loggingOut, api, open, navigate, login, logout } = useWorkspace();
  if (!session) return <SignIn notice={notice} onLogin={login} />;

  const role = session.user.role;
  return <div className="workspace"><aside className="sidebar"><div className="brand"><span className="brand-mark" aria-hidden="true">L</span> LCIT Manager</div>
    <nav aria-label="Điều hướng chính">
      <button aria-current={current.kind === 'search' ? 'page' : undefined} onClick={() => navigate({ kind: 'search' })}>Tra cứu</button>
      {nav.map((kind) => <button key={kind} aria-current={current.kind === kind ? 'page' : undefined} onClick={() => navigate({ kind })}>{catalogs[kind].title}</button>)}
      <button aria-current={current.kind === 'health' ? 'page' : undefined} onClick={() => navigate({ kind: 'health' })}>Kết nối hệ thống</button>
    </nav></aside><div className="work-area"><header className="account"><div><strong>{session.user.displayName}</strong><span>{roleNames[role]}</span></div>
      <button className="secondary" disabled={loggingOut} onClick={() => void logout()}>Đăng xuất</button></header>
    <main><div hidden={current.kind !== 'search'}><Search api={api} open={open} /></div>
      {current.kind === 'search' ? null : current.kind === 'health' ? <section className={`panel ${styles.connectionPanel}`}><h1>Kết nối hệ thống</h1><Health /></section> :
      current.id ? <Detail key={`${current.kind}:${current.id}`} kind={current.kind} id={current.id} api={api} role={role} open={open} back={() => navigate({ kind: current.kind as Kind })} /> :
      <Catalog key={current.kind} kind={current.kind} api={api} role={role} open={open} />}</main></div></div>;
}
