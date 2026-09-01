import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { LaunchedApp } from '../support/app.ts';
import { launchApp } from '../support/app.ts';
import { createAppFixture } from '../support/fixtures.ts';
import {
  activeDocument,
  activeDocumentTab,
  closeFolderSwitcher,
  dismissEmbeddingKeyPrompt,
  documentTab,
  fileTreeRow,
  openFolderSwitcher,
  openLibraryFolder,
  quickOpenDialog,
  quickOpenInput,
  switcherFolderItem,
} from '../support/locators.ts';
import { seedJourneyWorkspaces } from '../fixtures/journey-workspaces.ts';
import { primaryKey } from './journey-helpers.ts';

// Intent preserved: switching the window's folder resets the workspace
// (tabs and tree) while the whole library membership stays reachable —
// now through the titlebar folder switcher instead of the retired
// sidebar Library section rows.
test('folder switching resets the workspace while library membership remains available', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'two-folders' });
  seedJourneyWorkspaces(fixture);
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    expect(fs.existsSync(path.join(fixture.workspaces.projectA, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.workspaces.projectA, 'CLAUDE.md'))).toBe(false);
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, 'Welcome.md').click();
    await expect(activeDocument(app.page)).toContainText('Project Alpha');
    await expect(app.page.getByRole('tab', { name: 'Welcome.md' })).toHaveAttribute('aria-selected', 'true');

    await openLibraryFolder(app.page, 'project-beta');
    expect(fs.existsSync(path.join(fixture.workspaces.projectB, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.workspaces.projectB, 'CLAUDE.md'))).toBe(false);
    await expect(app.page).toHaveTitle('project-beta — StashBase');
    await dismissEmbeddingKeyPrompt(app.page);
    await expect(fileTreeRow(app.page, 'Notes.md')).toBeVisible();
    await expect(fileTreeRow(app.page, 'Second Note.md')).toHaveCount(0);
    // Membership remains available after the switch: the switcher menu
    // lists both members (the current folder stays listed with a check).
    await openFolderSwitcher(app.page);
    await expect(switcherFolderItem(app.page, 'project-alpha')).toBeVisible();
    await expect(switcherFolderItem(app.page, 'project-beta')).toBeVisible();
    await closeFolderSwitcher(app.page);
    await expect(documentTab(app.page, 'Welcome.md')).toHaveCount(0);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

// Intent preserved: document tabs persist, Quick Open and the Command
// Palette stay keyboard-operable, and dismissing them restores focus.
// Folder entry goes through the titlebar switcher; the flow inside the
// workspace is unchanged.
test('persistent document tabs and Quick Open remain keyboard-operable and restore focus', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    const welcome = fileTreeRow(app.page, 'Welcome.md');
    await welcome.click();
    await welcome.focus();
    await app.page.keyboard.press(`${primaryKey}+O`);
    await expect(quickOpenDialog(app.page)).toBeVisible();
    await expect(quickOpenInput(app.page)).toBeFocused();
    await quickOpenInput(app.page).press('Escape');
    await expect(quickOpenDialog(app.page)).toBeHidden();
    await expect(welcome).toBeFocused();

    await app.page.keyboard.press(`${primaryKey}+O`);
    await quickOpenInput(app.page).fill('Second Note');
    await quickOpenInput(app.page).press('Enter');
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Second Note.md');
    await expect(app.page.getByRole('tab', { name: 'Second Note.md' })).toHaveAttribute('aria-selected', 'true');
    await expect(documentTab(app.page, 'Welcome.md')).toBeVisible();

    await app.page.keyboard.press('F1');
    const palette = app.page.getByRole('dialog', { name: 'Command Palette' });
    await expect(palette).toBeVisible();
    const commandInput = palette.getByRole('combobox');
    await commandInput.fill('>Find in document');
    await commandInput.press('Enter');
    await expect(app.page.getByRole('search', { name: 'Find in document' })).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(app.page.getByRole('search', { name: 'Find in document' })).toBeHidden();

    // The tab's × is pointer-only chrome (aria-hidden inside role="tab"),
    // so it is addressed by its tooltip title rather than a role query.
    await app.page.getByTitle('Close Welcome.md').click();
    await expect(documentTab(app.page, 'Welcome.md')).toHaveCount(0);
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Second Note.md');
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

// Intent: J01/J12 — a bare Library stays interruption-free, while the first
// active folder offers the one app-wide Similarity Search setup choice. Not now is durable;
// the Files-panel action keeps setup manually reachable.
test('Similarity Search setup is offered on the first active folder and Not now suppresses later automatic prompts', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'two-folders' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    const skip = app.page.getByRole('button', { name: 'Not now', exact: true });

    await expect(skip).toBeHidden();
    await expect(app.page.getByText("Similarity Search isn't set up", { exact: true })).toBeVisible();

    await openLibraryFolder(app.page, 'project-alpha');
    await expect(app.page).toHaveTitle('project-alpha — StashBase');
    await expect(skip).toBeVisible();
    await skip.click();
    await expect(skip).toBeHidden();

    // A folder switch remains quiet after that explicit local-only choice.
    await openLibraryFolder(app.page, 'project-beta');
    await expect(skip).toBeHidden();
    await expect(app.page.getByText("Similarity Search isn't set up", { exact: true })).toBeVisible();

    await app.page.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(skip).toBeVisible();
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});
