import { useState } from 'react';
import { useEndpoints, useGrants, useLaunch } from '../controllers/use-access';
import { errorText, useRemote } from '../controllers/use-remote';
import { Page, RecordItem, RequestApi } from '../models/api';
import { AccessEndpoint, protocolName } from '../models/access';
import { Picker } from './catalog';
import styles from './reports.module.css';
import { SshTerminal } from './ssh-terminal';

const toneBadge = { ok: styles.badgeNotice, warn: styles.badgeWarning, error: styles.badgeCritical } as const;
const toneIcon = { ok: '✓', warn: '◔', error: '⚠' } as const;
const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

/** "Kết nối SSH/RDP" on a server's detail screen: administrators and specialists, never leaders. */
export function AccessPanel({ api, serverId, actorId, admin }: { api: RequestApi; serverId: string; actorId: string; admin: boolean }) {
  const { result, reload } = useEndpoints(api, serverId);
  const { launch, busy, report, terminal, closeTerminal } = useLaunch(api);
  const [granting, setGranting] = useState('');
  const [error, setError] = useState('');
  const items = result?.data?.items ?? [];

  async function grantSelf(endpoint: AccessEndpoint) {
    if (granting) return;
    setGranting(endpoint.id); setError('');
    try { await api(`/users/${actorId}/access-endpoints/${endpoint.id}`, { method: 'PUT' }); reload(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setGranting(''); }
  }

  return <div className="subpanel" aria-busy={Boolean(busy)}><div className="section-title"><h3>Kết nối SSH/RDP</h3>
    <button className="secondary" disabled={Boolean(busy)} onClick={reload}>Tải lại</button></div>
    <p className="muted">SSH mở terminal ngay trong ứng dụng; RDP mở Remote Desktop của Windows. Hệ thống kiểm tra quyền và ghi nhật ký trước mỗi kết nối. Bạn đăng nhập trực tiếp vào máy đích.
      Cần có VPN hoặc đường mạng tới máy đích.</p>
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
          <button disabled={!endpoint.canLaunch || Boolean(busy) || Boolean(terminal)} onClick={() => void launch(endpoint)}>{busy === endpoint.id ? 'Đang mở…' : 'Kết nối'}</button>
        </div></li>)}</ul>)}
    {terminal && <SshTerminal key={terminal.id} api={api} endpoint={terminal} close={closeTerminal} />}
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
