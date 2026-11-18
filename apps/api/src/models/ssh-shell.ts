import type { Client, ClientChannel } from 'ssh2';
import { ApiError } from '../shared/api-contract';

const OUTPUT_LIMIT = 256 * 1024;

export class SshShell {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private ended = false;
  private reading?: () => void;

  private constructor(private readonly channel: ClientChannel, private readonly activity: () => void) {
    channel.on('data', (data: Buffer) => this.receive(data));
    channel.stderr.on('data', (data: Buffer) => this.receive(data));
    channel.on('error', () => this.close());
    channel.stderr.on('error', () => this.close());
    channel.on('close', () => { this.ended = true; this.reading?.(); });
  }

  static open(client: Client, cols: number, rows: number, activity: () => void) {
    return new Promise<SshShell>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new ApiError(504, 'SSH_SHELL_TIMEOUT', 'The terminal did not start in time.')); }, 8000);
      client.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => {
        clearTimeout(timer);
        if (error || !channel) { reject(new ApiError(502, 'SSH_SHELL_FAILED', 'The server did not open a terminal.')); return; }
        const shell = new SshShell(channel, activity);
        if (expired) shell.close();
        else resolve(shell);
      });
    });
  }

  private receive(data: Buffer) {
    if (this.ended || data.length === 0) return;
    this.chunks.push(data);
    this.bytes += data.length;
    if (this.bytes >= OUTPUT_LIMIT) { this.channel.pause(); this.channel.stderr.pause(); }
    this.reading?.();
  }

  async read() {
    if (this.reading) throw new ApiError(409, 'SSH_SHELL_BUSY', 'Terminal output is already being read.');
    if (!this.bytes && !this.ended) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.reading?.(), 2000);
      this.reading = () => { clearTimeout(timer); this.reading = undefined; resolve(); };
    });
    const data = Buffer.concat(this.chunks, this.bytes).toString('base64');
    if (this.bytes) this.activity();
    this.chunks.length = 0;
    this.bytes = 0;
    if (!this.ended) { this.channel.resume(); this.channel.stderr.resume(); }
    return { data, ended: this.ended };
  }

  write(data: string, cols?: number, rows?: number) {
    if (this.ended) throw new ApiError(409, 'SSH_SHELL_CLOSED', 'The terminal has ended.');
    if (cols !== undefined && rows !== undefined) this.channel.setWindow(rows, cols, 0, 0);
    if (data) {
      if (this.channel.writableLength >= 64 * 1024) throw new ApiError(409, 'SSH_SHELL_BUSY', 'Wait for the terminal to process its input.');
      this.channel.write(data);
      this.activity();
    }
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    this.reading?.();
    this.channel.close();
  }
}
