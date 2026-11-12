import { useState } from 'react';
import { DownloadedFile, RequestApi } from '../models/api';
import { AttachmentPage, Attachment, maxAttachmentBytes, Permission } from '../models/attachments';
import { errorText, useRemote } from './use-remote';

function saveFile({ blob, fileName }: DownloadedFile) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function useAttachments(api: RequestApi, applicationId: string) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const listing = useRemote<AttachmentPage>(api, `/attachments?applicationId=${applicationId}&page=${page}&pageSize=10`, revision);
  const reload = () => { setError(''); setRevision((value) => value + 1); };

  async function run(label: string, work: () => Promise<string>) {
    if (busy) return;
    setBusy(label); setError(''); setNotice('');
    try { setNotice(await work()); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(''); }
  }

  const upload = (file: File) => run('upload', async () => {
    if (file.size > maxAttachmentBytes) throw new Error('Tệp vượt quá dung lượng cho phép (20 MiB).');
    const query = `applicationId=${applicationId}&fileName=${encodeURIComponent(file.name)}`;
    await api<Attachment>(`/attachments?${query}`, { file });
    setPage(1); setRevision((value) => value + 1);
    return `Đã tải lên “${file.name}”.`;
  });

  const download = (item: Attachment) => run(item.id, async () => {
    saveFile(await api<DownloadedFile>(`/attachments/${item.id}/download`, { binary: true }));
    return `Đã tải xuống “${item.fileName}”.`;
  });

  const archive = (item: Attachment) => run(item.id, async () => {
    await api(`/attachments/${item.id}/archive`, { method: 'POST' });
    setRevision((value) => value + 1);
    return `Đã gỡ “${item.fileName}”.`;
  });

  return { listing, setPage, reload, busy, error, notice, upload, download, archive };
}

export function usePermissions(api: RequestApi, userId: string) {
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const result = useRemote<{ items: { permission: Permission; grantedAt: string }[] }>(api, `/users/${userId}/permissions`, revision);
  const granted = new Set(result?.data?.items.map((item) => item.permission));

  async function toggle(permission: Permission) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api(`/users/${userId}/permissions/${permission}`, { method: granted.has(permission) ? 'DELETE' : 'PUT' });
      setRevision((value) => value + 1);
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  return { result, granted, busy, error, toggle };
}
