import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
// `.nosync` suffix keeps iCloud Drive from mangling these build artifacts
// when the repo lives under ~/Documents (it flattens PyInstaller's symlinks
// and evicts the bundled dylibs → the daemon binary stops loading).
const venvRoot = path.join(root, 'python', '.venv.nosync');
const python = process.platform === 'win32'
  ? path.join(venvRoot, 'Scripts', 'python.exe')
  : path.join(venvRoot, 'bin', 'python');
const entry = path.join(root, 'python', 'stashbase_daemon.py');
const distPath = path.join(root, 'python', 'sidecar.nosync');
const buildPath = path.join(root, 'dist', 'pyinstaller');
const cachePath = path.join(root, 'python', 'pyinstaller-cache.nosync');
const specPath = path.join(root, 'dist', 'pyinstaller');
const buildReqs = path.join(root, 'python', 'build-requirements.txt');
const setupPython = path.join(root, 'scripts', 'setup-python.mjs');
execFileSync(process.execPath, [path.join(root, 'scripts', 'lock-python.mjs'), '--check'], { cwd: root });
function getPipConstraintPath(constraintPath) {
  if (process.platform === 'win32' && constraintPath.includes(' ')) {
    try {
      const short = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${constraintPath}').ShortPath`],
        { encoding: 'utf8' }
      ).trim();
      if (short && !short.includes(' ')) return short;
    } catch {}
    const tempPath = path.join(os.tmpdir(), 'stashbase-constraints.txt');
    fs.copyFileSync(constraintPath, tempPath);
    return tempPath;
  }
  return constraintPath;
}
process.env.PIP_CONSTRAINT = getPipConstraintPath(path.join(root, 'python', 'constraints.txt'));
const args = process.argv.slice(2);
const buildExtractor = args.includes('--with-extract') || process.env.STASHBASE_BUILD_EXTRACT === '1';
// Keep the console-enabled bootloader so Node can capture stderr progress and
// failures, but hide consoles owned by the Windows extractor and its frozen
// multiprocessing workers before they can flash or steal focus.
const extractorConsoleArgs = process.platform === 'win32'
  ? ['--hide-console', 'hide-early']
  : [];
const pyinstallerEnv = {
  ...process.env,
  PYINSTALLER_CONFIG_DIR: cachePath,
};
const daemonExcludedModules = [
  'pymupdf',
  'pymupdf4llm',
  'fitz',
  'docx',
  'PIL',
  'cv2',
  'rapidocr_onnxruntime',
  'onnxruntime',
  'tokenizers',
  // Pulled by optional document parsing hooks, not by the daemon protocol
  // itself. Keeping them out saves space from the default app.
  'lxml',
  'pyarrow.tests',
];
const daemonForbiddenEntries = [
  'pymupdf',
  'pymupdf4llm',
  'fitz',
  'cv2',
  'rapidocr_onnxruntime',
  'onnxruntime',
  'tokenizers',
  'lxml',
];
const extractExcludedModules = [
  'blake3',
  'mfs',
  'milvus',
  'milvus_lite',
  'openai',
  'pyarrow',
  'pymilvus',
  'tiktoken',
];
const extractForbiddenEntries = [
  'blake3',
  'mfs',
  'milvus',
  'milvus_lite',
  'openai',
  'pyarrow',
  'pymilvus',
  'tiktoken',
];

function assertNoBundleEntries(bundleDir, forbiddenNames, label) {
  const internalDir = path.join(bundleDir, '_internal');
  if (!fs.existsSync(internalDir)) return;
  const forbidden = new Set(forbiddenNames.map((name) => name.toLowerCase()));
  const hits = [];
  const stack = [internalDir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const lower = entry.name.toLowerCase();
      const packageName = lower.endsWith('.dist-info') || lower.endsWith('.egg-info')
        ? lower.replace(/[-.].*$/, '')
        : lower;
      if (forbidden.has(lower) || forbidden.has(packageName)) {
        hits.push(path.relative(bundleDir, path.join(current, entry.name)));
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      }
    }
  }

  if (hits.length > 0) {
    throw new Error(
      `${label} bundle contains excluded heavy modules:\n` +
        hits.slice(0, 20).map((hit) => `  - ${hit}`).join('\n') +
        (hits.length > 20 ? `\n  ... and ${hits.length - 20} more` : ''),
    );
  }
  console.log(`[build:python-sidecar] ${label} excludes verified`);
}

function pruneDaemonBundle(bundleDir) {
  const pyarrowDir = path.join(bundleDir, '_internal', 'pyarrow');
  if (!fs.existsSync(pyarrowDir)) return;

  const pruned = [];
  for (const rel of ['include', 'includes', 'src', 'tests']) {
    const target = path.join(pyarrowDir, rel);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      pruned.push(path.relative(bundleDir, target));
    }
  }

  const stack = [pyarrowDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (/\.(pxd|pxi|pyx)$/i.test(entry.name)) {
        fs.rmSync(full, { force: true });
        pruned.push(path.relative(bundleDir, full));
      }
    }
  }

  if (pruned.length > 0) {
    console.log(`[build:python-sidecar] pruned ${pruned.length} PyArrow development artifact(s)`);
  }
}

// Always reconcile an existing developer environment with the locked inputs;
// release cache misses use a fresh environment. A successful version probe alone
// does not prove the installed PyInstaller or runtime dependencies are current.
execFileSync(process.execPath, [setupPython, ...(buildExtractor ? ['--with-extract'] : [])], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync(python, ['-m', 'pip', 'install', '-r', buildReqs], {
  cwd: root,
  stdio: 'inherit',
});

fs.rmSync(distPath, { recursive: true, force: true });
fs.mkdirSync(distPath, { recursive: true });
fs.mkdirSync(buildPath, { recursive: true });
fs.mkdirSync(cachePath, { recursive: true });

execFileSync(
  python,
  [
    '-m',
    'PyInstaller',
    '--clean',
    '--noconfirm',
    '--name',
    'stashbase-daemon',
    '--hidden-import',
    'mfs._process_supervisor',
    '--hidden-import',
    'blake3',
    // Document extraction stays in its own optional sidecar. MFS receives
    // only StashBase-completed UTF-8 projections in this daemon.
    ...daemonExcludedModules.flatMap((moduleName) => ['--exclude-module', moduleName]),
    '--copy-metadata',
    'milvus-lite',
    '--copy-metadata',
    'pymilvus',
    '--copy-metadata',
    'mfs',
    '--distpath',
    distPath,
    '--workpath',
    buildPath,
    '--specpath',
    specPath,
    entry,
  ],
  { cwd: root, env: pyinstallerEnv, stdio: 'inherit' },
);

// --onedir layout: <distPath>/stashbase-daemon/{stashbase-daemon, _internal/}.
// The executable is inside the same-named directory.
const outDir = path.join(distPath, 'stashbase-daemon');
const outBin = path.join(outDir, process.platform === 'win32' ? 'stashbase-daemon.exe' : 'stashbase-daemon');
if (!fs.existsSync(outBin)) {
  throw new Error(`PyInstaller did not produce ${outBin}`);
}
fs.chmodSync(outBin, 0o755);
pruneDaemonBundle(outDir);
assertNoBundleEntries(outDir, daemonForbiddenEntries, 'daemon');
console.log('[build:python-sidecar] done ->', outBin);

// Second sidecar: the one-shot extractors (`python/extract_main.py`,
// dispatching pdf_extract / ocr_extract). Unlike the daemon this DOES need
// the heavy CV/ML deps, so it bundles onnxruntime + opencv (rapidocr) and
// the pymupdf data files. `--collect-all` is load-bearing: rapidocr ships
// its ONNX models as package data and pymupdf ships layout resources that
// PyInstaller's static analysis misses, so the frozen binary errors at
// runtime ("No such file or directory: .../models/*.onnx" / pymupdf
// resources) without them. Both bundles share `python/sidecar.nosync/` and
// ride to the app via electron-builder's `extraResources`
// (`from: python/sidecar.nosync` → `to: python/sidecar` inside the .app).
if (!buildExtractor) {
  console.log('[build:python-sidecar] skipped optional PDF/OCR extractor (use --with-extract or STASHBASE_BUILD_EXTRACT=1)');
} else {
  const extractEntry = path.join(root, 'python', 'extract_main.py');
  execFileSync(
    python,
    [
      '-m',
      'PyInstaller',
      '--clean',
      '--noconfirm',
      '--name',
      'stashbase-extract',
      ...extractorConsoleArgs,
      // pdf_extract.py / ocr_extract.py are sibling modules imported lazily
      // by extract_main; put `python/` on the analysis path and pin them as
      // hidden imports so PyInstaller bundles both branches.
      '--paths',
      path.join(root, 'python'),
      '--hidden-import',
      'pdf_extract',
      '--hidden-import',
      'ocr_extract',
      '--collect-all',
      'rapidocr_onnxruntime',
      '--collect-all',
      'pymupdf4llm',
      '--collect-all',
      'pymupdf',
      ...extractExcludedModules.flatMap((moduleName) => ['--exclude-module', moduleName]),
      '--distpath',
      distPath,
      '--workpath',
      buildPath,
      '--specpath',
      specPath,
      extractEntry,
    ],
    { cwd: root, env: pyinstallerEnv, stdio: 'inherit' },
  );

  const extractBin = path.join(
    distPath,
    'stashbase-extract',
    process.platform === 'win32' ? 'stashbase-extract.exe' : 'stashbase-extract',
  );
  if (!fs.existsSync(extractBin)) {
    throw new Error(`PyInstaller did not produce ${extractBin}`);
  }
  fs.chmodSync(extractBin, 0o755);
  assertNoBundleEntries(path.dirname(extractBin), extractForbiddenEntries, 'extractor');
  console.log('[build:python-sidecar] done ->', extractBin);
}
