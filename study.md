# Implementing project Math mode correctly

This guide describes the remaining work needed for Math mode to render valid
LaTeX consistently in Chat and Markdown documents.

## Why the Transformer document did not format

The generated Markdown contains invalid or unsupported delimiter use. For
example, it opens display math with `\[` but closes it with `]`. The closing
delimiter must be `\]`.

It also uses normal parentheses for formula text:

```md
(d\_{model})
```

Normal parentheses are prose, not math delimiters. The valid inline form is:

```md
\(d_{model}\)
```

Inside Math mode, do not escape `_` in a formula. Use `d_{model}`, not
`d\_{model}`.

Correct examples:

```md
If the model width is \(d_{model}\), each token becomes a vector in
\(\mathbb{R}^{d_{model}}\).

\[
X = E + P
\]

\[
\operatorname{Attention}(Q,K,V)
= \operatorname{softmax}\left(\frac{QK^T}{\sqrt{d_k}} + M\right)V
\]
```

## 1. Give agents the current formatting rule

File: `server/agent-runtime-instructions.ts`

Every built-in agent must receive the Math formatting rule on each subsequent
turn. Do not only send it when a native chat session starts: changing the
project switch must affect the next request in an existing conversation.

The resolved instruction should be equivalent to:

```ts
const mathFormatting = mathMode
  ? 'Use $...$ for inline formulas and $$...$$ for display formulas. Escape literal dollar signs as \\$.'
  : 'Use \\(...\\) for inline formulas and $$...$$ for display formulas. Dollar amounts can use ordinary $.';
```

Add this to the shared runtime composition for Default, Claude, Codex, and
Antigravity. Do not alter text already produced by an agent after a toggle.

## 2. Create one shared delimiter policy

Documents and Chat must not each develop their own slightly different parser
rules. Put the common policy in a small shared renderer module, for example:

```text
renderer/src/shared/markdown/math-delimiters.ts
```

The helper must follow these rules:

| Source | Math off | Math on |
| --- | --- | --- |
| `$x^2$` | Literal text | Inline math |
| `\$` outside math | Literal `$` | Literal `$` |
| `\(x^2\)` | Inline math | Inline math |
| `\[x^2\]` | Display math | Display math |
| `$$...$$` | Math | Math |
| `math` / `latex` fence | Display math | Display math |
| Inline code / other fence | Literal code | Literal code |

It must protect inline-code spans and fenced code blocks before recognizing
delimiters. A lone unpaired `$` must remain text.

Use this same helper from:

- `renderer/src/features/documents/ui/markdown/math.ts`
- `renderer/src/features/agent/ui/transcript/markdown.tsx`

This shared owner prevents parsing drift between a Chat reply and a Markdown
file copied from that reply.

## 3. Add backslash delimiter recognition before Markdown escapes it

Markdown consumes backslashes as escapes. Therefore `\(...\)` and `\[...\]`
need recognition before the ordinary Markdown parser removes their backslashes.

The parser/preprocessor should:

1. scan protected code regions first;
2. identify valid inline and display LaTeX delimiters outside those regions;
3. pass recognizable math to KaTeX/remark-math;
4. retain the original delimiter/source for serialization and copy.

Existing Chat code has a local `withDollarMath(...)` helper for part of this
job. Move or replace that behavior with the shared implementation so Documents
gets the same support.

## 4. Apply a toggle without recreating the editor

File: `renderer/src/features/documents/ui/markdown/document.tsx`

Do **not** remount or recreate the Milkdown editor on a Math-mode toggle. A
recreated editor can lose unsaved edits, undo history, caret/selection, and
reading position.

Instead, keep the same Milkdown editor instance and refresh only the math
interpretation. The refresh should:

1. capture the current selection and scroll position;
2. reparse or redecorate the editor's current in-memory Markdown using the new
   Math setting;
3. mark the display-only transaction `addToHistory: false`;
4. suppress normal `onChange` reporting during that transaction;
5. restore selection and scroll position.

Conceptually:

```ts
useEffect(() => {
  const editor = editorRef.current;
  if (!editor) return;

  const markdown = editor.getMarkdown();
  const selection = currentSelection(editor);
  const scrollTop = currentScrollPosition();

  refreshMathRendering(editor, { markdown, mathMode });

  restoreSelection(editor, selection);
  restoreScrollPosition(scrollTop);
}, [mathMode]);
```

`refreshMathRendering(...)` must not modify the source stored by the document
runtime. A toggle is a presentation/parsing operation, not a user edit.

## 5. Preserve source, copy, and errors

- Preserve `$`, `\$`, `\(...\)`, `\[...\]`, and `$$...$$` exactly as authored
  where the document has not otherwise been edited.
- Chat's Copy action should continue copying raw message source, not rendered
  KaTeX HTML.
- Selecting rendered math and copying it within StashBase must preserve formula
  source/structure.
- Keep KaTeX untrusted (`trust: false`) and retain invalid formula source so an
  author can correct it.

## 6. Tests required

Add focused tests for both Documents and Chat:

1. Every row of the delimiter table above, with Math both off and on.
2. Dollar amounts such as `$10 ... $20` off, and `\$10 ... \$20` on.
3. Inline code and non-math fenced code staying literal.
4. A lone `$` staying literal.
5. Existing and new Chat messages rerendering immediately after a toggle.
6. A dirty Markdown document keeping its source, undo history, selection, and
   scroll after a toggle.
7. Chat-to-document formula copy/paste, edit, save, and reopen.
8. Every built-in agent receiving the current formatting rule on its next turn
   and producing representative Markdown correctly.
