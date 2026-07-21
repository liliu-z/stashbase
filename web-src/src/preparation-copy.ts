export type PreparationOutput = 'transcript' | 'audio-preview' | 'searchable-text';

const WAITING_COPY: Record<PreparationOutput, string> = {
  transcript: 'Waiting to transcribe…',
  'audio-preview': 'Waiting to prepare a compatible preview…',
  'searchable-text': 'Waiting to prepare searchable text…',
};

/** User-facing copy for a queued preparation. Scheduler lanes and task kinds
 * stay behind this interface so every file preview explains the same state in
 * product language. */
export function preparationWaitCopy(output: PreparationOutput, tasksAhead: number): string {
  const ahead = Number.isFinite(tasksAhead) ? Math.max(0, Math.floor(tasksAhead)) : 0;
  if (ahead === 0) return WAITING_COPY[output];
  return 'Waiting for other file preparation to finish…';
}
