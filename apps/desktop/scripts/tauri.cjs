const { spawnSync } = require('node:child_process');
const { homedir } = require('node:os');
const { delimiter, join } = require('node:path');

function cargoAvailable() {
  return spawnSync('cargo.exe', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 }).status === 0;
}

const [command, ...args] = process.argv.slice(2);
const buildsDesktop = ['dev', 'build'].includes(command) && !args.some((arg) => arg === '--help' || arg === '-h');
if (process.platform === 'win32' && command === 'dev' && !process.env.WEBVIEW2_USER_DATA_FOLDER) {
  process.env.WEBVIEW2_USER_DATA_FOLDER = join(__dirname, '..', 'src-tauri', 'target', 'webview2-dev');
}

if (process.platform === 'win32' && buildsDesktop && !cargoAvailable()) {
  const userHome = homedir();
  const cargoBin = join(process.env.CARGO_HOME || join(userHome, '.cargo'), 'bin');
  const rustupHome = process.env.RUSTUP_HOME || join(userHome, '.rustup');
  const host = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[process.arch];
  const originalPath = process.env.PATH;
  const candidates = [cargoBin];

  // An installed toolchain can run directly when the rustup shim cannot start.
  if (host && !process.env.RUSTUP_TOOLCHAIN) {
    candidates.push(join(rustupHome, 'toolchains', `stable-${host}-pc-windows-msvc`, 'bin'));
  }
  const found = candidates.some((directory) => {
    process.env.PATH = [directory, originalPath].filter(Boolean).join(delimiter);
    return cargoAvailable();
  });
  if (!found) {
    console.error('Cargo could not start. Install the Rust stable MSVC toolchain with rustup, then run this command again.');
    process.exit(1);
  }
}

require('@tauri-apps/cli/tauri.js');
