import { useSearch } from '../controllers/use-search';
import { RequestApi } from '../models/api';
import { Kind } from '../models/catalog';
import { Pager } from './catalog';
import { Icon } from './icon';

export function Search({ api, open }: { api: RequestApi; open: (kind: Kind, id: string) => void }) {
  const { value, setValue, term, result, submit, changePage } = useSearch(api);
  return <section className="panel search-panel"><div className="search-heading"><span className="eyebrow">THÔNG TIN TẬP TRUNG · TRA CỨU NHANH</span><h1>Kết nối mọi thông tin<br />trong hệ thống của bạn.</h1><p>Tìm ứng dụng và các tài nguyên liên quan chỉ trong một lần tra cứu.</p></div>
    <form className="search-form" onSubmit={submit}><label>Từ khóa<input value={value} maxLength={253} placeholder="IP, hostname, tên miền, ứng dụng hoặc đơn vị" onChange={(event) => setValue(event.target.value)} required /></label>
      <button disabled={!value.trim()}><Icon name="search" size={18} />Tìm kiếm</button></form>
    {!term && <div className="search-guide"><div className="section-title"><h2>Bắt đầu từ thông tin bạn có</h2><span className="muted">Một nơi tra cứu, nhiều kết nối</span></div><div className="guide-grid">
      {[['servers', 'IP & hostname', 'Tra cứu ứng dụng qua địa chỉ IP hoặc tên máy chủ.'], ['domains', 'Tên miền', 'Tìm ứng dụng gắn với tên miền trong hệ thống.'], ['applications', 'Ứng dụng & đơn vị', 'Tra cứu theo tên ứng dụng hoặc đơn vị quản lý.']].map(([icon, title, description]) => <article className="guide-card" key={icon}><span className="guide-icon"><Icon name={icon} size={24} /></span><h3>{title}</h3><p>{description}</p></article>)}
    </div><p className="search-note"><Icon name="shield" size={16} />Kết quả được hiển thị theo quyền truy cập của bạn.</p></div>}
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
