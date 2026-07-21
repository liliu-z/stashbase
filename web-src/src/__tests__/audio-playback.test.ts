import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioPlaybackPosition } from '../audio-playback.ts';

test('search seek survives replacement with a compatible playback source', () => {
  const position = new AudioPlaybackPosition();
  position.setSourceIdentity('/library:meeting.wav:v1');
  const original = { currentTime: 0 };
  const fallback = { currentTime: 0 };
  position.remember(42_500);
  assert.equal(position.apply(original), true);
  assert.equal(original.currentTime, 42.5);

  assert.equal(position.apply(fallback), true);
  assert.equal(fallback.currentTime, 42.5);

  position.reset();
  fallback.currentTime = 0;
  assert.equal(position.apply(fallback), false);
  assert.equal(fallback.currentTime, 0);
});

test('same-path source replacement clears the previous recording position', () => {
  const position = new AudioPlaybackPosition();
  const replacement = { currentTime: 0 };
  position.setSourceIdentity('/library:meeting.wav:v1');
  position.remember(42_500);

  position.setSourceIdentity('/library:meeting.wav:v2');

  assert.equal(position.apply(replacement), false);
  assert.equal(replacement.currentTime, 0);
});
