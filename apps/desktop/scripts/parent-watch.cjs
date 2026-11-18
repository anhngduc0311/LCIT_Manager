const { join } = require('node:path');

if (!process.env.ATTACHMENTS_DIR?.trim()) {
  process.env.ATTACHMENTS_DIR = join(process.env.LCIT_DESKTOP_DATA_DIR, 'attachments');
}

// The desktop owns the only write end of this pipe. Windows closes it even on a crash.
process.stdin.once('end', () => process.exit(0));
process.stdin.resume();
