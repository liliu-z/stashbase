import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const homebrewToken = process.env.HOMEBREW_GITHUB_API_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!dryRun) {
  throw new Error(
    'Direct publication is disabled. Dispatch the coordinated GitHub Release workflow; ' +
      'use pnpm dist:brew --dry-run only to preview the macOS package and cask.',
  );
}

function run(command, commandArgs) {
  execFileSync(command, commandArgs, {
    cwd: root,
    env: {
      ...process.env,
      HOMEBREW_GITHUB_API_TOKEN: process.env.HOMEBREW_GITHUB_API_TOKEN || homebrewToken || '',
    },
    stdio: 'inherit',
  });
}

function commandExists(command, commandArgs = ['--version']) {
  try {
    execFileSync(command, commandArgs, { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!commandExists('brew')) {
  throw new Error('Homebrew is required for cask publishing.');
}

console.log(`[publish] ${pkg.name}@${pkg.version}`);
console.log('[publish] step 1/2: build and upload GitHub Release artifacts');
run(process.execPath, [path.join(root, 'scripts', 'publish-github-release.mjs'), ...args]);

console.log('[publish] step 2/2: publish Homebrew cask update');
run(process.execPath, [path.join(root, 'scripts', 'publish-homebrew.mjs'), ...args]);

console.log('[publish] done');
