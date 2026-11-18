'use client';

import { useEffect, useRef, useState } from 'react';
import { errorText } from '../controllers/use-remote';
import type { RequestApi } from '../models/api';
import styles from './sftp-browser.module.css';

export type RemoteSession = { id: string; path?: string; host: string; port: number; fingerprint: string };
type Challenge = { requiresVerification: true; fingerprint: string; host: string; port: number };
type OpenResult = Challenge | (RemoteSession & { requiresVerification: false });

export function SshLogin({ api, endpointId, mode, connected }: {
  api: RequestApi; endpointId: string; mode: 'ssh' | 'sftp'; connected: (session: RemoteSession) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<Challenge>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const running = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function connect() {
    if (running.current || !username.trim()) return;
    running.current = true; setBusy(true); setError('');
    const suppliedPassword = challenge ? password : '';
    setPassword('');
    try {
      const result = await api<OpenResult>(`/access-endpoints/${endpointId}/${mode}/sessions`, {
        method: 'POST', body: { username: username.trim(), password: suppliedPassword, ...(challenge && { fingerprint: challenge.fingerprint }) },
      });
      if (result.requiresVerification) { if (mounted.current) setChallenge(result); }
      else if (mounted.current) connected(result);
      else await api(`/sftp/sessions/${result.id}`, { method: 'DELETE' });
    } catch (failure) { if (mounted.current) setError(errorText(failure)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }

  return <>
    <form className={styles.login} onSubmit={(event) => { event.preventDefault(); void connect(); }}>
      <label>Tên đăng nhập SSH<input autoFocus required maxLength={128} autoComplete="username" value={username} disabled={busy || Boolean(challenge)} onChange={(event) => setUsername(event.target.value)} /></label>
      {challenge && <div className={styles.verification}>
        <strong>Xác minh khóa máy chủ · {challenge.host}:{challenge.port}</strong><code>{challenge.fingerprint}</code>
        <p>Đối chiếu dấu vân tay này với thông tin do quản trị máy đích cung cấp trước khi đăng nhập.</p>
      </div>}
      {challenge && <label>Mật khẩu SSH<input autoFocus type="password" name="ssh-password" required maxLength={4096} autoComplete="off" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>}
      <div className="actions"><button disabled={busy || !username.trim()}>{busy ? 'Đang kết nối…' : challenge ? 'Xác nhận khóa và đăng nhập' : 'Kiểm tra máy chủ'}</button>
        {challenge && <button type="button" className="secondary" disabled={busy} onClick={() => { setChallenge(undefined); setPassword(''); setError(''); }}>Nhập lại</button>}</div>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}
