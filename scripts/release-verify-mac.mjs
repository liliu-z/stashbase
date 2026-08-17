import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release.nosync');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const productName = pkg.build?.productName || pkg.name;
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const skipSmoke = args.has('--skip-smoke');

if (process.platform !== 'darwin') {
  throw new Error('release:verify:mac must run on macOS.');
}

// Mirror what `dist:brew` actually ships: the distributed build bundles and
// requires the optional PDF/OCR extractor sidecar (see
// scripts/publish-github-release.mjs). Force it on here too so the preflight
// builds, asserts, and smoke-tests the same artifact users install.
process.env.STASHBASE_BUILD_EXTRACT = '1';
process.env.STASHBASE_REQUIRE_EXTRACT = '1';
process.env.STASHBASE_RELEASE_BUILD = '1';

function run(command, args, options = {}) {
  console.log(`[release:verify:mac] ${command} ${args.join(' ')}`);
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
}

function findDmg() {
  const files = fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir) : [];
  const dmgs = files
    .filter((name) => name.endsWith('.dmg'))
    .filter((name) => name.includes(pkg.version))
    .sort()
    .map((name) => path.join(releaseDir, name));
  if (dmgs.length !== 1) {
    throw new Error(
      `Expected exactly one ${pkg.version} DMG in ${releaseDir}, found ${dmgs.length}:\n` +
        dmgs.map((file) => `  ${path.basename(file)}`).join('\n'),
    );
  }
  return dmgs[0];
}

function assertPath(target, label) {
  if (!fs.existsSync(target)) throw new Error(`DMG is missing ${label}: ${target}`);
}

function verifyMountedDmg(dmg) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-dmg-verify-'));
  let attached = false;
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmg]);
    attached = true;
    const appPath = path.join(mountPoint, `${productName}.app`);
    assertPath(appPath, `${productName}.app`);
    assertPath(path.join(mountPoint, 'Applications'), 'Applications link');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
    run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
    console.log(`[release:verify:mac] verified signed and notarized app in ${path.basename(dmg)}`);
  } finally {
    if (attached) {
      run('hdiutil', ['detach', mountPoint]);
    }
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

if (!skipBuild) run(process.execPath, ['scripts/package-desktop.mjs']);
if (!skipSmoke) run(process.execPath, ['scripts/smoke-packaged-server.mjs']);
verifyMountedDmg(findDmg());
console.log('[release:verify:mac] ok');
