/**
 * Edits that keep the document and the owner's props in agreement: chipping
 *  the `@path` runs in a value that arrived from outside, projecting the armed
 *  skill as the leading token, and deleting a chip as one character. Every
 *  function here dispatches to a live view; the pure `chipRuns` is the one it
 *  all rests on, and is exercised on its own. */
import { isolateHistory } from '@codemirror/commands';
import { Transaction, type StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import {
  addMention,
  MENTION,
  mentionField,
  removeMention,
  skillMarker,
  type MentionEffect,
} from './mention-markers';

/** Dictation is one undo step and leaves existing mention widgets intact. */
export function appendDictation(view: EditorView, snapshot: { before: string; after: string }) {
  const suffix = snapshot.after.slice(snapshot.before.length);
  view.dispatch({
    changes: { from: view.state.doc.length, insert: suffix },
    selection: { anchor: view.state.doc.length + suffix.length },
    annotations: isolateHistory.of('full'),
  });
}

export function deleteMentionSelection(view: EditorView, backward: boolean) {
  if (view.state.readOnly) return false;
  const selection = view.state.selection.main;
  const mentions = view.state.field(mentionField);
  let from = selection.from;
  let to = selection.to;
  if (selection.empty) {
    const targets: { from: number; to: number }[] = [];
    mentions.between(0, view.state.doc.length, (mentionFrom, mentionTo) => {
      if (
        (backward && mentionTo === selection.head) ||
        (!backward && mentionFrom === selection.head)
      ) {
        targets.push({ from: mentionFrom, to: mentionTo });
      }
    });
    const target = targets[0];
    if (!target) return false;
    from = target.from;
    to = target.to;
  }
  const removed: StateEffect<MentionEffect>[] = [];
  mentions.between(from, to, (mentionFrom, mentionTo, mention) => {
    if (mentionFrom < to && mentionTo > from) {
      removed.push(
        removeMention.of({
          fresh: false,
          from: mentionFrom,
          kind: mention.kind,
          path: mention.path,
        }),
      );
    }
  });
  if (!removed.length) return false;
  // The skill token owns the single space that seats it, so deleting the
  // token does not leave the draft starting with one.
  const skillDeleted = removed.some((effect) => effect.value.kind === 'skill');
  const end =
    selection.empty && skillDeleted && view.state.doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
  view.dispatch({ changes: { from, to: end }, effects: removed });
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** `@path` runs in plain text, for every known path, left to right. */
export function chipRuns(
  text: string,
  paths: readonly string[],
): Array<{ from: number; path: string; to: number }> {
  const runs: Array<{ from: number; path: string; to: number }> = [];
  for (const path of paths) {
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(path)}(?=$|\\s)`, 'gu');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const from = match.index + (match[1]?.length ?? 0);
      runs.push({ from, path, to: from + 1 + path.length });
    }
  }
  runs.sort((a, b) => a.from - b.from || b.to - a.to);
  // Overlapping runs keep the earliest, longest one.
  const kept: typeof runs = [];
  let coveredTo = -1;
  for (const run of runs) {
    if (run.from < coveredTo) continue;
    kept.push(run);
    coveredTo = run.to;
  }
  return kept;
}

/** Replace the whole document with `text`, chipping the known paths. The
 *  armed skill is re-added with it: a replacement drops every marker, and
 *  the token is the projection of a prop the document does not own. */
export function replaceDocument(
  view: EditorView,
  text: string,
  paths: readonly string[],
  skill: { label: string } | null,
  recordHistory = true,
) {
  const runs = chipRuns(text, paths);
  let result = skill ? `${MENTION} ` : '';
  let cursor = 0;
  const effects: StateEffect<MentionEffect>[] = skill
    ? [addMention.of({ fresh: false, from: 0, kind: 'skill', path: skill.label })]
    : [];
  for (const run of runs) {
    result += text.slice(cursor, run.from);
    effects.push(
      addMention.of({ fresh: false, from: result.length, kind: 'file', path: run.path }),
    );
    result += MENTION;
    cursor = run.to;
  }
  result += text.slice(cursor);
  view.dispatch({
    changes: { from: 0, insert: result, to: view.state.doc.length },
    ...(recordHistory ? {} : { annotations: Transaction.addToHistory.of(false) }),
    effects,
    selection: { anchor: result.length },
  });
}

/** Insert, remove, or relabel the leading skill token so the document shows
 *  exactly the skill the owner has armed. */
export function projectSkill(view: EditorView, skill: { label: string } | null) {
  const marker = skillMarker(view.state);
  if (marker && marker.path === skill?.label) return;
  if (marker) {
    const spaced = view.state.doc.sliceString(marker.to, marker.to + 1) === ' ';
    view.dispatch({
      changes: { from: marker.from, to: spaced ? marker.to + 1 : marker.to },
      effects: removeMention.of({
        fresh: false,
        from: marker.from,
        kind: 'skill',
        path: marker.path,
      }),
    });
  }
  if (!skill) return;
  const caret = view.state.selection.main.head;
  const insert = `${MENTION} `;
  view.dispatch({
    changes: { from: 0, insert },
    effects: addMention.of({ fresh: true, from: 0, kind: 'skill', path: skill.label }),
    selection: { anchor: caret + insert.length },
  });
}

/** Chip `@path` runs still sitting as plain text in the live document. */
export function chipInPlace(view: EditorView, paths: readonly string[]) {
  const runs = chipRuns(view.state.doc.toString(), paths);
  if (runs.length === 0) return;
  // Right to left, so earlier offsets survive each replacement; effect
  // positions are in the post-change document.
  const changes = runs.map((run) => ({ from: run.from, insert: MENTION, to: run.to }));
  const changeSet = view.state.changes(changes);
  view.dispatch({
    changes: changeSet,
    effects: runs.map((run) =>
      addMention.of({
        fresh: false,
        from: changeSet.mapPos(run.from, -1),
        kind: 'file',
        path: run.path,
      }),
    ),
  });
}
