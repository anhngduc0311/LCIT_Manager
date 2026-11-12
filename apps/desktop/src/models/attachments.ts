import { Page } from './api';

export interface Attachment {
  id: string; applicationId: string; fileName: string; mediaType: string; sizeBytes: number;
  sha256: string; uploadedBy: string; uploadedByName: string | null; uploadedAt: string;
}
export interface AttachmentPage extends Page<Attachment> { canUpload: boolean; canDownload: boolean }

export const permissionLabels = {
  'attachments.download': 'Tải tệp đính kèm',
  'reports.export': 'Xuất báo cáo',
} as const;
export type Permission = keyof typeof permissionLabels;

export const acceptedFileTypes = '.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx,.doc,.xls,.txt,.csv';
export const maxAttachmentBytes = 20 * 1024 * 1024;

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
