/**
 * One-time Python sidecar installer.
 *
 * 1. Find Python 3.13 on PATH. The embedded MFS release intentionally
 *    supports only Python >=3.13,<3.14.
 * 2. Create `python/.venv.nosync` if missing (the `.nosync` suffix keeps
 *    iCloud Drive from corrupting it when the repo is under ~/Documents).
 * 3. `pip install -r python/requirements.txt` into it.
 *
 * Optional PDF/OCR extraction dependencies are intentionally split into
 * `python/requirements-extract.txt`; pass `--with-extract` (the
 * `setup:python-extract` script) to install them too, for developing the
 * local extractor or running OCR from a source checkout.
 *
 * Fails loudly with an actionable message rather than letting the
 * embedding daemon crash later with "No module named 'mfs'".
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENV = path.join(ROOT, 'python', '.venv.nosync');
const REQS = path.join(ROOT, 'python', 'requirements.txt');
const EXTRACT_REQS = path.join(ROOT, 'python', 'requirements-extract.txt');
// Constrain runtime and isolated build dependencies to the reviewed resolution.
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'lock-python.mjs'), '--check'], { cwd: ROOT });
// pip splits this environment option on whitespace; a file URL keeps the
// checkout's own constraint readable without short names or temporary copies.
process.env.PIP_CONSTRAINT = pathToFileURL(path.join(ROOT, 'python', 'constraints.txt')).href;
const WITH_EXTRACT = process.argv.includes('--with-extract');
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(VENV, 'Scripts', 'python.exe')
  : path.join(VENV, 'bin', 'python');

const REQUIRED_MAJOR = 3;
const REQUIRED_MINOR = 13;

const CANDIDATES = [
  'python3.13',
  'python3',
  'python',
];

function probe(bin) {
  const r = spawnSync(bin, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const [major, minor] = r.stdout.trim().split(/\s+/).map(Number);
  return { bin, major, minor };
}

function findPython() {
  const tried = [];
  for (const c of CANDIDATES) {
    const r = probe(c);
    if (!r) continue;
    tried.push(`${c} (${r.major}.${r.minor})`);
    if (r.major === REQUIRED_MAJOR && r.minor === REQUIRED_MINOR) {
      return r;
    }
  }
  const seen = tried.length ? tried.join(', ') : 'none';
  console.error(
    `[setup:python] Python ${REQUIRED_MAJOR}.${REQUIRED_MINOR} was not found on PATH.\n` +
      `  Probed: ${seen}\n` +
      `  Install Python 3.13 (for example \`brew install python@3.13\`) and re-run.`,
  );
  process.exit(1);
}

const py = findPython();
console.log(`[setup:python] using ${py.bin} (${py.major}.${py.minor})`);

mkdirSync(path.dirname(VENV), { recursive: true });
if (existsSync(VENV)) {
  const existing = probe(VENV_PYTHON);
  if (!existing || existing.major !== REQUIRED_MAJOR || existing.minor !== REQUIRED_MINOR) {
    console.log(`[setup:python] replacing incompatible venv at ${VENV}`);
    rmSync(VENV, { recursive: true, force: true });
  }
}
if (!existsSync(VENV)) {
  console.log(`[setup:python] creating venv at ${VENV}`);
  execFileSync(py.bin, ['-m', 'venv', VENV], { stdio: 'inherit' });
}

console.log(`[setup:python] installing deps from ${REQS}`);
execFileSync(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' });
// The retired zilliztech distribution owns the same `mfs` import package.
// Remove it before installing the new project so stale modules cannot survive
// an in-place development environment upgrade.
execFileSync(VENV_PYTHON, ['-m', 'pip', 'uninstall', '-y', 'mfs-cli'], { stdio: 'inherit' });
// Check both release provenance and version: pip may retain a different source
// with the same package version when moving from a Git checkout to a release.
const mfsRelease = readFileSync(REQS, 'utf8').match(/^mfs @ (https:\/\/github\.com\/liliu-z\/mfs\/archive\/refs\/tags\/v(\d+\.\d+\.\d+)\.tar\.gz)\s*$/m);
if (!mfsRelease) throw new Error('requirements.txt must pin MFS to a versioned release archive');
const [, mfsUrl, mfsVersion] = mfsRelease;
const installedMfsMatchesRelease = () => JSON.parse(execFileSync(VENV_PYTHON, ['-c', `
import importlib.metadata as metadata, json
try:
    distribution = metadata.distribution('mfs')
    installed = json.loads(distribution.read_text('direct_url.json') or '{}')
    print(json.dumps(distribution.version == ${JSON.stringify(mfsVersion)} and installed.get('url') == ${JSON.stringify(mfsUrl)}))
except metadata.PackageNotFoundError:
    print('false')
`], { encoding: 'utf8' }).trim());
if (!installedMfsMatchesRelease()) {
  execFileSync(VENV_PYTHON, ['-m', 'pip', 'uninstall', '-y', 'mfs'], { stdio: 'inherit' });
}
execFileSync(VENV_PYTHON, ['-m', 'pip', 'install', '-r', REQS], { stdio: 'inherit' });
if (!installedMfsMatchesRelease()) throw new Error('Installed MFS does not match its pinned release');
if (WITH_EXTRACT) {
  console.log(`[setup:python] installing extraction deps from ${EXTRACT_REQS}`);
  execFileSync(VENV_PYTHON, ['-m', 'pip', 'install', '-r', EXTRACT_REQS], { stdio: 'inherit' });
}

// Smoke-test the imports the daemon needs, so a corrupt venv reports
// failure here instead of at first daemon spawn.
const probeImports = `
import sys
try:
    import mfs, openai, numpy
    assert hasattr(mfs, 'MFS'), 'installed mfs package does not expose MFS'
    print(f'[setup:python] ok: mfs.MFS, openai ({openai.__version__}), numpy')
except Exception as e:
    print(f'[setup:python] import probe failed: {e}', file=sys.stderr)
    sys.exit(1)
`;
execFileSync(VENV_PYTHON, ['-c', probeImports], { stdio: 'inherit' });

if (WITH_EXTRACT) {
  const probeExtract = `
import sys
try:
    import pymupdf4llm, rapidocr_onnxruntime
    print('[setup:python] ok: pymupdf4llm, rapidocr_onnxruntime')
except Exception as e:
    print(f'[setup:python] extraction import probe failed: {e}', file=sys.stderr)
    sys.exit(1)
`;
  execFileSync(VENV_PYTHON, ['-c', probeExtract], { stdio: 'inherit' });
}
