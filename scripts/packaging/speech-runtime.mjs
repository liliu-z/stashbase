// The upstream Windows DLLs link the VC 14.40+ runtime dynamically. Stage
// Microsoft's app-local redistributables from the release host's VS toolchain;
// desktop users must never be sent to a separate prerequisite installer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REQUIRED = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

function findRedist(environment) {
  const candidates = [];
  if (environment.VCToolsRedistDir) candidates.push(environment.VCToolsRedistDir);
  const vswhere = path.join(environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (fs.existsSync(vswhere)) {
    const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
    const versions = path.join(installation, 'VC', 'Redist', 'MSVC');
    if (fs.existsSync(versions)) for (const version of fs.readdirSync(versions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) candidates.push(path.join(versions, version));
  }
  for (const candidate of candidates) {
    const x64 = path.join(candidate, 'x64');
    if (!fs.existsSync(x64)) continue;
    for (const name of fs.readdirSync(x64)) {
      const directory = path.join(x64, name);
      if (name.endsWith('.CRT') && REQUIRED.every((file) => fs.existsSync(path.join(directory, file)))) return directory;
    }
  }
  throw new Error('Windows speech packaging requires the Visual Studio 2022 x64 C++ redistributable files (VC 14.40 or newer) on the release host.');
}

function verifyVersion(file) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$v=(Get-Item -LiteralPath $env:STASHBASE_CRT_FILE).VersionInfo; if ($v.FileMajorPart -ne 14 -or $v.FileMinorPart -lt 40) { throw "Speech requires VC runtime 14.40 or newer" }'], {
    env: { ...process.env, STASHBASE_CRT_FILE: file }, windowsHide: true, stdio: 'pipe',
  });
}

export function stageWindowsSpeechRuntime({ root, redistDirectory, checkVersion = verifyVersion }) {
  const source = redistDirectory ?? findRedist(process.env);
  for (const file of REQUIRED) {
    const absolute = path.join(source, file);
    const bytes = fs.readFileSync(absolute);
    const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
    if (pe < 0 || pe + 6 > bytes.length || bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664)
      throw new Error(`The Windows speech runtime is missing a valid x64 ${file}.`);
    checkVersion(absolute);
  }
  const destination = path.join(root, 'build', 'native.nosync', 'speech-crt');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const file of fs.readdirSync(source)) {
    if (file.toLowerCase().endsWith('.dll') && fs.statSync(path.join(source, file)).isFile()) fs.copyFileSync(path.join(source, file), path.join(destination, file));
  }
  return destination;
}
