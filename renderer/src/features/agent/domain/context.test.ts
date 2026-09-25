import { describe, expect, it } from 'vite-plus/test';

import {
  addContextItem,
  applyMention,
  contextItemKey,
  contextItemName,
  mentionQueryAt,
  PASSAGE_QUOTE_LIMIT,
  passageContextItem,
  rankMentionSuggestions,
  removeContextItem,
  removeMentionText,
  segmentFileMentions,
  staleContext,
  validateContext,
  type AgentContextItem,
  type AgentScopeListing,
} from './context';
import { renderPromptContext } from './prompt-context';

const listing: AgentScopeListing = {
  files: [
    { format: 'md', path: 'docs/archive/agent-panel.md' },
    { format: 'md', path: 'docs/agent.md' },
    { format: 'md', path: 'agent-notes.md' },
    { format: 'md', path: 'notes/agent.md' },
    { format: 'md', path: 'readme.md' },
    { format: 'generic', path: 'agent.bin' },
  ],
  folders: ['docs', 'docs/archive', 'social/x-posts'],
};

const source = (path: string, format: 'md' | 'pdf' = 'md'): AgentContextItem => ({
  boundVersion: null,
  format,
  kind: 'source',
  source: { folderPath: '/Library/Research', path },
});

const passage = (path: string, quote: string): AgentContextItem => {
  const item = passageContextItem({ folderPath: '/Library/Research', path }, quote);
  if (!item) throw new Error('empty passage');
  return item;
};

const transient: AgentContextItem = {
  kind: 'transient',
  name: 'screen shot.png',
  path: '/tmp/stashbase-attachments/batch/screen shot.png',
};

describe('context items', () => {
  it('keys, names, adds without duplicates, and removes by key', () => {
    const a = source('docs/agent.md');
    expect(contextItemKey(a)).toBe('source:/Library/Research/docs/agent.md');
    expect(contextItemKey(transient)).toBe(
      'transient:/tmp/stashbase-attachments/batch/screen shot.png',
    );
    expect(contextItemName(a)).toBe('agent.md');
    expect(contextItemName(transient)).toBe('screen shot.png');
    const once = addContextItem([], a);
    const twice = addContextItem(once, { ...a });
    expect(twice).toEqual([a]);
    expect(addContextItem(twice, transient)).toEqual([a, transient]);
    expect(removeContextItem([a, transient], contextItemKey(a))).toEqual([transient]);
  });

  it('keeps two passages of one file, and the file itself, apart', () => {
    const first = passage('docs/agent.md', 'First paragraph.');
    const keys = [
      contextItemKey(first),
      contextItemKey(passage('docs/agent.md', 'Second paragraph.')),
      contextItemKey(source('docs/agent.md')),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(contextItemKey(passage('docs/agent.md', '  First paragraph.\n'))).toBe(keys[0]);
    expect(addContextItem([first], passage('docs/agent.md', 'First paragraph.'))).toEqual([first]);
    expect(passageContextItem({ folderPath: '/Library/Research', path: 'a.md' }, ' \n ')).toBe(
      null,
    );
  });
});

describe('mention ranking', () => {
  it('prioritizes exact filename and prefix matches and skips generic files', () => {
    expect(rankMentionSuggestions(listing, 'agent').map((s) => s.path)).toEqual([
      'docs/agent.md',
      'notes/agent.md',
      'agent-notes.md',
      'docs/archive/agent-panel.md',
    ]);
  });

  it('is stable for an empty query, caps results, and includes folders', () => {
    expect(rankMentionSuggestions(listing, '', [], 2).map((s) => s.path)).toEqual([
      'docs',
      'docs/archive',
    ]);
    expect(rankMentionSuggestions(listing, 'archive').map((s) => [s.path, s.kind])).toEqual([
      ['docs/archive', 'folder'],
      ['docs/archive/agent-panel.md', 'file'],
    ]);
  });

  it('ignores punctuation, case, and accents and returns nothing without a listing', () => {
    expect(rankMentionSuggestions(listing, 'xpos').map((s) => s.path)).toEqual(['social/x-posts']);
    expect(
      rankMentionSuggestions(
        { files: [{ format: 'md', path: 'Docs/Résumé 2026/案例-总结.md' }], folders: [] },
        'resume/2026案例总结',
      ),
    ).toEqual([{ format: 'md', kind: 'file', path: 'Docs/Résumé 2026/案例-总结.md' }]);
    expect(rankMentionSuggestions(null, 'agent')).toEqual([]);
  });

  it('leads with the open documents and keeps them ahead of equal scores', () => {
    expect(rankMentionSuggestions(listing, '', ['notes/agent.md'], 3).map((s) => s.path)).toEqual([
      'notes/agent.md',
      'docs',
      'docs/archive',
    ]);
    expect(rankMentionSuggestions(listing, 'agent', ['notes/agent.md']).map((s) => s.path)).toEqual(
      ['notes/agent.md', 'docs/agent.md', 'agent-notes.md', 'docs/archive/agent-panel.md'],
    );
    // Being open never outranks a closer match.
    expect(
      rankMentionSuggestions(listing, 'archive', ['docs/archive/agent-panel.md']).map(
        (s) => s.path,
      ),
    ).toEqual(['docs/archive', 'docs/archive/agent-panel.md']);
  });
});

describe('mention text editing', () => {
  it('finds an open query at the start or after whitespace only', () => {
    expect(mentionQueryAt('@ag', 3)).toEqual({ from: 0, kind: 'mention', query: 'ag' });
    expect(mentionQueryAt('read @docs/ag', 13)).toEqual({
      from: 5,
      kind: 'mention',
      query: 'docs/ag',
    });
    expect(mentionQueryAt('read @', 6)).toEqual({ from: 5, kind: 'mention', query: '' });
    expect(mentionQueryAt('mail@example', 12)).toBeNull();
    expect(mentionQueryAt('read @docs/agent.md ', 20)).toBeNull();
    expect(mentionQueryAt('read @docs/agent.md now', 12)).toEqual({
      from: 5,
      kind: 'mention',
      query: 'docs/a',
    });
  });

  it('applies and removes a mention run at the end and in the middle', () => {
    const end = applyMention(
      'read @ag',
      { from: 5, kind: 'mention', query: 'ag' },
      'docs/agent.md',
    );
    expect(end).toEqual({ caret: 20, text: 'read @docs/agent.md ' });
    expect(removeMentionText(end.text, 'docs/agent.md')).toBe('read ');

    const middle = applyMention(
      'read @ag now',
      { from: 5, kind: 'mention', query: 'ag' },
      'docs/agent.md',
    );
    expect(middle).toEqual({ caret: 19, text: 'read @docs/agent.md now' });
    expect(removeMentionText(middle.text, 'docs/agent.md')).toBe('read now');

    expect(removeMentionText('@docs/agent.md first', 'docs/agent.md')).toBe('first');
    expect(removeMentionText('see @docs/agent.md', 'docs/agent.md')).toBe('see');
    expect(removeMentionText('see @docs/agent.md.bak', 'docs/agent.md')).toBe(
      'see @docs/agent.md.bak',
    );
  });
});

describe('context validation', () => {
  const scope = { kind: 'folder', path: '/Library/Research' } as const;

  it('reports each status and lets only stale items block a send', () => {
    const items = [
      source('docs/agent.md'),
      source('gone.md'),
      source('paper.pdf', 'pdf'),
      source('scan.pdf', 'pdf'),
      source('talk.pdf', 'pdf'),
      transient,
    ];
    const validations = validateContext(items, {
      listing: {
        files: [
          { format: 'md', path: 'docs/agent.md' },
          { format: 'pdf', path: 'paper.pdf' },
          { format: 'pdf', path: 'scan.pdf' },
          { format: 'pdf', path: 'talk.pdf' },
        ],
        folders: [],
      },
      readiness: { 'paper.pdf': 'pending', 'scan.pdf': 'failed', 'talk.pdf': 'blocked' },
      scope,
    });
    expect(validations.map((v) => [v.status, v.reason])).toEqual([
      ['ready', null],
      ['stale', 'This file is no longer in the folder.'],
      ['preparing', 'Searchable text is still being prepared.'],
      ['failed', 'Preparation failed; the Agent gets the source only.'],
      ['blocked', 'Preparation is blocked.'],
      ['ready', null],
    ]);
    expect(staleContext(validations).map((v) => v.item)).toEqual([source('gone.md')]);
  });

  it('treats a project scope or another folder as stale and an unknown listing as ready', () => {
    expect(
      validateContext([source('docs/agent.md')], {
        listing: null,
        readiness: {},
        scope: { kind: 'folder', path: '/project/Research' },
      })[0],
    ).toMatchObject({ reason: 'This file belongs to a different folder.', status: 'stale' });
    expect(
      validateContext([source('docs/agent.md')], {
        listing: null,
        readiness: {},
        scope: { kind: 'folder', path: '/Library/Other' },
      })[0]?.status,
    ).toBe('stale');
    expect(
      validateContext([source('docs/agent.md')], { listing: null, readiness: {}, scope })[0]
        ?.status,
    ).toBe('ready');
  });

  it('refuses a passage only when its file left the folder or it is too long', () => {
    const validations = validateContext(
      [
        passage('docs/agent.md', 'Short.'),
        passage('docs/agent.md', 'x'.repeat(PASSAGE_QUOTE_LIMIT + 1)),
        passage('gone.md', 'Short.'),
      ],
      {
        listing,
        // A pending or changed file does not matter: the quote travels itself.
        readiness: { 'docs/agent.md': 'pending' },
        scope,
        versions: { 'docs/agent.md': 7 },
      },
    );
    expect(validations.map((v) => v.status)).toEqual(['ready', 'stale', 'stale']);
    expect(validations[1]?.reason).toContain('longer than');
    expect(validations[2]?.reason).toBe('This file is no longer in the folder.');
  });
});

describe('prompt rendering', () => {
  it('leaves text alone without context and renders the legacy suffix otherwise', () => {
    expect(renderPromptContext('hello', [])).toBe('hello');
    const rendered = renderPromptContext('Summarize these.', [
      { item: source('notes.md'), resolved: null },
      {
        item: source('paper.pdf', 'pdf'),
        resolved: {
          available: true,
          kind: 'derived',
          path: '/Library/Research/paper.pdf',
          readPath: '/AppData/derived/paper.md',
          reason: '',
          sourceFormat: 'pdf',
          sourcePath: 'paper.pdf',
        },
      },
      {
        item: source('scan.pdf', 'pdf'),
        resolved: {
          available: false,
          kind: 'direct',
          path: '/Library/Research/scan.pdf',
          readPath: 'scan.pdf',
          reason: 'Searchable text is pending or preparation failed.',
          sourceFormat: 'pdf',
          sourcePath: 'scan.pdf',
        },
      },
      { item: transient, resolved: null },
    ]);
    expect(rendered).toBe(
      [
        'Summarize these.',
        '',
        'Attached files:',
        '- /Library/Research/notes.md',
        '- paper.pdf (for text context, use mcp__stashbase__read_file with path /Library/Research/paper.pdf; it returns the derived text representation for this pdf)',
        '- scan.pdf (derived text is not available yet; Searchable text is pending or preparation failed.)',
        '- /tmp/stashbase-attachments/batch/screen shot.png',
      ].join('\n'),
    );
    expect(renderPromptContext('', [{ item: transient, resolved: null }])).toBe(
      'Attached files:\n- /tmp/stashbase-attachments/batch/screen shot.png',
    );
  });

  it('renders passages as quoted blocks ahead of the attached files', () => {
    const rendered = renderPromptContext('Tighten these.', [
      { item: source('notes.md'), resolved: null },
      { item: passage('docs/agent.md', 'First line.\n\nThird line.'), resolved: null },
      { item: passage('notes.md', 'Only line.'), resolved: null },
    ]);
    expect(rendered).toBe(
      [
        'Tighten these.',
        '',
        'Selected passages:',
        '- /Library/Research/docs/agent.md',
        '  > First line.',
        '  >',
        '  > Third line.',
        '- /Library/Research/notes.md',
        '  > Only line.',
        '',
        'Attached files:',
        '- /Library/Research/notes.md',
      ].join('\n'),
    );
    expect(renderPromptContext('', [{ item: passage('a.md', 'Quote.'), resolved: null }])).toBe(
      'Selected passages:\n- /Library/Research/a.md\n  > Quote.',
    );
  });
});

describe('file mention segmentation', () => {
  it('chips @ mentions, bare paths, and attachment paths while keeping prose as text', () => {
    expect(segmentFileMentions('See @topic/note.md and docs/a.pdf now')).toEqual([
      { kind: 'text', text: 'See' },
      { kind: 'text', text: ' ' },
      { kind: 'mention', path: 'topic/note.md', start: 3 },
      { kind: 'text', text: ' and' },
      { kind: 'text', text: ' ' },
      { kind: 'mention', path: 'docs/a.pdf', start: 22 },
      { kind: 'text', text: ' now' },
    ]);
    const attached = '/tmp/batch/screen shot.png';
    expect(segmentFileMentions(`Look at ${attached}.`, [attached])).toEqual([
      { kind: 'text', text: 'Look at ' },
      { kind: 'mention', path: attached, start: 8 },
      { kind: 'text', text: '.' },
    ]);
    expect(segmentFileMentions('Read the README.md first')).toEqual([
      { kind: 'text', text: 'Read the README.md first' },
    ]);
  });
});
