'use client';

import { useEffect, useRef, useState } from 'react';
import type { AccessEndpoint, AccessLaunchResponse } from '../models/access';
import type { RequestApi } from '../models/api';
import { errorText } from '../controllers/use-remote';
import styles from './ssh-terminal.module.css';

type Output = { type: 'data'; data: number[] } | { type: 'exit'; code: number | null } | { type: 'error'; message: string };

export function SshTerminal({ api, endpoint, close }: { api: RequestApi; endpoint: AccessEndpoint; close: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<{ grant: AccessLaunchResponse; username: string }>();
  const [status, setStatus] = useState('Nhập tên đăng nhập để kết nối.');
  const [error, setError] = useState('');

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function connect() {
    if (busy || connection) return;
    if (!/^[a-zA-Z0-9._@\\-]+$/.test(username.trim()) || username.trim().startsWith('-')) {
      setError('Tên đăng nhập SSH không hợp lệ.'); return;
    }
    setBusy(true); setError('');
    try {
      const grant = await api<AccessLaunchResponse>(`/access-endpoints/${endpoint.id}/launch`, { method: 'POST' });
      if (grant.protocol !== 'ssh') throw new Error('Điểm truy cập đã đổi giao thức. Hãy đóng và tải lại.');
      if (mounted.current) setConnection({ grant, username: username.trim() });
    } catch (failure) { if (mounted.current) setError(errorText(failure)); }
    finally { if (mounted.current) setBusy(false); }
  }

  useEffect(() => {
    if (!connection || !host.current) return;
    let disposed = false;
    let id: string | undefined;
    let ended = false;
    let cleanup = () => {};
    const fail = (failure: unknown) => { if (!disposed) setError(errorText(failure)); };
    async function open() {
      const [{ Terminal }, { FitAddon }, { Channel, invoke }] = await Promise.all([
        import('@xterm/xterm'), import('@xterm/addon-fit'), import('@tauri-apps/api/core'),
      ]);
      if (disposed || !host.current) return;
      const term = new Terminal({ cursorBlink: true, scrollback: 5000, fontSize: 14, fontFamily: 'Consolas, monospace', theme: { background: '#101722', foreground: '#e5edf8' } });
      const fit = new FitAddon();
      term.loadAddon(fit); term.open(host.current); fit.fit(); term.focus();
      const channel = new Channel<Output>();
      let pending = Promise.resolve();
      let terminalReady = false;
      const resizePty = () => {
        if (!id || ended || !terminalReady) return;
        const sessionId = id;
        const cols = Math.min(term.cols, 500), rows = Math.min(term.rows, 300);
        // Cursor-report responses must reach ConPTY before a resize can run.
        pending = pending.then(() => disposed || ended ? undefined : invoke<void>('ssh_resize', { id: sessionId, cols, rows })).catch(fail);
      };
      channel.onmessage = (message) => {
        if (disposed) return;
        if (message.type === 'data') term.write(new Uint8Array(message.data));
        else if (message.type === 'error') setError(message.message);
        else {
          ended = true;
          term.options.disableStdin = true;
          setStatus(`Phiên SSH đã kết thúc (mã ${message.code ?? '?'}). Đóng terminal để kết nối lại.`);
        }
      };
      const input = term.onData((data) => {
        if (!id || ended) return;
        const sessionId = id;
        // Preserve ordering and keep large pastes within the native input limit.
        for (const point of data.match(/[\s\S]{1,8192}/gu) ?? []) {
          pending = pending.then(() => disposed || ended ? undefined : invoke<void>('ssh_write', { id: sessionId, data: point })).catch(fail);
        }
        if (!terminalReady && /\x1b\[\d+;\d+R/.test(data)) {
          terminalReady = true;
          resizePty();
        }
      });
      const resize = term.onResize(resizePty);
      const observer = new ResizeObserver(() => { if (!disposed) fit.fit(); });
      observer.observe(host.current);
      cleanup = () => { observer.disconnect(); input.dispose(); resize.dispose(); term.dispose(); };
      setStatus('Đang mở SSH…');
      try {
        const grant = connection!.grant;
        // ConPTY can request a cursor report before ssh_open returns.
        id = grant.authorizationId;
        id = await invoke<string>('ssh_open', {
          request: { authorizationId: grant.authorizationId, protocol: grant.protocol, host: grant.host, port: grant.port },
          username: connection!.username, cols: Math.min(term.cols, 500), rows: Math.min(term.rows, 300), output: channel,
        });
        if (disposed) { await invoke('ssh_close', { id }); return; }
        if (!ended) {
          setStatus('SSH đang chạy. Làm theo lời nhắc trong terminal để đăng nhập.');
          term.focus();
        }
      } catch (failure) { ended = true; term.options.disableStdin = true; fail(failure); setStatus('Không mở được SSH. Đóng terminal để thử lại.'); }
    }
    void open().catch(fail);
    return () => {
      disposed = true; cleanup();
      if (id) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('ssh_close', { id })).catch(() => {});
    };
  }, [connection]);

  return <section className={styles.panel} aria-label="Terminal SSH">
    <div className={styles.header}><strong>SSH · {connection?.grant.host ?? endpoint.host}:{connection?.grant.port ?? endpoint.port}</strong>
      <button className="secondary" onClick={close}>Đóng terminal</button></div>
    {!connection && <form className={styles.login} onSubmit={(event) => { event.preventDefault(); void connect(); }}>
      <label>Tên đăng nhập SSH <input autoFocus required maxLength={128} value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
      <button disabled={busy || !username.trim()}>{busy ? 'Đang kiểm tra quyền…' : 'Mở SSH'}</button>
    </form>}
    <p className="muted" role="status">{status}{connection && <> · Mã đối chiếu <code>{connection.grant.authorizationId.slice(0, 8)}</code></>}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {connection && <><p className="muted">Nhập mật khẩu trong terminal (ký tự sẽ không hiển thị). Với máy mới, kiểm tra dấu vân tay khóa máy chủ trước khi xác nhận.</p>
      <div className={styles.terminal} ref={host} /></>}
  </section>;
}
