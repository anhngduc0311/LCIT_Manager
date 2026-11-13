'use client';
import { useNotifications } from '../controllers/use-alerts';
import { useVietnameseValidation } from '../controllers/use-validation-messages';
import { toolViews, ToolView, useWorkspace } from '../controllers/use-workspace';
import { Kind } from '../models/catalog';
import { AlertsView, NotificationBell } from './alerts';
import { Catalog, Detail } from './catalog';
import { catalogs, roleNames } from './catalog-config';
import { ImportsView } from './imports';
import { DashboardView, ReportsView } from './reports';
import { Search } from './search';
import { Health, SignIn } from './sign-in';
import { Icon } from './icon';
import styles from './sign-in.module.css';

const tools: Record<ToolView, { title: string; icon: string; adminOnly?: boolean }> = {
 dashboard: { title: 'Tổng quan', icon: 'dashboard' },
 alerts: { title: 'Cảnh báo', icon: 'alerts' },
 reports: { title: 'Báo cáo', icon: 'reports' },
 imports: { title: 'Nhập Excel', icon: 'imports', adminOnly: true },
};

export function Workspace() {
 const workspace = useWorkspace();
 // Applies to the sign-in form and every form after sign-in.
 useVietnameseValidation();
 if (!workspace.session) return <SignIn notice={workspace.notice} onLogin={workspace.login} />;
 // Notifications poll only while signed in, so they live in a component mounted after sign-in.
 return <SignedIn workspace={workspace} session={workspace.session} />;
}

function SignedIn({ workspace, session }: { workspace: ReturnType<typeof useWorkspace>; session: NonNullable<ReturnType<typeof useWorkspace>['session']> }) {
 const { current: requested, nav, loggingOut, api, open, navigate, logout } = workspace;
 const notifications = useNotifications(api, session.user.id);
 const role = session.user.role;
 const visibleTools = toolViews.filter((view) => !tools[view].adminOnly || role === 'admin');
 const current = (toolViews as readonly string[]).includes(requested.kind) && !visibleTools.includes(requested.kind as ToolView)
  ? { kind: 'search' as const } : requested;
 const tool = (toolViews as readonly string[]).includes(current.kind) ? current.kind as ToolView : undefined;
 const title = current.kind === 'search' ? 'Tra cứu hệ thống' : current.kind === 'health' ? 'Kết nối hệ thống' : tool ? tools[tool].title : catalogs[current.kind as Kind].title;
 const unread = notifications.unreadCount;
 return <div className="workspace"><aside className="sidebar">
  <div className="brand"><span className="brand-mark" aria-hidden="true">L</span><div>LCIT<span className="brand-subtitle">MANAGER</span></div></div>
  <p className="nav-label">KHÔNG GIAN LÀM VIỆC</p>
  <nav aria-label="Điều hướng chính">
   <button aria-current={current.kind === 'search' ? 'page' : undefined} onClick={() => navigate({ kind: 'search' })}><Icon name="search" />Tra cứu</button>
   {visibleTools.map((view) => <button key={view} aria-current={current.kind === view ? 'page' : undefined} onClick={() => navigate({ kind: view })}>
    <Icon name={tools[view].icon} />{tools[view].title}{view === 'alerts' && unread > 0 && <strong aria-label={`${unread} chưa đọc`}> ({unread})</strong>}</button>)}
   {nav.map((kind) => <button key={kind} aria-current={current.kind === kind ? 'page' : undefined} onClick={() => navigate({ kind })}><Icon name={kind} />{catalogs[kind].title}</button>)}
   <button className="health-nav" aria-current={current.kind === 'health' ? 'page' : undefined} onClick={() => navigate({ kind: 'health' })}><Icon name="health" />Kết nối hệ thống</button>
  </nav>
  <div className="sidebar-footer"><Icon name="shield" /><div>Quản lý tập trung<span>Hạ tầng & ứng dụng</span></div></div>
 </aside><div className="work-area"><header className="account">
  <div className="breadcrumb">Không gian làm việc<span>/</span><strong>{title}</strong></div>
  <NotificationBell count={unread} open={() => navigate({ kind: 'alerts' })} />
  <div className="avatar" aria-hidden="true">{session.user.displayName.trim().charAt(0).toUpperCase()}</div>
  <div className="account-info"><strong>{session.user.displayName}</strong><span>{roleNames[role]}</span></div>
  <button className="secondary logout" disabled={loggingOut} onClick={() => void logout()}><Icon name="logout" size={17} /><span>Đăng xuất</span></button>
 </header><main><div hidden={current.kind !== 'search'}><Search api={api} open={open} /></div>
 {current.kind === 'search' ? null : tool === 'dashboard' ? <DashboardView api={api} open={open} /> :
 tool === 'reports' ? <ReportsView api={api} open={open} /> :
 tool === 'alerts' ? <AlertsView api={api} notifications={notifications} open={open} /> :
 tool === 'imports' ? <ImportsView api={api} /> :
 current.kind === 'health' ? <section className={`panel ${styles.connectionPanel}`}><p className="eyebrow">HỆ THỐNG</p><h1>Kết nối hệ thống</h1><p className="page-description">Kiểm tra kết nối đến dịch vụ và cơ sở dữ liệu.</p><Health /></section> :
 current.id ? <Detail key={`${current.kind}:${current.id}`} kind={current.kind as Kind} id={current.id} api={api} role={role} open={open} back={() => navigate({ kind: current.kind as Kind })} /> :
 <Catalog key={current.kind} kind={current.kind as Kind} api={api} role={role} actorId={session.user.id} open={open} />}</main>
 <footer className="workspace-footer">LCIT Manager<span>Quản lý hạ tầng. Kết nối thông tin.</span></footer></div></div>;
}
