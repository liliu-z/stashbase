import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function storeVersion(version) {
  if (version !== version.trim() || !/^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || version.split('.').some((part) => Number(part) > 65535)) {
    throw new Error('Microsoft Store requires a stable version with three integers up to 65535 and a nonzero major.');
  }
  // The fourth segment is reserved for the Store.
  return `${version}.0`;
}

export function stageWindowsStore(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = storeVersion(pkg.version);
  const source = path.join(root, 'release.nosync', 'win-unpacked');
  for (const relative of ['StashBase.exe', 'resources/app.asar', 'resources/python/sidecar/stashbase-daemon/stashbase-daemon.exe']) {
    if (!fs.statSync(path.join(source, relative)).isFile()) throw new Error(`Missing Windows payload: ${relative}`);
  }
  const staging = fs.mkdtempSync(path.join(root, 'release.nosync', 'msix-stage-'));
  try {
    fs.cpSync(source, path.join(staging, 'app'), {
      recursive: true,
      filter(file) {
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`MSIX payload cannot contain a symbolic link: ${file}`);
        return true;
      },
    });
    fs.cpSync(path.join(root, 'build/windows-store/Assets'), path.join(staging, 'Assets'), { recursive: true });
    const template = fs.readFileSync(path.join(root, 'build/windows-store/AppxManifest.xml'), 'utf8');
    if (template.split('{{VERSION}}').length !== 2) throw new Error('MSIX manifest must contain one version placeholder.');
    fs.writeFileSync(path.join(staging, 'AppxManifest.xml'), template.replace('{{VERSION}}', version));
    return staging;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(stageWindowsStore(fileURLToPath(new URL('../../', import.meta.url))));
}
