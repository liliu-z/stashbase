# Study notes: project Math mode

This note explains the files named in the Math-mode request, what the current
code does, and what remains to be built. It is based on the code in this
checkout, not only on the request text.

## Short answer

The feature is **partly present, but not implemented end to end**.

- Documents and Chat already render several kinds of KaTeX math.
- Chat already converts `\\(...\\)` and `\\[...\\]` to a form its Markdown
  renderer understands, while leaving inline code alone.
- Both rendering entry points deliberately have `singleDollarTextMath: false`,
  so `$x^2$` is currently text everywhere.
- There is a visible `Math` switch next to the reading-font control, but it is
  only React component state. It is reset when that component remounts and is
  not passed to either Markdown renderer, saved per project, or sent to agents.
- No discovered server route/config field, renderer state owner, agent prompt,
  or tests implement the requested per-project persistence and live updates.

The existing switch therefore looks like an early UI stub rather than a
completed product feature.

## 1. `renderer/src/features/documents/ui/markdown/math.ts`

### Purpose

This is the Documents editor's Math extension for Milkdown/Crepe. Milkdown is
the Markdown editor framework; this file teaches it which math syntax to parse,
how to represent math inside the editor, how to show a formula preview, and
how to write the editor content back to Markdown.

### What its main pieces do

| Code area | Responsibility | Current result |
| --- | --- | --- |
| `remarkDoubleDollarMath` | Configures the `remark-math` parser. | Enables `$$...$$` math but explicitly disables `$...$` math with `singleDollarTextMath: false`. |
| `mathBlocksToCode` / `remarkMathBlockAsCode` | Changes parsed block-math nodes into `LaTeX` code blocks. | Makes display math editable in the normal code-block editor and keeps a visual preview. |
| `mathInlineSchema` | Defines Milkdown's atomic inline-math document node. | Stores the unrendered formula in its `value` attribute and serializes it as an `inlineMath` Markdown node. |
| `mathInlineView` | Creates the visible DOM for an inline formula. | Uses KaTeX and retains the source in `data-value`, useful for the editor's DOM parsing/copy path. |
| `mathBlockSchema` | Overrides Markdown serialization for `LaTeX` code blocks created from math. | Saves those blocks back as `$$...$$` instead of a fenced code block. |
| `math(editor)` | Installs the plugins and configures code-block previews. | Renders `math` and `latex` fenced blocks as display math. |

### Important current behavior

The opening comment accurately describes today's rule: ordinary dollar amounts
are protected because `$...$` is disabled. A Markdown document containing
`$x^2$` therefore shows source text instead of an inline formula.

This file does preserve the existing double-dollar and `math`/`latex` fence
behavior. Its KaTeX options are conservative (`trust: false`) and use
`throwOnError: false`, which means an unsupported formula is shown in a way the
author can inspect/correct rather than permitting trusted commands.

### Missing for the requested feature

1. It accepts no `mathMode` value and always supplies `false` to
   `singleDollarTextMath`.
2. It has no equivalent of Chat's pre-processing for `\\(...\\)` and
   `\\[...\\]`. Markdown normally consumes those backslashes as escapes before
   the math parser gets a chance to recognize them.
3. Reconfiguring Milkdown must be designed around the existing editor
   lifecycle: changing the setting needs a re-render/reparse without replacing
   the editor instance, resetting selection, losing undo history, or marking
   the source dirty.
4. It needs focused tests for the whole requested syntax table, source
   round-tripping, dirty-document behavior, clipboard/selection behavior, and
   reopening a saved Markdown document.

## 2. `renderer/src/features/agent/ui/transcript/markdown.tsx`

### Purpose

This is the Chat transcript's read-only Markdown renderer. It takes raw text
from an agent or user message and produces React DOM using `react-markdown`,
GFM, `remark-math`, and KaTeX. It also controls safe links and prevents remote
images from rendering.

### What its main pieces do

| Code area | Responsibility | Current result |
| --- | --- | --- |
| `isHttpUrl` and `markdownComponents` | Permit only HTTP(S) external links, safely route project-file links, and suppress images. | Chat Markdown does not turn unsafe URLs or remote images into active content. |
| `LATEX_DELIMITERS` | Finds code spans/fences first, then `$$...$$`, then LaTeX bracket delimiters. | Prevents the conversion helper from treating `\\(x\\)` inside code as math. |
| `withDollarMath` | Rewrites `\\(...\\)` and `\\[...\\]` into `$$...$$` before Markdown strips the backslashes. | Inline bracket syntax becomes inline math; a bracket formula occupying its line becomes a display block. |
| `AgentMarkdown` | Combines the parser, KaTeX renderer, and safe components. | Parses GFM and existing math, but hard-codes single-dollar parsing off. |

### Why the pre-processing is needed

Markdown uses backslash as an escape character. Without the conversion step,
the Markdown parser can eat the `\\` in `\\(x^2\\)` and leave ordinary text
instead of a recognizable math delimiter. The helper runs before
`ReactMarkdown`, preserves code samples, and then gives the result to
`remark-math`.

### Important current behavior

`remarkPlugins` contains:

```ts
[remarkMath, { singleDollarTextMath: false }]
```

So the transcript intentionally treats `$x^2$` as literal text. Its test suite
also verifies that a sentence with `$4 ... $5` does not accidentally become a
formula. It has tests for KaTeX, bracket delimiters, code preservation, safe
links, and GFM.

### Missing for the requested feature

1. `AgentMarkdown` needs a project Math-mode input, or access to a shared
   project-setting state, and must use it for `singleDollarTextMath`.
2. Every transcript caller must receive that live setting so existing messages
   re-render immediately after a toggle.
3. Chat copy already copies the raw stored text (see `copy-action.tsx`), which
   is a good start, but the acceptance case for copying a rendered formula and
   browser selection needs explicit verification.
4. The parser/transform rules must be shared with Documents or deliberately
   implemented from one common owner. Two near-identical parsers can otherwise
   drift on escaped dollars, code blocks, malformed formulas, and inline versus
   display layout.

## 3. `renderer/src/features/settings/ui/appearance/reading-text-menu.tsx`

### Purpose

This component renders the compact reading controls shown in Documents:

- a button/popover for reading font and size;
- the `Math` switch immediately to its right.

`appearanceApi` and `useAppearance` manage the existing app-wide reading font
and size preferences. `Tooltip`, `Switch`, and the other UI components supply
the accessible controls and styling.

### What the Math switch currently does

The component has this local state:

```ts
const [mathMode, setMathMode] = useState(false);
```

Clicking the switch flips that boolean and its `aria-checked` value. Nothing
else reads it. It is not stored in `config.json`, associated with a project,
passed to Documents/Chat, or supplied to an agent.

Its current tooltip is only `Math mode for this project`. The requested tooltip
also needs the syntax instructions: `Use $...$ for formulas and \\$ for a
literal dollar sign.`

The nearby test, `reading-text-menu.test.tsx`, proves only position and local
on/off behavior. It does not prove a persisted project setting.

## 4. Existing persistence and project identity: `server/app-config.ts`,
`server/folder.ts`, and `server/routes/agent-preferences.ts`

These were not named as implementation starting points, but the request says to
follow their existing boundaries.

- `server/app-config.ts` owns the single local application config file,
  `~/.stashbase/config.json`, including safe/atomic config writes. This is an
  appropriate *kind* of storage for Math mode because it does not create a
  file inside a project or copy with it.
- `server/folder.ts` owns registered project roots, window-to-project binding,
  root normalization, and identity comparisons. Its `filesystemPath.equal(...)`
  handling avoids treating spelling differences in the same local folder as
  different projects.
- `server/routes/agent-preferences.ts` is the closest precedent for a setting
  stored per project. It validates an absolute scope, confirms that the scope
  is an exact registered project root, then stores a per-project record in the
  app config. Math mode should follow the same validation/identity pattern,
  rather than putting data in Markdown frontmatter or a project file.

There is no `mathMode` field or Math-specific HTTP route/protocol in these
files today.

## 5. Existing agent-instruction boundary:
`server/agent-runtime-instructions.ts`

This module defines the shared product instruction block composed into all
built-in agent runtimes. `composeAgentRuntimeInstructions(...)` combines:

1. the StashBase agent role;
2. an optional persona; and
3. the product-owned runtime policy.

Codex, Claude, Antigravity, Default, and OpenCode-related runtime paths call
this composition at their respective session/turn boundaries. This is the
right policy owner for the short Math formatting rule.

However, the current composition accepts only an optional persona. It neither
looks up a project Math setting nor adds either required formatting instruction.
Some runtimes also send instructions only when opening a native session, so
the implementation must inspect each runtime's subsequent-turn path. The
requirement is specifically that a toggle affects the next turn of an existing
chat without a conversation restart.

## 6. Copy and stored-message boundaries

`renderer/src/features/agent/ui/transcript/copy-action.tsx` is relevant even
though it was not listed in the request. Its `CopyAction` writes the untouched
`text` property to the clipboard, not the rendered HTML. That is the desired
foundation: copying a Chat reply should retain formula delimiters and source.

Selecting rendered MathML/KaTeX DOM is a separate browser-selection behavior.
It needs an explicit test/implementation check because render-only DOM can
otherwise copy visual output rather than source. The requested guarantee is
source preservation for StashBase-to-StashBase copy/paste, not a guarantee for
every external application's HTML clipboard format.

## Implementation checklist derived from the request

1. Add a validated, local-only, per-project Math preference and renderer API;
   default it to `false`.
2. Load/save it using the existing registered-project identity and app-config
   ownership, then expose it to renderer state.
3. Replace the switch's component-local state with that setting and the full
   requested tooltip. Keep the control beside the font dropdown.
4. Give Documents and Chat the same delimiter policy: always support escaped
   bracket delimiters, double dollars, and `math`/`latex` fences; enable only
   single-dollar parsing when the setting is on; leave code literal.
5. Ensure a live setting change reparses/re-renders without source rewriting
   or editor recreation that loses dirty state, undo, selection, or position.
6. Pass the current rule to every built-in agent for each subsequent turn,
   including an existing native chat session.
7. Verify raw Chat copy, rendered-formula selection, paste, document save and
   reopen, distinct Project A/Project B persistence, and all acceptance-table
   cases.
8. Update the affected product capability/journey design documentation and
   engineering-boundary/journey evidence after implementation.

## Files worth reading next

- `renderer/src/features/agent/ui/transcript/markdown.test.tsx` — current
  Chat math and code-preservation tests.
- `renderer/src/features/settings/ui/appearance/reading-text-menu.test.tsx` —
  current UI-stub test.
- `renderer/src/features/agent/ui/transcript/copy-action.tsx` — Chat copy
  preserves raw message text today.
- `server/agent-runtime-instructions.ts` — shared agent policy owner.
- `server/routes/agent-preferences.ts` and
  `shared/protocols/http/agent-preferences.ts` — closest per-project local
  preference pattern.
- `server/app-config.ts` and `server/folder.ts` — local persistence and
  project-identity owners.
