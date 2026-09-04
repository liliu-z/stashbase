/**
 * All SVG icons used in the UI, drawn from Lucide (ISC).
 *
 * Sized via parent CSS so each component stays a pure shape — no
 * width/height props. Colour follows `currentColor`, so the parent's
 * `color` rule wins.
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
 * The assets are PINNED IN-REPO under `assets/icons/lucide/` and
 * `scripts/gen-icons.mjs` regenerates this file from them — edit the map
 * there, not the paths here. Two families sit deliberately off-set:
 * brand marks (GitHub, Discord — Lucide ships no brands) keep their
 * Phosphor filled geometry on their own envelope, and the file-format
 * glyphs in `FileTypeIcon.tsx` stay their own set.
 *
 * Product brand marks (Claude, Codex, the StashBase cube) and the two
 * 16-box preparation status glyphs have no set equivalent and stay
 * hand-authored at the bottom; the generator lifts them across verbatim.
 */

import * as React from 'react';

type IconProps = { className?: string };

/** Every Lucide asset shares this envelope; `filled` paints the same
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

/** Search — titlebar control and Command Palette entry. (lucide `search`) */
export function SearchIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m21 21-4.34-4.34"/> <circle cx="11" cy="11" r="8"/>
    </Icon>
  );
}

/** Disclosure caret: menus, pills, section headers. (lucide `chevron-down`) */
export function ChevronDownIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m6 9 6 6 6-6"/>
    </Icon>
  );
}

/** Past sessions — the chat panel’s History dropdown. (lucide `history`) */
export function HistoryIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/> <path d="M3 3v5h5"/> <path d="M12 7v5l4 2"/>
    </Icon>
  );
}

/** Composer send. (lucide `arrow-up`) */
export function ArrowUpIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m5 12 7-7 7 7"/> <path d="M12 19V5"/>
    </Icon>
  );
}

/** Stop a streaming Agent turn. Filled: a solid block reads as a hard stop where an outline reads as a frame. (lucide `square`, filled) */
export function StopIcon({ className }: IconProps) {
  return (
    <Icon className={className} filled>
      <rect width="18" height="18" x="3" y="3" rx="2"/>
    </Icon>
  );
}

/** New chat / add. (lucide `plus`) */
export function PlusIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M5 12h14"/> <path d="M12 5v14"/>
    </Icon>
  );
}

/** Edit permission mode. (lucide `code`) */
export function CodeIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m16 18 6-6-6-6"/> <path d="m8 6-6 6 6 6"/>
    </Icon>
  );
}

/** Ask-before-each-edit permission mode. (lucide `hand`) */
export function HandIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/> <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/> <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/> <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
    </Icon>
  );
}

/** Plan mode — explore, then present a plan. (lucide `clipboard-list`) */
export function ClipboardListIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/> <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/> <path d="M12 11h4"/> <path d="M12 16h4"/> <path d="M8 11h.01"/> <path d="M8 16h.01"/>
    </Icon>
  );
}

/** Effort (thinking depth) in the Modes dropdown. (lucide `dumbbell`) */
export function DumbbellIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z"/> <path d="m2.5 21.5 1.4-1.4"/> <path d="m20.1 3.9 1.4-1.4"/> <path d="M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z"/> <path d="m9.6 14.4 4.8-4.8"/>
    </Icon>
  );
}

/** Auto mode — the model picks the permission mode. (lucide `zap`) */
export function BoltIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>
    </Icon>
  );
}

/** New note. (lucide `file-plus`) */
export function NewFileIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/> <path d="M14 2v5a1 1 0 0 0 1 1h5"/> <path d="M9 15h6"/> <path d="M12 18v-6"/>
    </Icon>
  );
}

/** New folder. (lucide `folder-plus`) */
export function NewFolderIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 10v6"/> <path d="M9 13h6"/> <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
    </Icon>
  );
}

/** Document Outline section header. (lucide `align-left`) */
export function OutlineIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M21 5H3"/> <path d="M15 12H3"/> <path d="M17 19H3"/>
    </Icon>
  );
}

/** Library section header. (lucide `library`) */
export function LibraryIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m16 6 4 14"/> <path d="M12 6v14"/> <path d="M8 8v12"/> <path d="M4 4v16"/>
    </Icon>
  );
}

/** Folder — Library rows and the tree. (lucide `folder`) */
export function FolderIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
    </Icon>
  );
}

/** Reindex / sync. (lucide `refresh-cw`) */
export function SyncIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/> <path d="M21 3v5h-5"/> <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/> <path d="M8 16H3v5"/>
    </Icon>
  );
}

/** Fold every open folder in the tree. (lucide `fold-vertical`) */
export function CollapseAllIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 22v-6"/> <path d="M12 8V2"/> <path d="M4 12H2"/> <path d="M10 12H8"/> <path d="M16 12h-2"/> <path d="M22 12h-2"/> <path d="m15 19-3-3-3 3"/> <path d="m15 5-3 3-3-3"/>
    </Icon>
  );
}

/** Unfold the tree. (lucide `unfold-vertical`) */
export function ExpandAllIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 22v-6"/> <path d="M12 8V2"/> <path d="M4 12H2"/> <path d="M10 12H8"/> <path d="M16 12h-2"/> <path d="M22 12h-2"/> <path d="m15 19-3 3-3-3"/> <path d="m15 5-3-3-3 3"/>
    </Icon>
  );
}

/** A file with no format-specific mark — chrome surfaces (tool activity, mentions). The tree’s format glyphs live in FileTypeIcon.tsx and stay on their own set. (lucide `file`) */
export function FileGenericIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/> <path d="M14 2v5a1 1 0 0 0 1 1h5"/>
    </Icon>
  );
}

/** Files view — same document frame as NewFileIcon so the two read as a family. (lucide `file-text`) */
export function FilesViewIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/> <path d="M14 2v5a1 1 0 0 0 1 1h5"/> <path d="M10 9H8"/> <path d="M16 13H8"/> <path d="M16 17H8"/>
    </Icon>
  );
}

/** Sidebar toggle, titlebar left. (lucide `panel-left`) */
export function PanelLeftIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2"/> <path d="M9 3v18"/>
    </Icon>
  );
}

/** Chat-panel toggle, titlebar right. Lucide ships both sides, so this is its own asset rather than a mirror. (lucide `panel-right`) */
export function PanelRightIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2"/> <path d="M15 3v18"/>
    </Icon>
  );
}

/** Report a bug, in Settings → General. (lucide `bug`) */
export function BugIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 20v-9"/> <path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/> <path d="M14.12 3.88 16 2"/> <path d="M21 21a4 4 0 0 0-3.81-4"/> <path d="M21 5a4 4 0 0 1-3.55 3.97"/> <path d="M22 13h-4"/> <path d="M3 21a4 4 0 0 1 3.81-4"/> <path d="M3 5a4 4 0 0 0 3.55 3.97"/> <path d="M6 13H2"/> <path d="m8 2 1.88 1.88"/> <path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>
    </Icon>
  );
}

/** Rename / edit. (lucide `pencil`) */
export function EditIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/> <path d="m15 5 4 4"/>
    </Icon>
  );
}

/** Delete. (lucide `trash-2`) */
export function TrashIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M10 11v6"/> <path d="M14 11v6"/> <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/> <path d="M3 6h18"/> <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </Icon>
  );
}

/** Overflow menu trigger. (lucide `ellipsis`) */
export function MoreHorizontalIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="1"/> <circle cx="19" cy="12" r="1"/> <circle cx="5" cy="12" r="1"/>
    </Icon>
  );
}

/** MCP connectors. (lucide `plug`) */
export function PlugIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 22v-5"/> <path d="M15 8V2"/> <path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/> <path d="M9 8V2"/>
    </Icon>
  );
}

/** Preview / read-only view. (lucide `eye`) */
export function PreviewIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/> <circle cx="12" cy="12" r="3"/>
    </Icon>
  );
}

/** Selected row in a menu. (lucide `check`) */
export function CheckIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M20 6 9 17l-5-5"/>
    </Icon>
  );
}

/** Opens outside the app. (lucide `external-link`) */
export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M15 3h6v6"/> <path d="M10 14 21 3"/> <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    </Icon>
  );
}

/** Favorite, unset. (lucide `star`) */
export function StarIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>
    </Icon>
  );
}

/** Favorite, set. Its own export rather than a class toggle: the filled state is the same Lucide star painted with a currentColor fill. (lucide `star`, filled) */
export function StarFilledIcon({ className }: IconProps) {
  return (
    <Icon className={className} filled>
      <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>
    </Icon>
  );
}

/** Agent Instructions / system prompt — the panel-toolbar control. A scroll with text lines: the standing orders an agent reads. Deliberately NOT shared with the AGENTS.md tree glyph, which stays the robot — the file marks the agent contract, the control edits the orders. (lucide `scroll-text`) */
export function InstructionsIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M15 12h-5"/> <path d="M15 8h-5"/> <path d="M19 17V5a2 2 0 0 0-2-2H4"/> <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>
    </Icon>
  );
}

/** The AGENTS.md tree glyph — a vendor-neutral agent contract file; the robot marks the agent itself, distinct from the Instructions scroll. (lucide `bot`) */
export function BotIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 8V4H8"/> <rect width="16" height="12" x="4" y="8" rx="2"/> <path d="M2 14h2"/> <path d="M20 14h2"/> <path d="M15 13v2"/> <path d="M9 13v2"/>
    </Icon>
  );
}

/** Templates — the sidebar entry and its gallery tab (the marketplace-gallery glyph). (lucide `layout-grid`) */
export function SquaresFourIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect width="7" height="7" x="3" y="3" rx="1"/> <rect width="7" height="7" x="14" y="3" rx="1"/> <rect width="7" height="7" x="14" y="14" rx="1"/> <rect width="7" height="7" x="3" y="14" rx="1"/>
    </Icon>
  );
}

/** The switcher mark (macOS/VS Code select idiom) — the sidebar folder header’s Change-folder trigger; distinct on purpose from the single fold chevron beside it. (lucide `chevrons-up-down`) */
export function CaretUpDownIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m7 15 5 5 5-5"/> <path d="m7 9 5-5 5 5"/>
    </Icon>
  );
}

/** Copy to clipboard. (lucide `copy`) */
export function CopyIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/> <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </Icon>
  );
}

/** Settings, in the sidebar’s bottom account row. (lucide `settings`) */
export function SettingsIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/> <circle cx="12" cy="12" r="3"/>
    </Icon>
  );
}

/** Account — the avatar chip’s content while nobody is signed in. (lucide `user`) */
export function UserIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/> <circle cx="12" cy="7" r="4"/>
    </Icon>
  );
}

/** An API key the user supplies. (lucide `key`) */
export function KeyIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m2 21 9.6-9.6"/> <path d="m7.5 15.5 2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19"/> <circle cx="15.5" cy="7.5" r="5.5"/>
    </Icon>
  );
}

/** Proceed / drill in. (lucide `arrow-right`) */
export function ArrowRightIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M5 12h14"/> <path d="m12 5 7 7-7 7"/>
    </Icon>
  );
}

/** Dismiss a dialog, toast, or card. (lucide `x`) */
export function CloseIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M18 6 6 18"/> <path d="m6 6 12 12"/>
    </Icon>
  );
}

/** Import from GitHub. Brand mark, on-set in Phosphor. (phosphor `github-logo`, regular) */
export function GithubLogoIcon({ className }: IconProps) {
  return (
    <PhosphorIcon className={className}>
      <path d="M208.31,75.68A59.78,59.78,0,0,0,202.93,28,8,8,0,0,0,196,24a59.75,59.75,0,0,0-48,24H124A59.75,59.75,0,0,0,76,24a8,8,0,0,0-6.93,4,59.78,59.78,0,0,0-5.38,47.68A58.14,58.14,0,0,0,56,104v8a56.06,56.06,0,0,0,48.44,55.47A39.8,39.8,0,0,0,96,192v8H72a24,24,0,0,1-24-24A40,40,0,0,0,8,136a8,8,0,0,0,0,16,24,24,0,0,1,24,24,40,40,0,0,0,40,40H96v16a8,8,0,0,0,16,0V192a24,24,0,0,1,48,0v40a8,8,0,0,0,16,0V192a39.8,39.8,0,0,0-8.44-24.53A56.06,56.06,0,0,0,216,112v-8A58.14,58.14,0,0,0,208.31,75.68ZM200,112a40,40,0,0,1-40,40H112a40,40,0,0,1-40-40v-8a41.74,41.74,0,0,1,6.9-22.48A8,8,0,0,0,80,73.83a43.81,43.81,0,0,1,.79-33.58,43.88,43.88,0,0,1,32.32,20.06A8,8,0,0,0,119.82,64h32.35a8,8,0,0,0,6.74-3.69,43.87,43.87,0,0,1,32.32-20.06A43.81,43.81,0,0,1,192,73.83a8.09,8.09,0,0,0,1,7.65A41.72,41.72,0,0,1,200,104Z"/>
    </PhosphorIcon>
  );
}

/** Community Discord, in Settings → General. Brand mark, on-set in Phosphor. FILL weight: the regular outline’s thin face features smear into a robot at 16px; the solid mark stays legible. (phosphor `discord-logo`, fill) */
export function DiscordIcon({ className }: IconProps) {
  return (
    <PhosphorIcon className={className}>
      <path d="M247.51,174.39,218,58a16.08,16.08,0,0,0-13-11.88l-36.06-5.92a16.22,16.22,0,0,0-18.26,11.88l-.21.85a4,4,0,0,0,3.27,4.93,155.62,155.62,0,0,1,24.41,5.62,8.2,8.2,0,0,1,5.62,9.7,8,8,0,0,1-10.19,5.64,155.4,155.4,0,0,0-90.8-.1,8.22,8.22,0,0,1-10.28-4.81,8,8,0,0,1,5.08-10.33,156.85,156.85,0,0,1,24.72-5.72,4,4,0,0,0,3.27-4.93l-.21-.85A16.21,16.21,0,0,0,87.08,40.21L51,46.13A16.08,16.08,0,0,0,38,58L8.49,174.39a15.94,15.94,0,0,0,9.06,18.51l67,29.71a16.17,16.17,0,0,0,21.71-9.1l3.49-9.45a4,4,0,0,0-3.27-5.35,158.13,158.13,0,0,1-28.63-6.2,8.2,8.2,0,0,1-5.61-9.67,8,8,0,0,1,10.2-5.66,155.59,155.59,0,0,0,91.12,0,8,8,0,0,1,10.19,5.65,8.19,8.19,0,0,1-5.61,9.68,157.84,157.84,0,0,1-28.62,6.2,4,4,0,0,0-3.27,5.35l3.49,9.45a16.18,16.18,0,0,0,21.71,9.1l67-29.71A15.94,15.94,0,0,0,247.51,174.39ZM92,152a12,12,0,1,1,12-12A12,12,0,0,1,92,152Zm72,0a12,12,0,1,1,12-12A12,12,0,0,1,164,152Z"/>
    </PhosphorIcon>
  );
}

/** Claude mark (Simple Icons, CC0) in the Claude brand coral. File
 *  glyph for Claude.md / CLAUDE.md, the Claude Code rules file. */
export function ClaudeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="#D97757" aria-hidden="true">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

/** OpenAI / Codex mark (Simple Icons, CC0). Monochrome, so it follows
 *  `--fg` to stay legible on light and dark. The mark fills its native 24-box almost
 *  edge-to-edge, so the viewBox is padded to ~78% fill — otherwise it
 *  reads visibly larger than the other glyphs in the same 16px slot. */
export function CodexIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="-2 -2 28 28" fill="var(--fg)" aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

export function CubeLogoIcon({ className }: IconProps) {
  // Token-driven so the mark keeps its weight and hue in both themes;
  // hidden back edges stay a step lighter than the lit front edges. The
  // cropped viewBox removes the source mark's surplus whitespace so its
  // optical footprint matches the other brand marks in the same CSS slot.
  return (
    <svg className={className} viewBox="44 44 424 424" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g stroke="var(--stroke-strong)" strokeWidth={18} strokeLinecap="round" strokeLinejoin="round">
        <path d="M92 158 L92 342" />
        <path d="M92 342 L256 436" />
      </g>
      <g stroke="var(--accent)" strokeWidth={23} strokeLinecap="round" strokeLinejoin="round">
        <path d="M92 158 L256 64 L338 111" />
        <path d="M92 158 L256 252 L420 158" />
        <path d="M420 158 L420 342" />
        <path d="M256 436 L420 342" />
        <path d="M256 342 L256 436" />
      </g>
    </svg>
  );
}

/** Cancelled preparation — a "no entry" bar in a ring. Hand-authored on a
 *  16-box because it is a status mark sized to sit inside a tree row, not a
 *  chrome glyph; Phosphor's `prohibit` reads far heavier at 14px. */
export function CancelledIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.25 8h5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Failed preparation — a knocked-out "!" in a solid triangle. The two parts
 *  are class-tagged rather than painted here so the owning row can key the
 *  knockout to its own surface (see `.warning-mark-*` in `workspace.css`);
 *  no Phosphor asset offers that split. */
export function WarningIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path className="warning-mark-shape" d="M8 2.2 14.4 13.2H1.6L8 2.2Z" />
      <text className="warning-mark-text" x="8" y="12" textAnchor="middle">!</text>
    </svg>
  );
}
