'use client';

import { useEffect, useRef, useState } from 'react';
import type { AccessEndpoint } from '../models/access';
import { ApiFailure, DownloadedFile, RequestApi } from '../models/api';
import { formatBytes } from '../models/attachments';
import { saveFile } from '../controllers/use-attachments';
import { errorText } from '../controllers/use-remote';
import styles from './sftp-browser.module.css';

interface RemoteFile { name: string; type: string; size: number; modifyTime: number }
interface Listing { path: string; items: RemoteFile[] }
type OpenResult = { requiresVerification: true; fingerprint: string; host: string; port: number } |
  { requiresVerification: false; id: string; path: string; host: string; port: number; fingerprint: string };
const join = (path: string, name: string) => `${path.replace(/\/+$/, '')}/${name}`;
const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

export function SftpBrowser({ api, endpoint, close }: { api: RequestApi; endpoint: AccessEndpoint; close: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<Extract<OpenResult, { requiresVerification: true }>>();
  const [session, setSession] = useState<Extract<OpenResult, { requiresVerification: false }>>();
  const [listing, setListing] = useState<Listing>();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const running = useRef(false);
  const sessionId = useRef<string | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (sessionId.current) void api(`/sftp/sessions/${sessionId.current}`, { method: 'DELETE' }).catch(() => {});
    };
  }, [api]);

  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (failure) {
      if (!mounted.current) return;
      setError(errorText(failure));
      if (failure instanceof ApiFailure && ['SFTP_SESSION_CLOSED', 'SFTP_OPERATION_FAILED', 'SFTP_TIMEOUT', 'SFTP_FILE_REQUIRED', 'FILE_TOO_LARGE', 'CONNECTION_GRANT_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(failure.code)) {
        sessionId.current = undefined; setSession(undefined); setListing(undefined); setChallenge(undefined);
      }
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  }

  async function list(id: string, nextPath: string) {
    const data = await api<Listing>(`/sftp/sessions/${id}/files?path=${encodeURIComponent(nextPath)}`);
    if (mounted.current) { setListing(data); setPath(data.path); }
  }

  const connect = () => run(async () => {
    const result = await api<OpenResult>(`/access-endpoints/${endpoint.id}/sftp/sessions`, {
      method: 'POST', body: { username: username.trim(), password: challenge ? password : '', ...(challenge && { fingerprint: challenge.fingerprint }) },
    });
    if (result.requiresVerification) { if (mounted.current) setChallenge(result); return; }
    if (!mounted.current) { await api(`/sftp/sessions/${result.id}`, { method: 'DELETE' }); return; }
    sessionId.current = result.id; setSession(result); setPassword(''); setChallenge(undefined);
    await list(result.id, result.path);
  });

  const navigate = (nextPath: string) => run(async () => { if (session) await list(session.id, nextPath); });
  const upload = (file: File) => run(async () => {
    if (!session || !listing) return;
    if (file.size > 20 * 1024 * 1024) throw new Error('Tệp vượt quá 20 MiB.');
    if (!file.name || /[/\\\x00-\x1f]/.test(file.name) || ['.', '..'].includes(file.name)) throw new Error('Tên tệp không hợp lệ.');
    await api(`/sftp/sessions/${session.id}/upload?path=${encodeURIComponent(join(listing.path, file.name))}`, { file });
    await list(session.id, listing.path);
    if (mounted.current) setNotice(`Đã tải lên “${file.name}”.`);
  });
  const download = (file: RemoteFile) => run(async () => {
    if (!session || !listing) return;
    const data = await api<DownloadedFile>(`/sftp/sessions/${session.id}/download?path=${encodeURIComponent(join(listing.path, file.name))}`, { binary: true });
    if (mounted.current) { saveFile(data); setNotice(`Đã tải xuống “${file.name}”.`); }
  });

  return <section className={styles.panel} aria-label="Truyền tệp SFTP" aria-busy={busy}>
    <div className="section-title"><h3>SFTP · {session?.host ?? challenge?.host ?? endpoint.host}:{session?.port ?? challenge?.port ?? endpoint.port}</h3>
      <button className="secondary" onClick={close}>Đóng SFTP</button></div>
    <p className="muted">Duyệt và truyền tệp qua kết nối SSH riêng. Máy chạy API cần có đường mạng tới máy đích. Mỗi tệp tối đa 20 MiB.</p>
    {!session && <form className={styles.login} onSubmit={(event) => { event.preventDefault(); void connect(); }}>
      <label>Tên đăng nhập SSH<input autoFocus required maxLength={128} autoComplete="username" value={username} disabled={busy || Boolean(challenge)} onChange={(event) => setUsername(event.target.value)} /></label>
      <label>Mật khẩu SSH<input type="password" required={Boolean(challenge)} maxLength={4096} autoComplete="off" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
      {challenge && <div className={styles.verification}>
        <strong>Xác minh khóa máy chủ</strong><code>{challenge.fingerprint}</code>
        <p>Đối chiếu dấu vân tay này với thông tin do quản trị máy đích cung cấp trước khi đăng nhập.</p>
      </div>}
      <div className="actions"><button disabled={busy || !username.trim()}>{busy ? 'Đang kết nối…' : challenge ? 'Xác nhận khóa và đăng nhập' : 'Kiểm tra máy chủ'}</button>
        {challenge && <button type="button" className="secondary" disabled={busy} onClick={() => { setChallenge(undefined); setPassword(''); }}>Nhập lại</button>}</div>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {session && <>
      <form className={styles.navigation} onSubmit={(event) => { event.preventDefault(); void navigate(path); }}>
        <label className={styles.path}>Thư mục từ xa<input value={path} onChange={(event) => setPath(event.target.value)} disabled={busy} required /></label>
        <button disabled={busy || !path.startsWith('/')}>Đi đến</button>
        <button type="button" className="secondary" disabled={busy || !listing || listing.path === '/'} onClick={() => void navigate(`${listing!.path}/..`)}>Thư mục cha</button>
        <button type="button" className="secondary" disabled={busy || !listing} onClick={() => void navigate(listing!.path)}>Tải lại</button>
        <button type="button" disabled={busy || !listing} onClick={() => fileInput.current?.click()}>Tải lên tệp</button>
        <input type="file" ref={fileInput} hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} />
      </form>
      <p className="muted">Tệp trùng tên sẽ bị từ chối. Phiên tự đóng sau 5 phút không hoạt động.</p>
      {busy && <p role="status">Đang xử lý SFTP…</p>}
      {listing && <div className={styles.files}><table><thead><tr><th>Tên</th><th>Kích thước</th><th>Sửa đổi</th><th>Thao tác</th></tr></thead>
        <tbody>{[...listing.items].sort((a, b) => Number(b.type === 'd') - Number(a.type === 'd') || a.name.localeCompare(b.name)).map((file) => <tr key={file.name}>
          <td className={styles.name}>{file.type === 'd' ? '📁 ' : file.type === 'l' ? '↗ ' : ''}{file.name}</td>
          <td>{file.type === 'd' ? '—' : formatBytes(file.size)}</td><td>{dateTime.format(new Date(file.modifyTime))}</td>
          <td>{file.type === 'd' ? <button className="secondary" disabled={busy} onClick={() => void navigate(join(listing.path, file.name))}>Mở</button> :
            file.type === '-' ? <button className="secondary" disabled={busy || file.size > 20 * 1024 * 1024} onClick={() => void download(file)}>Tải xuống</button> : <span className="muted">Liên kết</span>}</td>
        </tr>)}</tbody></table>{listing.items.length === 0 && <p className="muted">Thư mục trống.</p>}</div>}
    </>}
  </section>;
}
