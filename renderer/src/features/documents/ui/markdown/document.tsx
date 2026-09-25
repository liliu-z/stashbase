/**
 * The Markdown surface. Reading and writer modes share one Milkdown editor
 * instance per tab so selection, history, and scroll survive a mode switch,
 * and the heading outline is published from the live document.
 */
import { languages } from '@codemirror/language-data';
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { blockEdit } from '@milkdown/crepe/feature/block-edit';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { latex } from '@milkdown/crepe/feature/latex';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { table } from '@milkdown/crepe/feature/table';
import { toolbar } from '@milkdown/crepe/feature/toolbar';
import { replaceAll } from '@milkdown/kit/utils';
import { BookOpen, PenLine } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { TabsSubtle, TabsSubtleItem } from '@/components/ui/tabs-subtle';
import { startMarkdownEditorCreation } from '@/features/documents/application/markdown-editor-lifecycle';
import type { DocumentNavigationRuntime } from '@/features/documents/application/navigation-runtime';
import type { MarkdownViewMode } from '@/features/documents/domain/document';
import { resolveDocumentLink } from '@/features/documents/domain/link-target';
import { splitLeadingYamlFrontmatter } from '@/features/documents/domain/markdown';
import type { DocumentHeading } from '@/features/documents/domain/outline';
import type { DocumentSelection } from '@/features/documents/domain/selection';
import { cn } from '@/lib/utils';
import type { SourceReference } from '@/shared/domain/source-reference';
import { writeToClipboard } from '@/shared/ui/clipboard';

import { watchMarkdownChanges } from './changes';
import { createMarkdownFindController } from './find-controller';
import { HumanizeNotice } from './humanize-notice';
import { MarkdownOpenFailure } from './open-failure';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import './document.css';
import {
  activeHeadingId,
  applyHeadingIds,
  currentEditorView,
  documentScroller,
  extractDocumentHeadings,
  headingElementAtPosition,
  headingsForView,
  scrollOutlineToHeading,
  type ProseMirrorDocument,
} from './outline-adapter';
import { useAskAgent } from './selection-markdown';
import { selectionToolbar } from './selection-toolbar';
import { useHumanize, type HumanizeBinding } from './use-humanize';
import { useRevisionReview, type RevisionBinding } from './use-revision-review';

type CreationState = 'creating' | 'failed' | 'ready';

export interface MarkdownDocumentProps {
  active: boolean;
  canChangeMode: boolean;
  dirty: boolean;
  /** Humanize on the selection toolbar. Absent where no rewrite service is
   *  wired, and then the toolbar offers no such control. */
  humanize?: HumanizeBinding | undefined;
  mode: MarkdownViewMode;
  name: string;
  /** Ask Agent on the selection toolbar, with the exact selection. Absent
   *  where no Agent sits beside the document. */
  onAskAgent?: ((selection: DocumentSelection) => void) | undefined;
  onChange(value: string): void;
  onNavigate(target: { anchor?: string | undefined; source: SourceReference }): void;
  onModeChange(mode: MarkdownViewMode): void;
  onOpenExternal(href: string): Promise<boolean>;
  navigation: DocumentNavigationRuntime;
  readOnly: boolean;
  /** The review the document runtime holds, and what this surface reports
   *  back to it. */
  revision: RevisionBinding;
  source: SourceReference;
  tabId: string;
  value: string;
}

/** One retained Milkdown model whose editable boundary changes in place. */
export function MarkdownDocument({
  active,
  canChangeMode,
  dirty,
  humanize,
  mode,
  name,
  onAskAgent,
  onChange,
  onNavigate,
  onModeChange,
  onOpenExternal,
  navigation,
  readOnly,
  revision,
  source,
  tabId,
  value,
}: MarkdownDocumentProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<CrepeBuilder | null>(null);
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);
  const valueRef = useRef(value);
  const activeRef = useRef(active);
  const navigateRef = useRef(onNavigate);
  const openExternalRef = useRef(onOpenExternal);
  const sourceRef = useRef(source);
  const observedValueRef = useRef(value);
  const frontmatterRef = useRef(splitLeadingYamlFrontmatter(value).source);
  const suppressChangeRef = useRef(false);
  const headingSnapshotRef = useRef<{
    document: ProseMirrorDocument;
    headings: DocumentHeading[];
  } | null>(null);
  const refreshHeadingsRef = useRef<() => void>(() => undefined);
  const registrationOwnerRef = useRef(Symbol(tabId));
  const [attempt, setAttempt] = useState(0);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [creationState, setCreationState] = useState<CreationState>('creating');
  const [headings, setHeadings] = useState<DocumentHeading[]>([]);
  const [linkFailure, setLinkFailure] = useState(false);
  const {
    active: reviewActive,
    attach: attachReview,
    bar: reviewBar,
  } = useRevisionReview({ creationState, revision });
  const humanizeControls = useHumanize(humanize, editorRef);
  // `run` is stable, so the toolbar built with the editor keeps it without a ref.
  const humanizeRun = humanize === undefined ? null : humanizeControls.run;
  const askAgentRun = useAskAgent(onAskAgent, source);
  const pendingAnchor = useStore(navigation.store, (state) =>
    state.pendingAnchor?.tabId === tabId ? state.pendingAnchor.id : null,
  );
  activeRef.current = active;
  navigateRef.current = onNavigate;
  openExternalRef.current = onOpenExternal;
  sourceRef.current = source;
  onChangeRef.current = onChange;
  readOnlyRef.current = readOnly;
  valueRef.current = value;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    setCreationState('creating');
    setHeadings([]);
    setActiveHeading(null);
    headingSnapshotRef.current = null;
    const initial = splitLeadingYamlFrontmatter(valueRef.current);
    frontmatterRef.current = initial.source;
    observedValueRef.current = valueRef.current;

    const editor = new CrepeBuilder({ root: host, defaultValue: initial.body })
      .addFeature(placeholder, { mode: 'block', text: 'Start writing… or type /' })
      .addFeature(cursor)
      .addFeature(listItem)
      .addFeature(linkTooltip, {
        inputPlaceholder: 'Paste a URL or file path…',
        onCopyLink: (href) =>
          void writeToClipboard(href).catch(() => {
            // swallowed: the link tooltip is already gone by the time a refusal
            // lands, so there is no longer a surface to report it on.
          }),
      })
      .addFeature(blockEdit)
      .addFeature(
        toolbar,
        selectionToolbar({
          askAgent: askAgentRun,
          humanize: humanizeRun ? () => humanizeRun(editor) : undefined,
        }),
      )
      .addFeature(table)
      .addFeature(codeMirror, { copyText: 'Copy code', languages })
      .addFeature(latex);
    const releaseReview = attachReview(editor);
    const updateHeadings = () => {
      const view = currentEditorView(editor);
      if (!view) {
        setHeadings([]);
        return;
      }
      const cached = headingSnapshotRef.current;
      if (cached?.document === view.state.doc) {
        setHeadings(cached.headings);
        return;
      }
      const next = extractDocumentHeadings(view.state.doc);
      headingSnapshotRef.current = { document: view.state.doc, headings: next };
      setHeadings(next);
    };
    refreshHeadingsRef.current = updateHeadings;
    editor.setReadonly(readOnlyRef.current);
    watchMarkdownChanges(editor, (markdown) => {
      if (readOnlyRef.current || suppressChangeRef.current) return;
      onChangeRef.current(frontmatterRef.current + markdown);
      updateHeadings();
    });

    const stopCreation = startMarkdownEditorCreation(editor, {
      failed: () => {
        setCreationState('failed');
        if (activeRef.current) navigation.setOutlineFailed(tabId, true);
      },
      ready: () => {
        editorRef.current = editor;
        editor.setReadonly(readOnlyRef.current);
        updateHeadings();
        setCreationState('ready');
      },
    });

    return () => {
      if (editorRef.current === editor) editorRef.current = null;
      releaseReview();
      if (refreshHeadingsRef.current === updateHeadings) {
        refreshHeadingsRef.current = () => undefined;
      }
      stopCreation();
    };
  }, [askAgentRun, attachReview, attempt, humanizeRun, navigation, tabId]);

  useEffect(() => {
    editorRef.current?.setReadonly(readOnly);
  }, [readOnly]);

  useEffect(() => {
    const editor = editorRef.current;
    // An open review holds the document against the version it was computed
    // for, and nothing accepted yet leaves the buffer clean, so a background
    // reconcile would otherwise replace the text the review describes.
    if (!editor || creationState !== 'ready' || dirty || reviewActive) return;
    if (observedValueRef.current === value) return;
    observedValueRef.current = value;
    const incoming = splitLeadingYamlFrontmatter(value);
    frontmatterRef.current = incoming.source;
    if (editor.getMarkdown() === incoming.body) return;
    suppressChangeRef.current = true;
    editor.editor.action(replaceAll(incoming.body));
    queueMicrotask(() => {
      suppressChangeRef.current = false;
      refreshHeadingsRef.current();
    });
  }, [creationState, dirty, reviewActive, value]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const routeLink = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a');
      if (!anchor) return;
      event.preventDefault();
      const target = resolveDocumentLink(anchor.getAttribute('href') ?? '', sourceRef.current);
      if (target.kind === 'anchor') {
        navigateRef.current({ anchor: target.id, source: sourceRef.current });
      } else if (target.kind === 'source') {
        navigateRef.current({ anchor: target.anchor, source: target.source });
      } else if (target.kind === 'external') {
        setLinkFailure(false);
        void openExternalRef
          .current(target.href)
          .then((opened) => setLinkFailure(!opened))
          .catch(() => setLinkFailure(true));
      }
    };
    host.addEventListener('click', routeLink);
    return () => host.removeEventListener('click', routeLink);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const frame = requestAnimationFrame(() => applyHeadingIds(host, headings));
    return () => cancelAnimationFrame(frame);
  }, [headings]);

  useEffect(() => {
    if (!active || creationState !== 'ready') return;
    const owner = registrationOwnerRef.current;
    return navigation.claimOutline(tabId, owner);
  }, [active, creationState, navigation, tabId]);

  useEffect(() => {
    if (!active || creationState !== 'ready') return;
    navigation.publishOutline(
      tabId,
      registrationOwnerRef.current,
      { activeId: activeHeading, headings },
      (heading) =>
        scrollOutlineToHeading(
          hostRef.current,
          heading,
          currentEditorView(editorRef.current),
          hostRef.current?.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)')
            .matches ?? true,
        ),
    );
  }, [active, activeHeading, creationState, headings, navigation, tabId]);

  useEffect(() => {
    if (!active || creationState !== 'ready') return;
    const host = hostRef.current;
    const proseMirror = host?.querySelector<HTMLElement>('.ProseMirror');
    if (!host || !proseMirror) return;
    const controller = createMarkdownFindController(proseMirror, documentScroller(host));
    const release = navigation.claimFind(tabId, registrationOwnerRef.current, controller);
    return () => {
      release();
      controller.dispose();
    };
  }, [active, creationState, navigation, tabId]);

  useEffect(() => {
    if (!active || creationState !== 'ready' || headings.length === 0) return;
    const host = hostRef.current;
    if (!host) return;
    const scroller = documentScroller(host);
    const update = () => {
      const view = currentEditorView(editorRef.current);
      const currentHeadings = headingsForView(view, headingSnapshotRef);
      const threshold = scroller.getBoundingClientRect().top + 16;
      const positions = currentHeadings.flatMap((heading) => {
        const element = headingElementAtPosition(view, heading.position);
        return element ? [{ id: heading.id, top: element.getBoundingClientRect().top }] : [];
      });
      setActiveHeading(activeHeadingId(currentHeadings, positions, threshold));
    };
    scroller.addEventListener('scroll', update, { passive: true });
    update();
    return () => scroller.removeEventListener('scroll', update);
  }, [active, creationState, headings]);

  useEffect(() => {
    if (!active || creationState !== 'ready' || !pendingAnchor) return;
    const frame = requestAnimationFrame(() => {
      if (!activeRef.current) return;
      hostRef.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(pendingAnchor)}`)
        ?.scrollIntoView({ block: 'start' });
      navigation.consumeAnchor(tabId, pendingAnchor);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, creationState, headings, navigation, pendingAnchor, tabId]);

  return (
    <div
      aria-label={`${name} Markdown content`}
      className="markdown-surface bg-surface-2"
      data-markdown-state={creationState}
      data-read-only={readOnly || undefined}
      role="document"
    >
      {canChangeMode && (
        <TabsSubtle
          aria-label="Markdown mode"
          className="markdown-mode-control"
          iconOnly
          onSelect={(index) => onModeChange(index === 0 ? 'writer' : 'reading')}
          selectedIndex={mode === 'writer' ? 0 : 1}
          size="compact"
          track
        >
          <TabsSubtleItem icon={PenLine} label="Edit" title="Edit" />
          <TabsSubtleItem icon={BookOpen} label="Read" title="Read" />
        </TabsSubtle>
      )}
      {creationState === 'creating' && (
        <div className="markdown-status" role="status">
          Opening {name}
        </div>
      )}
      {creationState === 'failed' && (
        <MarkdownOpenFailure onRetry={() => setAttempt((current) => current + 1)} />
      )}
      {reviewBar}
      <HumanizeNotice controls={humanizeControls} />
      {linkFailure && (
        <div className="markdown-link-failure" role="alert">
          Could not open this link in your browser.
        </div>
      )}
      <div className={cn('markdown-crepe', readOnly && 'markdown-crepe-readonly')} ref={hostRef} />
    </div>
  );
}
