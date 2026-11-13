import { Injectable } from '@nestjs/common';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkServerIdentity, connect, ConnectionOptions } from 'node:tls';
import { allowedAddress, allowedHost, networkMonitorConfig } from './network-monitor-config';

export interface ProbeTarget { type: 'dns' | 'tls'; host: string; recordType?: string; target?: string; port?: number; sni?: string }
export interface ProbeResult {
  status: 'success' | 'dns_error' | 'timeout' | 'tls_error' | 'expired' | 'blocked';
  addresses: string[]; observedExpiryAt: string | null; errorCode: string | null;
}
export const probeFailure = (status: ProbeResult['status'], errorCode: string, addresses: string[] = []): ProbeResult =>
  ({ status, errorCode, addresses, observedExpiryAt: null });

@Injectable()
export class NetworkProbe {
  readonly config = networkMonitorConfig();
  protected createResolver() { return new Resolver({ timeout: this.config.timeoutMs, tries: 1 }); }
  protected openTls(options: ConnectionOptions) { return connect(options); }

  async check(target: ProbeTarget): Promise<ProbeResult> {
    if (target.type === 'dns' && !['A','AAAA','CNAME','NS','PTR','MX','TXT','SRV','CAA'].includes(target.recordType!)) return probeFailure('blocked', 'DNS_TYPE_NOT_SUPPORTED');
    if (!allowedHost(target.host, this.config)) return probeFailure('blocked', 'HOST_NOT_ALLOWED');
    if (target.type === 'tls' && (!this.config.ports.includes(target.port!) ||
      (target.sni && !allowedHost(target.sni, this.config)))) return probeFailure('blocked', 'TLS_TARGET_NOT_ALLOWED');
    if (target.host.startsWith('*.')) return probeFailure('blocked', 'WILDCARD_NOT_PROBEABLE');
    const resolver = this.createResolver();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ProbeResult>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolver.cancel(); resolve(probeFailure('timeout', 'CHECK_TIMEOUT')); }, this.config.timeoutMs);
    });
    let cancelSocket: (() => void) | undefined;
    let phase: 'dns' | 'tls' = 'dns';
    const work = (async (): Promise<ProbeResult> => {
      try {
        if (target.type === 'dns') {
          const answers = await resolver.resolve(target.host, target.recordType!);
          if (!Array.isArray(answers) || !answers.length) return probeFailure('dns_error', 'DNS_NO_ANSWER');
          const addresses = ['A', 'AAAA'].includes(target.recordType!) ? answers as string[] : [];
          if (addresses.some((ip) => !allowedAddress(ip, this.config))) return probeFailure('blocked', 'ADDRESS_NOT_ALLOWED', addresses);
          return { status: 'success', addresses, observedExpiryAt: null, errorCode: null };
        }
        let addresses: string[];
        if (isIP(target.host)) addresses = [target.host];
        else {
          const resolved = await Promise.allSettled([resolver.resolve4(target.host), resolver.resolve6(target.host)]);
          addresses = resolved.flatMap((entry) => entry.status === 'fulfilled' ? entry.value : []);
          if (!addresses.length) {
            const hasTimeout = resolved.some((entry) => entry.status === 'rejected' && entry.reason?.code === 'ETIMEOUT');
            return probeFailure(hasTimeout ? 'timeout' : 'dns_error', hasTimeout ? 'DNS_TIMEOUT' : 'DNS_LOOKUP_FAILED');
          }
        }
        if (timedOut) return probeFailure('timeout', 'CHECK_TIMEOUT');
        // Validate the entire answer set and pin the connection to a validated literal IP. No second DNS lookup.
        if (addresses.some((ip) => !allowedAddress(ip, this.config))) return probeFailure('blocked', 'ADDRESS_NOT_ALLOWED', addresses);
        phase = 'tls';
        return await new Promise<ProbeResult>((resolve) => {
          const identity = target.sni || target.host;
          const socket = this.openTls({ host: addresses[0], port: target.port,
            servername: isIP(identity) ? undefined : identity, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
          let settled = false;
          const finish = (result: ProbeResult) => {
            if (settled) return;
            settled = true;
            resolve(result);
            socket.destroy();
          };
          cancelSocket = () => finish(probeFailure('timeout', 'CHECK_TIMEOUT', addresses));
          socket.once('error', () => finish(probeFailure('tls_error', 'TLS_CONNECTION_FAILED', addresses)));
          socket.once('close', () => finish(probeFailure('tls_error', 'TLS_CONNECTION_CLOSED', addresses)));
          socket.once('secureConnect', () => {
            const certificate = socket.getPeerCertificate();
            if (!certificate?.raw || checkServerIdentity(identity, certificate)) return finish(probeFailure('tls_error', 'TLS_IDENTITY_INVALID', addresses));
            const expiry = new Date(certificate.valid_to);
            if (!Number.isFinite(expiry.getTime())) return finish(probeFailure('tls_error', 'TLS_CERTIFICATE_INVALID', addresses));
            const expired = expiry.getTime() < Date.now();
            if (!socket.authorized && !(expired && String(socket.authorizationError) === 'CERT_HAS_EXPIRED')) {
              return finish(probeFailure('tls_error', 'TLS_UNTRUSTED', addresses));
            }
            finish({ status: expired ? 'expired' : 'success', addresses, observedExpiryAt: expiry.toISOString(), errorCode: expired ? 'CERT_HAS_EXPIRED' : null });
          });
        });
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (phase === 'tls') return probeFailure('tls_error', 'TLS_CONNECTION_FAILED');
        return probeFailure(code === 'ETIMEOUT' || timedOut ? 'timeout' : 'dns_error', code === 'ETIMEOUT' || timedOut ? 'DNS_TIMEOUT' : 'DNS_LOOKUP_FAILED');
      }
    })();
    try { return await Promise.race([work, timeout]); }
    finally { clearTimeout(timer); resolver.cancel(); cancelSocket?.(); }
  }
}
