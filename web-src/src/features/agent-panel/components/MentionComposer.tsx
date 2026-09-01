import { useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState, RangeSet, RangeValue, StateEffect, StateField } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, invertedEffects } from '@codemirror/commands';
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, WidgetType } from '@codemirror/view';
import { basename } from '@/common/lib/paths';
import { mentionKeyAction } from '@/features/agent-panel/lib/mentionKeys';
import { handleComposerPaste } from '@/features/agent-panel/lib/clipboardAttachments';

const MENTION = '\uFFFC';

export type MentionQuery = { kind: 'mention' | 'skill'; q: string; from: number } | null;

export type MentionComposerHandle = {
  focus: () => void;
  insertMention: (path: string, query: Exclude<MentionQuery, null>) => void;
  insertSkill: (label: string, query: Exclude<MentionQuery, null>) => void;
  clearQuery: (query: Exclude<MentionQuery, null>) => void;
  submit: () => void;
};

class Mention extends RangeValue {
  // Keep text inserted at the token's right boundary outside the marker range.
  // Otherwise RangeSet mapping expands the range and keepMentionMarkers removes it.
  endSide = -1;

  constructor(readonly path: string, readonly kind: 'file' | 'skill' = 'file') { super(); }

  eq(other: Mention) {
    return this.path === other.path && this.kind === other.kind;
  }
}

class MentionWidget extends WidgetType {
  constructor(private readonly path: string, private readonly kind: 'file' | 'skill') { super(); }

  eq(other: MentionWidget) {
    return this.path === other.path && this.kind === other.kind;
  }

  toDOM() {
    const token = document.createElement('span');
    token.className = this.kind === 'skill' ? 'agent-skill-mention' : 'agent-file-mention';
    token.textContent = this.kind === 'skill' ? `/${this.path}` : basename(this.path);
    token.title = this.path;
    // The chip shows a basename; the full path belongs in the TEXT layer,
    // not an `aria-label`. This span carries no role, so a label on it is
    // dropped outright — the same silence the transcript's own file chip
    // (`renderUserFileMentions`) fixed with an `sr-only` run.
    const spoken = document.createElement('span');
    spoken.className = 'sr-only';
    spoken.textContent = this.kind === 'skill'
      ? ` (selected skill: ${this.path})`
      : ` (file mention: ${this.path})`;
    token.append(spoken);
    return token;
  }
}

type MentionState = { mentions: RangeSet<Mention>; decorations: DecorationSet };

const addMention = StateEffect.define<{ from: number; path: string; kind?: 'file' | 'skill' }>({
  map: (value, changes) => ({ ...value, from: changes.mapPos(value.from, -1) }),
});

const removeMention = StateEffect.define<{ from: number; path: string; kind?: 'file' | 'skill' }>({
  map: (value, changes) => ({ ...value, from: changes.mapPos(value.from, -1) }),
});

const mentionField = StateField.define<MentionState>({
  create: () => buildMentionState(RangeSet.empty),
  update: (value, transaction) => {
    let mentions = keepMentionMarkers(value.mentions.map(transaction.changes), transaction.state.doc);
    for (const effect of transaction.effects) {
      if (effect.is(addMention)) {
        mentions = mentions.update({
          add: [new Mention(effect.value.path, effect.value.kind).range(effect.value.from, effect.value.from + MENTION.length)],
          sort: true,
        });
      } else if (effect.is(removeMention)) {
        mentions = mentions.update({
          filter: (from, _to, mention) => from !== effect.value.from || mention.path !== effect.value.path || mention.kind !== effect.value.kind,
        });
      }
    }
    return buildMentionState(mentions);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).mentions),
  ],
});

function buildMentionState(mentions: RangeSet<Mention>): MentionState {
  const decorations: ReturnType<Decoration['range']>[] = [];
  mentions.between(0, Infinity, (from, to, mention) => {
    decorations.push(Decoration.replace({ widget: new MentionWidget(mention.path, mention.kind) }).range(from, to));
  });
  return { mentions, decorations: Decoration.set(decorations, true) };
}

function keepMentionMarkers(mentions: RangeSet<Mention>, doc: EditorState['doc']) {
  const kept: ReturnType<Mention['range']>[] = [];
  mentions.between(0, doc.length, (from, to, mention) => {
    if (doc.sliceString(from, to) === MENTION) kept.push(mention.range(from, to));
  });
  return RangeSet.of(kept, true);
}

function serialize(state: EditorState) {
  const { mentions } = state.field(mentionField);
  let cursor = 0;
  let text = '';
  mentions.between(0, state.doc.length, (from, to, mention) => {
    text += state.doc.sliceString(cursor, from) + (mention.kind === 'skill' ? '' : `@${mention.path}`);
    cursor = to;
  });
  return text + state.doc.sliceString(cursor);
}

function mentionQuery(state: EditorState): MentionQuery {
  const selection = state.selection.main;
  if (!selection.empty) return null;
  const before = state.doc.sliceString(0, selection.head);
  const match = /(^|\s)([@/])([^\s@/]*)$/.exec(before);
  return match ? { kind: match[2] === '/' ? 'skill' : 'mention', q: match[3], from: selection.head - match[3].length } : null;
}

function deleteMentionSelection(view: EditorView, backward: boolean) {
  const selection = view.state.selection.main;
  const { mentions } = view.state.field(mentionField);
  let from = selection.from;
  let to = selection.to;
  if (selection.empty) {
    const targets: { from: number; to: number }[] = [];
    mentions.between(0, view.state.doc.length, (mentionFrom, mentionTo) => {
      if ((backward && mentionTo === selection.head) || (!backward && mentionFrom === selection.head)) {
        targets.push({ from: mentionFrom, to: mentionTo });
      }
    });
    const target = targets[0];
    if (!target) return false;
    from = target.from;
    to = target.to;
  }

  const removed: StateEffect<{ from: number; path: string; kind?: 'file' | 'skill' }>[] = [];
  mentions.between(from, to, (mentionFrom, mentionTo, mention) => {
    if (mentionFrom < to && mentionTo > from) removed.push(removeMention.of({ from: mentionFrom, path: mention.path, kind: mention.kind }));
  });
  if (!removed.length) return false;
  view.dispatch({ changes: { from, to }, effects: removed });
  return true;
}

export function MentionComposer({
  disabled,
  placeholder: placeholderText,
  onChange,
  onMentionChange,
  onMentionNavigate,
  onMentionAccept,
  onMentionDismiss,
  onShiftTab,
  onSubmit,
  onPasteImages,
  onFocusChange,
  onSkillMarkerRemoved,
  mentionListboxId,
  mentionActiveOptionId,
  mentionOpen,
  ref,
}: {
  disabled: boolean;
  placeholder: string;
  onChange: (text: string) => void;
  onMentionChange: (mention: MentionQuery) => void;
  onMentionNavigate: (direction: 1 | -1) => void;
  onMentionAccept: () => boolean;
  onMentionDismiss: () => void;
  onShiftTab: () => boolean;
  onSubmit: (text: string) => boolean;
  onPasteImages?: (files: File[]) => void;
  onFocusChange: (focused: boolean) => void;
  onSkillMarkerRemoved: () => void;
  mentionListboxId?: string;
  mentionActiveOptionId?: string;
  mentionOpen: boolean;
  ref: React.Ref<MentionComposerHandle>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const disabledRef = useRef(disabled);
  const onChangeRef = useRef(onChange);
  const onMentionChangeRef = useRef(onMentionChange);
  const onMentionNavigateRef = useRef(onMentionNavigate);
  const onMentionAcceptRef = useRef(onMentionAccept);
  const onMentionDismissRef = useRef(onMentionDismiss);
  const onShiftTabRef = useRef(onShiftTab);
  const onSubmitRef = useRef(onSubmit);
  const onPasteImagesRef = useRef(onPasteImages);
  const onFocusChangeRef = useRef(onFocusChange);
  const onSkillMarkerRemovedRef = useRef(onSkillMarkerRemoved);
  const mentionOpenRef = useRef(mentionOpen);
  const mentionDismissedRef = useRef(false);
  const editableCompartmentRef = useRef(new Compartment());
  const placeholderCompartmentRef = useRef(new Compartment());

  disabledRef.current = disabled;
  onChangeRef.current = onChange;
  onMentionChangeRef.current = onMentionChange;
  onMentionNavigateRef.current = onMentionNavigate;
  onMentionAcceptRef.current = onMentionAccept;
  onMentionDismissRef.current = onMentionDismiss;
  onShiftTabRef.current = onShiftTab;
  onSubmitRef.current = onSubmit;
  onPasteImagesRef.current = onPasteImages;
  onFocusChangeRef.current = onFocusChange;
  onSkillMarkerRemovedRef.current = onSkillMarkerRemoved;
  mentionOpenRef.current = mentionOpen;

  function submit() {
    const view = viewRef.current;
    if (!view || !onSubmitRef.current(serialize(view.state))) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length } });
  }

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    insertMention: (path, query) => {
      const view = viewRef.current;
      if (!view) return;
      const from = query.from - 1;
      view.dispatch({
        changes: { from, to: view.state.selection.main.head, insert: MENTION + ' ' },
        effects: addMention.of({ from, path }),
        selection: { anchor: from + MENTION.length + 1 },
      });
      view.focus();
    },
    insertSkill: (label, query) => {
      const view = viewRef.current;
      if (!view) return;
      const from = query.from - 1;
      view.dispatch({
        changes: { from, to: view.state.selection.main.head, insert: MENTION + ' ' },
        effects: addMention.of({ from, path: label, kind: 'skill' }),
        selection: { anchor: from + MENTION.length + 1 },
      });
      view.focus();
    },
    clearQuery: (query) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ changes: { from: query.from - 1, to: view.state.selection.main.head }, selection: { anchor: query.from - 1 } });
      view.focus();
    },
    submit,
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const currentMentionQuery = () => {
      const view = viewRef.current;
      return view && mentionOpenRef.current ? mentionQuery(view.state) : null;
    };
    const runMentionKey = (key: string) => {
      const action = mentionKeyAction(key, Boolean(currentMentionQuery()));
      if (action === 'next') {
        onMentionNavigateRef.current(1);
        return true;
      }
      if (action === 'previous') {
        onMentionNavigateRef.current(-1);
        return true;
      }
      if (action === 'accept') return onMentionAcceptRef.current();
      if (action === 'dismiss') {
        mentionDismissedRef.current = true;
        onMentionDismissRef.current();
        return true;
      }
      return false;
    };
    const view = new EditorView({
      state: EditorState.create({
        extensions: [
          history(),
          invertedEffects.of((transaction) => transaction.effects.flatMap((effect) => {
            if (effect.is(addMention)) return [removeMention.of(effect.value)];
            if (effect.is(removeMention)) return [addMention.of(effect.value)];
            return [];
          })),
          mentionField,
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            paste: (event) => {
              return handleComposerPaste(event.clipboardData, disabledRef.current, onPasteImagesRef.current);
            },
            focus: () => {
              onFocusChangeRef.current(true);
              return false;
            },
            blur: () => {
              onFocusChangeRef.current(false);
              return false;
            },
          }),
          placeholderCompartmentRef.current.of(placeholder(placeholderText)),
          editableCompartmentRef.current.of(EditorView.editable.of(!disabledRef.current)),
          keymap.of([
            {
              key: 'ArrowDown',
              run: () => runMentionKey('ArrowDown'),
            },
            {
              key: 'ArrowUp',
              run: () => runMentionKey('ArrowUp'),
            },
            {
              key: 'Enter',
              run: () => {
                if (runMentionKey('Enter')) return true;
                if (disabledRef.current) return true;
                submit();
                return true;
              },
            },
            {
              key: 'Tab',
              run: () => runMentionKey('Tab'),
            },
            { key: 'Shift-Tab', run: () => onShiftTabRef.current() },
            {
              key: 'Escape',
              run: () => runMentionKey('Escape'),
            },
            { key: 'Backspace', run: (view) => deleteMentionSelection(view, true) },
            { key: 'Delete', run: (view) => deleteMentionSelection(view, false) },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              mentionDismissedRef.current = false;
              onChangeRef.current(serialize(update.state));
              let hasSkillMarker = false;
              update.state.field(mentionField).mentions.between(0, update.state.doc.length, (_from, _to, marker) => {
                if (marker.kind === 'skill') hasSkillMarker = true;
              });
              if (!hasSkillMarker) onSkillMarkerRemovedRef.current();
            }
            if (update.docChanged || update.selectionSet) {
              onMentionChangeRef.current(mentionDismissedRef.current ? null : mentionQuery(update.state));
            }
          }),
          EditorView.theme({
            // Scaled like every other chrome text (text-base = 13px at
            // scale 1) — a raw px here was the one input that ignored the
            // UI-scale setting.
            // Two lines of room at rest, auto-growing to ~9 while
            // composing. One line made the field read as a single-line
            // input — a box you drop a sentence into — when the thing it
            // actually invites is a paragraph; the second line of empty
            // space is what says "write as much as you want".
            //
            // Driven by a CSS VARIABLE, not by an outside rule: this
            // theme is injected into <head> at runtime, so a stylesheet
            // override of `.cm-editor` ties on specificity and loses on
            // order — which is exactly how the hero's taller composer
            // silently stopped applying. Callers raise the resting
            // height by setting `--composer-min-h` on any ancestor.
            '&': { minHeight: 'var(--composer-min-h, 48px)', maxHeight: '192px', font: 'inherit', fontSize: 'calc(13px * var(--ui-scale))' },
            '&.cm-focused': { outline: 'none' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: '1.5' },
            '.cm-content': { minHeight: 'calc(var(--composer-min-h, 48px) - 8px)', padding: '8px 2px 0', caretColor: 'var(--fg)' },
            // Tertiary, not secondary: at --muted the placeholder reads
            // as typed text and outweighs the (smaller) control labels.
            // Derived via alpha so both themes dim proportionally.
            '.cm-placeholder': { color: 'var(--text-placeholder)' },
          }),
          EditorView.contentAttributes.of({ 'aria-label': 'Message agent' }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      onFocusChangeRef.current(false);
      view.destroy();
      viewRef.current = null;
    };
  // The editor owns its document; callbacks are kept current in refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(!disabled)) });
  }, [disabled]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: placeholderCompartmentRef.current.reconfigure(placeholder(placeholderText)) });
  }, [placeholderText]);

  useEffect(() => {
    const input = viewRef.current?.contentDOM;
    if (!input) return;
    if (!mentionOpen) {
      input.removeAttribute('role');
      input.removeAttribute('aria-autocomplete');
      input.removeAttribute('aria-haspopup');
      input.removeAttribute('aria-controls');
      input.removeAttribute('aria-expanded');
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', String(Boolean(mentionListboxId)));
    if (mentionListboxId) input.setAttribute('aria-controls', mentionListboxId);
    // Focus stays in the editor, so the active row is announced through
    // activedescendant rather than by moving focus into the list.
    if (mentionActiveOptionId) input.setAttribute('aria-activedescendant', mentionActiveOptionId);
    else input.removeAttribute('aria-activedescendant');
  }, [mentionActiveOptionId, mentionListboxId, mentionOpen]);

  return <div ref={hostRef} className="agent-input" />;
}
