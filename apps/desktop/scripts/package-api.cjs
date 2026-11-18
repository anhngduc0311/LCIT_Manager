const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../../..');
const target = join(__dirname, '../src-tauri/target');
const npm = process.env.npm_execpath;
if (!npm || process.platform !== 'win32') {
  throw new Error('Package the Windows API through npm on Windows.');
}

function run(executable, args, cwd) {
  execFileSync(executable, args, { cwd, stdio: 'inherit', windowsHide: true });
}

mkdirSync(target, { recursive: true });
const staging = mkdtempSync(join(target, 'package-api-'));
try {
  run(process.execPath, [
    npm, 'run', 'build', '--workspace', '@lcit/api', '--', '--outDir', join(staging, 'apps/api/dist'),
  ], root);
  for (const workspace of ['apps/api', 'apps/desktop']) {
    mkdirSync(join(staging, workspace), { recursive: true });
    copyFileSync(join(root, workspace, 'package.json'), join(staging, workspace, 'package.json'));
  }
  for (const file of ['package.json', 'package-lock.json']) {
    copyFileSync(join(root, file), join(staging, file));
  }
  run(process.execPath, [
    npm, 'ci', '--workspace', '@lcit/api', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
  ], staging);

  // npm links the workspace back into node_modules. The packaged API runs from apps/api.
  rmSync(join(staging, 'node_modules/@lcit/api'), { force: true, recursive: true });
  copyFileSync(process.execPath, join(staging, 'node.exe'));
  copyFileSync(join(__dirname, 'parent-watch.cjs'), join(staging, 'parent-watch.cjs'));

  const archive = join(staging, 'bundled-api.tar.gz');
  run('tar.exe', ['-czf', archive, 'node.exe', 'parent-watch.cjs', 'apps/api', 'node_modules'], staging);
  renameSync(archive, join(target, 'bundled-api.tar.gz'));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
