# Visual Style

Keep documents and conversation readable; navigation and controls stay secondary.

- The StashBase themes use restrained neutral surfaces, a coherent icon family,
  and color for meaning such as errors, decisions, and changed text. Named
  themes come from published palettes, never ones StashBase composes; their
  identity shows in surfaces, text, accent, selection, links, and quotes,
  while headings and body text stay in the theme's own ink.
- Keep controls compact and long-form text comfortable. Use sans for interface
  text and monospace for paths/code. Markdown prose offers a reading font:
  Serif (the default, for writing) or Sans (for documents full of code), or a
  font installed on the computer from Settings. Serif and Sans switch with the
  reading text size from an e-reader style menu in the document's reading bar,
  a paper-coloured band the editor scrolls beneath without passing under. All
  stay app-wide Appearance preferences. The reading font changes only the
  rendered document's prose and headings; the interface, Chat, source view,
  code, and tables keep their own faces, the font never changes the
  background, and CJK text keeps the platform sans under Serif or Sans.
- Support light/dark themes, text sizes, keyboard use, visible focus, and reduced
  motion, whether the system or Settings asks for it.
- Motion explains change without taking attention or reading position from work.
- Text a reader may need to copy stays selectable even when its row is a
  control: names, paths, and the commands an agent ran. Navigation chrome —
  menu rows, tabs, tree rows, drag handles — does not select. A drag that
  selects text never also fires the row's action.

Tokens, fonts, geometry, and layout recipes stay in their code owners.
[Engineering Boundaries](../code-review/architecture.md#styling-and-tooling) records
integration constraints; [Journey Coverage](../code-review/journey-coverage.md#cross-cutting-gaps)
records unresolved contrast and composition evidence.
