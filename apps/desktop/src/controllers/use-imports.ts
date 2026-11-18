import { useState } from 'react';
import { RequestApi } from '../models/api';
import { Columns, guessColumns, ImportField, ImportReceipt, PreviewResponse, requiredFields, RowDecision, RowStatus, UploadedBatch } from '../models/imports';
import { errorText } from './use-remote';

const maxImportBytes = 10 * 1024 * 1024;

export function useImportWizard(api: RequestApi) {
  const [batch, setBatch] = useState<UploadedBatch>();
  const [sheet, setSheet] = useState('');
  const [headerRow, setHeaderRow] = useState(1);
  const [columns, setColumns] = useState<Columns>({});
  const [preview, setPreview] = useState<PreviewResponse>();
  // Latest version on the server; kept when the user goes back to change the mapping.
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [receipt, setReceipt] = useState<ImportReceipt>();
  const [statusFilter, setStatusFilter] = useState<RowStatus | ''>('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function run(label: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError('');
    try { await work(); } catch (failure) { setError(errorText(failure)); } finally { setBusy(''); }
  }

  const selectedSheet = batch?.sheets.find((item) => item.name === sheet);
  const headers = selectedSheet?.sampleRows.find((row) => row.rowNumber === headerRow)?.cells ?? [];
  const missing = requiredFields.filter((field) => !columns[field]);
  const usedTwice = Object.values(columns).filter((column, index, all) => all.indexOf(column) !== index);

  function chooseSheet(name: string, row = 1, from = batch) {
    const target = from?.sheets.find((item) => item.name === name);
    setSheet(name); setHeaderRow(row);
    setColumns(guessColumns(target?.sampleRows.find((item) => item.rowNumber === row)?.cells ?? []));
  }

  const upload = (file: File) => run('upload', async () => {
    if (!/\.xlsx$/i.test(file.name)) throw new Error('Chỉ nhận tệp Excel .xlsx.');
    if (file.size > maxImportBytes) throw new Error('Tệp vượt quá 10 MiB cho mỗi lô nhập.');
    const created = await api<UploadedBatch>(`/imports?fileName=${encodeURIComponent(file.name)}`, { file });
    setBatch(created); setPreview(undefined); setReceipt(undefined); setVersion(created.previewVersion);
    if (created.sheets[0]) chooseSheet(created.sheets[0].name, 1, created);
  });

  /** Each preview rebuilds decisions from defaults, so every choice to keep is sent again. */
  async function sendPreview(decisions: { rowNumber: number; action: RowDecision }[]) {
    if (!batch) return;
    const next = await api<PreviewResponse>(`/imports/${batch.id}/preview`, { method: 'POST', body: {
      sheet, headerRow, columns, previewVersion: version, decisions,
    } });
    setPreview(next); setVersion(next.previewVersion);
    setSelected(new Set(next.rows.filter((row) => row.decision !== 'skip').map((row) => row.rowNumber)));
  }

  const runPreview = () => run('preview', () => sendPreview(
    preview ? preview.rows.filter((row) => row.decision !== (row.status === 'new' ? 'create' : 'skip')).map((row) => ({ rowNumber: row.rowNumber, action: row.decision })) : [],
  ));

  const decide = (rowNumber: number, action: RowDecision) => run(`row-${rowNumber}`, () => {
    const kept = (preview?.rows ?? [])
      .map((row) => ({ rowNumber: row.rowNumber, action: row.rowNumber === rowNumber ? action : row.decision }))
      .filter((item) => {
        const row = preview!.rows.find((candidate) => candidate.rowNumber === item.rowNumber)!;
        return item.action !== (row.status === 'new' ? 'create' : 'skip');
      });
    return sendPreview(kept);
  });

  function toggle(rowNumber: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rowNumber)) next.delete(rowNumber); else next.add(rowNumber);
      return next;
    });
  }

  const confirm = () => run('confirm', async () => {
    if (!batch || !preview) return;
    setReceipt(await api<ImportReceipt>(`/imports/${batch.id}/confirm`, { method: 'POST', body: {
      previewVersion: preview.previewVersion, rowNumbers: [...selected].sort((a, b) => a - b),
    } }));
  });

  function reset() {
    setBatch(undefined); setPreview(undefined); setReceipt(undefined); setSheet(''); setColumns({});
    setSelected(new Set()); setStatusFilter(''); setError('');
  }

  const rows = preview?.rows ?? [];
  const counts = rows.reduce<Partial<Record<RowStatus, number>>>((all, row) => ({ ...all, [row.status]: (all[row.status] ?? 0) + 1 }), {});
  const step = !batch ? 0 : receipt ? 3 : preview ? 2 : 1;

  return {
    step, batch, sheet, chooseSheet, selectedSheet, headerRow, setHeaderRow: (row: number) => chooseSheet(sheet, row), headers,
    columns, setColumn: (field: ImportField, column: number | undefined) => setColumns((current) => ({ ...current, [field]: column })),
    missing, usedTwice, preview, rows, counts, selected, toggle, decide, statusFilter, setStatusFilter, receipt,
    upload, runPreview, confirm, reset, busy, error,
    backToMapping: () => setPreview(undefined),
  };
}
