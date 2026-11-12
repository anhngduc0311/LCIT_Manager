'use client';
import { useWorkspace } from '../controllers/use-workspace';
import { Kind } from '../models/catalog';
import { Catalog, Detail } from './catalog';
import { catalogs, roleNames } from './catalog-config';
import { Search } from './search';
import { Health, SignIn } from './sign-in';
import { Icon } from './icon';
import styles from './sign-in.module.css';

export function Workspace() {
 const { session, notice, current, nav, loggingOut, api, open, navigate, login, logout } = useWorkspace();
 if (!session) return <SignIn notice={notice} onLogin={login} />;
 const role = session.user.role;
 const title = current.kind === 'search' ? 'Tra cứu hệ thống' : current.kind === 'health' ? 'Kết nối hệ thống' : catalogs[current.kind].title;
 return <div className="workspace"><aside className="sidebar">
  <div className="brand"><span className="brand-mark" aria-hidden="true">L</span><div>LCIT<span className="brand-subtitle">MANAGER</span></div></div>
  <p className="nav-label">KHÔNG GIAN LÀM VIỆC</p>
  <nav aria-label="Điều hướng chính">
   <button aria-current={current.kind === 'search' ? 'page' : undefined} onClick={() => navigate({ kind: 'search' })}><Icon name="search" />Tra cứu</button>
   {nav.map((kind) => <button key={kind} aria-current={current.kind === kind ? 'page' : undefined} onClick={() => navigate({ kind })}><Icon name={kind} />{catalogs[kind].title}</button>)}
   <button className="health-nav" aria-current={current.kind === 'health' ? 'page' : undefined} onClick={() => navigate({ kind: 'health' })}><Icon name="health" />Kết nối hệ thống</button>
  </nav>
  <div className="sidebar-footer"><Icon name="shield" /><div>Quản lý tập trung<span>Hạ tầng & ứng dụng</span></div></div>
 </aside><div className="work-area"><header className="account">
  <div className="breadcrumb">Không gian làm việc<span>/</span><strong>{title}</strong></div>
  <div className="avatar" aria-hidden="true">{session.user.displayName.trim().charAt(0).toUpperCase()}</div>
  <div className="account-info"><strong>{session.user.displayName}</strong><span>{roleNames[role]}</span></div>
  <button className="secondary logout" disabled={loggingOut} onClick={() => void logout()}><Icon name="logout" size={17} /><span>Đăng xuất</span></button>
 </header><main><div hidden={current.kind !== 'search'}><Search api={api} open={open} /></div>
 {current.kind === 'search' ? null : current.kind === 'health' ? <section className={`panel ${styles.connectionPanel}`}><p className="eyebrow">HỆ THỐNG</p><h1>Kết nối hệ thống</h1><p className="page-description">Kiểm tra kết nối đến dịch vụ và cơ sở dữ liệu.</p><Health /></section> :
 current.id ? <Detail key={`${current.kind}:${current.id}`} kind={current.kind} id={current.id} api={api} role={role} open={open} back={() => navigate({ kind: current.kind as Kind })} /> :
 <Catalog key={current.kind} kind={current.kind} api={api} role={role} actorId={session.user.id} open={open} />}</main>
 <footer className="workspace-footer">LCIT Manager<span>Quản lý hạ tầng. Kết nối thông tin.</span></footer></div></div>;
}
