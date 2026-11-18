import { useRef } from 'react';
import { useImportWizard } from '../controllers/use-imports';
import { useLocalPage } from '../controllers/use-local-page';
import { RequestApi } from '../models/api';
import { allowedDecisions, columnLetter, decisionText, ImportField, importFields, PreviewRow, reasonVi, requiredFields, RowDecision, RowStatus, rowStatusText } from '../models/imports';
import { Pager } from './catalog';
import { Icon } from './icon';
import mapping from './import-mapping.module.css';
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

export function ImportsView({ api, onBack }: { api: RequestApi; onBack?: () => void }) {
  const wizard = useImportWizard(api);
  const input = useRef<HTMLInputElement>(null);
  const { batch, busy, error, step } = wizard;
  const visible = wizard.rows.filter((row) => !wizard.statusFilter || row.status === wizard.statusFilter);
  const previewPage = useLocalPage(visible, 20);
  const columnCount = Math.max(1, ...(wizard.selectedSheet?.sampleRows.map((row) => row.cells.length) ?? [1]));
  const columnOptions = Array.from({ length: columnCount }, (_, index) => {
    const header = wizard.headers[index];
    return <option key={index + 1} value={index + 1}>Cột {columnLetter(index + 1)}{header ? ` · ${header}` : ''}</option>;
  });

  function filterRows(status: RowStatus | '') {
    wizard.setStatusFilter(status);
    previewPage.change(1);
  }

  return <section className="panel" aria-busy={Boolean(busy)}><div className="section-title"><div>{onBack && <button className="text-button" onClick={onBack}>‹ Danh mục</button>}<p className="eyebrow">NHẬP DỮ LIỆU</p><h1>Nhập Excel</h1>
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

    {step === 1 && batch && <section className={mapping.card} aria-labelledby="import-mapping-title">
      <header className={mapping.source}>
        <div className={mapping.file}>
          <span className={mapping.fileIcon}><Icon name="imports" size={22} /></span>
          <div><span className={mapping.fileLabel}>Tệp Excel</span><strong>{batch.fileName}</strong></div>
        </div>
        <div className={mapping.sourceFields}>
          <label>Trang tính<select value={wizard.sheet} disabled={Boolean(busy)} onChange={(event) => wizard.chooseSheet(event.target.value)}>
            {batch.sheets.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.rowCount} dòng)</option>)}
          </select></label>
          <label>Dòng tiêu đề<select value={wizard.headerRow} disabled={Boolean(busy)} onChange={(event) => wizard.setHeaderRow(Number(event.target.value))}>
            {wizard.selectedSheet?.sampleRows.map((row) => <option key={row.rowNumber} value={row.rowNumber}>Dòng {row.rowNumber}</option>)}
          </select></label>
        </div>
      </header>
      <div className={mapping.body}>
        <div className={mapping.heading}>
          <h2 id="import-mapping-title">Cột Excel cho từng trường</h2>
          <span className={mapping.progress}>Đã chọn {requiredFields.length - wizard.missing.length}/{requiredFields.length} trường bắt buộc</span>
        </div>
        <div className={mapping.fields}>
          {(Object.entries(importFields) as [ImportField, string][]).map(([field, label]) => {
            const required = requiredFields.includes(field);
            const column = wizard.columns[field];
            const invalid = column === undefined ? required : wizard.usedTwice.includes(column);
            return <label key={field} className={mapping.field}>
              <span>{label}{required ? <span className={mapping.required} aria-hidden="true"> *</span> : <small className={mapping.optional}>Tùy chọn</small>}</span>
              <select value={column ?? ''} required={required} aria-invalid={invalid || undefined} disabled={Boolean(busy)}
                onChange={(event) => wizard.setColumn(field, event.target.value ? Number(event.target.value) : undefined)}>
                <option value="">{required ? 'Chọn cột Excel' : 'Không dùng'}</option>
                {columnOptions}
              </select>
            </label>;
          })}
        </div>
      </div>
      <footer className={mapping.footer}>
        <div className={mapping.feedback} aria-live="polite">
          {wizard.missing.length > 0 && <p>Cần chọn cột cho {wizard.missing.map((field) => importFields[field]).join(', ')}.</p>}
          {wizard.usedTwice.length > 0 && <p>Mỗi cột chỉ dùng cho một trường.</p>}
        </div>
        <button type="button" disabled={Boolean(busy) || wizard.missing.length > 0 || wizard.usedTwice.length > 0} onClick={() => void wizard.runPreview()}>
          {busy === 'preview' ? 'Đang xem trước…' : 'Xem trước'} <Icon name="arrow" size={17} />
        </button>
      </footer>
    </section>}

    {step === 2 && wizard.preview && <div className="subpanel">
      <div className="actions">
        <button className={wizard.statusFilter === '' ? undefined : 'secondary'} onClick={() => filterRows('')}>Tất cả ({wizard.rows.length})</button>
        {(Object.keys(rowStatusText) as RowStatus[]).filter((status) => wizard.counts[status]).map((status) =>
          <button key={status} className={wizard.statusFilter === status ? undefined : 'secondary'} onClick={() => filterRows(status)}>
            {rowStatusText[status]} ({wizard.counts[status]})</button>)}
      </div>
      <p className="muted" style={{ marginTop: '.6rem' }}>Dòng có bản ghi sẵn có mặc định bỏ qua; chọn “Gộp” sau khi xem bản ghi đối chiếu. Gộp có thể sửa tài nguyên dùng chung. Dòng lỗi, xung đột hoặc trùng cần sửa trong tệp và tải lô mới.</p>
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Ghi</th><th>Dòng</th><th>Trạng thái</th><th>Dữ liệu</th><th>Quyết định</th></tr></thead>
        <tbody>{previewPage.items.map((row) => <tr key={row.rowNumber}>
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
      <Pager {...previewPage} disabled={Boolean(busy)} />
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
