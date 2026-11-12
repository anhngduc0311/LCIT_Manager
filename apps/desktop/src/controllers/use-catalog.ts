import { useState } from 'react';
import { Page, RecordItem, RequestApi, Role } from '../models/api';
import { Kind } from '../models/catalog';
import { errorText, useRemote } from './use-remote';

export function useCatalogList(api: RequestApi, kind: Kind) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const listing = useRemote<Page<RecordItem>>(api, `/${kind}?page=${page}`, revision);
  const reload = () => setRevision((value) => value + 1);
  const create = (body: Record<string, unknown>) => api<RecordItem>(`/${kind}`, { method: 'POST', body });
  return { setPage, listing, reload, create };
}

export function useCatalogDetail(api: RequestApi, kind: Kind, id: string, role: Role, back: () => void) {
  const path = `/${kind}/${id}`;
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const result = useRemote<RecordItem>(api, path, revision);
  const item = result?.data;
  const admin = role === 'admin';
  const assignment = useRemote<{ organizationIds: string[]; applicationIds: string[] }>(api, admin && kind === 'users' ? `${path}/assignments` : '', revision);
  const canEdit = admin || (role === 'specialist' && kind === 'applications');
  function refresh() { setEditing(''); setError(''); setRevision((value) => value + 1); }
  async function mutate(url: string, method: string, body?: unknown) {
    if (busy) return;
    setBusy(true); setError('');
    try { await api(url, { method, body }); if (url.endsWith('/archive')) back(); else refresh(); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }

  async function saveItem(body: Record<string, unknown>, version: number) {
    await api(path, { method: 'PATCH', body: { ...body, version } });
    refresh();
  }

  async function saveChild(group: string, childId: string | undefined, body: Record<string, unknown>, version: number) {
    const url = childId ? `${path}/${group}/${childId}` : `${path}/${group}`;
    await api(url, { method: childId ? 'PATCH' : 'POST', body: { ...body, version } });
    refresh();
  }

  return { path, revision, editing, setEditing, error, busy, result, item, admin, assignment, canEdit, refresh, mutate, saveItem, saveChild };
}
