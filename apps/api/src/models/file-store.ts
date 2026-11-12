import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const keyPattern = /^[0-9a-f]{64}$/;
const headBytes = 8192;

export class FileTooLargeError extends Error {}

export interface StoredFile {
  size: number;
  sha256: string;
  head: Buffer;
}

export function attachmentRoot() {
  // An empty value (as in .env.example) means the default folder, not the current directory.
  return resolve(process.env.ATTACHMENTS_DIR?.trim() || join(__dirname, '../../storage/attachments'));
}

/**
 * Private local file store. Keys are random hex strings chosen by the API, never user input,
 * so paths cannot escape the root. Content is written to `<key>.part`, flushed, then linked to
 * its final name, so a crash leaves either no file, a `.part` file or a complete file.
 */
@Injectable()
export class FileStore {
  readonly root = attachmentRoot();

  newKey() {
    return randomBytes(32).toString('hex');
  }

  private path(key: string) {
    if (!keyPattern.test(key)) throw new Error('Invalid storage key.');
    return join(this.root, key.slice(0, 2), key);
  }

  async write(key: string, source: Readable, maxBytes: number): Promise<StoredFile> {
    const target = this.path(key);
    const partial = `${target}.part`;
    await mkdir(join(target, '..'), { recursive: true });
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headLength = 0;
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > maxBytes) return done(new FileTooLargeError());
        hash.update(chunk);
        if (headLength < headBytes) {
          const slice = chunk.subarray(0, headBytes - headLength);
          head.push(slice);
          headLength += slice.length;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(partial, { flags: 'wx', flush: true }));
      // link() fails with EEXIST instead of replacing a complete file the way rename() would.
      await link(partial, target);
    } finally {
      await rm(partial, { force: true });
    }
    return { size, sha256: hash.digest('hex'), head: Buffer.concat(head) };
  }

  /** Opens the file before any response header is sent, so a missing file can still produce an API error. */
  async open(key: string) {
    const path = this.path(key);
    const { size } = await stat(path);
    const stream = createReadStream(path);
    await new Promise<void>((done, fail) => stream.once('open', () => done()).once('error', fail));
    return { stream, size };
  }

  async remove(key: string) {
    const path = this.path(key);
    await rm(path, { force: true });
    await rm(`${path}.part`, { force: true });
  }

  /** Lists stored keys (complete or partial) last modified before `olderThan`. */
  async keysOlderThan(olderThan: Date) {
    const keys = new Set<string>();
    let shards: string[];
    try {
      shards = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    for (const shard of shards.filter((name) => /^[0-9a-f]{2}$/.test(name))) {
      for (const name of await readdir(join(this.root, shard))) {
        const key = name.replace(/\.part$/, '');
        if (!keyPattern.test(key) || key.slice(0, 2) !== shard) continue;
        const { mtime } = await stat(join(this.root, shard, name));
        if (mtime < olderThan) keys.add(key);
      }
    }
    return [...keys];
  }
}

export const attachmentTypes: Record<string, { mediaType: string; signature: (head: Buffer) => boolean }> = (() => {
  const starts = (bytes: number[] | string) => {
    const expected = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Buffer.from(bytes);
    return (head: Buffer) => head.subarray(0, expected.length).equals(expected);
  };
  const zip = starts([0x50, 0x4b, 0x03, 0x04]);
  const ole = starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const plain = (head: Buffer) => !head.includes(0);
  return {
    pdf: { mediaType: 'application/pdf', signature: starts('%PDF-') },
    png: { mediaType: 'image/png', signature: starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    jpg: { mediaType: 'image/jpeg', signature: starts([0xff, 0xd8, 0xff]) },
    jpeg: { mediaType: 'image/jpeg', signature: starts([0xff, 0xd8, 0xff]) },
    docx: { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', signature: zip },
    xlsx: { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', signature: zip },
    pptx: { mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', signature: zip },
    doc: { mediaType: 'application/msword', signature: ole },
    xls: { mediaType: 'application/vnd.ms-excel', signature: ole },
    txt: { mediaType: 'text/plain; charset=utf-8', signature: plain },
    csv: { mediaType: 'text/csv; charset=utf-8', signature: plain },
  };
})();

export function attachmentMaxBytes() {
  const configured = Number(process.env.ATTACHMENT_MAX_BYTES);
  return Number.isInteger(configured) && configured > 0 ? configured : 20 * 1024 * 1024;
}
