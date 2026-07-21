import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type RefObject } from 'react';
import { VIEWABLE_FILE_EXTENSION_ALTERNATION } from '../../../../shared/file-formats.ts';
import { renderMarkdownInline } from '../../markdown';
import { ChevronDownIcon, CopyIcon, EditIcon, FileGenericIcon } from '../../icons';
import type { Attachment, Block, ToolBlock, ToolStatus } from './types';

export interface QueuedTurnPreview {
  id: string;
  text: string;
  attachments?: Attachment[];
  status: 'waiting' | 'steering' | 'steered';
  canSteer?: boolean;
}

export function MessageList({
  blocks, queuedTurns, turnActive, phase, fatal, agentName, agentShortName, Icon, editableUserMessageIds, onPermission, onSteerQueued, onCopyUserMessage, onResendUserMessage, onRetry, onOpenArtifact,
}: {
  blocks: Block[];
  queuedTurns: QueuedTurnPreview[];
  turnActive: boolean;
  phase: 'connecting' | 'live' | 'closed';
  fatal: string | null;
  agentName: string;
  agentShortName: string;
  Icon: ComponentType<{ className?: string }>;
  editableUserMessageIds: Set<string>;
  onPermission: (toolBlockId: string, permId: string, allow: boolean) => void;
  onSteerQueued: (id: string) => void;
  onCopyUserMessage: (text: string) => void;
  onResendUserMessage: (text: string) => void;
  onRetry: () => void;
  onOpenArtifact: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setShowJump(!stick.current);
  }

  useEffect(() => {
    if (stick.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
      setShowJump(false);
    }
  });

  const turns = useMemo(() => groupTurns(blocks), [blocks]);

  return (
    <div className="agent-messages" ref={ref} onScroll={onScroll}>
      {blocks.length === 0 && phase === 'live' && <Hero name={agentName} Icon={Icon} />}
      {phase === 'connecting' && <div className="agent-empty">Connecting to {agentShortName}…</div>}
      {blocks.length === 0 && phase === 'closed' && fatal && (
        <FatalState fatal={fatal} agentShortName={agentShortName} onRetry={onRetry} />
      )}
      {turns.map((turn) => (
        <div className="agent-turn" key={turn.key}>
          {turn.head && (
            <UserTurnHead
              block={turn.head}
              scrollRef={ref}
              sticky={queuedTurns.length === 0}
              canEdit={editableUserMessageIds.has(turn.head.id)}
              onCopy={onCopyUserMessage}
              onSendEdit={onResendUserMessage}
            />
          )}
          <TurnBody
            blocks={turn.body}
            editableUserMessageIds={editableUserMessageIds}
            onPermission={onPermission}
            onCopyUserMessage={onCopyUserMessage}
            onResendUserMessage={onResendUserMessage}
            onOpenArtifact={onOpenArtifact}
          />
        </div>
      ))}
      {queuedTurns.map((turn) => (
        <QueuedTurn
          key={turn.id}
          turn={turn}
          onSteer={onSteerQueued}
        />
      ))}
      {blocks.length > 0 && phase === 'closed' && fatal && (
        <FatalInline fatal={fatal} agentShortName={agentShortName} onRetry={onRetry} />
      )}
      {turnActive && <div className="agent-working"><span className="agent-dot" />{agentShortName} is working…</div>}
      {showJump && (
        <button type="button" className="agent-jump-latest" onClick={() => {
          if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          stick.current = true;
          setShowJump(false);
        }}>Jump to latest ↓</button>
      )}
    </div>
  );
}

interface Turn { key: string; head: Extract<Block, { kind: 'user' }> | null; body: Block[] }

function groupTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const b of blocks) {
    if (b.kind === 'user') {
      cur = { key: b.id, head: b, body: [] };
      turns.push(cur);
    } else {
      if (!cur) { cur = { key: `lead-${b.id}`, head: null, body: [] }; turns.push(cur); }
      cur.body.push(b);
    }
  }
  return turns;
}

function TurnBody({ blocks, editableUserMessageIds, onPermission, onCopyUserMessage, onResendUserMessage, onOpenArtifact }: {
  blocks: Block[];
  editableUserMessageIds: Set<string>;
  onPermission: (t: string, p: string, a: boolean) => void;
  onCopyUserMessage: (text: string) => void;
  onResendUserMessage: (text: string) => void;
  onOpenArtifact: (path: string) => void;
}) {
  const groups: Array<Block | ToolBlock[]> = [];
  for (const block of blocks) {
    // Permission requests are actions, not background activity. Keep each
    // one outside the collapsible activity stream so its Allow/Reject controls
    // remain visible even when the preceding tool group is collapsed.
    if (block.kind !== 'tool' || block.status === 'awaiting') {
      groups.push(block);
      continue;
    }
    const previous = groups[groups.length - 1];
    if (Array.isArray(previous)) previous.push(block);
    else groups.push([block]);
  }
  return <>{groups.map((group) => Array.isArray(group)
    ? <ToolActivityGroup key={`activity-${group[0].id}`} tools={group} onPermission={onPermission} onOpenArtifact={onOpenArtifact} />
    : <BlockView
      key={group.id}
      block={group}
      canEditUserMessage={editableUserMessageIds.has(group.id)}
      onPermission={onPermission}
      onCopyUserMessage={onCopyUserMessage}
      onResendUserMessage={onResendUserMessage}
      onOpenArtifact={onOpenArtifact}
    />
  )}</>;
}

function UserTurnHead({
  block, scrollRef, sticky = true, canEdit, onCopy, onSendEdit,
}: {
  block: Extract<Block, { kind: 'user' }>;
  scrollRef?: RefObject<HTMLDivElement | null>;
  sticky?: boolean;
  canEdit: boolean;
  onCopy: (text: string) => void;
  onSendEdit: (text: string) => void;
}) {
  const [stuck, setStuck] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.text);
  const sentinelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!sticky) {
      setStuck(false);
      return;
    }
    const root = scrollRef?.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      ([e]) => setStuck(!e.isIntersecting),
      { root, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollRef, sticky]);

  useEffect(() => {
    if (!editing) setDraft(block.text);
  }, [block.text, editing]);

  return (
    <>
      {sticky && <span ref={sentinelRef} className="agent-turn-sentinel" aria-hidden="true" />}
      <div className={'agent-turn-head' + (block.text && !editing ? ' has-actions' : '') + (sticky ? '' : ' static') + (stuck ? ' stuck' : '')}>
        {block.attachments && block.attachments.length > 0 && (
          <div className="agent-turn-attach">
            {block.attachments.map((a) => (
              <span key={a.path} className="agent-attach-chip" title={a.path}>
                <FileGenericIcon className="agent-attach-icon" />
                <span className="agent-attach-name">{a.name}</span>
                {a.dims && <span className="agent-attach-dims">{a.dims}</span>}
              </span>
            ))}
          </div>
        )}
        {editing ? (
          <InlineUserMessageEditor
            text={draft}
            saveLabel="Send"
            onChange={setDraft}
            onCancel={() => {
              setDraft(block.text);
              setEditing(false);
            }}
            onSave={() => {
              const text = draft.trim();
              if (!text) return;
              setEditing(false);
              onSendEdit(text);
            }}
          />
        ) : (
          <>
            {block.text && <UserMessageText text={block.text} />}
            {block.text && (
              <UserMessageActions
                text={block.text}
                canEdit={canEdit}
                onCopy={onCopy}
                onEdit={() => setEditing(true)}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}

function QueuedTurn({
  turn, onSteer,
}: {
  turn: QueuedTurnPreview;
  onSteer: (id: string) => void;
}) {
  const label = turn.status === 'steered' ? 'Steered' : turn.status === 'steering' ? 'Steering' : 'Waiting';
  return (
    <div className="agent-turn queued">
      <div className="agent-turn-head queued">
        {turn.attachments && turn.attachments.length > 0 && (
          <div className="agent-turn-attach">
            {turn.attachments.map((a) => (
              <span key={a.path} className="agent-attach-chip" title={a.path}>
                <FileGenericIcon className="agent-attach-icon" />
                <span className="agent-attach-name">{a.name}</span>
                {a.dims && <span className="agent-attach-dims">{a.dims}</span>}
              </span>
            ))}
          </div>
        )}
        <div className="agent-turn-line">
          {turn.text && <UserMessageText text={turn.text} />}
          <span className="agent-turn-actions">
            <span className="agent-turn-waiting">
              <span className="agent-dot" />
              {label}
            </span>
            {turn.canSteer && turn.status === 'waiting' && (
              <button type="button" className="agent-turn-steer" onClick={() => onSteer(turn.id)}>
                Steer
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function InlineUserMessageEditor({
  text, saveLabel = 'Save', onChange, onCancel, onSave,
}: {
  text: string;
  saveLabel?: string;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    });
  }, []);
  return (
    <div className="agent-turn-edit">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => {
          onChange(e.target.value);
          e.currentTarget.style.height = 'auto';
          e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="agent-turn-edit-actions">
        <button type="button" className="agent-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="agent-btn primary" onClick={onSave}>{saveLabel}</button>
      </div>
    </div>
  );
}

const USER_TEXT_CHAR_LIMIT = 300;
const USER_TEXT_LINE_LIMIT = 4;
const FILE_MENTION_RE = new RegExp(
  `(^|\\s)@([^\\n]*?\\.(?:${VIEWABLE_FILE_EXTENSION_ALTERNATION}))(?![/.])`,
  'gi',
);

function UserMessageText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = userTextPreview(text);
  const collapsible = preview !== text;
  return (
    <span className="agent-turn-text">
      {renderUserFileMentions(open || !collapsible ? text : preview)}
      {collapsible && !open && <span className="agent-turn-ellipsis">…</span>}
      {collapsible && (
        <button
          type="button"
          className="agent-turn-expand"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? 'Show less' : 'Show more'}
          <ChevronDownIcon className={'agent-turn-expand-icon' + (open ? ' open' : '')} />
        </button>
      )}
    </span>
  );
}

/** The composer serializes its atomic @-mention widget as @<path>. Restore
 * that same compact file chip in the transcript without treating ordinary
 * inline code or assistant prose as an attachment. */
function renderUserFileMentions(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  FILE_MENTION_RE.lastIndex = 0;
  while ((match = FILE_MENTION_RE.exec(text))) {
    const [raw, leading, path] = match;
    const start = match.index;
    if (start > cursor) parts.push(text.slice(cursor, start));
    if (leading) parts.push(leading);
    parts.push(
      <span key={`${start}:${path}`} className="agent-file-mention" title={path} aria-label={`File mention: ${path}`}>
        {baseName(path)}
      </span>,
    );
    cursor = start + raw.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length ? parts : [text];
}

function UserMessageActions({
  text, canEdit, onCopy, onEdit,
}: {
  text: string;
  canEdit: boolean;
  onCopy: (text: string) => void;
  onEdit: () => void;
}) {
  return (
    <div className="agent-turn-user-actions" aria-label="Message actions">
      <button type="button" title="Copy message" onClick={() => onCopy(text)}>
        <CopyIcon />
      </button>
      {canEdit && (
        <button type="button" title="Edit and resend" onClick={onEdit}>
          <EditIcon />
        </button>
      )}
    </div>
  );
}

function userTextPreview(text: string): string {
  const lines = text.split(/\r?\n/);
  let out = lines.slice(0, USER_TEXT_LINE_LIMIT).join('\n');
  if (out.length > USER_TEXT_CHAR_LIMIT) out = out.slice(0, USER_TEXT_CHAR_LIMIT);
  if (lines.length > USER_TEXT_LINE_LIMIT || text.length > out.length) return out.trimEnd();
  return text;
}

function fatalCopy(fatal: string, agentShortName: string): { title: string; detail: string } {
  if (/No folder open/i.test(fatal)) {
    return { title: 'No folder open', detail: 'Open a folder, then retry.' };
  }
  return { title: `${agentShortName} couldn't continue`, detail: fatal };
}

function FatalState({
  fatal, agentShortName, onRetry,
}: {
  fatal: string;
  agentShortName: string;
  onRetry: () => void;
}) {
  const copy = fatalCopy(fatal, agentShortName);
  return (
    <div className="agent-fatal-state">
      <div className="agent-fatal-card">
        <div className="agent-fatal-title">{copy.title}</div>
        <div className="agent-fatal-detail">{copy.detail}</div>
        <button type="button" className="agent-btn" onClick={onRetry}>Retry</button>
      </div>
    </div>
  );
}

function FatalInline({
  fatal, agentShortName, onRetry,
}: {
  fatal: string;
  agentShortName: string;
  onRetry: () => void;
}) {
  const copy = fatalCopy(fatal, agentShortName);
  return (
    <div className="agent-fatal-inline">
      <div>
        <div className="agent-fatal-title">{copy.title}</div>
        <div className="agent-fatal-detail">{copy.detail}</div>
      </div>
      <button type="button" className="agent-btn" onClick={onRetry}>Retry</button>
    </div>
  );
}

function Hero({ name, Icon }: { name: string; Icon: ComponentType<{ className?: string }> }) {
  return (
    <div className="agent-hero">
      <div className="agent-hero-wordmark">
        <Icon className="agent-hero-mark" />
        <span className="agent-hero-name">{name}</span>
      </div>
      {name === 'Claude Code' && <PixelMascot />}
    </div>
  );
}

function PixelMascot() {
  const color = '#D97757';
  const px: Array<[number, number]> = [];
  for (let x = 2; x <= 6; x++) for (let y = 1; y <= 4; y++) px.push([x, y]);
  px.push([2, 5], [3, 5], [5, 5], [6, 5]);
  const eyes = new Set(['3,2', '5,2']);
  return (
    <svg className="agent-hero-sprite" viewBox="0 0 9 7" shapeRendering="crispEdges" aria-hidden="true">
      {px.filter(([x, y]) => !eyes.has(`${x},${y}`)).map(([x, y]) => (
        <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" fill={color} />
      ))}
    </svg>
  );
}

function BlockView({ block, canEditUserMessage, onPermission, onCopyUserMessage, onResendUserMessage, onOpenArtifact }: {
  block: Block;
  canEditUserMessage: boolean;
  onPermission: (t: string, p: string, a: boolean) => void;
  onCopyUserMessage: (text: string) => void;
  onResendUserMessage: (text: string) => void;
  onOpenArtifact: (path: string) => void;
}) {
  switch (block.kind) {
    case 'user':
      return <UserTurnHead
        block={block}
        canEdit={canEditUserMessage}
        onCopy={onCopyUserMessage}
        onSendEdit={onResendUserMessage}
      />;
    case 'assistant':
      return (
        <div className="agent-msg assistant">
          <div
            className="agent-prose"
            onClick={(event) => {
              const target = event.target;
              const anchor = target instanceof Element ? target.closest('a') : null;
              const path = localAssistantLinkPath(anchor?.getAttribute('href') ?? null);
              if (!path) return;
              event.preventDefault();
              onOpenArtifact(path);
            }}
            dangerouslySetInnerHTML={{ __html: renderMarkdownInline(block.text) }}
          />
        </div>
      );
    case 'thinking':
      return <ThinkingView text={block.text} />;
    case 'error':
      return <div className="agent-error">{block.text}</div>;
    case 'tool':
      return <ToolCard block={block} onPermission={onPermission} />;
  }
}

/** Local Markdown links in an agent response open files in the workspace;
 * external URLs and in-document anchors retain their ordinary browser action. */
function localAssistantLinkPath(href: string | null): string | null {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  const path = href.split('#', 1)[0];
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function ToolActivityGroup({ tools, onPermission, onOpenArtifact }: {
  tools: ToolBlock[];
  onPermission: (t: string, p: string, a: boolean) => void;
  onOpenArtifact: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = tools.find((tool) => tool.status === 'running');
  const failures = tools.filter((tool) => tool.status === 'error' || tool.status === 'denied').length;
  const summary = failures
    ? `${failures} step${failures === 1 ? '' : 's'} need attention — ${activitySummary(tools, active)}`
    : activitySummary(tools, active);
  return (
    <section className={'agent-activity' + (active ? ' active' : '') + (failures ? ' attention' : '')}>
      <button type="button" className="agent-activity-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <ChevronDownIcon className={'agent-activity-chev' + (open ? ' open' : '')} />
        {active && <span className="agent-dot" />}
        <span>{summary}</span>
      </button>
      {open && <div className="agent-activity-body">{tools.map((tool) => <ToolCard key={tool.id} block={tool} onPermission={onPermission} />)}</div>}
      <ArtifactCards changes={tools.filter((tool) => tool.status === 'done').flatMap(fileChanges)} onOpen={onOpenArtifact} />
    </section>
  );
}

function ThinkingView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={'agent-thinking' + (open ? ' open' : '')}>
      <button type="button" className="agent-thinking-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDownIcon className="agent-thinking-chev" />
        <span>Thinking</span>
      </button>
      {open && <div className="agent-thinking-body">{text}</div>}
    </div>
  );
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: 'Running',
  awaiting: 'Review',
  done: 'Done',
  error: 'Error',
  denied: 'Denied',
};

function ToolCard({ block, onPermission }: { block: ToolBlock; onPermission: (t: string, p: string, a: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const diff = useMemo(() => buildDiff(block.name, block.input), [block.name, block.input]);
  const summary = toolSummary(block.name, block.input);

  return (
    <div className={'agent-tool status-' + block.status}>
      <button type="button" className="agent-tool-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDownIcon className="agent-tool-chev" />
        <span className="agent-tool-name">{toolActivityTitle(block.name, block.input)}</span>
        {summary && <span className="agent-tool-summary">{summary}</span>}
        <span className={'agent-tool-status s-' + block.status}>
          {block.status === 'running' && <span className="agent-dot" />}
          {STATUS_LABEL[block.status]}
        </span>
      </button>

      {block.status === 'awaiting' && block.permId && (
        <div className="agent-perm">
          <div className="agent-perm-title">{block.permTitle ?? `Allow Claude to run ${block.name}?`}</div>
          {diff && <DiffView diff={diff} />}
          {!diff && block.name === 'Bash' && (
            <pre className="agent-bash">{String(block.input.command ?? '')}</pre>
          )}
          <div className="agent-perm-actions">
            <button type="button" className="agent-btn ghost" onClick={() => onPermission(block.id, block.permId!, false)}>Reject</button>
            <button type="button" className="agent-btn primary" onClick={() => onPermission(block.id, block.permId!, true)}>Allow</button>
          </div>
        </div>
      )}

      {open && block.status !== 'awaiting' && (
        <div className="agent-tool-body">
          {diff && <DiffView diff={diff} />}
          {!diff && block.name === 'Bash' && <pre className="agent-bash">{String(block.input.command ?? '')}</pre>}
          {!diff && block.name !== 'Bash' && (
            <pre className="agent-tool-input">{JSON.stringify(block.input, null, 2)}</pre>
          )}
          {block.result != null && block.result !== '' && (
            <pre className={'agent-tool-result' + (block.status === 'error' ? ' err' : '')}>{clip(block.result)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ArtifactCards({ changes, onOpen }: { changes: Array<{ path: string; kind: string }>; onOpen: (path: string) => void }) {
  if (!changes.length) return null;
  return <div className="agent-artifacts">{changes.map((change) => (
    <div className="agent-artifact" key={change.path}>
      <FileGenericIcon className="agent-artifact-icon" />
      <span className="agent-artifact-path" title={change.path}>{change.path}</span>
      <span className="agent-artifact-kind">{change.kind}</span>
      <button type="button" onClick={() => onOpen(change.path)}>Open</button>
    </div>
  ))}</div>;
}

function fileChanges(block: ToolBlock): Array<{ path: string; kind: string }> {
  if (block.name !== 'File change') return [];
  const raw = Array.isArray(block.input.changes) ? block.input.changes : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const change = item as Record<string, unknown>;
    const path = [change.path, change.filePath, change.file_path].find((value): value is string => typeof value === 'string' && value.length > 0);
    if (!path) return [];
    const kind = typeof change.kind === 'string' ? change.kind : typeof change.type === 'string' ? change.type : 'Changed';
    return [{ path, kind }];
  });
}

function activityLabel(tool: ToolBlock): string {
  if (tool.name === 'File change') return 'Editing files';
  if (tool.name === 'Bash') return 'Verifying changes';
  if (/search|read/i.test(tool.name)) return 'Reading library';
  return tool.name;
}

type CommandAction = { type?: unknown; path?: unknown };

function commandActions(input: Record<string, unknown>): CommandAction[] {
  return Array.isArray(input.actions)
    ? input.actions.filter((action): action is CommandAction => !!action && typeof action === 'object')
    : [];
}

function toolActivityTitle(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') {
    const action = commandActions(input)[0];
    if (action?.type === 'read' && typeof action.path === 'string') return `Read ${baseName(action.path)}`;
    if (action?.type === 'listFiles') return 'Listed files';
    if (action?.type === 'search') return 'Searched files';
    return 'Ran command';
  }
  if (/read_file$/i.test(name)) {
    const path = input.path ?? input.file_path;
    return typeof path === 'string' ? `Read ${baseName(path)}` : 'Read file';
  }
  if (/list_directory$/i.test(name)) return 'Listed files';
  if (/search/i.test(name)) return 'Searched files';
  if (name === 'File change') return 'Changed files';
  return name;
}

function activitySummary(tools: ToolBlock[], active?: ToolBlock): string {
  if (active) return `${toolActivityTitle(active.name, active.input)}…`;

  let reads = 0;
  let lists = 0;
  let searches = 0;
  let commands = 0;
  let changes = 0;
  let toolsUsed = 0;
  for (const tool of tools) {
    if (tool.name === 'Bash') {
      const actions = commandActions(tool.input);
      if (!actions.length) { commands++; continue; }
      for (const action of actions) {
        if (action.type === 'read') reads++;
        else if (action.type === 'listFiles') lists++;
        else if (action.type === 'search') searches++;
        else commands++;
      }
    } else if (/read_file$/i.test(tool.name)) reads++;
    else if (/list_directory$/i.test(tool.name)) lists++;
    else if (/search/i.test(tool.name)) searches++;
    else if (tool.name === 'File change') changes++;
    else toolsUsed++;
  }
  const labels = [
    reads && `read ${reads} file${reads === 1 ? '' : 's'}`,
    lists && `listed ${lists} folder${lists === 1 ? '' : 's'}`,
    searches && `searched ${searches} time${searches === 1 ? '' : 's'}`,
    commands && `ran ${commands} command${commands === 1 ? '' : 's'}`,
    changes && `changed ${changes} file set${changes === 1 ? '' : 's'}`,
    toolsUsed && `used ${toolsUsed} tool${toolsUsed === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return labels.length ? labels.join(', ') : 'Worked';
}

type DiffRow = { type: 'ctx' | 'del' | 'add'; text: string };

function DiffView({ diff }: { diff: { file: string; rows: DiffRow[] } }) {
  return (
    <div className="agent-diff">
      <div className="agent-diff-file">{diff.file}</div>
      <div className="agent-diff-body">
        {diff.rows.map((r, i) => (
          <div key={i} className={'agent-diff-row ' + r.type}>
            <span className="agent-diff-gutter">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
            <span className="agent-diff-text">{r.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildDiff(name: string, input: Record<string, unknown>): { file: string; rows: DiffRow[] } | null {
  const file = String(input.file_path ?? input.path ?? '');
  if (name === 'Edit') {
    return { file, rows: lineDiff(String(input.old_string ?? ''), String(input.new_string ?? '')) };
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const rows: DiffRow[] = [];
    for (const e of input.edits as Array<Record<string, unknown>>) {
      rows.push(...lineDiff(String(e.old_string ?? ''), String(e.new_string ?? '')));
    }
    return { file, rows };
  }
  if (name === 'Write') {
    return { file, rows: lineDiff('', String(input.content ?? '')) };
  }
  return null;
}

function lineDiff(oldStr: string, newStr: string): DiffRow[] {
  const o = oldStr === '' ? [] : oldStr.split('\n');
  const n = newStr === '' ? [] : newStr.split('\n');
  let p = 0;
  while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let s = 0;
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;

  const rows: DiffRow[] = [];
  const ctx = 3;
  const headStart = Math.max(0, p - ctx);
  for (let i = headStart; i < p; i++) rows.push({ type: 'ctx', text: o[i] });
  for (let i = p; i < o.length - s; i++) rows.push({ type: 'del', text: o[i] });
  for (let i = p; i < n.length - s; i++) rows.push({ type: 'add', text: n[i] });
  const tailEnd = Math.min(o.length, o.length - s + ctx);
  for (let i = o.length - s; i < tailEnd; i++) rows.push({ type: 'ctx', text: o[i] });
  return rows;
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const f = input.file_path ?? input.path;
  if (typeof f === 'string') return baseName(f);
  if (name === 'Bash' && typeof input.command === 'string') return clipInline(input.command, 100);
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.query === 'string') return input.query;
  if (typeof input.url === 'string') return input.url;
  return '';
}

const baseName = (p: string) => p.split('/').pop() || p;
const clipInline = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const clip = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + '\n…(truncated)' : s);
