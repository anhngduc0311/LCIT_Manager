import { useRef } from 'react';
import { useAttachments, usePermissions } from '../controllers/use-attachments';
import { RequestApi } from '../models/api';
import { acceptedFileTypes, formatBytes, Permission, permissionLabels } from '../models/attachments';
import { Pager } from './catalog';

const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

export function Attachments({ api, applicationId }: { api: RequestApi; applicationId: string }) {
  const { listing, setPage, reload, busy, error, notice, upload, download, archive } = useAttachments(api, applicationId);
  const input = useRef<HTMLInputElement>(null);
  const data = listing?.data;
  return <div className="subpanel" aria-busy={Boolean(busy)}><div className="section-title"><h3>Tài liệu đính kèm</h3>
    <div className="actions">
      {data?.canUpload && <>
        <input ref={input} type="file" accept={acceptedFileTypes} hidden onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void upload(file);
        }} />
        <button disabled={Boolean(busy)} onClick={() => input.current?.click()}>{busy === 'upload' ? 'Đang tải lên…' : 'Tải lên tệp'}</button>
      </>}
      <button className="secondary" disabled={Boolean(busy)} onClick={reload}>Tải lại</button>
    </div></div>
    {!listing && <p role="status">Đang tải danh sách tệp…</p>}
    {(listing?.error || error) && <p className="error" role="alert">{listing?.error || error}</p>}
    {notice && <p role="status">{notice}</p>}
    {data && <>
      {data.canUpload && <p className="muted">PDF, ảnh PNG/JPG, Word, Excel, PowerPoint, TXT hoặc CSV, tối đa 20 MiB.</p>}
      {!data.canDownload && data.total > 0 && <p className="muted">Bạn xem được danh sách nhưng cần Quản trị cấp quyền “Tải tệp đính kèm” để tải xuống.</p>}
      {data.items.length === 0 ? <p className="muted">Chưa có tài liệu.</p> :
        <ul className="rows">{data.items.map((item) => <li key={item.id}>
          <div><strong>{item.fileName}</strong><br />
            <span className="muted">{formatBytes(item.sizeBytes)} · {item.uploadedByName ?? 'Không rõ'} · {dateTime.format(new Date(item.uploadedAt))}</span></div>
          <div className="actions">
            {data.canDownload && <button className="secondary" disabled={Boolean(busy)} onClick={() => void download(item)}>
              {busy === item.id ? 'Đang xử lý…' : 'Tải xuống'}</button>}
            {data.canUpload && <button className="secondary" disabled={Boolean(busy)} onClick={() => {
              if (window.confirm(`Gỡ tệp “${item.fileName}” khỏi ứng dụng?`)) void archive(item);
            }}>Gỡ</button>}
          </div>
        </li>)}</ul>}
      {data.total > data.pageSize && <Pager {...data} change={setPage} />}
    </>}
  </div>;
}

export function Permissions({ api, userId }: { api: RequestApi; userId: string }) {
  const { result, granted, busy, error, toggle } = usePermissions(api, userId);
  return <div className="subpanel" aria-busy={busy}><h3>Quyền bổ sung</h3>
    <p className="muted">Lãnh đạo và Chuyên viên chỉ thực hiện được các thao tác này khi được cấp, và chỉ trong phạm vi của họ.</p>
    {!result && <p role="status">Đang tải quyền…</p>}
    {(result?.error || error) && <p className="error" role="alert">{result?.error || error}</p>}
    {result?.data && <ul className="rows">{(Object.keys(permissionLabels) as Permission[]).map((permission) => <li key={permission}>
      <span>{permissionLabels[permission]} <span className="muted">· {granted.has(permission) ? 'Đã cấp' : 'Chưa cấp'}</span></span>
      <button className={granted.has(permission) ? 'secondary' : undefined} disabled={busy} onClick={() => void toggle(permission)}>
        {granted.has(permission) ? 'Thu hồi' : 'Cấp quyền'}</button>
    </li>)}</ul>}
  </div>;
}
