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
  font installed on the computer from Settings. The document's reading bar, a
  paper-coloured band the editor scrolls beneath without passing under, holds
  one Appearance menu set out like an e-reader's: the font, each sample set in
  its own face; text size on a slider of seven steps; the page colour; then
  line width and line spacing. A page colour is a light and a dark theme that
  follow the system together, drawn as one half-and-half swatch: White,
  Paper and Green, whose ink is tinted to their page as an e-reader's is. All
  stay app-wide Appearance preferences. The reading font changes only the
  rendered document's prose and headings; the interface, Chat, source view,
  code, and tables keep their own faces, the font never changes the
  background, and CJK text keeps the platform sans under Serif or Sans.
- Support light/dark themes, text sizes, keyboard use, visible focus, and reduced
  motion, whether the system or Settings asks for it.
- Native status menus use the OS menu surface and typography, compact section
  labels and conversation titles. Menu-bar marks use optical small-size stroke
  weights, transparent backgrounds and tighter padding so the brand has comparable visual weight to
  neighboring system icons at native scale. Status marks stay small and still: a hollow
  neutral ring for work, a solid dot for attention, separated from the brand mark
  by clear space. Colored tray/taskbar marks use the fixed badge-red token;
  macOS menu-bar templates keep native contrast and Dock badges keep system styling.
- Motion explains change without taking attention or reading position from work.
- A notice goes where its subject is, so the reader is not interrupted more
  than that subject needs:
  - **Inline** beside the thing it is about (a field, a document, a panel, a
    chat turn) when that thing is on screen. It lasts as long as the state it
    describes.
  - **The strip** under the title row for a standing condition of the whole
    window, or one waiting on the reader's answer, such as the sign-in offer.
    It pushes content down rather than covering it, and stays until resolved
    or answered.
  - **Floating** over the top centre of the surface the reader acted on, for
    the outcome of something they just did that could not land where they
    acted, such as a file or link that did not open. Dismissing it loses
    nothing, because the reader can simply try again or take the same step
    elsewhere. A choice offered nowhere else belongs inline instead.
  - **The corner** at the sidebar's foot for work the reader was not
    watching, such as an update or background preparation. While the sidebar
    is collapsed, its control carries a dot instead. The lower right is never
    used, because the composer and its send button live there.
  - **A passing status** over the top centre of a view whose content changed
    by itself, such as an HTML preview that loaded its file's newer version.
    It is an ink pill like a tooltip, monochrome like the rest of the
    interface. A spinner turns into a check as the new content appears. It
    pushes nothing, takes no input, and leaves on its own after a few
    seconds, so it is the one notice without a dismissal. A failure that
    stands is a strip instead.

  Every notice says itself the same way: the sentence in ink, then its
  answer, then the dismissal last and quietest. Only an offer, such as
  signing in, is centred, and only the offer itself carries its mark; the
  wait after taking it up does not. Every card can be dismissed.
- Cards are paper. A card set in a page has no fill of its own, only a light
  hairline, so it shows the page beneath. A floating card is the one card
  with a fill, because it covers content, and it adds a soft shadow. Grey
  fills and decorative icon tiles are not used.
- A surface shows at most one solid action: a dialog's commit, a decision
  card's answer, or an offer's single answer. In a dialog or a decision card
  it is placed last; in a notice the dismissal stays last. Repeated row
  actions and every recovery action are outlined and carry no icon. A
  recovery that repeats the step that failed is labelled **Retry**; one that
  does something else, such as reconnecting, names it. Quiet text buttons
  only dismiss or cancel, and align with the content edge rather than
  reaching past it. A grey filled button never sits on a paper card.
- A button that is working keeps its action's name and shows a spinner. What
  is being waited for is said in the row's detail line, never in the button.
- A row with actions opens one menu, from a right click and from its "…"
  button alike. Every menu uses the shared menu surface. A destructive item
  is in the error colour, after a separator, at the end.
- Every drop target shows the same neutral highlight while a drag it accepts
  is over it: a faint fill with a hairline, never a colour. A drop reports
  its outcome at most once.
- In the app, as in the menu bar, a small solid dot means something needs a
  look. Ongoing work is shown as a word or a spinner, never as a dot. A dot
  on a control keeps clear space around it.
- Text a reader may need to copy stays selectable even when its row is a
  control: names, paths, and the commands an agent ran. Navigation chrome —
  menu rows, tabs, tree rows, drag handles — does not select. A drag that
  selects text never also fires the row's action.

Tokens, fonts, geometry, and layout recipes stay in their code owners.
[Engineering Boundaries](../code-review/architecture.md#styling-and-tooling) records
integration constraints; [Journey Coverage](../code-review/journey-coverage.md#cross-cutting-gaps)
records unresolved contrast and composition evidence.
