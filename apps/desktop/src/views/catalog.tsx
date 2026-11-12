import { FormEvent, Fragment, useState } from 'react';
import { useCatalogDetail, useCatalogList } from '../controllers/use-catalog';
import { errorText, useRemote } from '../controllers/use-remote';
import { Page, RecordItem, RequestApi, Role } from '../models/api';
import { Kind } from '../models/catalog';
import { catalogs, childGroups, Field, roleNames } from './catalog-config';
import accountStyles from './accounts.module.css';

const itemTitle = (row: RecordItem) => String(row.name ?? row.hostname ?? row.displayName ?? row.username ?? row.id);
const asIds = (value: unknown) => Array.isArray(value) ? value as string[] : [];

export function Pager({ page, pageSize, total, change }: { page: number; pageSize: number; total: number; change: (page: number) => void }) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return <div className="pager"><span>{total} mục · Trang {page}/{last}</span><div className="actions">
    <button type="button" className="secondary" disabled={page <= 1} onClick={() => change(page - 1)}>Trước</button>
    <button type="button" className="secondary" disabled={page >= last} onClick={() => change(page + 1)}>Sau</button>
  </div></div>;
}

function Picker({ api, kind, value, change, required, initialLabel = '' }: { api: RequestApi; kind: Kind; value: string; change: (value: string) => void; required?: boolean; initialLabel?: string }) {
  const [page, setPage] = useState(1);
  const [label, setLabel] = useState(initialLabel);
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

function EditForm({ api, fields, item, save, cancel, title }: {
  api: RequestApi; fields: Field[]; item?: RecordItem; save: (body: Record<string, unknown>) => Promise<void>; cancel: () => void; title?: string;
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
  return <form className="editor" onSubmit={submit}>{title && <h2 className={accountStyles.formTitle}>{title}</h2>}<div className="form-grid">
    {fields.map(({ key, label, type, options, required, source }) => {
      const value = values[key] ?? '';
      const change = (newValue: string) => setValues((previous) => ({ ...previous, [key]: newValue }));
      const needed = required || (type === 'password' && !item);
      return <label key={key}>{label}{source ? <Picker api={api} kind={source} value={value} change={change} required={needed}
        initialLabel={key === 'ownerId' ? String(item?.ownerDisplayName ?? '') : undefined} /> :
        options ? <select value={value} required={needed} onChange={(event) => change(event.target.value)}><option value="" disabled={Boolean(item?.[key])}>Chọn</option>
          {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> :
        type === 'area' ? <textarea rows={3} value={value} required={needed} onChange={(event) => change(event.target.value)} /> :
        <input type={type ?? 'text'} value={value} required={needed} min={type === 'number' ? 1 : undefined} max={type === 'number' ? 65535 : undefined}
          minLength={type === 'password' ? 12 : undefined} autoComplete={type === 'password' ? 'new-password' : undefined} onChange={(event) => change(event.target.value)} />}</label>;
    })}
  </div>{error && <p className="error" role="alert">{error}</p>}
  <div className="actions"><button disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button><button type="button" className="secondary" disabled={busy} onClick={cancel}>Hủy</button></div></form>;
}

function ResourceName({ api, kind, id, open, fallback }: { api: RequestApi; kind: Kind; id: string; open?: (kind: Kind, id: string) => void; fallback?: string }) {
  const result = useRemote<RecordItem>(api, `/${kind}/${id}`);
  if (result?.error) return <span className="muted">{fallback || result.error}</span>;
  if (!result?.data) return <span className="muted">Đang tải…</span>;
  return open ? <button className="text-button" onClick={() => open(kind, id)}>{itemTitle(result.data)}</button> : <span>{itemTitle(result.data)}</span>;
}

export function Catalog({ kind, api, role, actorId, open }: { kind: Kind; api: RequestApi; role: Role; actorId: string; open: (kind: Kind, id: string) => void }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState('');
  const [confirming, setConfirming] = useState('');
  const { setPage, listing, reload, create, saveItem, removeItem, removing, removeError } = useCatalogList(api, kind);
  const config = catalogs[kind];
  const manageAccounts = kind === 'users' && role === 'admin';
  const accountPage = listing?.data;

  function resetAccountActions() {
    setConfirming('');
    setEditing('');
  }

  if (manageAccounts) return <section className={`panel ${accountStyles.panel}`} aria-labelledby="accounts-title">
    <header className={accountStyles.header}>
      <div><h1 id="accounts-title">Tài khoản</h1><p>Quản lý người dùng và quyền truy cập.</p></div>
      <div className="actions">
        <button className="secondary" disabled={removing} onClick={() => { resetAccountActions(); reload(); }}>Tải lại</button>
        <button disabled={removing || creating} onClick={() => { resetAccountActions(); setCreating(true); }}>+ Thêm tài khoản</button>
      </div>
    </header>
    {creating && <EditForm api={api} fields={config.fields} title="Thêm tài khoản" cancel={() => setCreating(false)} save={async (body) => {
      const item = await create(body);
      open(kind, item.id);
    }} />}
    {!listing && <p className={accountStyles.feedback} role="status">Đang tải tài khoản…</p>}
    {listing?.error && <p className={`error ${accountStyles.feedback}`} role="alert">{listing.error}</p>}
    {removeError && <p className={`error ${accountStyles.feedback}`} role="alert">{removeError}</p>}
    {accountPage && <div className={accountStyles.list}>
      {accountPage.items.length === 0 ? <p className="empty">Chưa có tài khoản.</p> :
        <div className={accountStyles.scroll} tabIndex={0} role="region" aria-label="Danh sách tài khoản">
          <table className={accountStyles.table} aria-label="Danh sách tài khoản">
            <thead><tr><th scope="col">Người dùng</th><th scope="col">Vai trò</th><th scope="col">Trạng thái</th><th scope="col">Thao tác</th></tr></thead>
            <tbody>{accountPage.items.map((row) => {
              const name = itemTitle(row);
              const username = String(row.username ?? '');
              const accountRole = String(row.role ?? '');
              const status = String(row.status ?? '');
              const isCurrent = row.id === actorId;
              return <Fragment key={row.id}>
                <tr>
                  <th scope="row"><div className={accountStyles.identity}>
                    <span className={accountStyles.initial} aria-hidden="true">{name.trim().slice(0, 1).toLocaleUpperCase('vi')}</span>
                    <div>
                      <button className={`text-button ${accountStyles.name}`} onClick={() => open(kind, row.id)}>{name}</button>
                      <span className={accountStyles.username}>{username}{isCurrent && <span className={accountStyles.current}>Bạn</span>}</span>
                    </div>
                  </div></th>
                  <td><span className={accountStyles.role} data-role={accountRole}>{roleNames[accountRole as Role] ?? (accountRole || '—')}</span></td>
                  <td><span className={accountStyles.status} data-status={status}>{status === 'active' ? 'Hoạt động' : status === 'locked' ? 'Đã khóa' : '—'}</span></td>
                  <td><div className={accountStyles.rowActions}>
                    <button type="button" className="secondary" disabled={removing || creating || editing === row.id} aria-label={`Sửa tài khoản ${username}`} onClick={() => { setConfirming(''); setEditing(row.id); }}>Sửa</button>
                    {!isCurrent && <button type="button" className="secondary account-delete" disabled={removing || creating || Boolean(editing)} aria-label={`Xóa tài khoản ${username}`} aria-expanded={confirming === row.id} onClick={() => setConfirming(confirming === row.id ? '' : row.id)}>Xóa</button>}
                  </div></td>
                </tr>
                {editing === row.id && <tr className={accountStyles.expanded}><td colSpan={4}>
                  <EditForm key={row.version} api={api} fields={config.fields} item={row} title={`Sửa tài khoản ${username}`} cancel={() => setEditing('')} save={async (body) => { await saveItem(row, body); setEditing(''); }} />
                </td></tr>}
                {confirming === row.id && <tr className={accountStyles.expanded}><td colSpan={4}>
                  <div className={accountStyles.confirm} role="group" aria-label="Xác nhận xóa tài khoản">
                    <div><h2>Xóa tài khoản {username}?</h2><p>Tài khoản sẽ bị đăng xuất và mất quyền truy cập.</p></div>
                    <div className="actions">
                      <button type="button" className="secondary" disabled={removing} onClick={() => setConfirming('')}>Hủy</button>
                      <button type="button" className={accountStyles.danger} disabled={removing} onClick={async () => { await removeItem(row); setConfirming(''); }}>{removing ? 'Đang xóa…' : 'Xác nhận xóa'}</button>
                    </div>
                  </div>
                </td></tr>}
              </Fragment>;
            })}</tbody>
          </table>
        </div>}
      <Pager {...accountPage} change={(page) => { if (!removing) { resetAccountActions(); setPage(page); } }} />
    </div>}
  </section>;

  return <section className="panel catalog-panel"><div className="section-title"><div><p className="eyebrow">DANH MỤC HỆ THỐNG</p><h1>{config.title}</h1><p className="page-description">Quản lý và tra cứu thông tin {config.title.toLocaleLowerCase('vi')}.</p></div><div className="actions">
    {role === 'admin' && !creating && <button onClick={() => setCreating(true)}>Thêm mới</button>}
    <button className="secondary" onClick={reload}>Tải lại</button>
  </div></div>
    {creating && <EditForm api={api} fields={config.fields} save={async (body) => {
      const item = await create(body); open(kind, item.id);
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
  const { path, revision, editing, setEditing, error, busy, result, item, admin, assignment, canEdit, refresh, mutate, saveItem, saveChild } = useCatalogDetail(api, kind, id, role, back);
  const config = catalogs[kind];
  const fields = admin ? config.fields : config.fields.filter(({ key }) => ['name', 'description', 'status'].includes(key));
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
      {editing === 'root' ? <EditForm key={item.version} item={item} api={api} fields={fields} cancel={() => setEditing('')} save={(body) => saveItem(body, item.version)} /> : <dl className="details">{config.fields.filter(({ key }) => item[key] != null).map(({ key, label, options, source }) =>
        <div key={key}><dt>{label}</dt><dd>{source && (source !== 'users' || admin) ? <ResourceName api={api} kind={source} id={String(item[key])} open={open}
          fallback={key === 'ownerId' ? String(item.ownerDisplayName ?? '') : undefined} /> :
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
          {(adding || edited) && <EditForm key={editing} api={api} item={edited} fields={group.fields} cancel={() => setEditing('')} save={(body) => saveChild(group.path, edited?.id, body, item.version)} />}</div>;
      })}
    </>}
  </section>;
}
