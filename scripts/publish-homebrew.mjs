import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release.nosync');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const tag = `v${pkg.version}`;
const repo = process.env.GITHUB_REPOSITORY || repositorySlug(pkg.repository?.url);
const tap = process.env.HOMEBREW_TAP || 'liliu-z/stashbase';
const tapGitUrl = process.env.HOMEBREW_TAP_GIT_URL || 'git@github.com:liliu-z/homebrew-stashbase.git';
const cask = process.env.HOMEBREW_CASK || 'stashbase';

if (!repo) {
  throw new Error('Unable to determine GitHub repository. Set GITHUB_REPOSITORY=owner/repo.');
}

function repositorySlug(value) {
  if (!value) return null;
  return String(value)
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

function releaseFiles() {
  if (!fs.existsSync(releaseDir)) return [];
  return fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(releaseDir, entry.name));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function checkBrew() {
  try {
    execFileSync('brew', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('Homebrew is required for publishing the cask. Install brew and try again.');
  }
}

function run(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
}

function ensureTap() {
  const tapped = execFileSync('brew', ['tap'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .includes(tap);

  if (tapped) return;
  run('brew', ['tap', tap, tapGitUrl]);
}

function tapRepoPath() {
  return execFileSync('brew', ['--repo', tap], { encoding: 'utf8' }).trim();
}

function git(tapRepo, args, options = {}) {
  return execFileSync('git', ['-C', tapRepo, ...args], {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  });
}

function caskContent({ url, checksum }) {
  const productName = pkg.build?.productName || 'StashBase';
  const appName = `${productName}.app`;

  return `cask "${cask}" do
  version "${pkg.version}"
  sha256 "${checksum}"

  url "${url}"
  name "${productName}"
  desc "${pkg.description}"
  homepage "https://github.com/${repo}"

  app "${appName}"

  zap trash: [
    "~/.stashbase",
    "~/Library/Application Support/${productName}",
    "~/Library/Logs/${productName}",
    "~/Library/Preferences/${pkg.build?.appId || 'com.stashbase.app'}.plist",
    "~/Library/Saved Application State/${pkg.build?.appId || 'com.stashbase.app'}.savedState",
  ]
end
`;
}

function publishCask({ url, checksum }) {
  const tapRepo = tapRepoPath();
  const casksDir = path.join(tapRepo, 'Casks');
  const caskPath = path.join(casksDir, `${cask}.rb`);
  const branch = git(tapRepo, ['branch', '--show-current']).trim() || 'HEAD';
  const status = git(tapRepo, ['status', '--short']).trim();

  if (status) {
    throw new Error(`Homebrew tap has uncommitted changes in ${tapRepo}:\n${status}`);
  }

  git(tapRepo, ['pull', '--ff-only'], { stdio: 'inherit' });

  const content = caskContent({ url, checksum });
  if (dryRun) {
    console.log(`[homebrew] dry run: would write ${caskPath}`);
    console.log(content);
    return;
  }

  fs.mkdirSync(casksDir, { recursive: true });
  fs.writeFileSync(caskPath, content);

  const changed = git(tapRepo, ['status', '--short']).trim();
  if (!changed) {
    console.log('[homebrew] cask is already up to date');
    return;
  }

  git(tapRepo, ['add', caskPath], { stdio: 'inherit' });
  git(tapRepo, ['commit', '-m', `Update ${cask} to ${pkg.version}`], { stdio: 'inherit' });
  git(tapRepo, ['push', 'origin', branch], { stdio: 'inherit' });
}

const dmgs = releaseFiles()
  .filter((file) => path.basename(file).endsWith('.dmg'))
  .filter((file) => path.basename(file).includes(pkg.version))
  .sort();

if (dmgs.length !== 1) {
  throw new Error(
    `Expected exactly one ${pkg.version} DMG in ${releaseDir}, found ${dmgs.length}:\n` +
      dmgs.map((file) => `  ${path.basename(file)}`).join('\n'),
  );
}

checkBrew();
ensureTap();

const dmg = dmgs[0];
const name = path.basename(dmg);
const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
const checksum = sha256(dmg);
const caskRef = `${tap}/${cask}`;

console.log(`[homebrew] ${caskRef} -> ${pkg.version}`);
console.log(`[homebrew] ${url}`);
publishCask({ url, checksum });
