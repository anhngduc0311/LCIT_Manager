/**
 * Types for the Excel import API of T2.2–T2.4 (person A). Contract: docs/IMPORT_API.md.
 *   POST /imports?fileName=...          raw .xlsx body             -> UploadedBatch
 *   POST /imports/{id}/preview          PreviewRequest             -> PreviewResponse (decisions are saved by previewing again)
 *   POST /imports/{id}/confirm          { previewVersion, rowNumbers } -> ImportReceipt (a completed batch returns its stored receipt)
 *   GET  /imports/{id}                                             -> ImportBatch
 * Administrators only. A changed catalog after preview returns 409 IMPORT_CONFLICT; an old previewVersion returns 409 STALE_VERSION.
 */
export const importFields = {
  organizationCode: 'Mã đơn vị',
  dataCenterCode: 'Mã trung tâm dữ liệu',
  applicationCode: 'Mã ứng dụng',
  applicationName: 'Tên ứng dụng',
  serverCode: 'Mã máy chủ',
  hostname: 'Hostname máy chủ',
  networkScope: 'Phạm vi mạng',
  privateIp: 'IP riêng',
  domain: 'Tên miền',
  serviceType: 'Hình thức dịch vụ',
  renewalDate: 'Hạn gia hạn tên miền (YYYY-MM-DD)',
} as const;
export type ImportField = keyof typeof importFields;
export const requiredFields: ImportField[] = ['organizationCode', 'dataCenterCode', 'applicationCode', 'applicationName',
  'serverCode', 'hostname', 'networkScope', 'privateIp', 'domain'];

export interface SheetRow { rowNumber: number; cells: (string | null)[] }
export interface ImportSheet { name: string; rowCount: number; sampleRows: SheetRow[] }
export interface UploadedBatch { id: string; fileName: string; status: 'uploaded'; previewVersion: number; sheets: ImportSheet[] }

export type Columns = Partial<Record<ImportField, number>>;
export type RowStatus = 'new' | 'match' | 'duplicate' | 'conflict' | 'error';
export type RowDecision = 'create' | 'merge' | 'skip';

interface Matched { id: string; code?: string; name?: string; hostname?: string; version: number; archived_at: string | null }
export interface PreviewRow {
  rowNumber: number;
  data: Partial<Record<ImportField, string>>;
  errors: { column: number; field: ImportField; reason: string }[];
  status: RowStatus;
  reasons: string[];
  duplicateOf: number | null;
  matches: { organization: Matched | null; dataCenter: Matched | null; applications: Matched[]; servers: Matched[]; domain: Matched | null };
  decision: RowDecision;
  result?: { outcome: 'created' | 'merged' | 'skipped' } | null;
}
export interface PreviewResponse { id: string; status: 'previewed'; previewVersion: number; mapping: { sheet: string; headerRow: number; columns: Columns }; rows: PreviewRow[] }
export interface ImportReceipt { id: string; status: 'completed'; previewVersion: number; created: number; merged: number; skipped: number;
  rows: { rowNumber: number; outcome: 'created' | 'merged' | 'skipped'; applicationId?: string; serverId?: string; domainId?: string }[] }

export const rowStatusText: Record<RowStatus, string> = {
  new: 'Dòng mới', match: 'Có bản ghi sẵn có', duplicate: 'Trùng dòng trước', conflict: 'Xung đột', error: 'Lỗi dữ liệu',
};
export const decisionText: Record<RowDecision, string> = { create: 'Tạo mới', merge: 'Gộp với bản ghi sẵn có', skip: 'Bỏ qua' };

/** Decisions the API accepts for a row (docs/IMPORT_API.md, "Dòng xem trước và xử lý trùng"). */
export function allowedDecisions(status: RowStatus): RowDecision[] {
  if (status === 'new') return ['create', 'skip'];
  if (status === 'match') return ['skip', 'merge'];
  return ['skip'];
}

const reasonText: Record<string, string> = {
  'Unknown or archived organizationCode.': 'Mã đơn vị không tồn tại hoặc đã lưu trữ.',
  'Unknown or archived dataCenterCode.': 'Mã trung tâm dữ liệu không tồn tại hoặc đã lưu trữ.',
  'A matching record is archived.': 'Bản ghi đối chiếu đã bị lưu trữ.',
  'Application name matches another code; review the source code before merging.': 'Tên ứng dụng trùng với một mã khác; kiểm tra lại mã trong tệp.',
  'Server code and scoped IP identify different servers.': 'Mã máy chủ và IP kèm phạm vi trỏ tới hai máy chủ khác nhau.',
  'Application code already exists.': 'Mã ứng dụng đã tồn tại.',
  'Server code already exists.': 'Mã máy chủ đã tồn tại.',
  'Private IP and network scope match an existing server; merge preserves its code.': 'IP và phạm vi mạng khớp một máy chủ sẵn có; gộp sẽ giữ mã máy chủ cũ.',
  'Domain already exists.': 'Tên miền đã tồn tại.',
  'Expected an IPv4 or IPv6 address.': 'Cần địa chỉ IPv4 hoặc IPv6 hợp lệ.',
  'Invalid code.': 'Mã không hợp lệ (chỉ chữ, số, dấu chấm, gạch dưới, gạch nối).',
  'Formula or unsupported cell value.': 'Ô chứa công thức hoặc giá trị không hỗ trợ.',
};
/** Vietnamese text for API reasons; unknown reasons are shown as sent. */
export const reasonVi = (reason: string) => reasonText[reason]
  ?? reason.replace(/^Conflicting values within this workbook \(row (\d+)\)\.$/, 'Giá trị mâu thuẫn với dòng $1 trong tệp.');

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases: Record<ImportField, string[]> = {
  organizationCode: ['organization_code', 'ma don vi', 'don vi'],
  dataCenterCode: ['data_center_code', 'ma dc', 'dc'],
  applicationCode: ['application_code', 'ma ung dung'],
  applicationName: ['application_name', 'ten ung dung', 'ung dung'],
  serverCode: ['server_code', 'ma may chu'],
  hostname: ['hostname', 'host', 'ten may chu'],
  networkScope: ['network_scope', 'vung mang'],
  privateIp: ['private_ip', 'ip', 'dia chi ip'],
  domain: ['domain', 'domain_name'],
  serviceType: ['service_type', 'hinh thuc dich vu'],
  renewalDate: ['renewal_date', 'han gia han', 'han ten mien'],
};

/** Guess 1-based column numbers from the header cells, e.g. "application_name" or "Tên ứng dụng". */
export function guessColumns(headers: (string | null)[]): Columns {
  const columns: Columns = {};
  const used = new Set<number>();
  for (const field of Object.keys(importFields) as ImportField[]) {
    const names = [importFields[field], field, ...aliases[field]].map(normalize);
    const index = headers.findIndex((header, position) => header && !used.has(position) && names.includes(normalize(header)));
    if (index >= 0) { columns[field] = index + 1; used.add(index); }
  }
  return columns;
}

/** Excel-style column letter for a 1-based column number. */
export function columnLetter(column: number) {
  let name = '';
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}
