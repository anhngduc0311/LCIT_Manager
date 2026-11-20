import { useEffect, useRef, useState } from 'react';
import { useEndpoints, useGrants, useLaunch } from '../controllers/use-access';
import { errorText, useRemote } from '../controllers/use-remote';
import { Page, RecordItem, RequestApi } from '../models/api';
import { AccessEndpoint, protocolName } from '../models/access';
import { Picker } from './catalog';
import styles from './reports.module.css';
import { SshTerminal } from './ssh-terminal';
import { SharedSshTerminal } from './shared-ssh-terminal';
import { SftpBrowser } from './sftp-browser';
import { RdpDesktop } from './rdp-desktop';
import layout from './access.module.css';

const toneBadge = { ok: styles.badgeNotice, warn: styles.badgeWarning, error: styles.badgeCritical } as const;
const toneIcon = { ok: '✓', warn: '◔', error: '⚠' } as const;
const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

/** "Kết nối SSH/RDP" on a server's detail screen: administrators and specialists, never leaders. */
export function AccessPanel({ api, serverId, actorId, admin, changed }: { api: RequestApi; serverId: string; actorId: string; admin: boolean; changed?: () => void }) {
  const { result, reload } = useEndpoints(api, serverId);
  const { launch, busy, report, terminal, closeTerminal, rdp, closeRdp } = useLaunch(api);
  const [granting, setGranting] = useState('');
  const [error, setError] = useState('');
  const [filePanel, setFilePanel] = useState<'closed' | 'visible' | 'hidden'>('closed');
  const [nativeSsh, setNativeSsh] = useState(false);
  const [sharedSessionId, setSharedSessionId] = useState<string>();
  const items = result?.data?.items ?? [];
  const combined = nativeSsh ? undefined : terminal;
  const showFiles = filePanel === 'visible';
  const fileWorkspace = useRef<HTMLDivElement>(null);

  useEffect(() => { if (showFiles) fileWorkspace.current?.scrollIntoView({ block: 'start' }); }, [showFiles]);

  function closeSsh() {
    closeTerminal(); setFilePanel('closed'); setNativeSsh(false); setSharedSessionId(undefined);
  }

  async function useDefaultRdpPort(endpoint: AccessEndpoint) {
    const server = await api<RecordItem>(`/servers/${serverId}`);
    const current = (server.accessEndpoints as AccessEndpoint[] | undefined)?.find((item) => item.id === endpoint.id);
    if (!current || current.protocol !== 'rdp' || current.host !== endpoint.host || current.port !== 22) {
      throw new Error('Điểm truy cập đã thay đổi. Hãy đóng RDP và tải lại trước khi sửa.');
    }
    await api(`/servers/${serverId}/access-endpoints/${endpoint.id}`, { method: 'PATCH', body: { version: server.version, port: 3389 } });
    // The saved destination changed, so explicitly grant the corrected configuration to this administrator.
    try { await api(`/users/${actorId}/access-endpoints/${endpoint.id}`, { method: 'PUT' }); }
    finally { closeRdp(); reload(); changed?.(); }
  }

  async function grantSelf(endpoint: AccessEndpoint) {
    if (granting) return;
    setGranting(endpoint.id); setError('');
    try { await api(`/users/${actorId}/access-endpoints/${endpoint.id}`, { method: 'PUT' }); reload(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setGranting(''); }
  }

  return <div className="subpanel" aria-busy={Boolean(busy)}><div className="section-title"><h3>Kết nối SSH/RDP</h3>
    <button className="secondary" disabled={Boolean(busy)} onClick={reload}>Tải lại</button></div>
    <p className="muted">SSH và RDP hiển thị ngay trong ứng dụng. Hệ thống kiểm tra quyền và ghi nhật ký trước mỗi kết nối.
      Khi dùng chung SSH và SFTP, máy chạy API cần có đường mạng tới máy đích.</p>
    {!result && <p role="status">Đang tải điểm truy cập…</p>}
    {result?.error && <p className="error" role="alert">{result.error}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {result?.data && (items.length === 0
      ? <p className="muted">{admin ? 'Máy chủ chưa có điểm truy cập SSH/RDP. Thêm ở mục “Điểm truy cập”.' : 'Chưa có điểm truy cập nào được cấp cho bạn trên máy chủ này. Hãy nhờ Quản trị cấp quyền.'}</p>
      : <ul className="rows">{items.map((endpoint) => <li key={endpoint.id}>
        <div><strong>{protocolName[endpoint.protocol]}</strong> <code>{endpoint.host}:{endpoint.port}</code>
          <span className={styles.small}>{endpoint.canLaunch ? 'Bạn đã được cấp quyền kết nối.' : 'Bạn chưa được cấp quyền cho cấu hình hiện tại.'}</span>
          {report?.endpointId === endpoint.id && <span className={styles.small} role="status">
            <span className={toneBadge[report.tone]}>{toneIcon[report.tone]}</span> {report.text}{report.reference && <> · Mã đối chiếu <code>{report.reference}</code></>}</span>}</div>
        <div className="actions">
          {admin && !endpoint.canLaunch && <button className="secondary" disabled={Boolean(granting)} onClick={() => void grantSelf(endpoint)}>
            {granting === endpoint.id ? 'Đang cấp…' : 'Cấp quyền cho tôi'}</button>}
          <button disabled={!endpoint.canLaunch || Boolean(busy) || (endpoint.protocol === 'ssh' ? Boolean(terminal) : Boolean(rdp))} onClick={() => void launch(endpoint)}>{busy === endpoint.id ? 'Đang mở…' : endpoint.protocol === 'rdp' ? 'Mở màn hình RDP' : 'Kết nối'}</button>
        </div></li>)}</ul>)}
    {terminal && <div>
      {combined && <SharedSshTerminal key={`shared:${combined.id}`} api={api} endpoint={combined} sessionId={sharedSessionId}
        connected={setSharedSessionId} close={closeSsh} openSftp={() => setFilePanel(showFiles ? 'hidden' : 'visible')}
        sftpVisible={showFiles} useNative={() => setNativeSsh(true)} />}
      {nativeSsh && <SshTerminal key={`ssh:${terminal.id}`} api={api} endpoint={terminal} close={closeSsh} />}
      {combined && sharedSessionId && filePanel !== 'closed' && <div className={layout.files} ref={fileWorkspace} hidden={!showFiles}>
        <SftpBrowser key={sharedSessionId} api={api} endpoint={combined} sharedSessionId={sharedSessionId} close={() => setFilePanel('hidden')} />
      </div>}
    </div>}
    {rdp && <RdpDesktop key={`rdp:${rdp.id}`} api={api} endpoint={rdp} close={closeRdp} fixDefaultPort={admin ? () => useDefaultRdpPort(rdp) : undefined} />}
  </div>;
}

function ServerName({ api, id }: { api: RequestApi; id: string }) {
  const result = useRemote<RecordItem>(api, `/servers/${id}`);
  return <span>{result?.data ? String(result.data.hostname ?? result.data.code ?? id) : result?.error ? 'Máy chủ không xem được' : 'Đang tải…'}</span>;
}

/** "Quyền kết nối" on an account's detail screen: administrators grant and revoke per endpoint. */
export function AccessGrants({ api, userId }: { api: RequestApi; userId: string }) {
  const { result, busy, error, grant, revoke } = useGrants(api, userId);
  const [server, setServer] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const endpoints = useRemote<Page<AccessEndpoint>>(api, server ? `/servers/${server}/access-endpoints?pageSize=100` : '');
  const grants = result?.data?.items ?? [];

  return <div className="subpanel" aria-busy={Boolean(busy)}><h3>Quyền kết nối SSH/RDP</h3>
    <p className="muted">Quyền được cấp riêng cho từng điểm truy cập và gắn với đúng cấu hình đang lưu. Đổi giao thức, host hoặc cổng thì phải cấp lại.
      Chuyên viên còn cần được phân công ứng dụng và liên kết máy chủ. Lãnh đạo không mở được kết nối.</p>
    {!result && <p role="status">Đang tải quyền…</p>}
    {(result?.error || error) && <p className="error" role="alert">{result?.error || error}</p>}
    {result?.data && (grants.length === 0 ? <p className="muted">Chưa được cấp quyền kết nối nào.</p> :
      <ul className="rows">{grants.map((item) => <li key={item.endpointId}>
        <div><strong>{protocolName[item.protocol]}</strong> <code>{item.host}:{item.port}</code> · <ServerName api={api} id={item.serverId} />
          <span className={styles.small}>Cấp lúc {dateTime.format(new Date(item.grantedAt))}
            {!item.isCurrent && <> · <span className={styles.badgeWarning}>◔ Cấu hình đã đổi, quyền cũ không còn hiệu lực</span></>}</span></div>
        <div className="actions">
          {!item.isCurrent && <button disabled={Boolean(busy)} onClick={() => void grant(item.endpointId)}>Cấp lại</button>}
          <button className="secondary" disabled={Boolean(busy)} onClick={() => {
            if (window.confirm(`Thu hồi quyền ${protocolName[item.protocol]} ${item.host}:${item.port}?`)) void revoke(item.endpointId);
          }}>Thu hồi</button>
        </div></li>)}</ul>)}
    <div className="actions" style={{ marginTop: '.6rem' }}>
      <Picker api={api} kind="servers" value={server} change={(value) => { setServer(value); setEndpoint(''); }} />
      {server && <select aria-label="Điểm truy cập" value={endpoint} onChange={(event) => setEndpoint(event.target.value)}>
        <option value="">Chọn điểm truy cập</option>
        {endpoints?.data?.items.map((item) => <option key={item.id} value={item.id}>{protocolName[item.protocol]} · {item.host}:{item.port}</option>)}</select>}
      <button disabled={!endpoint || Boolean(busy)} onClick={() => void grant(endpoint).then((done) => { if (done) { setEndpoint(''); } })}>Cấp quyền</button>
    </div>
    {server && endpoints?.error && <p className="error" role="alert">{endpoints.error}</p>}
    {server && endpoints?.data?.items.length === 0 && <p className="muted">Máy chủ này chưa có điểm truy cập SSH/RDP.</p>}
  </div>;
}
