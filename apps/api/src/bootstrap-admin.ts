import { randomUUID } from 'node:crypto';
import { usernameOf } from './access';
import { text } from './api-contract';
import { recordAudit } from './audit';
import { Database } from './database';
import { hashPassword, newPassword } from './password';

async function bootstrapAdmin() {
  const username = usernameOf(process.env.LCIT_ADMIN_USERNAME);
  const password = newPassword(process.env.LCIT_ADMIN_PASSWORD);
  const displayName = text(process.env.LCIT_ADMIN_DISPLAY_NAME ?? username, 'displayName', 160);
  const db = new Database();
  try {
    const created = await db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(1195590318)');
      const { rows: [admin] } = await client.query<{ username: string }>(
        "SELECT username FROM lcit.users WHERE role = 'admin' AND status = 'active' ORDER BY username LIMIT 1",
      );
      if (admin?.username === username) return false;
      if (admin) throw new Error('An active administrator already exists.');
      const { rows: [user] } = await client.query<{ id: string }>(`
        INSERT INTO lcit.users (username, display_name, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id
      `, [username, displayName, await hashPassword(password)]);
      await recordAudit(client, { action: 'user.bootstrap', targetType: 'user', targetId: user.id, requestId: randomUUID() });
      return true;
    });
    console.log(created ? 'Administrator created.' : 'Administrator already exists.');
  } finally {
    await db.onModuleDestroy();
  }
}

void bootstrapAdmin().catch((error: unknown) => {
  const code = (error as { code?: string })?.code;
  console.error(`Administrator setup failed${code ? ` (${code})` : ''}. Check migration, LCIT_ADMIN_* and existing administrator.`);
  process.exitCode = 1;
});
