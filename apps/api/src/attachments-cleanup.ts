import 'reflect-metadata';
import { AttachmentsService } from './models/attachments.service';
import { Database } from './models/database';
import { FileStore } from './models/file-store';

// Runs the same cleanup the API schedules every 15 minutes, e.g. after restoring a backup.
async function cleanup() {
  const db = new Database();
  try {
    const result = await new AttachmentsService(db, new FileStore()).cleanup();
    console.log(`Removed ${result.expiredPending} expired pending attachment(s) and ${result.orphanFiles} orphan file(s).`);
  } finally {
    await db.onModuleDestroy();
  }
}

void cleanup().catch((error: unknown) => {
  const code = (error as { code?: string })?.code;
  console.error(`Attachment cleanup failed${code ? ` (${code})` : ''}. Check DATABASE_URL and ATTACHMENTS_DIR.`);
  process.exitCode = 1;
});
