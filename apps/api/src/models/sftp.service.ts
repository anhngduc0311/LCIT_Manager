import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Client } from 'ssh2';
import SftpClient from 'ssh2-sftp-client';
import { SessionRequest } from './access';
import { AccessLaunchService } from './access-launch.service';
import { ApiError, bodyOf, invalid, text, uuid } from '../shared/api-contract';

export const SFTP_MAX_BYTES = 20 * 1024 * 1024;
const IDLE_MS = 5 * 60_000;
// The upstream runtime exposes the SSH client; DefinitelyTyped omits this field.
class ManagedSftpClient extends SftpClient { declare client: Client; }
interface Connection {
  client: ManagedSftpClient; actor: string; session: string; endpoint: string;
  host: string; port: number; used: number; created: number; busy: boolean;
}

export function remotePath(value: unknown): string {
  const path = text(value, 'path', 4096);
  if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)) invalid('path', 'Use an absolute remote path.');
  return posix.normalize(path);
}

@Injectable()
export class SftpService implements OnModuleDestroy {
  private readonly connections = new Map<string, Connection>();
  private opening = 0;
  private readonly timer = setInterval(() => {
    for (const [id, entry] of this.connections) {
      if (!entry.busy && (Date.now() - entry.used > IDLE_MS || Date.now() - entry.created > 60 * 60_000)) void this.dispose(id);
    }
  }, 30_000).unref();

  constructor(private readonly access: AccessLaunchService) {}

  async onModuleDestroy() {
    clearInterval(this.timer);
    await Promise.all([...this.connections.keys()].map((id) => this.dispose(id)));
  }

  private async end(client: ManagedSftpClient) {
    // Destroying the underlying SSH socket also releases an unresponsive transfer.
    client.client.destroy();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([client.end().catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
    clearTimeout(timer);
  }

  private async dispose(id: string) {
    const entry = this.connections.get(id);
    this.connections.delete(id);
    if (entry) await this.end(entry.client);
  }

  async open(request: SessionRequest, rawEndpoint: unknown, input: unknown) {
    const body = bodyOf(input, ['username', 'password', 'fingerprint']);
    const username = text(body.username, 'username', 128);
    if (typeof body.password !== 'string' || body.password.length > 4096) invalid('password', 'Expected a password.');
    const password = body.password;
    const fingerprint = body.fingerprint === undefined ? undefined : text(body.fingerprint, 'fingerprint', 100);
    if (fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) invalid('fingerprint', 'Expected an OpenSSH SHA256 fingerprint.');
    const target = await this.access.launch(request, rawEndpoint, {});
    if (target.protocol !== 'ssh') throw new ApiError(400, 'SFTP_SSH_REQUIRED', 'Choose an SSH endpoint.');
    if (this.opening + this.connections.size >= 32) throw new ApiError(429, 'SFTP_LIMIT', 'Too many SFTP connections.');
    this.opening++;
    // No library debug output: errors may contain server paths or usernames.
    const client = new ManagedSftpClient('lcit-sftp', { error: () => {}, end: () => {}, close: () => {} });
    let observed: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let authenticated = false, sftpReady = false, timedOut = false;
    let interactiveAnswered = false, additionalPrompt = false;
    client.client.once('ready', () => { authenticated = true; });
    client.client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
      if (prompts.length === 0) { finish([]); return; }
      // Only supply the password to one hidden password prompt, never an OTP or other challenge.
      if (!interactiveAnswered && prompts.length === 1 && !prompts[0].echo && /password|mật\s*khẩu/i.test(prompts[0].prompt) &&
          !/otp|one[ -]?time|verification|token|authenticator|code/i.test(prompts[0].prompt)) {
        interactiveAnswered = true;
        finish([password]);
      } else {
        additionalPrompt = true;
        finish(prompts.map(() => ''));
      }
    });
    try {
      const path = await Promise.race([(async () => {
        await client.connect({ host: target.host, port: target.port, username, password,
          readyTimeout: 8000, keepaliveInterval: 15_000, keepaliveCountMax: 2, tryKeyboard: true,
          hostVerifier: (key: Buffer) => {
            observed = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
            return fingerprint !== undefined && observed === fingerprint;
          },
        });
        sftpReady = true;
        return client.cwd();
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('SFTP connect timeout')); }, 10_000); })]);
      const id = randomUUID();
      this.connections.set(id, { client, actor: request.actor.id, session: request.sessionHash, endpoint: target.endpointId,
        host: target.host, port: target.port, used: Date.now(), created: Date.now(), busy: false });
      return { id, path, host: target.host, port: target.port, fingerprint: observed, requiresVerification: false };
    } catch (error) {
      await this.end(client);
      if (observed && !fingerprint) return { requiresVerification: true, fingerprint: observed, host: target.host, port: target.port };
      if (observed && fingerprint !== observed) throw new ApiError(409, 'SFTP_HOST_KEY_CHANGED', 'The server host key does not match.');
      if (additionalPrompt) throw new ApiError(502, 'SFTP_INTERACTIVE_REQUIRED', 'Additional interactive authentication is required.');
      if (timedOut || /timed out|timeout/i.test(error instanceof Error ? error.message : '')) throw new ApiError(504, 'SFTP_CONNECT_TIMEOUT', 'SFTP connection timed out.');
      if (sftpReady) throw new ApiError(502, 'SFTP_HOME_UNAVAILABLE', 'SFTP connected but the initial directory could not be read.');
      if (authenticated) throw new ApiError(502, 'SFTP_SUBSYSTEM_FAILED', 'SSH authenticated but the SFTP subsystem could not be opened.');
      if (/authentication methods failed|authentication failed/i.test(error instanceof Error ? error.message : '')) throw new ApiError(502, 'SFTP_AUTH_FAILED', 'SSH authentication was rejected.');
      throw new ApiError(502, 'SFTP_CONNECT_FAILED', 'Could not establish SFTP. Check credentials, network and the SFTP subsystem.');
    } finally { clearTimeout(timer); this.opening--; }
  }

  private owned(request: SessionRequest, rawId: unknown) {
    const id = uuid(rawId);
    const entry = this.connections.get(id);
    if (!entry || entry.actor !== request.actor.id || entry.session !== request.sessionHash) throw new ApiError(404, 'SFTP_SESSION_CLOSED', 'SFTP session closed.');
    return { id, entry };
  }

  private async run<T>(request: SessionRequest, rawId: unknown, action: (client: SftpClient) => Promise<T>) {
    const { id, entry } = this.owned(request, rawId);
    if (entry.busy) throw new ApiError(409, 'SFTP_BUSY', 'An operation is already running.');
    entry.busy = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (Date.now() - entry.used > IDLE_MS || Date.now() - entry.created > 60 * 60_000) {
        await this.dispose(id); throw new ApiError(404, 'SFTP_SESSION_CLOSED', 'SFTP session expired.');
      }
      // Recheck the live account, session, scope and exact granted destination for every operation.
      const target = await this.access.launch(request, entry.endpoint, {});
      if (target.protocol !== 'ssh' || target.host !== entry.host || target.port !== entry.port) {
        throw new ApiError(403, 'CONNECTION_GRANT_REQUIRED', 'The endpoint changed.');
      }
      return await Promise.race([action(entry.client), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(504, 'SFTP_TIMEOUT', 'SFTP operation timed out.')), 90_000);
      })]);
    } catch (error) {
      await this.dispose(id);
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'SFTP_OPERATION_FAILED', 'SFTP operation failed. Check remote permissions and reconnect.');
    } finally { clearTimeout(timer); entry.busy = false; entry.used = Date.now(); }
  }

  list(request: SessionRequest, id: unknown, rawPath: unknown) {
    const path = remotePath(rawPath);
    return this.run(request, id, async (client) => {
      const items = await client.list(path);
      return { path, items: items.map(({ name, type, size, modifyTime }) => ({ name, type, size, modifyTime })) };
    });
  }

  upload(request: SessionRequest, id: unknown, rawPath: unknown, bytes: Buffer) {
    const path = remotePath(rawPath);
    if (bytes.length > SFTP_MAX_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'Maximum 20 MiB.');
    return this.run(request, id, async (client) => {
      // Exclusive create prevents accidental overwrites, including through symlinks.
      await pipeline(Readable.from(bytes), client.createWriteStream(path, { flags: 'wx' }));
      return { path, size: bytes.length };
    });
  }

  download(request: SessionRequest, id: unknown, rawPath: unknown) {
    const path = remotePath(rawPath);
    return this.run(request, id, async (client) => {
      const stat = await client.stat(path);
      if (!stat.isFile) throw new ApiError(400, 'SFTP_FILE_REQUIRED', 'Choose a regular file.');
      if (stat.size > SFTP_MAX_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'Maximum 20 MiB.');
      const chunks: Buffer[] = []; let size = 0;
      const sink = new Writable({ write(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > SFTP_MAX_BYTES) { done(new ApiError(413, 'FILE_TOO_LARGE', 'Maximum 20 MiB.')); return; }
        chunks.push(Buffer.from(chunk)); done();
      } });
      await pipeline(client.createReadStream(path), sink);
      return { bytes: Buffer.concat(chunks), name: posix.basename(path) };
    });
  }

  async close(request: SessionRequest, rawId: unknown) {
    const { id } = this.owned(request, rawId);
    await this.dispose(id);
  }
}
