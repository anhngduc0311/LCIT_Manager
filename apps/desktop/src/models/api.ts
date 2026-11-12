export const apiUrl = (process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');

export type Role = 'admin' | 'leader' | 'specialist';
export interface User { id: string; username: string; displayName: string; role: Role }
export interface Session { token: string; expiresAt: string; user: User }
export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
export interface RecordItem { id: string; version: number; [field: string]: unknown }
export type RequestApi = <T>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<T>;

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
};

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function requestApi<T>(path: string, { method = 'GET', body, signal }: Parameters<RequestApi>[1] = {}, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/v1${path}`, {
      method, cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiFailure(0, 'OFFLINE', 'Không kết nối được API. Kiểm tra kết nối rồi thử lại.');
  }
  if (response.status === 204) return undefined as T;
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
