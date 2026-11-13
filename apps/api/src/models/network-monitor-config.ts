import ipaddr from 'ipaddr.js';
import { isIP } from 'node:net';
import { dnsName } from './network-input';

export function networkMonitorConfig(env: NodeJS.ProcessEnv = process.env) {
  function integer(key: string, fallback: number, max: number) {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new Error(`Invalid ${key}.`);
    return Number(raw);
  }
  const entries = (key: string) => (env[key] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  const hosts = entries('MONITORING_ALLOWED_HOSTS').map((entry) => {
    const wildcard = entry.startsWith('*.');
    const name = dnsName(wildcard ? entry.slice(2) : entry);
    if (!name || isIP(name)) throw new Error('Invalid MONITORING_ALLOWED_HOSTS.');
    return { name, wildcard };
  });
  const networks = entries('MONITORING_ALLOWED_CIDRS').map((entry) => {
    try {
      const [address, prefix] = ipaddr.parseCIDR(entry);
      if (entry.includes('%') || address.range() === 'ipv4Mapped') throw new Error();
      return { address, prefix };
    } catch { throw new Error('Invalid MONITORING_ALLOWED_CIDRS.'); }
  });
  const ports = (env.MONITORING_ALLOWED_TLS_PORTS ?? '443').split(',').map((entry) => {
    if (!/^\d+$/.test(entry.trim()) || Number(entry) < 1 || Number(entry) > 65535) throw new Error('Invalid MONITORING_ALLOWED_TLS_PORTS.');
    return Number(entry);
  });
  return { timeoutMs: integer('MONITORING_CHECK_TIMEOUT_MS', 5000, 30000),
    concurrency: integer('MONITORING_CHECK_CONCURRENCY', 4, 16), hosts, networks, ports };
}
export type NetworkMonitorConfig = ReturnType<typeof networkMonitorConfig>;

export function allowedAddress(raw: string, config: NetworkMonitorConfig) {
  if (!isIP(raw) || raw.includes('%')) return false;
  const address = ipaddr.process(raw); // IPv4-mapped IPv6 must obey the IPv4 policy.
  if (['unspecified', 'broadcast', 'multicast', 'linkLocal'].includes(address.range())) return false;
  return config.networks.some((network) => {
    if (address instanceof ipaddr.IPv4 && network.address instanceof ipaddr.IPv4) return address.match(network.address, network.prefix);
    if (address instanceof ipaddr.IPv6 && network.address instanceof ipaddr.IPv6) return address.match(network.address, network.prefix);
    return false;
  });
}
export function allowedHost(raw: string, config: NetworkMonitorConfig) {
  if (isIP(raw)) return allowedAddress(raw, config);
  const name = dnsName(raw);
  return !!name && config.hosts.some((entry) => entry.wildcard ? name.endsWith(`.${entry.name}`) : name === entry.name);
}
