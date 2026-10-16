import { describe, expect, it } from 'vite-plus/test';

import {
  runSummary,
  scheduledRunPrompt,
  scheduleLabel,
  taskDraft,
  type ScheduledTask,
} from './scheduled-tasks';

const task = (prompt: string, files: string[]): ScheduledTask => ({
  agent: null,
  enabled: false,
  files,
  id: 'brief',
  name: 'Brief',
  nextRunAt: null,
  problem: null,
  prompt,
  runs: [],
  time: '08:00',
});

describe('scheduled task requests', () => {
  it('asks the Agent to follow the files when the task says nothing else', () => {
    expect(scheduledRunPrompt('', ['workflows/brief.md'])).toBe(
      'Follow the steps in @workflows/brief.md.',
    );
    expect(scheduledRunPrompt(' @a.md @b.md ', ['a.md', 'b.md'])).toBe(
      'Follow the steps in @a.md and @b.md.',
    );
    expect(scheduledRunPrompt('Use @a.md for tone.', ['a.md'])).toBe('Use @a.md for tone.');
  });

  it('shows every named file as a mention in the form', () => {
    expect(taskDraft(task('', ['workflows/brief.md'])).prompt).toBe('@workflows/brief.md');
    expect(taskDraft(task('Pull topics.', ['a.md', 'b.md'])).prompt).toBe(
      'Pull topics. @a.md @b.md',
    );
    expect(taskDraft(task('Use @a.md.', ['a.md'])).prompt).toBe('Use @a.md.');
  });

  it('keeps the start of a reply as one plain line', () => {
    expect(runSummary('## Done\n\nSaved **`briefs/today.md`**.\n')).toBe(
      'Done Saved briefs/today.md.',
    );
    expect(runSummary('Kept write_file and snake_case names.')).toBe(
      'Kept write_file and snake_case names.',
    );
    // A real Codex reply: list items whose files are Markdown links.
    expect(
      runSummary(
        'I reviewed both files:\n\n- [daily-brief.md](daily-brief.md) defines a workflow.\n2. [brief](briefs/b.md) is saved.',
      ),
    ).toBe('I reviewed both files: daily-brief.md defines a workflow. brief is saved.');
    expect(runSummary('Keep 3.5 hours and a - b.')).toBe('Keep 3.5 hours and a - b.');
    expect(runSummary(' \n** **\n')).toBeNull();
    const long = runSummary(`${'word '.repeat(100)}end`);
    expect(long?.length).toBeLessThanOrEqual(300);
    expect(long).toMatch(/^word( word)+…$/u);
  });

  it('quotes a time the file states badly instead of reading another time into it', () => {
    expect(scheduleLabel('08:05', 'en-US')).toBe('Every day at 8:05 AM');
    expect(scheduleLabel('25:00', 'en-US')).toBe('Every day at 25:00');
    expect(scheduleLabel('08:60', 'en-US')).toBe('Every day at 08:60');
  });
});
