import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/bingwu/Projects/StashBase/stashbase';
// Pinned, vendored Lucide assets (see assets/icons/lucide/README.md): the
// UI set is a design decision, so its geometry is checked in rather than
// floating on a registry dependency.
const LUCIDE = path.join(ROOT, 'assets/icons/lucide');
const PHOSPHOR = path.join(ROOT, 'node_modules/@phosphor-icons/core/assets');
const TARGET = path.join(ROOT, 'web-src/src/common/components/icons.tsx');

// [export name, lucide name, note, filled?]
const MAP = [
  ['SearchIcon', 'search', 'Search — titlebar control and Command Palette entry.'],
  ['ChevronDownIcon', 'chevron-down', 'Disclosure caret: menus, pills, section headers.'],
  ['HistoryIcon', 'history', 'Past sessions — the chat panel’s History dropdown.'],
  ['ArrowUpIcon', 'arrow-up', 'Composer send.'],
  ['StopIcon', 'square', 'Stop a streaming Agent turn. Filled: a solid block reads as a hard stop where an outline reads as a frame.', true],
  ['PlusIcon', 'plus', 'New chat / add.'],
  ['CodeIcon', 'code', 'Edit permission mode.'],
  ['HandIcon', 'hand', 'Ask-before-each-edit permission mode.'],
  ['ClipboardListIcon', 'clipboard-list', 'Plan mode — explore, then present a plan.'],
  ['DumbbellIcon', 'dumbbell', 'Effort (thinking depth) in the Modes dropdown.'],
  ['BoltIcon', 'zap', 'Auto mode — the model picks the permission mode.'],
  ['NewFileIcon', 'file-plus', 'New note.'],
  ['NewFolderIcon', 'folder-plus', 'New folder.'],
  ['OutlineIcon', 'align-left', 'Document Outline section header.'],
  ['LibraryIcon', 'library', 'Library section header.'],
  ['FolderIcon', 'folder', 'Folder — Library rows and the tree.'],
  ['SyncIcon', 'refresh-cw', 'Reindex / sync.'],
  ['CollapseAllIcon', 'fold-vertical', 'Fold every open folder in the tree.'],
  ['ExpandAllIcon', 'unfold-vertical', 'Unfold the tree.'],
  ['FileGenericIcon', 'file', 'A file with no format-specific mark — chrome surfaces (tool activity, mentions). The tree’s format glyphs live in FileTypeIcon.tsx and stay on their own set.'],
  ['FilesViewIcon', 'file-text', 'Files view — same document frame as NewFileIcon so the two read as a family.'],
  ['PanelLeftIcon', 'panel-left', 'Sidebar toggle, titlebar left.'],
  ['PanelRightIcon', 'panel-right', 'Chat-panel toggle, titlebar right. Lucide ships both sides, so this is its own asset rather than a mirror.'],
  ['BugIcon', 'bug', 'Report a bug, in Settings → General.'],
  ['EditIcon', 'pencil', 'Rename / edit.'],
  ['TrashIcon', 'trash-2', 'Delete.'],
  ['MoreHorizontalIcon', 'ellipsis', 'Overflow menu trigger.'],
  ['PlugIcon', 'plug', 'MCP connectors.'],
  ['PreviewIcon', 'eye', 'Preview / read-only view.'],
  ['CheckIcon', 'check', 'Selected row in a menu.'],
  ['ExternalLinkIcon', 'external-link', 'Opens outside the app.'],
  ['StarIcon', 'star', 'Favorite, unset.'],
  ['StarFilledIcon', 'star', 'Favorite, set. Its own export rather than a class toggle: the filled state is the same Lucide star painted with a currentColor fill.', true],
  ['InstructionsIcon', 'scroll-text', 'Agent Instructions / system prompt — the panel-toolbar control. A scroll with text lines: the standing orders an agent reads. Deliberately NOT shared with the AGENTS.md tree glyph, which stays the robot — the file marks the agent contract, the control edits the orders.'],
  ['BotIcon', 'bot', 'The AGENTS.md tree glyph — a vendor-neutral agent contract file; the robot marks the agent itself, distinct from the Instructions scroll.'],
  ['SquaresFourIcon', 'layout-grid', 'Templates — the sidebar entry and its gallery tab (the marketplace-gallery glyph).'],
  ['CaretUpDownIcon', 'chevrons-up-down', 'The switcher mark (macOS/VS Code select idiom) — the sidebar folder header’s Change-folder trigger; distinct on purpose from the single fold chevron beside it.'],
  ['CopyIcon', 'copy', 'Copy to clipboard.'],
  ['SettingsIcon', 'settings', 'Settings, in the sidebar’s bottom account row.'],
  ['UserIcon', 'user', 'Account — the avatar chip’s content while nobody is signed in.'],
  ['KeyIcon', 'key', 'An API key the user supplies.'],
  ['ArrowRightIcon', 'arrow-right', 'Proceed / drill in.'],
  ['CloseIcon', 'x', 'Dismiss a dialog, toast, or card.'],
];

// Brand marks stay Phosphor: Lucide 1.x ships no brand icons at all, and a
// hand-traced logo would drift from the mark it imitates. Their filled
// 256-viewBox geometry rides its own envelope.
// [export name, phosphor slug, weight, note]
const PHOSPHOR_BRANDS = [
  ['GithubLogoIcon', 'github-logo', 'regular', 'Import from GitHub. Brand mark, on-set in Phosphor.'],
  ['DiscordIcon', 'discord-logo', 'fill', 'Community Discord, in Settings → General. Brand mark, on-set in Phosphor. FILL weight: the regular outline’s thin face features smear into a robot at 16px; the solid mark stays legible.'],
];

function lucideInner(name) {
  const raw = fs.readFileSync(path.join(LUCIDE, `${name}.svg`), 'utf8');
  const body = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/\s+/g, ' ')
    .replaceAll(' />', '/>')
    .trim();
  if (!body) throw new Error(`empty body in ${name}.svg`);
  // Inner elements must be JSX-safe as-is: styling lives on the envelope.
  if (/\s[a-z]+-[a-z]+=/.test(body)) throw new Error(`hyphenated attribute in ${name}.svg — teach the generator to convert it`);
  return body;
}

function phosphorInner(slug, weight) {
  const file = weight === 'regular' ? `${slug}.svg` : `${slug}-${weight}.svg`;
  const raw = fs.readFileSync(path.join(PHOSPHOR, weight, file), 'utf8');
  const body = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  if (!body.includes('<path')) throw new Error(`no path in ${file}`);
  return body;
}

// Product marks with no set equivalent stay hand-authored; lift them across
// verbatim from the current file.
const current = fs.readFileSync(TARGET, 'utf8');
function lift(name) {
  // Split on declaration boundaries rather than matching an optional
  // leading comment: `/**[\s\S]*?` can start anywhere earlier in the file
  // and silently swallow every function in between.
  const start = current.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`could not lift ${name}`);
  const end = current.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`unterminated ${name}`);
  const decl = current.slice(start, end + 2);
  // Re-attach the doc comment only when it directly abuts the declaration.
  const before = current.slice(0, start).trimEnd();
  const comment = before.endsWith('*/')
    ? before.slice(before.lastIndexOf('/**')) + '\n'
    : '';
  return comment + decl;
}

const header = `/**
 * All SVG icons used in the UI, drawn from Lucide (ISC).
 *
 * Sized via parent CSS so each component stays a pure shape — no
 * width/height props. Colour follows \`currentColor\`, so the parent's
 * \`color\` rule wins.
 *
 * Lucide is a STROKED set — 24-viewBox, round caps and round joins —
 * which is where the app's rounded icon voice comes from. The envelope
 * owns every stroke property, so two icons cannot disagree about
 * weight: 1.5, one step under Lucide's 2px default, for the light
 * hairline chrome weight (the Codex/Cursor register) rather than a
 * bold pictogram one. A solid state (send/stop, the set favorite star)
 * is the same geometry painted with a currentColor fill, never a
 * restyled stroke.
 *
 * The assets are PINNED IN-REPO under \`assets/icons/lucide/\` and
 * \`scripts/gen-icons.mjs\` regenerates this file from them — edit the map
 * there, not the paths here. Two families sit deliberately off-set:
 * brand marks (GitHub, Discord — Lucide ships no brands) keep their
 * Phosphor filled geometry on their own envelope, and the file-format
 * glyphs in \`FileTypeIcon.tsx\` stay their own set.
 *
 * Product brand marks (Claude, Codex, the StashBase cube) and the two
 * 16-box preparation status glyphs have no set equivalent and stay
 * hand-authored at the bottom; the generator lifts them across verbatim.
 */

import * as React from 'react';

type IconProps = { className?: string };

/** Every Lucide asset shares this envelope; \`filled\` paints the same
 * geometry as a solid currentColor silhouette. */
function Icon({ className, filled, children }: IconProps & { filled?: boolean; children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Brand marks keep Phosphor's 256-viewBox filled geometry. */
function PhosphorIcon({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}
`;

const bodies = MAP.map(([name, lucideName, note, filled]) => {
  const content = lucideInner(lucideName);
  return `
/** ${note} (lucide \`${lucideName}\`${filled ? ', filled' : ''}) */
export function ${name}({ className }: IconProps) {
  return (
    <Icon className={className}${filled ? ' filled' : ''}>
      ${content}
    </Icon>
  );
}`;
}).join('\n');

const brandBodies = PHOSPHOR_BRANDS.map(([name, slug, weight, note]) => `
/** ${note} (phosphor \`${slug}\`, ${weight}) */
export function ${name}({ className }: IconProps) {
  return (
    <PhosphorIcon className={className}>
      ${phosphorInner(slug, weight)}
    </PhosphorIcon>
  );
}`).join('\n');

const brands = ['ClaudeIcon', 'CodexIcon', 'CubeLogoIcon', 'CancelledIcon', 'WarningIcon'].map(lift).join('\n\n');

fs.writeFileSync(TARGET, `${header}${bodies}\n${brandBodies}\n\n${brands}\n`);
console.log(`icons.tsx: ${MAP.length} Lucide icons + ${PHOSPHOR_BRANDS.length} Phosphor brand marks + 5 hand-authored marks`);
