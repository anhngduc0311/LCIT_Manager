import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import { Actor, SessionRequest, sha256, usernameOf } from './access';
import { ApiError, ApiRequest, bodyOf, invalid, requestId } from '../shared/api-contract';
import { recordAudit } from './audit.service';
import { Database } from './database';
import { verifyPassword } from './password';

async function reserveAttempt(client: PoolClient, key: string, limit: number) {
  const { rows: [row] } = await client.query<{ attempts: number }>(`
    INSERT INTO lcit.login_throttles (key, window_start, attempts) VALUES ($1, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN lcit.login_throttles.window_start <= now() - interval '15 minutes' THEN 1
        ELSE least(lcit.login_throttles.attempts + 1, $2::integer + 1) END,
      window_start = CASE WHEN lcit.login_throttles.window_start <= now() - interval '15 minutes' THEN now()
        ELSE lcit.login_throttles.window_start END
    RETURNING attempts
  `, [key, limit]);
  return row.attempts <= limit;
}

@Injectable()
export class AuthService {
  constructor(private readonly db: Database) {}

  async login(input: unknown, request: ApiRequest) {
    const { username: rawUsername, password } = bodyOf(input, ['username', 'password']);
    const username = usernameOf(rawUsername);
    if (typeof password !== 'string' || password.length < 1 || password.length > 256) invalid('password', 'Expected 1–256 characters.');
    const ip = request.socket.remoteAddress ?? 'unknown';
    const accountKey = sha256(`account:${username}`);
    const audit = { action: 'auth.login', targetType: 'user', requestId: requestId(request) };
    const allowed = await this.db.transaction(async (client) => {
      // Share limits across API processes. The socket address does not trust forwarded headers.
      const allowed = await reserveAttempt(client, sha256(`ip:${ip}`), 60) && await reserveAttempt(client, accountKey, 5);
      if (!allowed) await recordAudit(client, { ...audit, outcome: 'denied' });
      return allowed;
    });
    if (!allowed) throw new ApiError(429, 'LOGIN_RATE_LIMITED', 'Too many sign-in attempts. Try again later.');

    const result = await this.db.transaction(async (client) => {
      const { rows: [user] } = await client.query<Actor & { status: string; passwordHash: string }>(`
        SELECT id, username, display_name AS "displayName", role, status, password_hash AS "passwordHash"
        FROM lcit.users WHERE username = $1 FOR SHARE
      `, [username]);
      const valid = await verifyPassword(password, user?.passwordHash);
      if (!valid || user?.status !== 'active') {
        await recordAudit(client, { ...audit, actorId: user?.id, targetId: user?.id, outcome: 'failure' });
        return null;
      }

      const token = randomBytes(32).toString('base64url');
      const { rows: [session] } = await client.query<{ expiresAt: Date }>(`
        INSERT INTO lcit.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '8 hours')
        RETURNING expires_at AS "expiresAt"
      `, [sha256(token), user.id]);
      await recordAudit(client, { ...audit, actorId: user.id, targetId: user.id });
      const { id, username: name, displayName, role } = user;
      return { token, expiresAt: session.expiresAt, user: { id, username: name, displayName, role } };
    });
    if (!result) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
    return result;
  }

  async findSessionActor(sessionHash: string): Promise<Actor | undefined> {
    const { rows: [actor] } = await this.db.query<Actor>(`
      SELECT u.id, u.username, u.display_name AS "displayName", u.role
      FROM lcit.sessions s JOIN lcit.users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'
    `, [sessionHash]);
    return actor;
  }

  async logout(request: SessionRequest) {
    await this.db.transaction(async (client) => {
      const result = await client.query('UPDATE lcit.sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [request.sessionHash]);
      if (result.rowCount) {
        await recordAudit(client, {
          actorId: request.actor.id, action: 'auth.logout', targetType: 'user', targetId: request.actor.id,
          requestId: requestId(request),
        });
      }
    });
  }
}
