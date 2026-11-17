/**
 * Types for the SSH/RDP API of T4.1 (person A). Contract: docs/ACCESS_API.md.
 *   GET    /servers/{id}/access-endpoints              -> Page<AccessEndpoint>  (specialists see only granted ones; leaders get 403)
 *   POST   /access-endpoints/{id}/launch               -> AccessLaunchResponse  (checks the grant, audits, returns the saved destination)
 *   GET    /users/{id}/access-endpoints                -> Page<AccessGrant>     (administrator)
 *   PUT    /users/{id}/access-endpoints/{endpointId}   -> 204                   (grant the current saved configuration)
 *   DELETE /users/{id}/access-endpoints/{endpointId}   -> 204
 * The launch response is the only source of protocol, host and port for a connection. Opening the client is the
 * SSH uses `ssh_open` with a native PTY and xterm.js; RDP uses `launch_access`.
 */
export type AccessProtocol = 'ssh' | 'rdp';

export interface AccessEndpoint { id: string; serverId: string; protocol: AccessProtocol; host: string; port: number; canLaunch: boolean }
export interface AccessLaunchResponse {
  authorizationId: string; endpointId: string; serverId: string; protocol: AccessProtocol; host: string; port: number; authorizedAt: string;
}
export interface AccessGrant {
  endpointId: string; serverId: string; protocol: AccessProtocol; host: string; port: number; grantedBy: string; grantedAt: string;
  /** False when the endpoint changed after the grant; the administrator must grant it again. */
  isCurrent: boolean;
}

export type LaunchStatus = 'started' | 'exited_early' | 'client_missing' | 'spawn_failed' | 'invalid';
/** Result of the Tauri command, see `LaunchOutcome` in launch.rs. */
export interface LaunchOutcome { status: LaunchStatus; protocol: string; detail: string; exitCode: number | null; pid: number | null }

export const protocolName: Record<AccessProtocol, string> = { ssh: 'SSH', rdp: 'RDP' };

export interface LaunchReport {
  tone: 'ok' | 'warn' | 'error';
  text: string;
  /** First characters of the authorization ID; the full value is in the audit log and in launch.log. */
  reference?: string;
}

/** User-facing sentence for what was observed when the client was started (never claims the sign-in worked). */
export function describeOutcome(outcome: LaunchOutcome, target: { protocol: AccessProtocol; host: string; port: number }): Omit<LaunchReport, 'reference'> {
  const where = `${target.host}:${target.port}`;
  const client = target.protocol === 'ssh' ? 'SSH' : 'Remote Desktop';
  const network = 'Kiểm tra VPN hoặc mạng, địa chỉ, cổng và máy đích đã chạy dịch vụ.';
  switch (outcome.status) {
    case 'started':
      return { tone: target.protocol === 'ssh' ? 'warn' : 'ok', text: target.protocol === 'ssh'
        ? `Đã mở SSH tới ${where}; đang chờ kết nối hoặc đăng nhập. Nếu chưa có phản hồi, SSH chờ tối đa 10 giây để kết nối. ${network}`
        : `Đã mở Remote Desktop tới ${where}. Nhập tài khoản trong cửa sổ Remote Desktop. Nếu không kết nối được, ${network.toLowerCase()}` };
    case 'exited_early':
      return { tone: 'error', text: `${client} đã đóng ngay sau khi mở (mã ${outcome.exitCode ?? '?'}), nhiều khả năng không kết nối được tới ${where}. ${network}` };
    case 'client_missing':
      return { tone: 'error', text: target.protocol === 'ssh'
        ? 'Máy này chưa có trình khách OpenSSH. Cài tại Cài đặt → Ứng dụng → Tính năng tùy chọn → OpenSSH Client, rồi thử lại.'
        : 'Không tìm thấy mstsc.exe (Remote Desktop Connection) trong thư mục hệ thống của Windows.' };
    case 'spawn_failed':
      return { tone: 'error', text: `Windows không mở được ${client}: ${outcome.detail}` };
    case 'invalid':
      return { tone: 'error', text: `Thông tin kết nối không hợp lệ (${outcome.detail}). Báo Quản trị kiểm tra điểm truy cập.` };
  }
}
