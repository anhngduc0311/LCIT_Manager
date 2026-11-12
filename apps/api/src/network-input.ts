import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { invalid, text } from './api-contract';

export function dnsName(raw: string, serviceLabels = false) {
  const name = raw.toLowerCase().replace(/\.$/, '');
  const validCharacters = serviceLabels ? /^[\p{L}\p{M}\p{N}._-]+$/u : /^[\p{L}\p{M}\p{N}.-]+$/u;
  if (!validCharacters.test(name)) return null;
  const ascii = domainToASCII(name);
  const label = serviceLabels ? /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/ : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  return ascii.length <= 253 && ascii.split('.').every((part) => label.test(part)) ? ascii : null;
}

export function host(value: unknown, field = 'host') {
  const raw = text(value, field, 253);
  if (isIP(raw) === 4) return raw;
  if (isIP(raw) === 6 && !raw.includes('%')) return new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  const name = dnsName(raw);
  if (!name || /^[\d.]+$/.test(name)) invalid(field, 'Expected an IP address or hostname without a URL, port or scope.');
  return name;
}

export function domainName(value: unknown) {
  const name = host(value, 'name');
  if (isIP(name) || !name.includes('.')) invalid('name', 'Expected a fully qualified domain name.');
  return name;
}

export function dnsOwner(value: unknown, domain: string) {
  const raw = text(value, 'host', 253);
  if (raw === '@') return domain;
  const wildcard = raw.startsWith('*.');
  const name = dnsName(wildcard ? raw.slice(2) : raw, true);
  if (!name) invalid('host', 'Expected @, a hostname or a wildcard hostname.');
  const owner = raw.endsWith('.') || name === domain || name.endsWith(`.${domain}`) ? name : `${name}.${domain}`;
  if (owner !== domain && !owner.endsWith(`.${domain}`)) invalid('host', 'The DNS host must belong to this domain.');
  if (owner.length + (wildcard ? 2 : 0) > 253) invalid('host', 'Hostname is too long.');
  return wildcard ? `*.${owner}` : owner;
}

export function port(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) invalid('port', 'Expected an integer between 1 and 65535.');
  return value;
}

export function dateOnly(value: unknown, field: string) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) invalid(field, 'Expected YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid(field, 'Expected a valid calendar date.');
  return value;
}
