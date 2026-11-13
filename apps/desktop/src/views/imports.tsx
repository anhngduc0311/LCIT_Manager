import { useRef } from 'react';
import { useImportWizard } from '../controllers/use-imports';
import { RequestApi } from '../models/api';
import { allowedDecisions, columnLetter, decisionText, ImportField, importFields, PreviewRow, reasonVi, requiredFields, RowDecision, RowStatus, rowStatusText } from '../models/imports';
import styles from './reports.module.css';

const steps = ['Chọn tệp', 'Ánh xạ cột', 'Xem trước và chọn dòng', 'Kết quả'];
const statusBadge: Record<RowStatus, string> = {
  new: styles.badgeNotice, match: styles.badgeWarning, duplicate: styles.badgeNotice, conflict: styles.badgeCritical, error: styles.badgeCritical,
};
const statusIcon: Record<RowStatus, string> = { new: '＋', match: '◔', duplicate: '≡', conflict: '⚠', error: '⚠' };

function Matches({ row }: { row: PreviewRow }) {
  const items = [
    ...row.matches.applications.map((item) => `Ứng dụng ${item.code}${item.name ? ` · ${item.name}` : ''}`),
    ...row.matches.servers.map((item) => `Máy chủ ${item.code}${item.hostname ? ` · ${item.hostname}` : ''}`),
    ...(row.matches.domain ? [`Tên miền ${row.matches.domain.name}`] : []),
  ];
  if (row.status !== 'match' || items.length === 0) return null;
  return <span className={styles.small}>Đối chiếu: {items.join('; ')}</span>;
}

export function ImportsView({ api }: { api: RequestApi }) {
  const wizard = useImportWizard(api);
  const input = useRef<HTMLInputElement>(null);
  const { batch, busy, error, step } = wizard;
  const visible = wizard.rows.filter((row) => !wizard.statusFilter || row.status === wizard.statusFilter);
  const columnCount = Math.max(1, ...(wizard.selectedSheet?.sampleRows.map((row) => row.cells.length) ?? [1]));

  return <section className="panel" aria-busy={Boolean(busy)}><div className="section-title"><div><p className="eyebrow">NHẬP DỮ LIỆU</p><h1>Nhập Excel</h1>
    <p className="page-description">Xem trước từng dòng, chọn gộp cho bản ghi đã có, rồi xác nhận. Chỉ các dòng được đánh dấu mới được ghi; cả lô ghi trong một transaction.</p></div>
    {batch && <button className="secondary" disabled={Boolean(busy)} onClick={wizard.reset}>Lô mới</button>}</div>
    <ol className="actions" aria-label="Các bước" style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem' }}>
      {steps.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined}
        className={index === step ? styles.badgeWarning : styles.badgeNotice}>{index + 1}. {label}</li>)}
    </ol>
    {error && <p className="error" role="alert">{error}</p>}

    {step === 0 && <div className="subpanel">
      <p>Chọn tệp .xlsx tối đa 10 MiB, 20 sheet, 10.000 dòng. Ô công thức, liên kết và ô lỗi không được đọc. Có thể thử với <code>fixtures/import-sample.xlsx</code>.</p>
      <input ref={input} type="file" accept=".xlsx" hidden onChange={(event) => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void wizard.upload(file);
      }} />
      <div className="actions"><button disabled={Boolean(busy)} onClick={() => input.current?.click()}>{busy === 'upload' ? 'Đang đọc tệp…' : 'Chọn tệp Excel'}</button></div>
    </div>}

    {step === 1 && batch && <div className="subpanel">
      <p><strong>{batch.fileName}</strong></p>
      <div className={styles.filters}>
        <label>Sheet<select value={wizard.sheet} onChange={(event) => wizard.chooseSheet(event.target.value)}>
          {batch.sheets.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.rowCount} dòng)</option>)}</select></label>
        <label>Dòng tiêu đề<select value={wizard.headerRow} onChange={(event) => wizard.setHeaderRow(Number(event.target.value))}>
          {wizard.selectedSheet?.sampleRows.map((row) => <option key={row.rowNumber} value={row.rowNumber}>Dòng {row.rowNumber}</option>)}</select></label>
      </div>
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Trường dữ liệu</th><th>Cột trong tệp</th></tr></thead>
        <tbody>{(Object.entries(importFields) as [ImportField, string][]).map(([field, label]) =>
          <tr key={field}><td>{label}{requiredFields.includes(field) ? <strong className="error"> *</strong> : <span className="muted"> (tùy chọn)</span>}</td>
            <td><select aria-label={`Cột cho ${label}`} value={wizard.columns[field] ?? ''} onChange={(event) => wizard.setColumn(field, event.target.value ? Number(event.target.value) : undefined)}>
              <option value="">— Không dùng —</option>
              {Array.from({ length: columnCount }, (_, index) => index + 1).map((column) =>
                <option key={column} value={column}>Cột {columnLetter(column)}{wizard.headers[column - 1] ? ` · ${wizard.headers[column - 1]}` : ''}</option>)}
            </select></td></tr>)}</tbody></table></div>
      {wizard.missing.length > 0 && <p className="error">Cần chọn cột cho: {wizard.missing.map((field) => importFields[field]).join(', ')}.</p>}
      {wizard.usedTwice.length > 0 && <p className="error">Mỗi cột chỉ dùng cho một trường.</p>}
      <div className="actions" style={{ marginTop: '.8rem' }}>
        <button disabled={Boolean(busy) || wizard.missing.length > 0 || wizard.usedTwice.length > 0} onClick={() => void wizard.runPreview()}>
          {busy === 'preview' ? 'Đang xem trước…' : 'Xem trước'}</button>
      </div>
    </div>}

    {step === 2 && wizard.preview && <div className="subpanel">
      <div className="actions">
        <button className={wizard.statusFilter === '' ? undefined : 'secondary'} onClick={() => wizard.setStatusFilter('')}>Tất cả ({wizard.rows.length})</button>
        {(Object.keys(rowStatusText) as RowStatus[]).filter((status) => wizard.counts[status]).map((status) =>
          <button key={status} className={wizard.statusFilter === status ? undefined : 'secondary'} onClick={() => wizard.setStatusFilter(status)}>
            {rowStatusText[status]} ({wizard.counts[status]})</button>)}
      </div>
      <p className="muted" style={{ marginTop: '.6rem' }}>Dòng có bản ghi sẵn có mặc định bỏ qua; chọn “Gộp” sau khi xem bản ghi đối chiếu. Gộp có thể sửa tài nguyên dùng chung. Dòng lỗi, xung đột hoặc trùng cần sửa trong tệp và tải lô mới.</p>
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Ghi</th><th>Dòng</th><th>Trạng thái</th><th>Dữ liệu</th><th>Quyết định</th></tr></thead>
        <tbody>{visible.map((row) => <tr key={row.rowNumber}>
          <td><input type="checkbox" aria-label={`Ghi dòng ${row.rowNumber}`} disabled={row.decision === 'skip' || Boolean(busy)}
            checked={wizard.selected.has(row.rowNumber)} onChange={() => wizard.toggle(row.rowNumber)} /></td>
          <td>{row.rowNumber}</td>
          <td><span className={statusBadge[row.status]}>{statusIcon[row.status]} {rowStatusText[row.status]}</span>
            {row.duplicateOf && <span className={styles.small}>Giống dòng {row.duplicateOf}</span>}
            {row.reasons.map((reason) => <span key={reason} className={styles.small}>{reasonVi(reason)}</span>)}
            <Matches row={row} /></td>
          <td>{(Object.keys(importFields) as ImportField[]).filter((field) => row.data[field] || row.errors.some((item) => item.field === field)).map((field) => {
            const problem = row.errors.find((item) => item.field === field);
            return <div key={field}><span className="muted">{importFields[field]}:</span> {problem
              ? <><mark>{row.data[field] || '(không đọc được)'}</mark> <span className="error">· Cột {columnLetter(problem.column)}: {reasonVi(problem.reason)}</span></>
              : row.data[field]}</div>;
          })}</td>
          <td><select aria-label={`Quyết định dòng ${row.rowNumber}`} value={row.decision} disabled={Boolean(busy) || allowedDecisions(row.status).length < 2}
            onChange={(event) => void wizard.decide(row.rowNumber, event.target.value as RowDecision)}>
            {allowedDecisions(row.status).map((decision) => <option key={decision} value={decision}>{decisionText[decision]}</option>)}</select></td>
        </tr>)}</tbody></table></div>
      <div className="actions" style={{ marginTop: '.8rem' }}>
        <button className="secondary" disabled={Boolean(busy)} onClick={wizard.backToMapping}>Sửa ánh xạ</button>
        <button className="secondary" disabled={Boolean(busy)} onClick={() => void wizard.runPreview()}>Xem trước lại</button>
        <button disabled={Boolean(busy)} onClick={() => {
          const count = wizard.selected.size;
          if (window.confirm(count ? `Ghi ${count} dòng đã chọn vào danh mục? Các dòng khác được ghi nhận là bỏ qua.` : 'Không có dòng nào được chọn. Hoàn tất lô mà không ghi dữ liệu?')) void wizard.confirm();
        }}>{busy === 'confirm' ? 'Đang ghi…' : `Xác nhận nhập ${wizard.selected.size} dòng`}</button>
      </div>
    </div>}

    {step === 3 && wizard.receipt && <div className="subpanel" role="status">
      <h3>Đã hoàn tất lô “{batch?.fileName}”</h3>
      <div className={styles.tiles} style={{ marginTop: '.8rem' }}>
        {([['created', 'Dòng tạo mới'], ['merged', 'Dòng gộp'], ['skipped', 'Dòng bỏ qua']] as const).map(([key, label]) =>
          <div className={styles.tile} key={key}><span>{label}</span><strong>{wizard.receipt![key]}</strong></div>)}
      </div>
      <p className="muted" style={{ marginTop: '.6rem' }}>Số liệu tính theo dòng nguồn, không phải số tài nguyên. Kết quả đã được lưu cùng nhật ký <code>imports.confirm</code>.</p>
    </div>}
  </section>;
}
