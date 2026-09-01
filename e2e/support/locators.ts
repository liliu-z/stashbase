import type { Locator, Page } from 'playwright';


export function appShell(page: Page): Locator {
  return page.locator('body[data-boot-settled="1"] > #root');
}

export function settingsButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Settings', exact: true });
}

/** Titlebar folder switcher trigger — the one home for moving between
 *  library folders. Its accessible name is a constant aria-label; the
 *  visible label is the active folder's name ("Library" with none). */
export function folderSwitcherTrigger(page: Page): Locator {
  return page.getByRole('button', { name: 'Switch folder' });
}

function switcherMenu(page: Page): Locator {
  return page.getByRole('menu');
}

export async function openFolderSwitcher(page: Page): Promise<void> {
  await folderSwitcherTrigger(page).click();
  await switcherMenu(page).waitFor({ state: 'visible' });
}

export async function closeFolderSwitcher(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await switcherMenu(page).waitFor({ state: 'hidden' });
}

/** A library member row inside the OPEN switcher menu. Member rows are
 *  `menuitemradio` (the switcher is a single-select picker, and the
 *  current folder reads back as `aria-checked`). The row's accessible
 *  name is the folder basename followed by its shortened path detail,
 *  so match on the leading basename only. */
export function switcherFolderItem(page: Page, name: string): Locator {
  return page.getByRole('menuitemradio', { name: new RegExp(`^${escapeForRegExp(name)}`) });
}

/** Switch this window's folder in place through the titlebar switcher. */
export async function openLibraryFolder(page: Page, name: string): Promise<void> {
  await openFolderSwitcher(page);
  await switcherFolderItem(page, name).click();
  await switcherMenu(page).waitFor({ state: 'hidden' });
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function fileTreeRow(page: Page, relativePath: string): Locator {
  return page.locator(`[role="treeitem"][data-path=${JSON.stringify(relativePath)}]`);
}

export function activeFileTreeRow(page: Page, relativePath: string): Locator {
  return fileTreeRow(page, relativePath).filter({ visible: true });
}

export function documentTab(page: Page, relativePath: string): Locator {
  return page.locator(`[role="tab"][title=${JSON.stringify(relativePath)}]`);
}

export function activeDocumentTab(page: Page): Locator {
  return page
    .getByRole('tablist', { name: 'Open documents' })
    .getByRole('tab', { selected: true });
}

export function activeDocument(page: Page): Locator {
  return page.getByRole('tabpanel').getByRole('region', { name: /Markdown document$/ });
}

export function activeMarkdownEditor(page: Page): Locator {
  // A Markdown document can contain an editable CodeMirror code block. The
  // document editor itself is the ProseMirror textbox, which is the surface
  // that owns document-level typing and selection.
  return activeDocument(page).locator('[role="textbox"].ProseMirror[contenteditable="true"]');
}

export function renameInput(page: Page, relativePath: string): Locator {
  return fileTreeRow(page, relativePath).locator('input[type="text"]');
}

export function quickOpenDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Quick Open' });
}

export function quickOpenInput(page: Page): Locator {
  return quickOpenDialog(page).getByRole('combobox');
}

export function settingsDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Settings' });
}

export function settingsTab(page: Page, name: string): Locator {
  return settingsDialog(page).getByRole('tab', { name, exact: true });
}

/**
 * A `Select` trigger, by its accessible name.
 *
 * The app's selects are Base UI listboxes, not native `<select>`s, so
 * Playwright's `selectOption()` does not apply and `toHaveValue()` reads
 * nothing — the trigger is a button whose TEXT is the current value. Use
 * `chooseSelectOption` to change one and `toHaveText` to assert one.
 */
export function selectTrigger(page: Page, name: string): Locator {
  return page.getByRole('combobox', { name, exact: true });
}

/** Open a `Select` and pick one of its rows by visible label. */
export async function chooseSelectOption(page: Page, name: string, option: string): Promise<void> {
  await selectTrigger(page, name).click();
  // The popup portals to <body>, so it is NOT inside the settings dialog —
  // scope to the listbox rather than to whatever opened it.
  await page.getByRole('listbox').getByRole('option', { name: option, exact: true }).click();
}

export function appearanceGroup(page: Page, name: string): Locator {
  return settingsDialog(page).getByRole('group', { name, exact: true });
}

export function appearanceChoice(page: Page, groupName: string, choice: string): Locator {
  return appearanceGroup(page, groupName).getByRole('button', { name: choice, exact: true });
}

export function saveStatus(page: Page): Locator {
  return page.locator('main.main').getByText('Saved', { exact: true });
}

export async function dismissEmbeddingKeyPrompt(
  page: Page,
): Promise<void> {
  // The first active folder offers Similarity Search setup once. Most journeys are about a
  // different capability, so this compatibility helper deliberately takes
  // the durable Not now path before they continue. Query the same localhost
  // state the gate is resolving before deciding whether to wait: checking
  // whether the lazy dialog happens to be mounted races the gate's request
  // and can return just before the modal opens over the next test action.
  const shouldOffer = await page.evaluate(async () => {
    if (window.localStorage.getItem('stashbase.ai-setup-seen') === '1') return false;
    const response = await fetch('/api/embedder');
    if (!response.ok) throw new Error(`Could not resolve Similarity Search setup state: ${response.status}`);
    const embedder = await response.json() as { authorized?: unknown };
    return embedder.authorized !== true;
  });
  if (!shouldOffer) return;
  const skip = page.getByRole('button', { name: 'Not now', exact: true });
  await skip.waitFor({ state: 'visible', timeout: 20_000 });
  await skip.click();
  await skip.waitFor({ state: 'hidden' });
}
