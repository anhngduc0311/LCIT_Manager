import { useSearch } from '../controllers/use-search';
import { RequestApi } from '../models/api';
import { Kind } from '../models/catalog';
import { Pager } from './catalog';

export function Search({ api, open }: { api: RequestApi; open: (kind: Kind, id: string) => void }) {
  const { value, setValue, term, result, submit, changePage } = useSearch(api);
  return <section className="panel search-panel"><h1>Tra cứu hệ thống</h1>
    <form className="search-form" onSubmit={submit}><label>Từ khóa<input value={value} maxLength={253} placeholder="IP, hostname, tên miền, ứng dụng hoặc đơn vị" onChange={(event) => setValue(event.target.value)} required /></label>
      <button disabled={!value.trim()}>Tìm kiếm</button></form>
    {term && !result && <p role="status">Đang tra cứu…</p>}
    {result?.error && <p className="error" role="alert">{result.error}</p>}
    {result?.data && <>
      {result.data.items.length === 0 && <p className="empty">Không tìm thấy kết quả cho “{term}”.</p>}
      {result.data.items.map((item) => <article className="search-result" key={item.id}>
        <div className="section-title"><h2><button className="text-button" onClick={() => open('applications', item.id)}>{item.name}</button></h2><span className="muted">{item.code}</span></div>
        <p>{item.organization.name}{item.owner && ` · Phụ trách: ${item.owner.displayName}`}</p>
        {item.servers.length > 0 && <ul className="rows">{item.servers.map((server) => <li key={server.id}><div>
          <button className="text-button" onClick={() => open('servers', server.id)}>{server.hostname}</button> <span className="muted">· {server.dataCenter.name}</span>
          {server.addresses.map((address) => <div key={`${address.address}:${address.networkScope}:${address.kind}`}><code>{address.address}</code> <span className="muted">· {address.networkScope}</span></div>)}
        </div>{server.accessMethods.length > 0 && <span>{server.accessMethods.map((method) => method.toUpperCase()).join(' · ')}</span>}</li>)}</ul>}
        {item.domains.length > 0 && <div className="actions domain-links">{item.domains.map((domain) =>
          <button key={domain.id} className="text-button" onClick={() => open('domains', domain.id)}>{domain.name}</button>)}</div>}
      </article>)}
      <Pager {...result.data} change={changePage} />
    </>}
  </section>;
}
