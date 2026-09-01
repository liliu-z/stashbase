import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import type { LaunchedApp } from '../support/app.ts';
import { launchApp } from '../support/app.ts';
import { createAppFixture } from '../support/fixtures.ts';
import {
  activeDocumentTab,
  dismissEmbeddingKeyPrompt,
  documentTab,
  closeFolderSwitcher,
  fileTreeRow,
  openFolderSwitcher,
  openLibraryFolder,
  quickOpenDialog,
  quickOpenInput,
  switcherFolderItem,
} from '../support/locators.ts';
import { primaryKey } from './journey-helpers.ts';

async function openFolderMenu(app: LaunchedApp, name: string): Promise<void> {
  await app.page.getByRole('button', { name: `More actions for ${name}` }).click();
}

test('double-clicking a file opens only one tab for that path', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    await fileTreeRow(app.page, 'Welcome.md').dblclick();

    await expect(documentTab(app.page, 'Welcome.md')).toHaveCount(1);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('persistent tabs prevent duplicates, reuse a blank tab, and expose MRU Editor History', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, 'Welcome.md').click();
    await fileTreeRow(app.page, 'Second Note.md').click();
    await fileTreeRow(app.page, 'Welcome.md').click();
    await expect(documentTab(app.page, 'Welcome.md')).toHaveCount(1);
    await expect(documentTab(app.page, 'Second Note.md')).toHaveCount(1);

    await app.page.keyboard.press(`${primaryKey}+T`);
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Empty tab');
    // Use an ordinary fixture source for the third editor. Folder entry no
    // longer manufactures AGENTS.md as hidden setup for unrelated tab tests.
    await fileTreeRow(app.page, 'data.json').click();
    await expect(app.page.locator('.tab-strip-inner > [role="tab"]')).toHaveCount(3);
    await expect(documentTab(app.page, 'data.json')).toHaveCount(1);

    // The chord cancels on window blur BY DESIGN (alt-tab register), so
    // make sure this window owns OS focus before pressing it — a stray
    // focus steal between the two Tab presses re-arms the pending switch
    // at index 1 and the selection lands one entry short.
    await app.page.bringToFront();
    await activeDocumentTab(app.page).focus();
    await app.page.keyboard.down('Control');
    await app.page.keyboard.press('Tab');
    await app.page.keyboard.press('Tab');
    const history = app.page.getByRole('dialog', { name: 'Editor History' });
    await expect(history).toBeVisible();
    await expect(history.getByRole('option').first()).toContainText('data.json');
    await expect(history.getByRole('option', { name: 'Second Note.md' })).toHaveAttribute('aria-selected', 'true');
    await app.page.keyboard.up('Control');
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Second Note.md');
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('Quick Open honors editor recency and command availability while Settings owns topmost input', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, 'Welcome.md').click();
    await fileTreeRow(app.page, 'Second Note.md').click();
    await documentTab(app.page, 'Welcome.md').click();

    await app.page.keyboard.press(`${primaryKey}+O`);
    await expect(quickOpenDialog(app.page).getByRole('option').first()).toContainText('Welcome.md');
    await quickOpenInput(app.page).fill('wel');
    await expect(quickOpenDialog(app.page).getByRole('option').first()).toContainText('Welcome.md');
    await quickOpenInput(app.page).press('Escape');

    await app.page.keyboard.press('F1');
    const palette = app.page.getByRole('dialog', { name: 'Command Palette' });
    await expect(palette.getByRole('option', { name: /Save/ })).toBeVisible();
    await expect(palette.getByRole('option', { name: /Toggle Editing Mode/ })).toBeVisible();
    await palette.getByRole('combobox').press('Escape');
    // The tab's × is pointer-only chrome (aria-hidden inside role="tab"),
    // so it is addressed by its tooltip title rather than a role query.
    await app.page.getByTitle('Close Welcome.md').click();
    await app.page.getByTitle('Close Second Note.md').click();
    await app.page.keyboard.press('F1');
    const emptyPalette = app.page.getByRole('dialog', { name: 'Command Palette' });
    await expect(emptyPalette.getByRole('option', { name: /Save/ })).toHaveCount(0);
    await expect(emptyPalette.getByRole('option', { name: /Find in Document/ })).toHaveCount(0);
    await emptyPalette.getByRole('combobox').press('Escape');

    await app.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = app.page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await app.page.keyboard.press(`${primaryKey}+O`);
    await expect(quickOpenDialog(app.page)).toHaveCount(0);
    await app.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

// Intent preserved: favoriting pins a member ahead of the rest of the
// library list (now the switcher menu's Favorites section before its
// Library section), and removing the ACTIVE folder returns the window
// Home without deleting anything on disk. Favorite/remove management
// lives only on the active folder header's "More actions" menu now, so
// each folder is favorited or removed while it is the window's folder.
test('Favorites pin above recents and removing the active folder returns to Home without deleting it', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'two-folders' });
  const preserved = `${fixture.workspaces.projectA}/Welcome.md`;
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-beta');
    await dismissEmbeddingKeyPrompt(app.page);
    await openFolderMenu(app, 'project-beta');
    await app.page.getByRole('menuitem', { name: 'Add to Favorites' }).click();

    // Ordering surfaces in the switcher menu: a "Favorites" heading with
    // project-beta appears before the "Library" heading with the
    // non-favorite member project-alpha.
    await openFolderSwitcher(app.page);
    await expect(switcherFolderItem(app.page, 'project-beta')).toBeVisible();
    const entries = await app.page.getByRole('menu')
      .locator('[role="presentation"], [role="menuitem"], [role="menuitemradio"]').allInnerTexts();
    const indexOf = (prefix: string) => entries.findIndex((text) => text.trim().startsWith(prefix));
    expect(indexOf('Favorites')).toBeGreaterThan(-1);
    expect(indexOf('project-beta')).toBeGreaterThan(indexOf('Favorites'));
    expect(indexOf('Library')).toBeGreaterThan(indexOf('project-beta'));
    expect(indexOf('project-alpha')).toBeGreaterThan(indexOf('Library'));

    // Selecting a member in the open menu switches this window in place.
    await switcherFolderItem(app.page, 'project-alpha').click();
    await expect(app.page).toHaveTitle('project-alpha — StashBase');
    // Folder switching remains uninterrupted when Similarity Search is off.
    await dismissEmbeddingKeyPrompt(app.page);

    await openFolderMenu(app, 'project-alpha');
    await app.page.getByRole('menuitem', { name: 'Remove from Library' }).click();
    await app.page.getByRole('dialog', { name: 'Remove from Library?' }).getByRole('button', { name: 'Remove' }).click();
    await expect(app.page).toHaveTitle('StashBase');
    await expect(app.page.getByRole('button', { name: 'Select project-alpha folder root' })).toHaveCount(0);
    await expect(app.page.getByText('Chat and search cover your whole library')).toBeVisible();
    // Returning to the bare window stays uninterrupted too.
    await dismissEmbeddingKeyPrompt(app.page);
    // Members remain but none is open, so the sidebar carries the Choose
    // Folder invitation below New Chat.
    await expect(app.page.getByRole('button', { name: 'Choose Folder' })).toBeVisible();
    // The removed folder is gone from the switcher menu; the remaining
    // member is still offered.
    await openFolderSwitcher(app.page);
    await expect(switcherFolderItem(app.page, 'project-beta')).toBeVisible();
    await expect(switcherFolderItem(app.page, 'project-alpha')).toHaveCount(0);
    await closeFolderSwitcher(app.page);
    expect(fs.existsSync(preserved)).toBe(true);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('the active-folder header switcher lists the library and swaps the window folder in place', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'two-folders' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await expect(app.page).toHaveTitle('project-alpha — StashBase');
    await dismissEmbeddingKeyPrompt(app.page);

    // The titlebar trigger opens the picker: add-folder actions on top,
    // membership rows below, the current folder carrying the check.
    await app.page.getByRole('button', { name: 'Switch folder' }).click();
    await expect(app.page.getByRole('menuitem', { name: 'Open Folder…' })).toBeVisible();
    await expect(app.page.getByRole('menuitemradio', { name: /project-alpha/ })).toBeVisible();

    // Selecting another member switches THIS window's folder in place.
    await app.page.getByRole('menuitemradio', { name: /project-beta/ }).click();
    await expect(app.page).toHaveTitle('project-beta — StashBase');
    await expect(fileTreeRow(app.page, 'Notes.md')).toBeVisible();
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});
