const assert = require('node:assert/strict');
const test = require('node:test');
const { shouldOfferClipboardImage } = require('./clipboard-watch-policy.cjs');

test('clipboard image offers require opt-in, window focus, and an unclaimed composer', () => {
  assert.equal(shouldOfferClipboardImage({ enabled: false, focused: true, composerFocused: false }), false);
  assert.equal(shouldOfferClipboardImage({ enabled: true, focused: false, composerFocused: false }), false);
  assert.equal(shouldOfferClipboardImage({ enabled: true, focused: true, composerFocused: true }), false);
  assert.equal(shouldOfferClipboardImage({ enabled: true, focused: true, composerFocused: false }), true);
});
