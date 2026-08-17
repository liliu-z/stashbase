const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function assertVersionedFrameworkStructure(appPath) {
  const frameworksPath = path.join(appPath, 'Contents', 'Frameworks');
  if (!fs.existsSync(frameworksPath)) {
    throw new Error(`Expected macOS Frameworks directory was not found: ${frameworksPath}`);
  }

  const frameworks = fs.readdirSync(frameworksPath)
    .filter((name) => name.endsWith('.framework'));
  for (const frameworkName of frameworks) {
    const frameworkPath = path.join(frameworksPath, frameworkName);
    const versionsPath = path.join(frameworkPath, 'Versions');
    const currentPath = path.join(versionsPath, 'Current');
    if (!fs.statSync(versionsPath).isDirectory() || !fs.lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`${frameworkName} must keep its versioned framework layout`);
    }

    for (const entry of fs.readdirSync(frameworkPath)) {
      if (entry === 'Versions') continue;
      const entryPath = path.join(frameworkPath, entry);
      if (!fs.lstatSync(entryPath).isSymbolicLink()) {
        throw new Error(`${frameworkName}/${entry} must remain a symbolic link before codesign`);
      }
      const target = fs.readlinkSync(entryPath);
      if (path.isAbsolute(target) || !target.startsWith('Versions/Current/')) {
        throw new Error(`${frameworkName}/${entry} has unexpected symbolic-link target: ${target}`);
      }
    }

    const infoPath = path.join(frameworkPath, 'Versions', 'Current', 'Resources', 'Info.plist');
    if (!fs.statSync(infoPath).isFile()) {
      throw new Error(`${frameworkName} is missing Versions/Current/Resources/Info.plist`);
    }
  }

  return frameworks.length;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    throw new Error(`Expected macOS app bundle was not found: ${appPath}`);
  }

  const frameworkCount = assertVersionedFrameworkStructure(appPath);
  if (process.env.GITHUB_ACTIONS === 'true') {
    // GitHub-hosted runners do not use an iCloud/File Provider workspace. Keep
    // electron-builder's original bundle in place so its framework links and
    // other filesystem semantics reach codesign unchanged.
    console.log(`[after-pack] verified ${frameworkCount} versioned frameworks; preserving CI bundle`);
    return;
  }

  // The repo lives under ~/Documents, which iCloud syncs. fileproviderd
  // tags bundle directories with FinderInfo / fileprovider xattrs that
  // `xattr -cr` cannot reliably strip (it re-applies them to tracked
  // inodes), and codesign refuses to sign with them present ("resource
  // fork, Finder information, or similar detritus not allowed"). A
  // `ditto --noextattr` clone writes fresh inodes carrying none of the
  // strippable attrs — only the kernel-applied com.apple.provenance
  // survives, which codesign tolerates. Clone and swap before electron-builder
  // applies the final Developer ID signature and notarization ticket. Nothing
  // may mutate the bundle after that point.
  const cleanPath = `${appPath}.clean`;
  fs.rmSync(cleanPath, { recursive: true, force: true });
  execFileSync('/usr/bin/ditto', ['--noextattr', '--noacl', '--norsrc', appPath, cleanPath], {
    stdio: 'inherit',
  });
  assertVersionedFrameworkStructure(cleanPath);
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.renameSync(cleanPath, appPath);
};

module.exports.assertVersionedFrameworkStructure = assertVersionedFrameworkStructure;
