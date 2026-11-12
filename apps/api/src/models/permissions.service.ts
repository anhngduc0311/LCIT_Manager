import { Injectable } from '@nestjs/common';
import { requireAdmin, SessionRequest } from './access';
import { choice, missing, requestId, uuid } from '../shared/api-contract';
import { recordAudit } from './audit.service';
import { Database } from './database';

/** Sensitive actions that need an explicit grant for leaders and specialists. Administrators always have them. */
export const permissions = ['attachments.download', 'reports.export'] as const;
export type Permission = typeof permissions[number];

/** SQL predicate: the actor in `actorParam` holds `permission` (or is an administrator, passed as `adminParam`). */
export function holdsPermission(permission: Permission, actorParam: string, adminParam: string) {
  return `(${adminParam}::boolean OR EXISTS (SELECT 1 FROM lcit.user_permissions perm
    WHERE perm.user_id = ${actorParam} AND perm.permission = '${permission}'))`;
}

@Injectable()
export class PermissionsService {
  constructor(private readonly db: Database) {}

  async list(request: SessionRequest, rawUser: string) {
    requireAdmin(request.actor);
    const userId = uuid(rawUser);
    const { rows: [row] } = await this.db.query<{ items: unknown[] }>(`
      SELECT COALESCE((SELECT json_agg(json_build_object('permission', p.permission, 'grantedAt', p.granted_at) ORDER BY p.permission)
        FROM lcit.user_permissions p WHERE p.user_id = u.id), '[]') AS items
      FROM lcit.users u WHERE u.id = $1 AND u.deleted_at IS NULL
    `, [userId]);
    if (!row) missing();
    return row;
  }

  async change(request: SessionRequest, rawUser: string, rawPermission: string, grant: boolean) {
    requireAdmin(request.actor);
    const userId = uuid(rawUser);
    const permission = choice(rawPermission, 'permission', permissions);
    await this.db.transaction(async (client) => {
      const { rowCount: exists } = await client.query('SELECT id FROM lcit.users WHERE id = $1 AND deleted_at IS NULL FOR KEY SHARE', [userId]);
      if (!exists) missing();
      const { rowCount } = grant
        ? await client.query('INSERT INTO lcit.user_permissions (user_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, permission])
        : await client.query('DELETE FROM lcit.user_permissions WHERE user_id = $1 AND permission = $2', [userId, permission]);
      if (!rowCount) return;
      await recordAudit(client, {
        actorId: request.actor.id, action: `users.permission.${grant ? 'grant' : 'revoke'}.${permission}`,
        targetType: 'users', targetId: userId, requestId: requestId(request),
      });
    });
  }
}
