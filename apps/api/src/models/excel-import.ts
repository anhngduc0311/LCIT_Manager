import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import { isIP } from 'node:net';
import { ApiError, bodyOf, choice, invalid, text } from '../shared/api-contract';
import { dateOnly, domainName, host } from './network-input';

export const importFields = ['organizationCode', 'dataCenterCode', 'applicationCode', 'applicationName',
  'serverCode', 'hostname', 'networkScope', 'privateIp', 'domain', 'serviceType', 'renewalDate'] as const;
export type ImportField = typeof importFields[number];
const requiredFields = importFields.slice(0, 9);
export interface SheetData { name: string; rows: { rowNumber: number; cells: (string | null)[] }[] }
export interface ImportRow {
  rowNumber: number; data: Record<string, string>; errors: { column: number; field: string; reason: string }[];
}

export async function parseWorkbook(buffer: Buffer): Promise<SheetData[]> {
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new ApiError(413, 'IMPORT_TOO_LARGE', 'Excel files must be at most 10 MiB.');
  try {
    let expanded = 0, entries = 0;
    unzipSync(buffer, { filter: (entry) => {
      expanded += entry.originalSize;
      if (++entries > 2000 || expanded > 50 * 1024 * 1024) invalid('file', 'Workbook expands beyond the allowed size.');
      return false;
    } });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0]);
    if (!book.worksheets.length || book.worksheets.length > 20) invalid('file', 'Expected 1–20 sheets.');
    let count = 0;
    return book.worksheets.map((sheet) => {
      if (sheet.rowCount > 10001 || sheet.columnCount > 64) invalid('file', 'Maximum 10,000 data rows and 64 columns.');
      const rows: SheetData['rows'] = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1 && ++count > 10000) invalid('file', 'Maximum 10,000 data rows per workbook.');
        const cells: (string | null)[] = [];
        for (let col = 1; col <= sheet.columnCount; col++) {
          const value = row.getCell(col).value;
          let cell: string | null;
          if (value === null || value === undefined) cell = '';
          else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') cell = String(value).trim();
          else if (value instanceof Date) cell = value.toISOString().slice(0, 10);
          else if ('richText' in value) cell = value.richText.map((part) => part.text).join('').trim();
          else cell = null; // Formula, hyperlink and error cells are never evaluated or followed.
          if (cell && (cell.length > 4000 || cell.includes('\0'))) invalid('file', 'Cell text exceeds the allowed size.');
          cells.push(cell);
        }
        rows.push({ rowNumber, cells });
      });
      return { name: sheet.name, rows };
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    invalid('file', 'Expected a valid, unencrypted .xlsx workbook.');
  }
}

export function normalizeSheet(sheets: SheetData[], raw: unknown) {
  const body = bodyOf(raw, ['sheet', 'headerRow', 'columns', 'decisions', 'previewVersion']);
  const sheet = sheets.find((item) => item.name === body.sheet);
  if (!sheet) invalid('sheet', 'Choose a sheet from this workbook.');
  const headerRow = body.headerRow ?? 1;
  if (!Number.isInteger(headerRow) || Number(headerRow) < 1 || Number(headerRow) > 10001) invalid('headerRow', 'Expected a valid row number.');
  const columns = bodyOf(body.columns, importFields);
  const used = new Set<number>();
  for (const [field, col] of Object.entries(columns)) {
    if (!Number.isInteger(col) || Number(col) < 1 || Number(col) > 64 || used.has(Number(col))) invalid(field, 'Use a unique, 1-based column number from 1 to 64.');
    used.add(Number(col));
  }
  for (const field of requiredFields) if (!columns[field]) invalid(field, 'Column mapping is required.');
  const rows: ImportRow[] = sheet.rows.filter((row) => row.rowNumber > Number(headerRow) && row.cells.some((cell) => cell !== '')).map((row) => {
    const data: Record<string, string> = {};
    const errors: ImportRow['errors'] = [];
    for (const [field, col] of Object.entries(columns)) {
      const value = row.cells[Number(col) - 1] ?? '';
      try {
        if (row.cells[Number(col) - 1] === null) invalid(field, 'Formula or unsupported cell value.');
        if (value === '' && !requiredFields.includes(field as ImportField)) continue;
        if (field.endsWith('Code')) {
          data[field] = text(value, field, 64).toUpperCase();
          if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(data[field])) invalid(field, 'Invalid code.');
        } else if (field === 'privateIp') {
          if (!isIP(value) || value.includes('%')) invalid(field, 'Expected an IPv4 or IPv6 address.');
          data[field] = isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
        } else if (field === 'hostname') data[field] = host(value, field);
        else if (field === 'domain') data[field] = domainName(value);
        else if (field === 'renewalDate') data[field] = dateOnly(value, field)!;
        else if (field === 'serviceType') data[field] = choice(value.toLowerCase(), field, ['ordered', 'monitoring', 'operations']);
        else data[field] = text(value, field, field === 'networkScope' ? 100 : 200);
        if (field === 'networkScope') data[field] = data[field].toUpperCase();
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const response = error.getResponse() as { fields?: Record<string, string> };
        errors.push({ column: Number(col), field, reason: Object.values(response.fields ?? {})[0] ?? 'Invalid cell.' });
      }
    }
    data.serviceType ??= 'operations';
    return { rowNumber: row.rowNumber, data, errors };
  });
  return { body, rows, mapping: { sheet: sheet.name, headerRow, columns } };
}
