'use client';

import { useEffect, useRef, useState } from 'react';
import { errorText } from '../controllers/use-remote';
import type { AccessEndpoint } from '../models/access';
import type { RequestApi } from '../models/api';
import { SshLogin } from './ssh-login';
import styles from './ssh-terminal.module.css';

export function SharedSshTerminal({ api, endpoint, sessionId, connected, close, openSftp, useNative, sftpVisible }: {
  api: RequestApi; endpoint: AccessEndpoint; sessionId?: string; connected: (id: string) => void; close: () => void;
  openSftp: () => void; useNative: () => void; sftpVisible: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const activeSession = useRef<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Đang mở terminal…');
  const [error, setError] = useState('');

  useEffect(() => () => {
    if (activeSession.current) void api(`/sftp/sessions/${activeSession.current}`, { method: 'DELETE' }).catch(() => {});
  }, [api]);

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    const { signal } = controller;
    const path = `/sftp/sessions/${sessionId}/shell`;
    let cleanup = () => {};
    setStatus('Đang mở terminal…'); setError('');

    async function open() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (signal.aborted || !host.current) return;
      const term = new Terminal({ cursorBlink: true, scrollback: 5000, fontSize: 14, fontFamily: 'Consolas, monospace', theme: { background: '#101722', foreground: '#e5edf8' } });
      const fit = new FitAddon();
      term.loadAddon(fit); term.open(host.current); fit.fit();
      const dimensions = () => ({ cols: Math.min(term.cols, 500), rows: Math.min(term.rows, 300) });
      let queued = '';
      let resizePending = false;
      let sending = false;
      let ready = false;
      let ended = false;

      async function send() {
        if (sending || !ready || ended || signal.aborted) return;
        sending = true;
        try {
          while ((queued || resizePending) && !ended && !signal.aborted) {
            const data = queued.match(/^[\s\S]{1,4096}/u)?.[0] ?? '';
            queued = queued.slice(data.length);
            const size = resizePending ? dimensions() : {};
            resizePending = false;
            await api(`${path}/input`, { method: 'POST', signal, body: { data, ...size } });
          }
        } catch (failure) {
          if (!signal.aborted && !ended) { ended = true; term.options.disableStdin = true; setError(errorText(failure)); }
        } finally { sending = false; }
      }

      const input = term.onData((data) => {
        if (queued.length + data.length > 64 * 1024) { setError('Dữ liệu dán quá dài. Hãy chia thành các phần nhỏ hơn.'); return; }
        queued += data;
        void send();
      });
      const resize = term.onResize(() => { resizePending = true; void send(); });
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(host.current);
      cleanup = () => { observer.disconnect(); resize.dispose(); input.dispose(); term.dispose(); };

      await api(path, { method: 'POST', signal, body: dimensions() });
      if (signal.aborted) return;
      ready = true;
      setReady(true);
      setStatus('SSH đã kết nối.');
      term.focus();
      void send();
      while (!signal.aborted && !ended) {
        const output = await api<{ data: string; ended: boolean }>(path, { signal });
        if (signal.aborted) return;
        if (output.data) term.write(Uint8Array.from(atob(output.data), (char) => char.charCodeAt(0)));
        if (output.ended) {
          ended = true;
          setReady(false);
          term.options.disableStdin = true;
          setStatus('Terminal đã kết thúc.');
        }
      }
    }

    void open().catch((failure) => {
      if (!signal.aborted) { cleanup(); cleanup = () => {}; setReady(false); setError(errorText(failure)); setStatus('Terminal đã ngắt kết nối.'); }
    });
    return () => { controller.abort(); cleanup(); };
  }, [api, sessionId]);

  return <section className={styles.panel} aria-label="Terminal SSH">
    <div className={styles.header}><strong>SSH · {endpoint.host}:{endpoint.port}</strong>
      <div className="actions">
        {ready && <button type="button" className="secondary" aria-expanded={sftpVisible} onClick={openSftp}>{sftpVisible ? 'Ẩn SFTP' : 'Mở SFTP'}</button>}
        <button type="button" className="secondary" onClick={close}>Đóng terminal</button>
      </div>
    </div>
    {sessionId ? <>
      <p className="muted" role="status">{status}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className={styles.terminal} ref={host} />
    </> : <>
      <SshLogin api={api} endpointId={endpoint.id} mode="ssh" connected={(session) => {
        activeSession.current = session.id;
        connected(session.id);
      }} />
      <button type="button" className="text-button" onClick={useNative}>Mở SSH riêng</button>
    </>}
  </section>;
}
