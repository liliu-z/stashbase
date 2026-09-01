import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/bingwu/Projects/StashBase/stashbase';
const ASSETS = path.join(ROOT, 'node_modules/@phosphor-icons/core/assets');
const TARGET = path.join(ROOT, 'web-src/src/common/components/icons.tsx');

// [export name, phosphor slug, weight, note, mirror?]
const MAP = [
  ['SearchIcon', 'magnifying-glass', 'regular', 'Search — titlebar control and Command Palette entry.'],
  ['ChevronDownIcon', 'caret-down', 'regular', 'Disclosure caret: menus, pills, section headers.'],
  ['HistoryIcon', 'clock-counter-clockwise', 'regular', 'Past sessions — the chat panel’s History dropdown.'],
  ['ArrowUpIcon', 'arrow-up', 'regular', 'Composer send.'],
  ['StopIcon', 'stop', 'fill', 'Stop a streaming Agent turn. Fill weight: a solid block reads as a hard stop where an outline reads as a frame.'],
  ['PlusIcon', 'plus', 'regular', 'New chat / add.'],
  ['CodeIcon', 'code', 'regular', 'Edit permission mode.'],
  ['HandIcon', 'hand', 'regular', 'Ask-before-each-edit permission mode.'],
  ['ClipboardListIcon', 'clipboard-text', 'regular', 'Plan mode — explore, then present a plan.'],
  ['DumbbellIcon', 'barbell', 'regular', 'Effort (thinking depth) in the Modes dropdown.'],
  ['BoltIcon', 'lightning', 'regular', 'Auto mode — the model picks the permission mode.'],
  ['NewFileIcon', 'file-plus', 'regular', 'New note.'],
  ['NewFolderIcon', 'folder-plus', 'regular', 'New folder.'],
  ['OutlineIcon', 'text-align-left', 'regular', 'Document Outline section header.'],
  ['LibraryIcon', 'books', 'regular', 'Library section header.'],
  ['FolderIcon', 'folder', 'regular', 'Folder — Library rows and the tree.'],
  ['SyncIcon', 'arrows-clockwise', 'regular', 'Reindex / sync.'],
  ['CollapseAllIcon', 'arrows-in-line-vertical', 'regular', 'Fold every open folder in the tree.'],
  ['ExpandAllIcon', 'arrows-out-line-vertical', 'regular', 'Unfold the tree.'],
  ['FileGenericIcon', 'file', 'regular', 'A file with no format-specific mark.'],
  ['FilesViewIcon', 'file-text', 'regular', 'Files view — same document frame as NewFileIcon so the two read as a family.'],
  ['PanelLeftIcon', 'sidebar-simple', 'regular', 'Sidebar toggle, titlebar left.'],
  ['PanelRightIcon', 'sidebar-simple', 'regular', 'Chat-panel toggle, titlebar right. Phosphor ships one side only, so this is the same mark mirrored — drawing a near-copy by hand would drift from it on the next icon-set update.', true],
  ['BugIcon', 'bug', 'regular', 'Report a bug, in the sidebar’s bottom row.'],
  ['DiscordIcon', 'discord-logo', 'regular', 'Community Discord, beside Report a bug. Phosphor carries the brand mark itself, so it stays on-set instead of being a lone hand-traced logo.'],
  ['EditIcon', 'pencil-simple', 'regular', 'Rename / edit.'],
  ['TrashIcon', 'trash', 'regular', 'Delete.'],
  ['MoreHorizontalIcon', 'dots-three', 'regular', 'Overflow menu trigger.'],
  ['PlugIcon', 'plug', 'regular', 'MCP connectors.'],
  ['PreviewIcon', 'eye', 'regular', 'Preview / read-only view.'],
  ['CheckIcon', 'check', 'regular', 'Selected row in a menu.'],
  ['ExternalLinkIcon', 'arrow-square-out', 'regular', 'Opens outside the app.'],
  ['StarIcon', 'star', 'regular', 'Favorite, unset.'],
  ['StarFilledIcon', 'star', 'fill', 'Favorite, set. Its own export rather than a `fill-current` class on StarIcon: Phosphor’s regular weight IS the outline path, so filling it does nothing — the filled state is a different asset.'],
  ['BotIcon', 'robot', 'regular', 'A generic agent, where no specific runtime is named.'],
  ['CopyIcon', 'copy', 'regular', 'Copy to clipboard.'],
  ['SettingsIcon', 'gear-six', 'regular', 'Settings, in the sidebar’s bottom account row.'],
  ['UserIcon', 'user', 'regular', 'Account — the avatar chip’s content while nobody is signed in.'],
  ['KeyIcon', 'key', 'regular', 'An API key the user supplies.'],
  ['ArrowRightIcon', 'arrow-right', 'regular', 'Proceed / drill in.'],
  ['CloseIcon', 'x', 'regular', 'Dismiss a dialog, toast, or card. Replaces the lone `lucide-react` import that was pulling in a second icon library for this one glyph.'],
];

function inner(slug, weight) {
  const file = weight === 'regular' ? `${slug}.svg` : `${slug}-${weight}.svg`;
  const raw = fs.readFileSync(path.join(ASSETS, weight, file), 'utf8');
  const body = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  if (!body.includes('<path')) throw new Error(`no path in ${file}`);
  return body;
}

// Brand marks have no Phosphor equivalent; lift them across verbatim.
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
 * All SVG icons used in the UI, drawn from Phosphor (MIT).
 *
 * Sized via parent CSS so each component stays a pure shape — no
 * width/height props. Colour follows \`currentColor\`, so the parent's
 * \`color\` rule wins.
 *
 * Phosphor ships every icon as a 256-viewBox FILLED path, not a stroked
 * one. There is therefore no stroke width to tune and no way for two icons
 * to disagree about weight — the property the old hand-drawn Lucide set had
 * to enforce by convention is now structural. Weight is chosen by picking a
 * different asset (\`regular\` for chrome, \`fill\` where a solid silhouette
 * carries meaning), never by restyling one.
 *
 * Paths are inlined rather than imported from \`@phosphor-icons/react\`:
 * that package carries six weights per icon and the renderer's entry chunk
 * has a hard budget (\`scripts/check-renderer-chunks.mjs\`). The assets
 * package is a devDependency, and \`scripts/gen-icons.mjs\` regenerates this
 * file from it — edit the map there, not the paths here.
 *
 * Product brand marks (Claude, Codex, the StashBase cube) and the two
 * 16-box preparation status glyphs have no Phosphor equivalent and stay
 * hand-authored at the bottom; the generator lifts them across verbatim.
 */

import * as React from 'react';

type IconProps = { className?: string };

/** Every Phosphor asset shares this envelope. */
function Icon({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}
`;

const bodies = MAP.map(([name, slug, weight, note, mirror]) => {
  const content = inner(slug, weight);
  const painted = mirror
    ? `<g transform="translate(256,0) scale(-1,1)">${content}</g>`
    : content;
  return `
/** ${note} (phosphor \`${slug}\`, ${weight}) */
export function ${name}({ className }: IconProps) {
  return (
    <Icon className={className}>
      ${painted}
    </Icon>
  );
}`;
}).join('\n');

const brands = ['ClaudeIcon', 'CodexIcon', 'CubeLogoIcon', 'CancelledIcon', 'WarningIcon'].map(lift).join('\n\n');

fs.writeFileSync(TARGET, `${header}${bodies}\n\n${brands}\n`);
console.log(`icons.tsx: ${MAP.length} Phosphor icons + 5 hand-authored marks`);
