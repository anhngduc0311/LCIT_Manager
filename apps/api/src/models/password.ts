import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { invalid } from '../shared/api-contract';

const options = { N: 2 ** 16, r: 8, p: 1, maxmem: 80 * 1024 * 1024 };
const dummySalt = Buffer.alloc(16);
const dummyDigest = Buffer.alloc(64);

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, digest) => error ? reject(error) : resolve(digest));
  });
}

export function newPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) {
    invalid('password', 'Expected 12–256 characters.');
  }
  return value;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: string, stored?: string) {
  const match = stored?.match(/^scrypt\$([0-9a-f]{32})\$([0-9a-f]{128})$/);
  const digest = await derive(password, match ? Buffer.from(match[1], 'hex') : dummySalt);
  return timingSafeEqual(digest, match ? Buffer.from(match[2], 'hex') : dummyDigest) && Boolean(match);
}
