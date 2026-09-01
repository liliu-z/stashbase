import { expect, test } from '@playwright/test';
import type { LaunchedApp } from '../support/app.ts';
import { launchApp } from '../support/app.ts';
import { createAppFixture } from '../support/fixtures.ts';
import {
  activeDocument,
  activeDocumentTab,
  dismissEmbeddingKeyPrompt,
  documentTab,
  openLibraryFolder,
} from '../support/locators.ts';
import {
  CROSS_FOLDER_NOTE,
  EXACT_SEARCH_PHRASE,
  seedJourneyWorkspaces,
} from '../fixtures/journey-workspaces.ts';
import { openFolderPickerMenu, primaryKey, stubOpenFolderDialog } from './journey-helpers.ts';

test('exact library search keeps cross-folder results in their owning identity', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'two-folders' });
  seedJourneyWorkspaces(fixture);
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await app.page.keyboard.press(`${primaryKey}+Shift+F`);
    const dialog = app.page.getByRole('dialog', { name: 'Search library' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Exact', exact: true }).click();
    await dialog.getByRole('combobox').fill(EXACT_SEARCH_PHRASE);

    const crossFolder = dialog.locator(`[role="option"][title=${JSON.stringify(`${fixture.workspaces.projectB}/${CROSS_FOLDER_NOTE}`)}]`);
    await expect(crossFolder).toBeVisible();
    await crossFolder.click();
    await expect(dialog).toBeHidden();
    await expect(app.page).toHaveTitle('project-alpha — StashBase');
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', `${fixture.workspaces.projectB}/${CROSS_FOLDER_NOTE}`);
    await expect(activeDocument(app.page)).toContainText('Cross Folder Result');
    await expect(app.page.getByText(/viewing a file outside the current folder/)).toBeVisible();
    await expect(app.page.getByRole('button', { name: 'Switch to Live Editing' })).toHaveCount(0);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('native folder dialog success, cancellation, and failure preserve their boundaries', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'empty' });
  seedJourneyWorkspaces(fixture);
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);

    await stubOpenFolderDialog(app.electron, { kind: 'cancel' });
    await openFolderPickerMenu(app.page);
    await expect(app.page).toHaveTitle('StashBase');
    await expect(app.page.getByText('Add a folder to your Wiki.')).toBeVisible();

    await stubOpenFolderDialog(app.electron, { kind: 'error', message: 'fixture picker failed' });
    await openFolderPickerMenu(app.page);
    await expect(app.page.getByRole('alert').filter({
      hasText: /Could not open the folder:.*fixture picker failed/,
    })).toBeVisible();
    await expect(app.page).toHaveTitle('StashBase');

    await stubOpenFolderDialog(app.electron, { kind: 'success', path: fixture.workspaces.projectA });
    await openFolderPickerMenu(app.page);
    await expect(app.page).toHaveTitle('project-alpha — StashBase');
    await expect(app.page.getByRole('button', { name: 'Select project-alpha folder root' })).toBeVisible();
    await dismissEmbeddingKeyPrompt(app.page);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('exact search remembers state, distinguishes duplicate paths, and resolves cross-folder content', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'two-folders' });
  seedJourneyWorkspaces(fixture);
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await app.page.keyboard.press(`${primaryKey}+Shift+F`);
    let dialog = app.page.getByRole('dialog', { name: 'Search library' });
    await dialog.getByRole('button', { name: 'Exact', exact: true }).click();
    await dialog.getByRole('combobox').fill(EXACT_SEARCH_PHRASE);
    await expect(dialog.getByText('project-alpha', { exact: true })).toBeVisible();
    await expect(dialog.getByText('project-beta', { exact: true })).toBeVisible();
    await dialog.getByRole('combobox').press('Escape');

    await openLibraryFolder(app.page, 'project-beta');
    await dismissEmbeddingKeyPrompt(app.page);
    await app.page.keyboard.press(`${primaryKey}+Shift+F`);
    dialog = app.page.getByRole('dialog', { name: 'Search library' });
    await expect(dialog.getByRole('combobox')).toHaveValue(EXACT_SEARCH_PHRASE);
    await expect(dialog.getByRole('button', { name: 'Exact', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('option')).not.toHaveCount(0);

    await dialog.getByRole('combobox').fill('Welcome to Project');
    const alphaWelcome = dialog.locator(`[role="option"][title=${JSON.stringify(`${fixture.workspaces.projectA}/Welcome.md`)}]`);
    const betaWelcome = dialog.locator(`[role="option"][title=${JSON.stringify(`${fixture.workspaces.projectB}/Welcome.md`)}]`);
    await expect(alphaWelcome).toBeVisible();
    await expect(betaWelcome).toBeVisible();
    await expect(alphaWelcome).not.toHaveAttribute('title', await betaWelcome.getAttribute('title') ?? '');

    await dialog.getByRole('combobox').fill(EXACT_SEARCH_PHRASE);
    const sameFolderMatch = dialog.locator(`[role="option"][title=${JSON.stringify(`${fixture.workspaces.projectB}/${CROSS_FOLDER_NOTE}`)}]`).last();
    await sameFolderMatch.click();
    await expect(app.page.getByRole('search', { name: 'Find in document' })).toBeVisible();
    await expect(app.page.getByPlaceholder('Find')).toHaveValue(EXACT_SEARCH_PHRASE);
    await expect(activeDocument(app.page).locator('img[src*="/asset/"]')).toBeVisible();
    await activeDocument(app.page).getByRole('link', { name: 'Beta sibling' }).click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Notes.md');

    await documentTab(app.page, CROSS_FOLDER_NOTE).click();
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await expect(app.page).toHaveTitle('project-alpha — StashBase');
    await app.page.keyboard.press(`${primaryKey}+Shift+F`);
    dialog = app.page.getByRole('dialog', { name: 'Search library' });
    await expect(dialog.getByRole('combobox')).toHaveValue(EXACT_SEARCH_PHRASE);
    const crossFolderMatch = dialog.locator(`[role="option"][title=${JSON.stringify(`${fixture.workspaces.projectB}/${CROSS_FOLDER_NOTE}`)}]`).last();
    await crossFolderMatch.click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', `${fixture.workspaces.projectB}/${CROSS_FOLDER_NOTE}`);
    await expect(app.page.getByText(/viewing a file outside the current folder/)).toBeVisible();
    await expect(activeDocument(app.page).locator('img[src*="/asset/"]')).toBeVisible();
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});
