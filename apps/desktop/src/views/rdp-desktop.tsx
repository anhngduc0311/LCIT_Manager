'use client';

import { useEffect, useRef, useState } from 'react';
import type { AccessEndpoint, AccessLaunchResponse } from '../models/access';
import type { RequestApi } from '../models/api';
import { errorText } from '../controllers/use-remote';
import styles from './rdp-desktop.module.css';

interface Bounds { x: number; y: number; width: number; height: number; visible: boolean }
interface RdpStatus { connected: number; reason: number }
type Phase = 'idle' | 'authorizing' | 'connecting' | 'connected' | 'ended';
const labels: Record<Phase, string> = { idle: 'Sẵn sàng kết nối', authorizing: 'Đang kiểm tra quyền…', connecting: 'Đang kết nối…', connected: 'Đã kết nối RDP', ended: 'Phiên RDP đã kết thúc' };

export function RdpDesktop({ api, endpoint, close, fixDefaultPort }: { api: RequestApi; endpoint: AccessEndpoint; close: () => void; fixDefaultPort?: () => Promise<void> }) {
  const screen = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const id = useRef<string | undefined>(undefined);
  const running = useRef(false);
  const started = useRef(0);
  const [username, setUsername] = useState('');
  const [domain, setDomain] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [target, setTarget] = useState<AccessLaunchResponse>();
  const busy = phase === 'authorizing' || phase === 'connecting';

  async function correctPort() {
    if (!fixDefaultPort || running.current) return;
    running.current = true; setError(''); setPhase('authorizing');
    try { await fixDefaultPort(); }
    catch (failure) { if (mounted.current) { setError(errorText(failure)); setPhase('idle'); } }
    finally { running.current = false; }
  }

  function bounds(): Bounds {
    const rect = screen.current!.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    return { x: Math.max(0, Math.round(rect.left * scale)), y: Math.max(0, Math.round(rect.top * scale)),
      width: Math.max(1, Math.min(16384, Math.round(rect.width * scale))), height: Math.max(1, Math.min(16384, Math.round(rect.height * scale))),
      // WebView2 can report itself occluded by its native RDP sibling. The parent
      // Windows window controls minimization; WebView visibility must not hide RDP.
      visible: Boolean(screen.current?.isConnected && rect.width > 0 && rect.height > 0) };
  }

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    let frame = 0;
    let last = '';
    let polling = false;
    const position = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!id.current || !screen.current) return;
        const geometry = bounds();
        const key = `${id.current}:${JSON.stringify(geometry)}`;
        if (last === key) return;
        last = key;
        void import('@tauri-apps/api/core').then(({ invoke }) => invoke('rdp_resize', { id: id.current, bounds: geometry }))
          .catch((failure) => { if (mounted.current) setError(errorText(failure)); });
      });
    };
    const observer = new ResizeObserver(position);
    if (screen.current) observer.observe(screen.current);
    window.addEventListener('resize', position);
    document.addEventListener('visibilitychange', position);
    const timer = window.setInterval(async () => {
      const sessionId = id.current;
      if (!sessionId || polling) return;
      polling = true;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const status = await invoke<RdpStatus>('rdp_status', { id: sessionId });
        if (!mounted.current || id.current !== sessionId) return;
        if (status.connected === 1) setPhase('connected');
        else if (status.connected === 2) setPhase('connecting');
        else if (Date.now() - started.current > 2000) {
          await invoke('rdp_close', { id: sessionId });
          if (!mounted.current || id.current !== sessionId) return;
          id.current = undefined; setPhase('ended');
          setError(status.reason === 7
            ? 'Máy đích từ chối kết nối RDP (mã 7). Kiểm tra đúng cổng RDP, tài khoản được phép Remote Desktop và chính sách đăng nhập trên máy đích.'
            : `RDP đã ngắt kết nối${status.reason ? ` (mã ${status.reason})` : ''}. Kiểm tra tài khoản, VPN, dịch vụ Remote Desktop và quyền truy cập trên máy đích.`);
        }
      } catch (failure) { if (mounted.current) setError(errorText(failure)); }
      finally { polling = false; }
    }, 1000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer); cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('resize', position); document.removeEventListener('visibilitychange', position);
      document.body.style.overflow = overflow;
      const sessionId = id.current;
      if (sessionId) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('rdp_close', { id: sessionId })).catch(() => {});
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  async function connect() {
    if (running.current || id.current || !screen.current) return;
    running.current = true; setError(''); setPhase('authorizing');
    const login = { username: username.trim(), domain: domain.trim(), password };
    setPassword('');
    try {
      const grant = await api<AccessLaunchResponse>(`/access-endpoints/${endpoint.id}/launch`, { method: 'POST' });
      if (!mounted.current) return;
      if (grant.protocol !== 'rdp') throw new Error('Điểm truy cập đã đổi giao thức. Hãy đóng và tải lại.');
      setTarget(grant);
      const { invoke } = await import('@tauri-apps/api/core');
      if (!mounted.current) return;
      const sessionId = await invoke<string>('rdp_open', {
        request: { authorizationId: grant.authorizationId, protocol: grant.protocol, host: grant.host, port: grant.port },
        ...login, bounds: bounds(),
      });
      if (!mounted.current) { await invoke('rdp_close', { id: sessionId }); return; }
      id.current = sessionId; started.current = Date.now(); setPhase('connecting');
      // Wait for the login form to collapse before aligning the native child window.
      requestAnimationFrame(() => { if (mounted.current && id.current === sessionId) void invoke('rdp_resize', { id: sessionId, bounds: bounds() }).catch((failure) => setError(errorText(failure))); });
    } catch (failure) {
      if (mounted.current) { setError(errorText(failure)); setPhase('idle'); }
    } finally { running.current = false; login.password = ''; }
  }

  const activePort = target?.port ?? endpoint.port;
  const activeHost = target?.host ?? endpoint.host;
  const where = activePort === 3389 ? activeHost : `${activeHost.includes(':') ? `[${activeHost}]` : activeHost}:${activePort}`;
  return <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="rdp-title">
    <header className={styles.toolbar}>
      <div><h2 id="rdp-title">Remote Desktop</h2><code>{where}</code></div>
      <span className={phase === 'connected' ? styles.connected : styles.status} role="status">{labels[phase]}</span>
      <button className="secondary" onClick={close}>{phase === 'connected' || busy ? 'Ngắt kết nối và đóng' : 'Đóng RDP'}</button>
    </header>
    {activePort === 22 && <div className={styles.portWarning} role="status">
      <div><strong>Điểm RDP đang dùng cổng 22 của SSH.</strong><p>RDP mặc định dùng cổng 3389. Đổi cấu hình sẽ cần cấp lại quyền cho đích mới.</p></div>
      {fixDefaultPort ? <button disabled={busy} onClick={() => void correctPort()}>Dùng cổng RDP mặc định</button> : <span>Nhờ Quản trị sửa điểm truy cập về cổng 3389.</span>}
    </div>}
    {(phase === 'idle' || phase === 'ended' || phase === 'authorizing') && <form className={styles.login} onSubmit={(event) => { event.preventDefault(); void connect(); }}>
      <label>Tài khoản Windows<input autoFocus required maxLength={255} autoComplete="username" placeholder="Administrator hoặc user@domain" value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} /></label>
      <label>Miền (không bắt buộc)<input maxLength={255} autoComplete="off" placeholder="DOMAIN" value={domain} disabled={busy} onChange={(event) => setDomain(event.target.value)} /></label>
      <label>Mật khẩu<input type="password" maxLength={4096} autoComplete="off" placeholder="Để trống để Windows hỏi khi cần" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
      <button disabled={busy || !username.trim()}>{busy ? 'Đang xử lý…' : phase === 'ended' ? 'Kết nối lại' : 'Kết nối RDP'}</button>
      <p className={styles.hint}>Đăng nhập bằng tài khoản trên máy Windows đích. Mật khẩu chỉ dùng cho phiên này.</p>
    </form>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.screen} ref={screen}>
      <div className={styles.placeholder}>
        <svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="6" y="8" width="52" height="36" rx="4" /><path d="M24 55h16M32 44v11M16 20h32M16 28h20" /></svg>
        <strong>{busy ? 'Đang mở màn hình từ xa…' : phase === 'ended' ? 'Phiên đã đóng' : 'Màn hình máy từ xa sẽ hiển thị tại đây'}</strong>
        <span>{where}</span>
      </div>
    </div>
    <footer className={styles.footer}><span>Màn hình và thao tác chuột, bàn phím được truyền trực tiếp tới máy đích.</span>
      {target && <span>Mã đối chiếu <code>{target.authorizationId.slice(0, 8)}</code></span>}</footer>
  </div>;
}
