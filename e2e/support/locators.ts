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

/** A library member row inside the OPEN switcher menu. The menuitem's
 *  accessible name is the folder basename followed by its shortened
 *  path detail, so match on the leading basename only. */
export function switcherFolderItem(page: Page, name: string): Locator {
  return page.getByRole('menuitem', { name: new RegExp(`^${escapeForRegExp(name)}`) });
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
  options: { waitForOffer?: boolean } = {},
): Promise<void> {
  // The AI Index prompt re-offers PER FOLDER within a window (the skip is
  // folder-scoped), so this can no longer cache per page. The launch harness
  // waits for the initial offer; later journey calls only dismiss a prompt
  // that is already visible and otherwise return immediately.
  // `bootSettled` can precede the lazy prompt chunk on slower CI hosts. Its
  // modal fallback owns pointer events, so wait for that boundary before
  // deciding whether the real prompt exists.
  await page.getByRole('dialog', { name: 'Getting things ready…', exact: true })
    .waitFor({ state: 'hidden', timeout: 20_000 });
  const skip = page.getByRole('button', { name: 'Skip AI Index for now', exact: true });
  if (options.waitForOffer) {
    await skip.waitFor({ state: 'visible', timeout: 20_000 });
  } else if (!(await skip.isVisible())) {
    return;
  }
  await skip.click();
  await skip.waitFor({ state: 'hidden' });
}
