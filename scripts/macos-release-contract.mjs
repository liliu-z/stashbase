import fs from 'node:fs';
import path from 'node:path';

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireGroup(env, names, label) {
  const configured = names.filter((name) => present(env[name]));
  if (configured.length === 0) return false;
  if (configured.length !== names.length) {
    const missing = names.filter((name) => !present(env[name]));
    throw new Error(`${label} is incomplete; missing ${missing.join(', ')}`);
  }
  return true;
}

export function assertMacosReleaseCredentials(env, options = {}) {
  const fileExists = options.fileExists ?? fs.existsSync;
  const isAbsolute = options.isAbsolute ?? path.isAbsolute;

  if (env.GITHUB_ACTIONS === 'true') {
    requireGroup(env, ['CSC_LINK', 'CSC_KEY_PASSWORD'], 'GitHub Developer ID signing credentials');
    if (!present(env.CSC_LINK) || !present(env.CSC_KEY_PASSWORD)) {
      throw new Error('GitHub macOS releases require CSC_LINK and CSC_KEY_PASSWORD');
    }
  }

  const apiKey = requireGroup(
    env,
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    'App Store Connect API notarization credentials',
  );
  const appleId = requireGroup(
    env,
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    'Apple ID notarization credentials',
  );
  const keychain = requireGroup(
    env,
    ['APPLE_KEYCHAIN_PROFILE'],
    'notarytool keychain credentials',
  );
  const modes = [apiKey, appleId, keychain].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error(
      modes === 0
        ? 'macOS releases require exactly one notarization credential set'
        : 'macOS releases must not configure multiple notarization credential sets',
    );
  }

  if (apiKey) {
    if (!isAbsolute(env.APPLE_API_KEY)) {
      throw new Error('APPLE_API_KEY must be an absolute path to the decoded .p8 file');
    }
    if (!fileExists(env.APPLE_API_KEY)) {
      throw new Error(`APPLE_API_KEY does not exist: ${env.APPLE_API_KEY}`);
    }
  }

  return apiKey ? 'api-key' : appleId ? 'apple-id' : 'keychain';
}
