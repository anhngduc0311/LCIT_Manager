import { Injectable, Logger, OnModuleDestroy, OnModuleInit, StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import { applicationScope, SessionRequest } from './access';
import { ApiError, invalid, missing, paged, PageRow, pagination, requestId, text, uuid } from '../shared/api-contract';
import { AuditEvent, recordAudit } from './audit.service';
import { Database } from './database';
import { attachmentMaxBytes, attachmentTypes, FileStore, FileTooLargeError } from './file-store';
import { holdsPermission } from './permissions.service';

const projection = `a.id, a.application_id AS "applicationId", a.file_name AS "fileName", a.media_type AS "mediaType",
  a.size_bytes::double precision AS "sizeBytes", a.sha256, a.uploaded_by AS "uploadedBy",
  (SELECT u.display_name FROM lcit.users u WHERE u.id = a.uploaded_by) AS "uploadedByName", a.available_at AS "uploadedAt"`;

class UploadRejected extends Error {
  constructor(readonly response: ApiError) { super(); }
}

function tooLarge(): never {
  throw new ApiError(413, 'FILE_TOO_LARGE', `Attachments are limited to ${attachmentMaxBytes()} bytes.`);
}

function unsupported(message = `Allowed file types: ${Object.keys(attachmentTypes).join(', ')}.`): never {
  throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', message);
}

export function fileNameOf(value: unknown) {
  const name = text(value, 'fileName', 255).normalize('NFC');
  // Control characters, path separators and characters Windows rejects in file names.
  if (/[\u0000-\u001f\u007f<>:"/\\|?*]/.test(name) || /^\.+$/.test(name) || /[. ]$/.test(name)) {
    invalid('fileName', 'Use a plain file name without a folder path or reserved characters.');
  }
  const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase();
  const type = extension ? attachmentTypes[extension] : undefined;
  if (!type) unsupported();
  return { name, type };
}

/** RFC 6266 header with an ASCII fallback and the exact UTF-8 name. */
export function contentDisposition(name: string) {
  const fallback = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** The rest of a rejected body is not read; closing the connection avoids draining up to the client's size. */
function closeAfterResponse(request: SessionRequest) {
  (request as unknown as { res?: { setHeader(name: string, value: string): void } }).res?.setHeader('Connection', 'close');
}

function pendingTtlMs() {
  const minutes = Number(process.env.ATTACHMENT_PENDING_TTL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
}

@Injectable()
export class AttachmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentsService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: Database, private readonly store: FileStore) {}

  onModuleInit() {
    if (!process.env.DATABASE_URL || process.env.ATTACHMENT_CLEANUP === 'off') return;
    this.timer = setInterval(() => {
      this.cleanup().catch(() => this.logger.warn('Attachment cleanup failed; it will retry on the next run.'));
    }, 15 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async list(request: SessionRequest, rawApplication: unknown, rawPage: unknown, rawSize: unknown) {
    const { actor } = request;
    const applicationId = uuid(rawApplication, 'applicationId');
    const { page, pageSize, offset } = pagination(rawPage, rawSize);
    const { rows: [row] } = await this.db.query<PageRow & { visible: boolean; canDownload: boolean }>(`
      WITH app AS (SELECT app.id FROM lcit.applications app
        WHERE app.id = $2 AND app.archived_at IS NULL AND ${applicationScope(actor.role, 'app', '$1')}),
      data AS (SELECT ${projection} FROM lcit.attachments a
        WHERE a.application_id IN (SELECT id FROM app) AND a.status = 'available' AND a.archived_at IS NULL),
      slice AS (SELECT * FROM data ORDER BY "uploadedAt" DESC, id LIMIT $3 OFFSET $4)
      SELECT EXISTS (SELECT 1 FROM app) AS visible, ${holdsPermission('attachments.download', '$1', '$5')} AS "canDownload",
        (SELECT count(*) FROM data) AS total,
        COALESCE((SELECT json_agg(slice ORDER BY "uploadedAt" DESC, id) FROM slice), '[]') AS items
    `, [actor.id, applicationId, pageSize, offset, actor.role === 'admin']);
    if (!row.visible) missing();
    return { ...paged(row, page, pageSize), canUpload: actor.role !== 'leader', canDownload: row.canDownload };
  }

  /**
   * Streams the raw request body (application/octet-stream) into the file store.
   * Step 1 records a pending row with a random storage key; step 2 writes and flushes the content;
   * step 3 marks the row available and records the audit event in one transaction.
   * A failure between steps leaves a pending row and possibly a file, which `cleanup` removes.
   */
  async upload(request: SessionRequest, rawApplication: unknown, rawName: unknown) {
    const { actor } = request;
    if (actor.role === 'leader') throw new ApiError(403, 'FORBIDDEN', 'Only administrators and assigned specialists can upload attachments.');
    const applicationId = uuid(rawApplication, 'applicationId');
    const { name, type } = fileNameOf(rawName);
    const headers = request.headers as Record<string, string | undefined>;
    if (!/^application\/octet-stream\s*(?:;|$)/i.test(headers['content-type'] ?? '')) {
      unsupported('Send the file content as application/octet-stream.');
    }
    const maxBytes = attachmentMaxBytes();
    if (Number(headers['content-length']) > maxBytes) {
      closeAfterResponse(request);
      tooLarge();
    }

    const key = this.store.newKey();
    const { rows: [pending] } = await this.db.query<{ id: string }>(`
      INSERT INTO lcit.attachments (application_id, storage_key, file_name, media_type, uploaded_by)
      SELECT app.id, $3, $4, $5, $1 FROM lcit.applications app
      WHERE app.id = $2 AND app.archived_at IS NULL AND ${applicationScope(actor.role, 'app', '$1')}
      RETURNING id
    `, [actor.id, applicationId, key, name, type.mediaType]);
    if (!pending) missing();

    try {
      let stored;
      try {
        stored = await this.store.write(key, request as unknown as Readable, maxBytes);
      } catch (error) {
        if (error instanceof FileTooLargeError) throw new UploadRejected(new ApiError(413, 'FILE_TOO_LARGE', `Attachments are limited to ${maxBytes} bytes.`));
        throw new UploadRejected(new ApiError(400, 'UPLOAD_INCOMPLETE', 'The upload did not complete. Try again.'));
      }
      if (stored.size === 0) throw new UploadRejected(new ApiError(400, 'EMPTY_FILE', 'The file is empty.'));
      if (!type.signature(stored.head)) {
        throw new UploadRejected(new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'The file content does not match its extension.'));
      }
      return await this.db.transaction(async (client) => {
        // Re-check scope: an assignment revoked during the upload must not publish the file.
        const { rows: [item] } = await client.query(`
          UPDATE lcit.attachments a SET status = 'available', size_bytes = $3, sha256 = $4, available_at = now()
          FROM lcit.applications app
          WHERE a.id = $2 AND a.status = 'pending' AND app.id = a.application_id AND app.archived_at IS NULL
            AND ${applicationScope(actor.role, 'app', '$1')}
          RETURNING ${projection}
        `, [actor.id, pending.id, stored.size, stored.sha256]);
        if (!item) missing();
        await recordAudit(client, {
          actorId: actor.id, action: 'attachment.upload', targetType: 'attachments', targetId: item.id,
          relatedId: applicationId, requestId: requestId(request),
        });
        return item;
      });
    } catch (error) {
      await this.discard(pending.id, key);
      if (error instanceof UploadRejected) {
        closeAfterResponse(request);
        throw error.response;
      }
      throw error;
    }
  }

  /** Best effort: if the database or disk is unavailable now, `cleanup` handles the leftovers later. */
  private async discard(id: string, key: string) {
    try {
      const { rowCount } = await this.db.query("DELETE FROM lcit.attachments WHERE id = $1 AND status = 'pending'", [id]);
      if (rowCount) await this.store.remove(key);
    } catch {
      this.logger.warn('Could not discard an incomplete attachment; cleanup will remove it.');
    }
  }

  async download(request: SessionRequest, rawId: string) {
    const { actor } = request;
    const id = uuid(rawId);
    const { rows: [row] } = await this.db.query<{
      applicationId: string; storageKey: string; fileName: string; mediaType: string; allowed: boolean;
    }>(`
      SELECT a.application_id AS "applicationId", a.storage_key AS "storageKey", a.file_name AS "fileName",
        a.media_type AS "mediaType", ${holdsPermission('attachments.download', '$1', '$3')} AS allowed
      FROM lcit.attachments a JOIN lcit.applications app ON app.id = a.application_id AND app.archived_at IS NULL
      WHERE a.id = $2 AND a.status = 'available' AND a.archived_at IS NULL AND ${applicationScope(actor.role, 'app', '$1')}
    `, [actor.id, id, actor.role === 'admin']);
    if (!row) missing();
    const event: AuditEvent = {
      actorId: actor.id, action: 'attachment.download', targetType: 'attachments', targetId: id,
      relatedId: row.applicationId, requestId: requestId(request),
    };
    if (!row.allowed) {
      await this.db.transaction((client) => recordAudit(client, { ...event, outcome: 'denied' }));
      throw new ApiError(403, 'DOWNLOAD_NOT_PERMITTED', 'Downloading attachments requires a grant from an administrator.');
    }
    let file;
    try {
      file = await this.store.open(row.storageKey);
    } catch {
      this.logger.error(`Attachment ${id} is missing from the file store.`);
      throw new ApiError(503, 'FILE_UNAVAILABLE', 'The file is temporarily unavailable.');
    }
    try {
      await this.db.transaction((client) => recordAudit(client, event));
    } catch (error) {
      file.stream.destroy();
      throw error;
    }
    return new StreamableFile(file.stream, { type: row.mediaType, length: file.size, disposition: contentDisposition(row.fileName) });
  }

  async archive(request: SessionRequest, rawId: string) {
    const { actor } = request;
    if (actor.role === 'leader') throw new ApiError(403, 'FORBIDDEN', 'Only administrators and assigned specialists can remove attachments.');
    const id = uuid(rawId);
    await this.db.transaction(async (client) => {
      const { rows: [row] } = await client.query<{ applicationId: string }>(`
        UPDATE lcit.attachments a SET archived_at = now() FROM lcit.applications app
        WHERE a.id = $2 AND a.status = 'available' AND a.archived_at IS NULL
          AND app.id = a.application_id AND app.archived_at IS NULL AND ${applicationScope(actor.role, 'app', '$1')}
        RETURNING a.application_id AS "applicationId"
      `, [actor.id, id]);
      if (!row) missing();
      await recordAudit(client, {
        actorId: actor.id, action: 'attachment.archive', targetType: 'attachments', targetId: id,
        relatedId: row.applicationId, requestId: requestId(request),
      });
    });
  }

  /**
   * Removes pending rows older than the TTL with their content, then files that no row references
   * (left behind when the process stopped between steps). Archived files are kept for restore.
   */
  async cleanup(now = new Date()) {
    const cutoff = new Date(now.getTime() - pendingTtlMs());
    const { rows: expired } = await this.db.query<{ storage_key: string }>(
      "DELETE FROM lcit.attachments WHERE status = 'pending' AND created_at < $1 RETURNING storage_key", [cutoff],
    );
    for (const { storage_key: key } of expired) await this.store.remove(key);

    let orphanFiles = 0;
    const keys = await this.store.keysOlderThan(cutoff);
    for (let start = 0; start < keys.length; start += 500) {
      const batch = keys.slice(start, start + 500);
      const { rows } = await this.db.query<{ storage_key: string }>(
        'SELECT storage_key FROM lcit.attachments WHERE storage_key = ANY($1)', [batch],
      );
      const known = new Set(rows.map((item) => item.storage_key));
      for (const key of batch.filter((item) => !known.has(item))) {
        await this.store.remove(key);
        orphanFiles += 1;
      }
    }
    return { expiredPending: expired.length, orphanFiles };
  }
}
