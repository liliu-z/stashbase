import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { LaunchedApp } from '../support/app.ts';
import { launchApp } from '../support/app.ts';
import { createAppFixture } from '../support/fixtures.ts';
import {
  activeDocument,
  activeDocumentTab,
  activeMarkdownEditor,
  dismissEmbeddingKeyPrompt,
  documentTab,
  fileTreeRow,
  openLibraryFolder,
  renameInput,
  saveStatus,
} from '../support/locators.ts';

const NOTE_NAME = 'Smoke Journey.md';
const NOTE_TEXT = 'Persisted through the real editor.';
const NOTE_CONTENT = `${NOTE_TEXT}\n`;

test('user can create, edit, save, navigate away, relaunch, and reopen a note', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  const noteFile = path.join(fixture.workspaces.projectA, NOTE_NAME);
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    await app.page.getByTitle('New note in project-alpha').click();
    await expect(renameInput(app.page, 'untitled-1.md')).toBeVisible();
    await renameInput(app.page, 'untitled-1.md').fill('Smoke Journey');
    await renameInput(app.page, 'untitled-1.md').press('Enter');
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', NOTE_NAME);

    const editor = activeMarkdownEditor(app.page);
    await expect(editor).toBeVisible();
    await editor.click();
    await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await app.page.keyboard.insertText(NOTE_TEXT);
    await expect(editor).toContainText(NOTE_TEXT);
    await expect(saveStatus(app.page)).toBeVisible();
    await expect.poll(() => fs.readFileSync(noteFile, 'utf8')).toBe(NOTE_CONTENT);

    await fileTreeRow(app.page, 'Welcome.md').click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Welcome.md');
    await documentTab(app.page, NOTE_NAME).click();
    await expect(activeMarkdownEditor(app.page)).toBeVisible({ timeout: 30_000 });
    await expect(activeMarkdownEditor(app.page)).toContainText('Persisted through the real editor');

    app = await app.relaunch();
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, NOTE_NAME).click();
    await expect(activeMarkdownEditor(app.page)).toBeVisible({ timeout: 30_000 });
    await expect(activeMarkdownEditor(app.page)).toContainText('Persisted through the real editor');
    expect(fs.readdirSync(fixture.workspaces.projectA).filter((name) => name === NOTE_NAME)).toHaveLength(1);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});
