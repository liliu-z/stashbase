/**
 * The composer's text field: a CodeMirror document in which a mention is one
 * atomic widget. The chip lives where it was typed, moves with the text, and
 * deletes as one character. The serialized draft the session keeps reads
 * `@path` in the chip's place, which is what the wire prompt and history
 * already understand.
 *
 * A `/` skill is the second marker kind: one token at the head of the
 * document, serializing to nothing, because the server — not the draft —
 * composes the skill into the wire prompt. The owner's `skill` prop is the
 * source of truth; the token is only its projection.
 *
 * This module is the React seam: the view's lifetime, the keymap, and the
 * compartments that follow prop changes. The marker representation, the chip
 * widgets and the document edits live beside it.
 */
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewline,
  invertedEffects,
} from '@codemirror/commands';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import type { InputMessageEditorContext } from '@/components/ui/input-message';
import type { ContextStatus, MentionQuery } from '@/features/agent/domain/context';
import { fontWeights } from '@/lib/font-weight';
import { ambient } from '@/lib/springs';

import {
  chipInPlace,
  chipRuns,
  deleteMentionSelection,
  projectSkill,
  replaceDocument,
} from './mention-document';
import type { MentionListboxBinding } from './mention-listbox';
import {
  addMention,
  MENTION,
  mentionField,
  mentionPaths,
  mentionQuery,
  removeMention,
  serialize,
  setStatuses,
  skillMarker,
  statusField,
} from './mention-markers';
import { mentionDecorations } from './mention-widgets';
import { crossfadePlaceholder } from './placeholder-crossfade';

export { chipRuns, serialize };

export interface MentionEditorHandle {
  focus(): void;
  /** Turn the open `@` query, or the caret, into a chip for `path`. */
  insertMention(path: string): void;
  /** Drop the open `/` query and put the skill token at the document head. */
  insertSkill(label: string): void;
}

export interface MentionEditorProps {
  ctx: InputMessageEditorContext;
  /** Paths whose `@path` runs in an externally supplied value become chips. */
  chipPaths: readonly string[];
  /** Per-path state shown as a dot in the chip; absent means ready. */
  statuses: Readonly<Record<string, ContextStatus>>;
  listbox: MentionListboxBinding;
  /** Whether `/` opens a skill query at all. */
  skillsEnabled: boolean;
  /** The armed skill, projected as the document's leading token. */
  skill: { id: string; label: string } | null;
  onQueryChange(query: MentionQuery | null): void;
  onMentionAdded(path: string): void;
  /** Fired when the last chip for a path leaves the document. */
  onMentionRemoved(path: string): void;
  /** Fired when the skill token leaves the document, so the owner disarms. */
  onSkillRemoved(): void;
}

export const MentionEditor = forwardRef<MentionEditorHandle, MentionEditorProps>(
  function MentionEditor(
    {
      chipPaths,
      ctx,
      listbox,
      onMentionAdded,
      onMentionRemoved,
      onQueryChange,
      onSkillRemoved,
      skill,
      skillsEnabled,
      statuses,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const ctxRef = useRef(ctx);
    const listboxRef = useRef(listbox);
    const onQueryChangeRef = useRef(onQueryChange);
    const onMentionAddedRef = useRef(onMentionAdded);
    const onMentionRemovedRef = useRef(onMentionRemoved);
    const onSkillRemovedRef = useRef(onSkillRemoved);
    const skillRef = useRef(skill);
    const skillsEnabledRef = useRef(skillsEnabled);
    const chipPathsRef = useRef(chipPaths);
    const dismissedRef = useRef(false);
    const editable = useRef(new Compartment());
    const placeholderCompartment = useRef(new Compartment());
    const placeholderFade = useRef(new Compartment());
    const attributes = useRef(new Compartment());
    const theme = useRef(new Compartment());
    ctxRef.current = ctx;
    listboxRef.current = listbox;
    onQueryChangeRef.current = onQueryChange;
    onMentionAddedRef.current = onMentionAdded;
    onMentionRemovedRef.current = onMentionRemoved;
    onSkillRemovedRef.current = onSkillRemoved;
    skillRef.current = skill;
    skillsEnabledRef.current = skillsEnabled;
    chipPathsRef.current = chipPaths;

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
      insertMention: (path) => {
        const view = viewRef.current;
        if (!view) return;
        const query = mentionQuery(view.state);
        const head = view.state.selection.main.head;
        const from = query ? query.from : head;
        const before = view.state.doc.sliceString(Math.max(0, from - 1), from);
        const lead = query || from === 0 || /\s/u.test(before) ? '' : ' ';
        const insert = `${lead}${MENTION} `;
        view.dispatch({
          changes: { from, insert, to: head },
          effects: addMention.of({ fresh: true, from: from + lead.length, kind: 'file', path }),
          selection: { anchor: from + insert.length },
        });
        view.focus();
        onMentionAddedRef.current(path);
      },
      insertSkill: (label) => {
        const view = viewRef.current;
        if (!view) return;
        const query = mentionQuery(view.state, true);
        if (query?.kind === 'skill') {
          view.dispatch({
            changes: { from: query.from, to: view.state.selection.main.head },
            selection: { anchor: query.from },
          });
        }
        projectSkill(view, { label });
        view.focus();
      },
    }));

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const runListboxKey = (key: string) => {
        const box = listboxRef.current;
        if (!box.open) return false;
        if (key === 'ArrowDown') {
          box.onNavigate(1);
          return true;
        }
        if (key === 'ArrowUp') {
          box.onNavigate(-1);
          return true;
        }
        if (key === 'Enter' || key === 'Tab') return box.onAccept();
        if (key === 'Escape') {
          dismissedRef.current = true;
          box.onDismiss();
          onQueryChangeRef.current(null);
          return true;
        }
        return false;
      };
      // Tab on an empty field takes the placeholder as the draft when the
      // composer says it is a request, and only then: a hint is not a draft.
      const acceptPlaceholder = (target: EditorView) => {
        const field = ctxRef.current;
        if (!field.acceptPlaceholder || field.disabled || target.state.doc.length > 0) return false;
        target.dispatch({
          changes: { from: 0, insert: field.placeholder },
          selection: { anchor: field.placeholder.length },
        });
        return true;
      };
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          extensions: [
            history(),
            invertedEffects.of((transaction) =>
              transaction.effects.flatMap((effect) => {
                if (effect.is(addMention)) return [removeMention.of(effect.value)];
                if (effect.is(removeMention)) return [addMention.of(effect.value)];
                return [];
              }),
            ),
            mentionField,
            statusField,
            mentionDecorations,
            EditorView.lineWrapping,
            placeholderCompartment.current.of(placeholder(ctxRef.current.placeholder)),
            placeholderFade.current.of([]),
            editable.current.of(EditorView.editable.of(!ctxRef.current.disabled)),
            attributes.current.of(EditorView.contentAttributes.of({})),
            theme.current.of([]),
            keymap.of([
              { key: 'ArrowDown', run: () => runListboxKey('ArrowDown') },
              { key: 'ArrowUp', run: () => runListboxKey('ArrowUp') },
              {
                key: 'Enter',
                run: () => {
                  if (runListboxKey('Enter')) return true;
                  if (!ctxRef.current.disabled) ctxRef.current.submit();
                  return true;
                },
              },
              { key: 'Shift-Enter', run: insertNewline },
              { key: 'Tab', run: (target) => runListboxKey('Tab') || acceptPlaceholder(target) },
              { key: 'Escape', run: () => runListboxKey('Escape') },
              { key: 'Backspace', run: (target) => deleteMentionSelection(target, true) },
              { key: 'Delete', run: (target) => deleteMentionSelection(target, false) },
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                dismissedRef.current = false;
                ctxRef.current.onValueChange(serialize(update.state));
                const before = mentionPaths(update.startState);
                const after = mentionPaths(update.state);
                for (const path of before) {
                  if (!after.has(path)) onMentionRemovedRef.current(path);
                }
                if (skillMarker(update.startState) && !skillMarker(update.state)) {
                  onSkillRemovedRef.current();
                }
              }
              if (update.docChanged || update.selectionSet) {
                onQueryChangeRef.current(
                  dismissedRef.current
                    ? null
                    : mentionQuery(update.state, skillsEnabledRef.current),
                );
              }
            }),
          ],
        }),
      });
      viewRef.current = view;
      if (ctxRef.current.value) {
        replaceDocument(view, ctxRef.current.value, chipPathsRef.current, skillRef.current);
      } else if (skillRef.current) {
        projectSkill(view, skillRef.current);
      }
      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // The view is built once and owns its own document from then on; every
      // prop it needs at mount is read through a ref, so this effect depends
      // on nothing that can change.
    }, []);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: editable.current.reconfigure(EditorView.editable.of(!ctx.disabled)),
      });
    }, [ctx.disabled]);

    // The first placeholder is set with the state; later ones crossfade in.
    const shownPlaceholder = useRef(ctxRef.current.placeholder);
    useEffect(() => {
      const view = viewRef.current;
      if (!view || shownPlaceholder.current === ctx.placeholder) return;
      shownPlaceholder.current = ctx.placeholder;
      return crossfadePlaceholder(
        view,
        { fade: placeholderFade.current, placeholder: placeholderCompartment.current },
        ctx.placeholder,
      );
    }, [ctx.placeholder]);

    const { fontSize, lineHeight, paddingX, paddingY } = ctx.metrics;
    useEffect(() => {
      viewRef.current?.dispatch({
        effects: theme.current.reconfigure(
          EditorView.theme({
            '&': {
              font: 'inherit',
              fontSize: `calc(${fontSize}px * var(--ui-scale, 1))`,
              lineHeight: `calc(${lineHeight}px * var(--ui-scale, 1))`,
              minHeight: `calc(${lineHeight * ctx.minRows}px * var(--ui-scale, 1) + ${paddingY * 2}px)`,
            },
            '&.cm-focused': { outline: 'none' },
            '.cm-content': {
              caretColor: 'var(--foreground)',
              padding: `${paddingY}px ${paddingX}px`,
            },
            '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
            '.cm-line': { padding: '0' },
            '.cm-placeholder': {
              color: 'var(--muted-foreground)',
              transition: `opacity ${ambient.crossfadeInMs}ms cubic-bezier(0.4, 0, 0.2, 1)`,
            },
            '.cm-content[data-placeholder-fading] .cm-placeholder': {
              opacity: '0',
              transitionDuration: `${ambient.crossfadeOutMs}ms`,
            },
            '.cm-scroller': {
              fontFamily: 'inherit',
              lineHeight: 'inherit',
              maxHeight: `calc(${lineHeight * ctx.maxRows}px * var(--ui-scale, 1) + ${paddingY * 2}px)`,
              overflow: 'auto',
            },
            '.cm-selectionBackground, ::selection': {
              backgroundColor: 'var(--selected) !important',
            },
          }),
        ),
      });
    }, [ctx.maxRows, ctx.minRows, fontSize, lineHeight, paddingX, paddingY]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: attributes.current.reconfigure(
          EditorView.contentAttributes.of({
            // No `aria-expanded`: it belongs to `combobox`, and this stays a
            // multiline `textbox` whose popup comes and goes mid-sentence —
            // swapping the role under a screen reader as `@` is typed reads
            // worse than the attribute buys. The controlled listbox and the
            // active option carry the popup instead, and both are allowed here.
            'aria-activedescendant': listbox.open ? (listbox.activeOptionId ?? '') : '',
            'aria-autocomplete': 'list',
            'aria-controls': listbox.open ? (listbox.controls ?? '') : '',
            'aria-describedby': ctx.ariaDescribedBy ?? '',
            'aria-label': ctx.ariaLabel,
            'aria-multiline': 'true',
            role: 'textbox',
          }),
        ),
      });
    }, [
      ctx.ariaDescribedBy,
      ctx.ariaLabel,
      listbox.activeOptionId,
      listbox.controls,
      listbox.open,
    ]);

    useEffect(() => {
      viewRef.current?.dispatch({ effects: setStatuses.of(statuses) });
    }, [statuses]);

    // External value sync: a cleared draft after send, a queued message
    // pulled back for editing, a starter prefill, or a tile removed from the
    // preview row all arrive as a new value; known paths become chips again.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      if (serialize(view.state) !== ctx.value) replaceDocument(view, ctx.value, chipPaths, skill);
      else chipInPlace(view, chipPaths);
      // The skill is projected after the value so a re-synced document keeps
      // the armed token, whichever of the two changed.
      projectSkill(view, skill);
    }, [chipPaths, ctx.value, skill]);

    return (
      <div
        className="text-foreground"
        ref={hostRef}
        style={{ fontVariationSettings: fontWeights.normal }}
      />
    );
  },
);
