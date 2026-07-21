import assert from 'node:assert/strict';
import test from 'node:test';
import {
  audioTranscriptStatusCopy,
  findAudioSeekSegment,
} from '../audio-transcript.ts';

const segments = [
  { id: 1, startMs: 1_000, endMs: 3_000, text: 'Welcome to the weekly planning meeting.' },
  { id: 2, startMs: 65_250, endMs: 70_000, text: 'The launch date moves to next Thursday.' },
];

test('yielded transcription uses product waiting copy without queue position', () => {
  const copy = audioTranscriptStatusCopy({
    status: 'pending',
    progress: {
      phase: 'yielded',
      lane: 'heavy',
      tasksAhead: 7,
    },
  });
  assert.equal(copy, 'Waiting for other file preparation to finish…');
  assert.doesNotMatch(copy ?? '', /7|lane|task|checkpoint/i);
});

test('audio semantic result uses transcript Markdown timestamp', () => {
  const segment = findAudioSeekSegment(
    '# Transcript: meeting.m4a\n\n- [00:01:05.250] The launch date moves to next Thursday.',
    segments,
  );
  assert.equal(segment?.id, 2);
});

test('audio semantic result falls back to exact segment text', () => {
  const segment = findAudioSeekSegment('Context before. The launch date moves to next Thursday. Context after.', segments);
  assert.equal(segment?.id, 2);
  assert.equal(findAudioSeekSegment('unrelated content', segments), null);
});

test('audio timestamp at an adjacent boundary selects the segment that starts there', () => {
  const adjacent = [
    { id: 1, startMs: 0, endMs: 1_000, text: 'First.' },
    { id: 2, startMs: 1_000, endMs: 2_000, text: 'Second.' },
  ];
  assert.equal(findAudioSeekSegment('- [00:00:01.000] Second.', adjacent)?.id, 2);
});

test('an exact keyword result timestamp disambiguates repeated text', () => {
  const repeated = [
    { id: 1, startMs: 5_000, endMs: 7_000, text: 'We approved the launch plan.' },
    { id: 2, startMs: 95_000, endMs: 98_000, text: 'The revised launch plan is final.' },
  ];
  assert.equal(
    findAudioSeekSegment('- [00:01:35.000] The revised launch plan is final.', repeated)?.id,
    2,
  );
});

test('explicit keyword timestamp survives a display snippet without timestamp text', () => {
  const repeated = [
    { id: 1, startMs: 5_000, endMs: 7_000, text: 'The same phrase.' },
    { id: 2, startMs: 95_000, endMs: 98_000, text: 'The same phrase.' },
  ];
  assert.equal(findAudioSeekSegment('…The same phrase.', repeated, 95_000)?.id, 2);
});
