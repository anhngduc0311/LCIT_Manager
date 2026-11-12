export const apiUrl = (process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');

export type Role = 'admin' | 'leader' | 'specialist';
export interface User { id: string; username: string; displayName: string; role: Role }
export interface Session { token: string; expiresAt: string; user: User }
export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
export interface RecordItem { id: string; version: number; [field: string]: unknown }
export interface RequestOptions {
  method?: string; body?: unknown; signal?: AbortSignal;
  /** Sent as the raw application/octet-stream body. */
  file?: Blob;
  /** Return the response body as a file instead of JSON. */
  binary?: boolean;
}
export type RequestApi = <T>(path: string, options?: RequestOptions) => Promise<T>;
export interface DownloadedFile { blob: Blob; fileName: string }

const messages: Record<string, string> = {
  INVALID_SESSION: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.',
  INVALID_CREDENTIALS: 'Tên đăng nhập hoặc mật khẩu không đúng, hoặc tài khoản đã bị khóa.',
  LOGIN_RATE_LIMITED: 'Bạn đã thử đăng nhập quá nhiều lần. Hãy thử lại sau.',
  DATABASE_UNAVAILABLE: 'Cơ sở dữ liệu chưa sẵn sàng.',
  FORBIDDEN: 'Tài khoản của bạn không có quyền thực hiện thao tác này.',
  FORBIDDEN_FIELDS: 'Các trường này cần quyền Quản trị.',
  NOT_FOUND: 'Không tìm thấy dữ liệu trong phạm vi được cấp.',
  DUPLICATE: 'Dữ liệu bị trùng. Kiểm tra mã hoặc giá trị đã nhập.',
  STALE_VERSION: 'Dữ liệu đã thay đổi. Hãy tải lại rồi thử lại.',
  CONCURRENT_UPDATE: 'Có thay đổi đồng thời. Hãy tải lại rồi thử lại.',
  DNS_RECORD_LINKED: 'Gỡ liên kết bản ghi DNS khỏi ứng dụng trước khi xóa.',
  INVALID_REFERENCE: 'Dữ liệu tham chiếu không còn hợp lệ. Hãy tải lại rồi chọn lại.',
  ASSIGNMENT_ROLE: 'Vai trò tài khoản không phù hợp với loại phân công này.',
  SELF_DELETE: 'Bạn không thể xóa tài khoản đang đăng nhập.',
  FILE_TOO_LARGE: 'Tệp vượt quá dung lượng cho phép (20 MiB).',
  UNSUPPORTED_FILE_TYPE: 'Định dạng tệp không được hỗ trợ hoặc nội dung không khớp phần mở rộng.',
  EMPTY_FILE: 'Tệp rỗng.',
  UPLOAD_INCOMPLETE: 'Tải lên bị gián đoạn. Hãy thử lại.',
  DOWNLOAD_NOT_PERMITTED: 'Bạn chưa được Quản trị cấp quyền tải tệp.',
  FILE_UNAVAILABLE: 'Tệp tạm thời không khả dụng. Hãy báo Quản trị.',
};

/** Reads the UTF-8 name from `filename*` (RFC 6266), falling back to the ASCII `filename`. */
function fileNameFrom(header: string | null) {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) { try { return decodeURIComponent(encoded); } catch { /* use fallback */ } }
  return header?.match(/filename="([^"]+)"/i)?.[1] ?? 'tep-dinh-kem';
}

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function requestApi<T>(path: string, { method = 'GET', body, signal, file, binary }: RequestOptions = {}, token?: string): Promise<T> {
  let response: Response;
  // Files may be up to 20 MiB, so they get a longer timeout than JSON requests.
  const timeout = AbortSignal.timeout(file || binary ? 120_000 : 12_000);
  try {
    response = await fetch(`${apiUrl}/api/v1${path}`, {
      method: file ? 'POST' : method, cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(file ? { 'Content-Type': 'application/octet-stream' } : body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiFailure(0, 'OFFLINE', 'Không kết nối được API. Kiểm tra kết nối rồi thử lại.');
  }
  if (response.status === 204) return undefined as T;
  if (binary && response.ok) {
    return { blob: await response.blob(), fileName: fileNameFrom(response.headers.get('Content-Disposition')) } as T;
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.code ?? '';
    const field = payload?.fields ? Object.keys(payload.fields)[0] : undefined;
    throw new ApiFailure(response.status, code, messages[code] ?? (field ? `Giá trị không hợp lệ (${field}).` : `Yêu cầu không thành công (HTTP ${response.status}).`));
  }
  return payload as T;
}

export async function checkHealth(signal: AbortSignal) {
  const response = await fetch(`${apiUrl}/health/ready`, {
    cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  const body = await response.json();
  return response.ok && body.database === 'up' ? 'ready' : response.status === 503 ? 'unavailable' : 'offline';
}
