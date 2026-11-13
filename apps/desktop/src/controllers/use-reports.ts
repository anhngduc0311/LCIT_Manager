import { useState } from 'react';
import { DownloadedFile, RequestApi } from '../models/api';
import { Dashboard, emptyFilter, filterQuery, InventoryPage, ReportFilter } from '../models/reports';
import { saveFile } from './use-attachments';
import { errorText, useRemote } from './use-remote';

export function useReportFilter() {
  const [filter, setFilter] = useState<ReportFilter>(emptyFilter);
  const change = (key: keyof ReportFilter, value: string) => setFilter((current) => ({ ...current, [key]: value }));
  const active = Object.values(filter).some(Boolean);
  return { filter, change, reset: () => setFilter(emptyFilter), active };
}

export function useDashboard(api: RequestApi, filter: ReportFilter) {
  const [revision, setRevision] = useState(0);
  const result = useRemote<Dashboard>(api, `/dashboard${filterQuery(filter)}`, revision);
  return { result, reload: () => setRevision((value) => value + 1) };
}

export function useInventory(api: RequestApi, filter: ReportFilter) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // A changed filter starts again from page 1.
  const [lastFilter, setLastFilter] = useState(filter);
  if (lastFilter !== filter) { setLastFilter(filter); setPage(1); }
  const result = useRemote<InventoryPage>(api, `/reports/inventory${filterQuery(filter, { page, pageSize: 20 })}`, revision);

  async function exportExcel() {
    if (exporting) return;
    setExporting(true); setError(''); setNotice('');
    try {
      const file = await api<DownloadedFile>(`/reports/inventory.xlsx${filterQuery(filter)}`, { binary: true });
      saveFile(file);
      setNotice(`Đã xuất “${file.fileName}”.`);
    } catch (failure) { setError(errorText(failure)); }
    finally { setExporting(false); }
  }

  return { result, setPage, reload: () => setRevision((value) => value + 1), exportExcel, exporting, error, notice };
}
