import { Role } from '../models/api';
import { Kind } from '../models/catalog';

type Option = [value: string, label: string];
export type Field = { key: string; label: string; type?: 'text' | 'date' | 'number' | 'password' | 'area'; options?: Option[]; source?: Kind; required?: boolean };
const field = (key: string, label: string, required = false): Field => ({ key, label, required });
export const roleNames: Record<Role, string> = { admin: 'Quản trị', leader: 'Lãnh đạo', specialist: 'Chuyên viên' };
const serviceTypes: Option[] = [['ordered', 'Đặt hàng'], ['monitoring', 'Giám sát'], ['operations', 'Quản trị vận hành']];
const codeName = [field('code', 'Mã', true), field('name', 'Tên', true), { key: 'description', label: 'Mô tả', type: 'area' } satisfies Field];
const ownership: Field[] = [
  { key: 'organizationId', label: 'Đơn vị', source: 'organizations', required: true },
  { key: 'ownerId', label: 'Người phụ trách', source: 'users' },
  { key: 'status', label: 'Trạng thái', options: [['active', 'Đang hoạt động'], ['inactive', 'Ngừng hoạt động']] },
];
export const catalogs: Record<Kind, { title: string; fields: Field[] }> = {
  applications: { title: 'Ứng dụng', fields: [...codeName, ...ownership, { key: 'serviceType', label: 'Hình thức dịch vụ', options: serviceTypes, required: true }] },
  servers: { title: 'Máy chủ', fields: [field('code', 'Mã', true), field('hostname', 'Hostname', true),
    { key: 'dataCenterId', label: 'Trung tâm dữ liệu', source: 'data-centers', required: true },
    field('operatingSystem', 'Hệ điều hành'), { key: 'configuration', label: 'Cấu hình', type: 'area' }, { key: 'notes', label: 'Ghi chú', type: 'area' }] },
  domains: { title: 'Tên miền', fields: [field('name', 'Tên miền', true), { key: 'renewalDate', label: 'Hạn gia hạn', type: 'date' }] },
  databases: { title: 'Cơ sở dữ liệu', fields: [...codeName, ...ownership, field('engine', 'Hệ quản trị CSDL', true)] },
  organizations: { title: 'Đơn vị', fields: codeName },
  'data-centers': { title: 'Trung tâm dữ liệu', fields: codeName },
  users: { title: 'Tài khoản', fields: [field('username', 'Tên đăng nhập', true), field('displayName', 'Họ và tên', true),
    { key: 'role', label: 'Vai trò', options: Object.entries(roleNames), required: true },
    { key: 'status', label: 'Trạng thái', options: [['active', 'Hoạt động'], ['locked', 'Đã khóa']] },
    { key: 'password', label: 'Mật khẩu', type: 'password' }] },
};

export const childGroups: Partial<Record<Kind, { path: string; key: string; title: string; fields: Field[] }[]>> = {
  servers: [
    { path: 'addresses', key: 'addresses', title: 'Địa chỉ IP', fields: [field('address', 'Địa chỉ', true), field('networkScope', 'Phạm vi mạng', true),
      { key: 'kind', label: 'Loại', options: [['private', 'Nội bộ'], ['public', 'Công khai'], ['nat', 'NAT']], required: true }] },
    { path: 'access-endpoints', key: 'accessEndpoints', title: 'Điểm truy cập', fields: [
      { key: 'protocol', label: 'Giao thức', options: [['ssh', 'SSH'], ['rdp', 'RDP']], required: true }, field('host', 'Host', true),
      { key: 'port', label: 'Cổng', type: 'number', required: true }] },
  ],
  domains: [
    { path: 'dns-records', key: 'dnsRecords', title: 'Bản ghi DNS', fields: [field('host', 'Host', true),
      { key: 'type', label: 'Loại', options: ['A', 'AAAA', 'CNAME', 'NS', 'PTR', 'MX', 'TXT', 'SRV', 'CAA'].map((value) => [value, value]), required: true },
      field('target', 'Đích', true)] },
    { path: 'tls-endpoints', key: 'tlsEndpoints', title: 'Điểm TLS', fields: [field('host', 'Host', true),
      { key: 'port', label: 'Cổng', type: 'number', required: true }, field('sni', 'SNI'), { key: 'manualExpiryDate', label: 'Hạn nhập tay', type: 'date' }] },
  ],
};
