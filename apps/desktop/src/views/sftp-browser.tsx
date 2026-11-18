'use client';

import { useEffect, useRef, useState } from 'react';
import type { AccessEndpoint } from '../models/access';
import { ApiFailure, DownloadedFile, RequestApi } from '../models/api';
import { useSftpLocal } from '../controllers/use-sftp-local';
import { saveFile } from '../controllers/use-attachments';
import { errorText } from '../controllers/use-remote';
import { RemoteSession, SshLogin } from './ssh-login';
import { SftpFileTable } from './sftp-file-table';
import { Icon } from './icon';
import styles from './sftp-browser.module.css';

interface RemoteFile { name: string; type: string; size: number; modifyTime: number }
interface Listing { path: string; items: RemoteFile[] }
const join = (path: string, name: string) => `${path.replace(/\/+$/, '')}/${name}`;

export function SftpBrowser({ api, endpoint, close, sharedSessionId }: {
  api: RequestApi; endpoint: AccessEndpoint; close: () => void; sharedSessionId?: string;
}) {
  const [session, setSession] = useState<RemoteSession>();
  const [listing, setListing] = useState<Listing>();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openRevision, setOpenRevision] = useState(0);
  const [localFilter, setLocalFilter] = useState('');
  const [remoteFilter, setRemoteFilter] = useState('');
  const [localName, setLocalName] = useState<string>();
  const [remoteName, setRemoteName] = useState<string>();
  const local = useSftpLocal();
  const mounted = useRef(true);
  const running = useRef(false);
  const sessionId = useRef<string | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeId = sharedSessionId ?? session?.id;
  const localFile = localName ? local.folder?.entries.get(localName) : undefined;
  const remoteFile = listing?.items.find((item) => item.name === remoteName && item.type === '-');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (sessionId.current) void api(`/sftp/sessions/${sessionId.current}`, { method: 'DELETE' }).catch(() => {});
    };
  }, [api]);

  useEffect(() => {
    if (!sharedSessionId) return;
    const controller = new AbortController();
    const { signal } = controller;
    setBusy(true); setError('');
    void api<Listing>(`/sftp/sessions/${sharedSessionId}/files/open`, { method: 'POST', signal })
      .then((data) => { if (!signal.aborted) { setListing(data); setPath(data.path); } })
      .catch((failure) => { if (!signal.aborted) setError(errorText(failure)); })
      .finally(() => { if (!signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, openRevision, sharedSessionId]);

  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (failure) {
      if (!mounted.current) return;
      setError(errorText(failure));
      if (failure instanceof ApiFailure && (['SFTP_SESSION_CLOSED', 'SFTP_OPERATION_FAILED', 'SFTP_TIMEOUT', 'CONNECTION_NOT_PERMITTED', 'CONNECTION_GRANT_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(failure.code)
        || (!sharedSessionId && ['SFTP_FILE_REQUIRED', 'FILE_TOO_LARGE'].includes(failure.code)))) {
        sessionId.current = undefined; setSession(undefined); setListing(undefined);
      }
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  }

  async function list(id: string, nextPath: string) {
    const data = await api<Listing>(`/sftp/sessions/${id}/files?path=${encodeURIComponent(nextPath)}`);
    if (mounted.current) { setListing(data); setPath(data.path); setRemoteName(undefined); }
  }

  function connected(result: RemoteSession) {
    sessionId.current = result.id;
    setSession(result);
    void run(() => list(result.id, result.path ?? '/'));
  }

  const navigate = (nextPath: string) => run(async () => { if (activeId) await list(activeId, nextPath); });
  const upload = (readFile: () => File | Promise<File | undefined> | undefined) => run(async () => {
    if (!activeId || !listing) return;
    const file = await readFile();
    if (!file) throw new Error('Không mở được tệp trên máy bạn.');
    if (file.size > 20 * 1024 * 1024) throw new Error('Tệp vượt quá 20 MiB.');
    if (!file.name || /[/\\\x00-\x1f]/.test(file.name) || ['.', '..'].includes(file.name)) throw new Error('Tên tệp không hợp lệ.');
    await api(`/sftp/sessions/${activeId}/upload?path=${encodeURIComponent(join(listing.path, file.name))}`, { file });
    await list(activeId, listing.path);
    if (mounted.current) setNotice(`Đã tải lên “${file.name}”.`);
  });
  const download = (file: RemoteFile) => run(async () => {
    if (!activeId || !listing) return;
    let destination: FileSystemFileHandle | undefined;
    try { destination = await local.savePicker(file.name); }
    catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (!(failure instanceof DOMException && ['NotSupportedError', 'SecurityError'].includes(failure.name))) throw failure;
    }
    const data = await api<DownloadedFile>(`/sftp/sessions/${activeId}/download?path=${encodeURIComponent(join(listing.path, file.name))}`, { binary: true });
    if (!mounted.current) return;
    if (destination) {
      const writer = await destination.createWritable();
      await data.blob.stream().pipeTo(writer);
      if (mounted.current) void local.refresh();
    } else saveFile(data);
    if (mounted.current) setNotice(`Đã tải xuống “${file.name}”.`);
  });

  function removeFile(file: RemoteFile) {
    if (!activeId || !listing || busy || running.current) return;
    if (!window.confirm(`Xóa vĩnh viễn tệp “${file.name}” trên máy chủ?`)) return;
    const filePath = join(listing.path, file.name);
    void run(async () => {
      await api(`/sftp/sessions/${activeId}/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
      if (!mounted.current) return;
      setListing({ ...listing, items: listing.items.filter((item) => item.name !== file.name) });
      setRemoteName(undefined);
      setNotice(`Đã xóa tệp “${file.name}”.`);
    });
  }

  return <section className={styles.panel} aria-label="Truyền tệp SFTP" aria-busy={busy}>
    <div className={styles.heading}><div><h3>Truyền tệp SFTP</h3><p>{session?.host ?? endpoint.host}:{session?.port ?? endpoint.port}</p></div>
      <button type="button" className="secondary" onClick={close}>{sharedSessionId ? 'Ẩn SFTP' : 'Đóng SFTP'}</button></div>
    {!activeId && <SshLogin api={api} endpointId={endpoint.id} mode="sftp" connected={connected} />}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {sharedSessionId && !listing && (error && !busy
      ? <button type="button" className="secondary" onClick={() => setOpenRevision((value) => value + 1)}>Thử lại SFTP</button>
      : <p role="status">Đang mở SFTP…</p>)}
    {activeId && listing && <>
      <div className={styles.panes}>
        <section className={styles.pane} aria-label="Tệp trên máy bạn">
          <header><h4>Tệp trên máy bạn</h4><input type="search" aria-label="Lọc tệp trên máy bạn" placeholder="Lọc tên tệp" value={localFilter} onChange={(event) => { setLocalFilter(event.target.value); setLocalName(undefined); }} /></header>
          <div className={styles.toolbar}>
            <button type="button" className="secondary" disabled={busy || local.busy} onClick={() => { setLocalName(undefined); void local.chooseFolder(); }}><Icon name="folder" size={16} /> Chọn thư mục</button>
            <button type="button" className="secondary" disabled={busy || local.busy || local.folders.length < 2} onClick={() => { setLocalName(undefined); local.up(); }}>Thư mục cha</button>
            <button type="button" className="secondary" aria-label="Tải lại thư mục trên máy bạn" title="Tải lại thư mục" disabled={busy || local.busy || !local.folder?.handle} onClick={() => void local.refresh()}><Icon name="refresh" size={16} /></button>
            <input type="file" hidden ref={(input) => { local.folderInput.current = input; if (input) input.webkitdirectory = true; }} onChange={(event) => { setLocalName(undefined); local.importFolder(event.currentTarget.files); event.currentTarget.value = ''; }} />
          </div>
          <p className={styles.localPath} title={local.folders.map((folder) => folder.name).join(' / ')}>{local.folders.map((folder) => folder.name).join(' / ') || 'Chưa chọn thư mục'}</p>
          {local.error && <p className="error" role="alert">{local.error}</p>}
          <SftpFileTable label="Tệp trên máy bạn" entries={[...(local.folder?.entries.values() ?? [])]} filter={localFilter} selected={localName} disabled={busy || local.busy}
            empty={local.folder ? 'Thư mục trống.' : 'Chọn thư mục để xem tệp.'} choose={(entry) => {
              if (entry.folder) { setLocalName(undefined); void local.openFolder(entry.folder); }
              else setLocalName(entry.name);
            }} />
          <footer>
            <button type="button" disabled={busy || local.busy || !localFile || (localFile.size ?? 0) > 20 * 1024 * 1024} onClick={() => void upload(() => localFile?.file ?? localFile?.handle?.getFile())}>Tải lên máy chủ <Icon name="arrow" size={16} /></button>
            <button type="button" className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>Chọn tệp để tải lên</button>
            <input type="file" ref={fileInput} hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(() => file); }} />
          </footer>
        </section>
        <section className={styles.pane} aria-label="Tệp trên máy chủ">
          <header><h4>Tệp trên máy chủ</h4><input type="search" aria-label="Lọc tệp trên máy chủ" placeholder="Lọc tên tệp" value={remoteFilter} onChange={(event) => { setRemoteFilter(event.target.value); setRemoteName(undefined); }} /></header>
          <form className={styles.toolbar} onSubmit={(event) => { event.preventDefault(); if (path.startsWith('/')) void navigate(path); }}>
            <button type="button" className="secondary" disabled={busy || listing.path === '/'} onClick={() => void navigate(`${listing.path}/..`)}>Thư mục cha</button>
            <button type="button" className="secondary" aria-label="Tải lại thư mục trên máy chủ" title="Tải lại thư mục" disabled={busy} onClick={() => void navigate(listing.path)}><Icon name="refresh" size={16} /></button>
            <div className={styles.remotePath}><input aria-label="Thư mục từ xa" value={path} onChange={(event) => setPath(event.target.value)} disabled={busy} required />
              <button type="submit" className="secondary" disabled={busy || !path.startsWith('/')}>Đi đến</button></div>
          </form>
          <SftpFileTable label="Tệp trên máy chủ" entries={listing.items} filter={remoteFilter} selected={remoteName} disabled={busy} empty="Thư mục trống." choose={(entry) => {
            if (entry.type === 'd') void navigate(join(listing.path, entry.name));
            else setRemoteName(entry.name);
          }} />
          <footer>
            <button type="button" disabled={busy || !remoteFile || remoteFile.size > 20 * 1024 * 1024} onClick={() => { if (remoteFile) void download(remoteFile); }}>Tải xuống máy bạn</button>
            <button type="button" className={`secondary ${styles.remove}`} disabled={busy || !remoteFile} onClick={() => { if (remoteFile) removeFile(remoteFile); }}>Xóa tệp</button>
          </footer>
        </section>
      </div>
      <p className={styles.note} role="status">{busy ? 'Đang xử lý SFTP…' : 'Tối đa 20 MiB mỗi tệp. Tải lên giữ nguyên các tệp đã có trên máy chủ.'}</p>
    </>}
  </section>;
}
