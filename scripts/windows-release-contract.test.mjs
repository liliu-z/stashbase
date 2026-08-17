import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWindowsSigningConfiguration } from './windows-release-contract.mjs';

test('Windows releases build unsigned when no signing credential is configured', () => {
  assert.equal(resolveWindowsSigningConfiguration({}), false);
  assert.equal(resolveWindowsSigningConfiguration({ CSC_LINK: ' ', CSC_KEY_PASSWORD: '' }), false);
});

test('Windows release signing fails closed when credentials are partial', () => {
  assert.throws(
    () => resolveWindowsSigningConfiguration({ CSC_LINK: 'certificate' }),
    /incomplete; missing CSC_KEY_PASSWORD/,
  );
  assert.throws(
    () => resolveWindowsSigningConfiguration({ CSC_KEY_PASSWORD: 'secret' }),
    /incomplete; missing CSC_LINK/,
  );
});

test('Windows release signing accepts a certificate and password', () => {
  assert.equal(resolveWindowsSigningConfiguration({
    CSC_LINK: 'base64-pfx',
    CSC_KEY_PASSWORD: 'secret',
  }), true);
});
