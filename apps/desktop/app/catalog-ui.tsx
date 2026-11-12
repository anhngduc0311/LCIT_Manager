'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Page, RecordItem, RequestApi, Role } from './api';

type Option = [value: string, label: string];
type Field = { key: string; label: string; type?: 'text' | 'date' | 'number' | 'password' | 'area'; options?: Option[]; source?: Kind; required?: boolean };
const field = (key: string, label: string, required = false): Field => ({ key, label, required });
export const roleNames: Record<Role, string> = { admin: 'Quản trị', leader: 'Lãnh đạo', specialist: 'Chuyên viên' };
const serviceTypes: Option[] = [['ordered', 'Đặt hàng'], ['monitoring', 'Giám sát'], ['operations', 'Quản trị vận hành']];
const codeName = [field('code', 'Mã', true), field('name', 'Tên', true), { key: 'description', label: 'Mô tả', type: 'area' } satisfies Field];
const ownership: Field[] = [
  { key: 'organizationId', label: 'Đơn vị', source: 'organizations', required: true },
  { key: 'ownerId', label: 'Người phụ trách', source: 'users' },
  { key: 'status', label: 'Trạng thái', options: [['active', 'Đang hoạt động'], ['inactive', 'Ngừng hoạt động']] },
];
export type Kind = 'applications' | 'servers' | 'domains' | 'databases' | 'organizations' | 'data-centers' | 'users';
export const catalogs: Record<Kind, { title: string; fields: Field[] }> = {
  applications: { title: 'Ứng dụng', fields: [...codeName, ...ownership, { key: 'serviceType', label: 'Hình thức dịch vụ', options: serviceTypes, required: true }] },
  servers: { title: 'Máy chủ', fields: [field('code', 'Mã', true), field('hostname', 'Hostname', true),
    { key: 'dataCenterId', label: 'Trung tâm dữ liệu', source: 'data-centers', required: true },
    field('operatingSystem', 'Hệ điều hành'), { key: 'configuration', label: 'Cấu hình', type: 'area' }, { key: 'notes', label: 'Ghi chú', type: 'area' }] },
  domains: { title: 'Tên miền', fields: [field('name', 'Tên miền', true), { key: 'renewalDate', label: 'Hạn gia hạn', type: 'date' }] },
  databases: { title: 'Cơ sở dữ liệu', fields: [...codeName, ...ownership, field('engine', 'Hệ quản trị CSDL', true)] },
  organizations: { title: 'Đơn vị', fields: codeName },
  'data-centers': { title: 'Trung tâm dữ liệu', fields: codeName },
  users: { title: 'Tài khoản', fields: [field('username', 'Tên đăng nhập', true), field('displayName', 'Họ và tên', true),
    { key: 'role', label: 'Vai trò', options: Object.entries(roleNames), required: true },
    { key: 'status', label: 'Trạng thái', options: [['active', 'Hoạt động'], ['locked', 'Đã khóa']] },
    { key: 'password', label: 'Mật khẩu', type: 'password' }] },
};

const childGroups: Partial<Record<Kind, { path: string; key: string; title: string; fields: Field[] }[]>> = {
  servers: [
    { path: 'addresses', key: 'addresses', title: 'Địa chỉ IP', fields: [field('address', 'Địa chỉ', true), field('networkScope', 'Phạm vi mạng', true),
      { key: 'kind', label: 'Loại', options: [['private', 'Nội bộ'], ['public', 'Công khai'], ['nat', 'NAT']], required: true }] },
    { path: 'access-endpoints', key: 'accessEndpoints', title: 'Điểm truy cập', fields: [
      { key: 'protocol', label: 'Giao thức', options: [['ssh', 'SSH'], ['rdp', 'RDP']], required: true }, field('host', 'Host', true),
      { key: 'port', label: 'Cổng', type: 'number', required: true }] },
  ],
  domains: [
    { path: 'dns-records', key: 'dnsRecords', title: 'Bản ghi DNS', fields: [field('host', 'Host', true),
      { key: 'type', label: 'Loại', options: ['A', 'AAAA', 'CNAME', 'NS', 'PTR', 'MX', 'TXT', 'SRV', 'CAA'].map((value) => [value, value]), required: true },
      field('target', 'Đích', true)] },
    { path: 'tls-endpoints', key: 'tlsEndpoints', title: 'Điểm TLS', fields: [field('host', 'Host', true),
      { key: 'port', label: 'Cổng', type: 'number', required: true }, field('sni', 'SNI'), { key: 'manualExpiryDate', label: 'Hạn nhập tay', type: 'date' }] },
  ],
};

export const itemTitle = (row: RecordItem) => String(row.name ?? row.hostname ?? row.displayName ?? row.username ?? row.id);
const asIds = (value: unknown) => Array.isArray(value) ? value as string[] : [];
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Thao tác không thành công.';

export function useRemote<T>(api: RequestApi, path: string, revision = 0) {
  const [result, setResult] = useState<{ path: string; revision: number; data?: T; error?: string }>();
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void api<T>(path, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setResult({ path, revision, data });
    }).catch((error) => {
      if (!controller.signal.aborted) setResult({ path, revision, error: errorText(error) });
    });
    return () => controller.abort();
  }, [api, path, revision]);
  return result?.path === path && result.revision === revision ? result : undefined;
}

export function Pager({ page, pageSize, total, change }: { page: number; pageSize: number; total: number; change: (page: number) => void }) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return <div className="pager"><span>{total} mục · Trang {page}/{last}</span><div className="actions">
    <button type="button" className="secondary" disabled={page <= 1} onClick={() => change(page - 1)}>Trước</button>
    <button type="button" className="secondary" disabled={page >= last} onClick={() => change(page + 1)}>Sau</button>
  </div></div>;
}

function Picker({ api, kind, value, change, required }: { api: RequestApi; kind: Kind; value: string; change: (value: string) => void; required?: boolean }) {
  const [page, setPage] = useState(1);
  const [label, setLabel] = useState('');
  const result = useRemote<Page<RecordItem>>(api, `/${kind}?page=${page}`);
  const detail = useRemote<RecordItem>(api, value && !result?.data?.items.some((item) => item.id === value) ? `/${kind}/${value}` : '');
  return <span className="picker"><select aria-label={`Chọn ${catalogs[kind].title.toLowerCase()}`} required={required} value={value} onChange={(event) => {
    setLabel(event.currentTarget.selectedOptions[0]?.text ?? ''); change(event.currentTarget.value);
  }}><option value="">Chọn {catalogs[kind].title.toLowerCase()}</option>
    {value && !result?.data?.items.some((item) => item.id === value) && <option value={value}>{detail?.data ? itemTitle(detail.data) : label || value}</option>}
    {result?.data?.items.map((item) => <option key={item.id} value={item.id}>{itemTitle(item)}</option>)}
  </select>
    {result?.error && <small role="alert">{result.error}</small>}
    {result?.data && result.data.total > result.data.pageSize && <Pager {...result.data} change={setPage} />}
  </span>;
}

function EditForm({ api, fields, item, save, cancel }: {
  api: RequestApi; fields: Field[]; item?: RecordItem; save: (body: Record<string, unknown>) => Promise<void>; cancel: () => void;
}) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(({ key }) => [key, String(item?.[key] ?? '')])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    const payload: Record<string, unknown> = {};
    for (const { key, type } of fields) {
      const value = values[key];
      if (value === String(item?.[key] ?? '')) continue;
      payload[key] = value === '' ? null : type === 'number' ? Number(value) : value;
    }
    if (Object.keys(payload).length === 0) { setError('Chưa có thay đổi để lưu.'); return; }
    setBusy(true); setError('');
    try { await save(payload); } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  return <form className="editor" onSubmit={submit}><div className="form-grid">
    {fields.map(({ key, label, type, options, required, source }) => {
      const value = values[key] ?? '';
      const change = (newValue: string) => setValues((previous) => ({ ...previous, [key]: newValue }));
      const needed = required || (type === 'password' && !item);
      return <label key={key}>{label}{source ? <Picker api={api} kind={source} value={value} change={change} required={needed} /> :
        options ? <select value={value} required={needed} onChange={(event) => change(event.target.value)}><option value="" disabled={Boolean(item?.[key])}>Chọn</option>
          {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> :
        type === 'area' ? <textarea rows={3} value={value} required={needed} onChange={(event) => change(event.target.value)} /> :
        <input type={type ?? 'text'} value={value} required={needed} min={type === 'number' ? 1 : undefined} max={type === 'number' ? 65535 : undefined}
          minLength={type === 'password' ? 12 : undefined} autoComplete={type === 'password' ? 'new-password' : undefined} onChange={(event) => change(event.target.value)} />}</label>;
    })}
  </div>{error && <p className="error" role="alert">{error}</p>}
  <div className="actions"><button disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button><button type="button" className="secondary" disabled={busy} onClick={cancel}>Hủy</button></div></form>;
}

function ResourceName({ api, kind, id, open }: { api: RequestApi; kind: Kind; id: string; open?: (kind: Kind, id: string) => void }) {
  const result = useRemote<RecordItem>(api, `/${kind}/${id}`);
  if (result?.error) return <span className="muted">{result.error}</span>;
  if (!result?.data) return <span className="muted">Đang tải…</span>;
  return open ? <button className="text-button" onClick={() => open(kind, id)}>{itemTitle(result.data)}</button> : <span>{itemTitle(result.data)}</span>;
}

export function Catalog({ kind, api, role, open }: { kind: Kind; api: RequestApi; role: Role; open: (kind: Kind, id: string) => void }) {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  const listing = useRemote<Page<RecordItem>>(api, `/${kind}?page=${page}`, revision);
  const config = catalogs[kind];
  return <section className="panel"><div className="section-title"><h1>{config.title}</h1><div className="actions">
    {role === 'admin' && !creating && <button onClick={() => setCreating(true)}>Thêm mới</button>}
    <button className="secondary" onClick={() => setRevision((value) => value + 1)}>Tải lại</button>
  </div></div>
    {creating && <EditForm api={api} fields={config.fields} save={async (body) => {
      const item = await api<RecordItem>(`/${kind}`, { method: 'POST', body }); open(kind, item.id);
    }} cancel={() => setCreating(false)} />}
    {!listing && <p role="status">Đang tải danh mục…</p>}
    {listing?.error && <p className="error" role="alert">{listing.error}</p>}
    {listing?.data && <>{listing.data.items.length === 0 ? <p className="empty">Chưa có dữ liệu trong phạm vi của bạn.</p> :
      <ul className="rows">{listing.data.items.map((row) => <li key={row.id}>
        <button className="text-button" onClick={() => open(kind, row.id)}>{itemTitle(row)}</button>
        <span className="muted">{String(row.code ?? row.username ?? row.renewalDate ?? '')}</span>
      </li>)}</ul>}<Pager {...listing.data} change={setPage} /></>}
  </section>;
}

type RelationConfig = { kind: Kind; ids: string[]; removable?: string[]; path?: string; title?: string };

function RelationList({ config, api, open, mutate }: {
  config: RelationConfig; api: RequestApi; open: (kind: Kind, id: string) => void;
  mutate: (path: string, method: string) => Promise<void>;
}) {
  const { kind, path, ids, removable = ids, title } = config;
  const [chosen, setChosen] = useState('');
  const [page, setPage] = useState(1);
  return <div className="subpanel"><h3>{title ?? catalogs[kind].title}</h3>
    {ids.length === 0 && <p className="muted">Chưa có liên kết.</p>}
    <ul className="rows">{ids.slice((page - 1) * 10, page * 10).map((id) => <li key={id}>
      <ResourceName api={api} kind={kind} id={id} open={open} />
      {path && removable.includes(id) && <button className="secondary" onClick={() => void mutate(`${path}/${id}`, 'DELETE')}>Gỡ</button>}
    </li>)}</ul>{ids.length > 10 && <Pager page={page} pageSize={10} total={ids.length} change={setPage} />}
    {path && <div className="actions"><Picker api={api} kind={kind} value={chosen} change={setChosen} />
      <button type="button" disabled={!chosen || removable.includes(chosen)} onClick={() => void mutate(`${path}/${chosen}`, 'PUT')}>Thêm liên kết</button>
    </div>}
  </div>;
}

function DnsLinks({ api, path, ids, mutate, canEdit }: { api: RequestApi; path: string; ids: string[]; mutate: (path: string, method: string) => Promise<void>; canEdit: boolean }) {
  const [domain, setDomain] = useState('');
  const [record, setRecord] = useState('');
  const selected = useRemote<RecordItem>(api, domain ? `/domains/${domain}` : '');
  const records = (selected?.data?.dnsRecords ?? []) as RecordItem[];
  return <div className="subpanel"><h3>Liên kết DNS theo ứng dụng</h3><p>{ids.length} bản ghi được liên kết</p>
    {canEdit && <div className="actions"><Picker api={api} kind="domains" value={domain} change={(id) => { setDomain(id); setRecord(''); }} />
      {domain && <><select aria-label="Bản ghi DNS" value={record} onChange={(event) => setRecord(event.target.value)}><option value="">Chọn bản ghi</option>
        {records.map((item) => <option key={item.id} value={item.id}>{String(item.host)} · {String(item.type)} · {String(item.target)}</option>)}</select>
        <button disabled={!record} onClick={() => void mutate(`${path}/${record}`, ids.includes(record) ? 'DELETE' : 'PUT')}>
          {ids.includes(record) ? 'Gỡ liên kết' : 'Thêm liên kết'}</button></>}
      {selected?.error && <p className="error" role="alert">{selected.error}</p>}</div>}
  </div>;
}

export function Detail({ kind, id, api, role, open, back }: { kind: Kind; id: string; api: RequestApi; role: Role;
  open: (kind: Kind, id: string) => void; back: () => void }) {
  const path = `/${kind}/${id}`;
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const result = useRemote<RecordItem>(api, path, revision);
  const item = result?.data;
  const admin = role === 'admin';
  const config = catalogs[kind];
  const assignment = useRemote<{ organizationIds: string[]; applicationIds: string[] }>(api, admin && kind === 'users' ? `${path}/assignments` : '', revision);
  const fields = admin ? config.fields : config.fields.filter(({ key }) => ['name', 'description', 'status'].includes(key));
  const canEdit = admin || (role === 'specialist' && kind === 'applications');
  function refresh() { setEditing(''); setError(''); setRevision((value) => value + 1); }
  async function mutate(url: string, method: string, body?: unknown) {
    if (busy) return;
    setBusy(true); setError('');
    try { await api(url, { method, body }); if (url.endsWith('/archive')) back(); else refresh(); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  const relations: RelationConfig[] = !item ? [] : kind === 'applications' ? [
    { kind: 'databases', ids: asIds(item.databaseIds), path: admin ? `${path}/databases` : undefined },
    { kind: 'servers', ids: asIds(item.serverIds), path: admin ? `${path}/servers` : undefined },
    { kind: 'domains', ids: asIds(item.domainIds), removable: asIds(item.directDomainIds), path: admin ? `${path}/domains` : undefined },
  ] : kind === 'servers' ? [{ kind: 'applications', ids: asIds(item.applicationIds) }, { kind: 'domains', ids: asIds(item.domainIds) }] :
    kind === 'domains' ? [{ kind: 'applications', ids: asIds(item.applicationIds) }, { kind: 'servers', ids: asIds(item.serverIds), path: admin ? `${path}/servers` : undefined }] : [];
  if (kind === 'users' && item && assignment?.data) {
    if (item.role === 'leader') relations.push({ kind: 'organizations', title: 'Đơn vị được cấp', ids: assignment.data.organizationIds, path: `${path}/assignments/organizations` });
    if (item.role === 'specialist') relations.push({ kind: 'applications', title: 'Ứng dụng được phân công', ids: assignment.data.applicationIds, path: `${path}/assignments/applications` });
  }
  return <section className="panel" aria-busy={busy}><div className="section-title"><div><button className="text-button" onClick={back}>‹ {config.title}</button>
    <h1>{item ? itemTitle(item) : 'Chi tiết'}</h1></div><div className="actions">
    <button className="secondary" onClick={refresh} disabled={busy}>Tải lại</button>
    {item && canEdit && <button onClick={() => setEditing('root')} disabled={busy}>Sửa</button>}
    {item && admin && kind !== 'users' && <button className="secondary" disabled={busy} onClick={() => {
      if (window.confirm('Lưu trữ bản ghi này?')) void mutate(`${path}/archive`, 'POST', { version: item.version });
    }}>Lưu trữ</button>}
  </div></div>
    {!result && <p role="status">Đang tải chi tiết…</p>}
    {(result?.error || error || assignment?.error) && <p className="error" role="alert">{result?.error || error || assignment?.error}</p>}
    {item && <>
      {editing === 'root' ? <EditForm key={item.version} item={item} api={api} fields={fields} cancel={() => setEditing('')} save={async (body) => {
        await api(path, { method: 'PATCH', body: { ...body, version: item.version } }); refresh();
      }} /> : <dl className="details">{config.fields.filter(({ key }) => item[key] != null).map(({ key, label, options, source }) =>
        <div key={key}><dt>{label}</dt><dd>{source && (source !== 'users' || admin) ? <ResourceName api={api} kind={source} id={String(item[key])} open={open} /> :
          options?.find(([value]) => value === item[key])?.[1] ?? (key === 'ownerId' ? String(item.ownerDisplayName ?? '—') : String(item[key]))}</dd></div>)}</dl>}
      {relations.length > 0 && <div className="related-grid">{relations.map((relation) => <RelationList key={`${relation.kind}:${revision}`} config={relation} api={api} open={open}
        mutate={(url, method) => mutate(url, method, kind === 'users' ? undefined : { version: item.version })} />)}</div>}
      {kind === 'applications' && <DnsLinks api={api} path={`${path}/dns-records`} ids={asIds(item.dnsRecordIds)}
        mutate={(url, method) => mutate(url, method, { version: item.version })} canEdit={admin} />}
      {childGroups[kind]?.filter((group) => admin || ['addresses', 'dnsRecords'].includes(group.key)).map((group) => {
        const records = (item[group.key] ?? []) as RecordItem[];
        const adding = editing === group.path;
        const edited = records.find((child) => editing === `${group.path}/${child.id}`);
        return <div className="subpanel" key={group.key}><div className="section-title"><h3>{group.title}</h3>
          {admin && <button className="secondary" onClick={() => setEditing(group.path)}>Thêm</button>}</div>
          {records.length === 0 && <p className="muted">Chưa có dữ liệu.</p>}
          <ul className="rows">{records.map((child) => <li key={child.id}><span>{group.fields.map(({ key, options }) =>
            options?.find(([value]) => value === child[key])?.[1] ?? child[key]).filter((value) => value != null && value !== '').map(String).join(' · ')}</span>
            {admin && <div className="actions"><button className="secondary" onClick={() => setEditing(`${group.path}/${child.id}`)}>Sửa</button>
              <button className="secondary" onClick={() => { if (window.confirm('Xóa mục này?')) void mutate(`${path}/${group.path}/${child.id}`, 'DELETE', { version: item.version }); }}>Xóa</button></div>}</li>)}</ul>
          {(adding || edited) && <EditForm key={editing} api={api} item={edited} fields={group.fields} cancel={() => setEditing('')} save={async (body) => {
            await api(`${path}/${group.path}${edited ? `/${edited.id}` : ''}`, { method: edited ? 'PATCH' : 'POST', body: { ...body, version: item.version } }); refresh();
          }} />}</div>;
      })}
    </>}
  </section>;
}
