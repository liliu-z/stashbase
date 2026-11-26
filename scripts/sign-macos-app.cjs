const path = require('node:path');
const { signAsync } = require('@electron/osx-sign');

const openCodeEntitlements = path.resolve(
  __dirname,
  '..',
  'build',
  'entitlements.mac.opencode.plist',
);
const openCodeSuffix = '/Contents/Resources/opencode/opencode.exe';

function isBundledOpenCode(filePath) {
  return filePath.replaceAll('\\', '/').endsWith(openCodeSuffix);
}

function optionsForSignedFile(filePath, inherited) {
  if (!isBundledOpenCode(filePath)) return inherited;
  return { ...inherited, entitlements: openCodeEntitlements };
}

function createOptionsForFile(inheritedOptionsForFile) {
  return (filePath) => optionsForSignedFile(
    filePath,
    inheritedOptionsForFile ? inheritedOptionsForFile(filePath) : null,
  );
}

/** electron-builder owns identity discovery, hardened-runtime flags, nested
 * signing order, and notarization. This adapter changes only the entitlement
 * file for the bundled Bun/OpenCode executable and delegates the same signing
 * operation back to electron-osx-sign. */
async function signMacosApp(options) {
  await signAsync({
    ...options,
    // electron-osx-sign 1.3.x consumes this callback synchronously. Returning
    // a Promise silently drops every per-file override, including OpenCode's
    // Bun/JIT entitlement.
    optionsForFile: createOptionsForFile(options.optionsForFile),
  });
}

module.exports = signMacosApp;
module.exports.isBundledOpenCode = isBundledOpenCode;
module.exports.optionsForSignedFile = optionsForSignedFile;
module.exports.createOptionsForFile = createOptionsForFile;
