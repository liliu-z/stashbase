import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { LaunchedApp } from '../support/app.ts';
import { launchApp } from '../support/app.ts';
import { createAppFixture } from '../support/fixtures.ts';
import { activeDocumentTab, activeMarkdownEditor, dismissEmbeddingKeyPrompt, fileTreeRow, openLibraryFolder } from '../support/locators.ts';

async function openCurrentFolderMenu(app: LaunchedApp, folderName: string): Promise<void> {
  await app.page.getByRole('button', { name: `More actions for ${folderName}` }).click();
}

async function chooseContextAction(app: LaunchedApp, relativePath: string, action: string): Promise<void> {
  await fileTreeRow(app.page, relativePath).click({ button: 'right' });
  await app.page.getByRole('menuitem', { name: action, exact: true }).click();
}

function readRecent(configFile: string): Array<{ path: string; favorite?: boolean }> {
  return (JSON.parse(fs.readFileSync(configFile, 'utf8')) as {
    recentFolders: Array<{ path: string; favorite?: boolean }>;
  }).recentFolders;
}

test('file and folder CRUD honors rename and delete cancel/confirm with disk as oracle', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  const folderPath = path.join(fixture.workspaces.projectA, 'CRUD Folder');
  const originalFile = path.join(folderPath, 'Initial.md');
  const renamedFile = path.join(folderPath, 'Renamed.md');
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    await openCurrentFolderMenu(app, 'project-alpha');
    await app.page.getByRole('menuitem', { name: 'New Folder…' }).click();
    const folderInput = app.page.getByRole('textbox', { name: 'New folder in folder root' });
    await folderInput.fill('CRUD Folder');
    await folderInput.press('Enter');
    await expect(fileTreeRow(app.page, 'CRUD Folder')).toBeVisible();
    await expect.poll(() => fs.existsSync(folderPath)).toBe(true);

    await app.page.getByRole('button', { name: /New note in CRUD Folder/ }).click();
    const noteInput = app.page.getByRole('textbox', { name: 'Rename file untitled-1.md' });
    await noteInput.fill('Initial');
    await noteInput.press('Enter');
    await expect(fileTreeRow(app.page, 'CRUD Folder/Initial.md')).toBeVisible();
    await expect.poll(() => fs.existsSync(originalFile)).toBe(true);

    await chooseContextAction(app, 'CRUD Folder/Initial.md', 'Rename…');
    const renameInput = fileTreeRow(app.page, 'CRUD Folder/Initial.md').locator('input[type="text"]');
    await renameInput.fill('Renamed');
    await renameInput.press('Enter');
    await expect(fileTreeRow(app.page, 'CRUD Folder/Renamed.md')).toBeVisible();
    await expect.poll(() => fs.existsSync(renamedFile)).toBe(true);
    expect(fs.existsSync(originalFile)).toBe(false);

    await chooseContextAction(app, 'CRUD Folder/Renamed.md', 'Delete');
    const fileDelete = app.page.getByRole('alertdialog', { name: 'Confirm action' });
    await expect(fileDelete).toContainText('Delete CRUD Folder/Renamed.md?');
    await fileDelete.getByRole('button', { name: 'Cancel' }).click();
    await expect(fileTreeRow(app.page, 'CRUD Folder/Renamed.md')).toBeVisible();
    expect(fs.existsSync(renamedFile)).toBe(true);

    await chooseContextAction(app, 'CRUD Folder/Renamed.md', 'Delete');
    await app.page.getByRole('alertdialog', { name: 'Confirm action' }).getByRole('button', { name: 'Confirm' }).click();
    await expect(fileTreeRow(app.page, 'CRUD Folder/Renamed.md')).toHaveCount(0);
    await expect.poll(() => fs.existsSync(renamedFile)).toBe(false);

    await chooseContextAction(app, 'CRUD Folder', 'Delete');
    await app.page.getByRole('alertdialog', { name: 'Confirm action' }).getByRole('button', { name: 'Cancel' }).click();
    expect(fs.existsSync(folderPath)).toBe(true);
    await chooseContextAction(app, 'CRUD Folder', 'Delete');
    await app.page.getByRole('alertdialog', { name: 'Confirm action' }).getByRole('button', { name: 'Confirm' }).click();
    await expect(fileTreeRow(app.page, 'CRUD Folder')).toHaveCount(0);
    await expect.poll(() => fs.existsSync(folderPath)).toBe(false);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('Favorites and library removal persist without deleting the member folder', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'two-folders' });
  const preservedFile = path.join(fixture.workspaces.projectA, 'Welcome.md');
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    await openCurrentFolderMenu(app, 'project-alpha');
    await app.page.getByRole('menuitem', { name: 'Add to Favorites' }).click();
    await expect.poll(() => readRecent(fixture.configFile).find((entry) => entry.path === fixture.workspaces.projectA)?.favorite).toBe(true);
    app = await app.relaunch();
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await openCurrentFolderMenu(app, 'project-alpha');
    await expect(app.page.getByRole('menuitem', { name: 'Remove from Favorites' })).toBeVisible();
    await app.page.keyboard.press('Escape');

    await openCurrentFolderMenu(app, 'project-alpha');
    await app.page.getByRole('menuitem', { name: 'Remove from Library' }).click();
    const removal = app.page.getByRole('dialog', { name: 'Remove from Library?' });
    await expect(removal).toContainText('not delete the folder or its files');
    await removal.getByRole('button', { name: 'Cancel' }).click();
    expect(readRecent(fixture.configFile).some((entry) => entry.path === fixture.workspaces.projectA)).toBe(true);

    await openCurrentFolderMenu(app, 'project-alpha');
    await app.page.getByRole('menuitem', { name: 'Remove from Library' }).click();
    await app.page.getByRole('dialog', { name: 'Remove from Library?' }).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => readRecent(fixture.configFile).some((entry) => entry.path === fixture.workspaces.projectA)).toBe(false);
    expect(fs.existsSync(preservedFile)).toBe(true);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('visible Sync Folder reconciles an external filesystem mutation', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  const externalFile = path.join(fixture.workspaces.projectA, 'Externally Added.md');
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    expect(await fileTreeRow(app.page, 'Externally Added.md').count()).toBe(0);
    fs.writeFileSync(externalFile, '# External mutation\n\nDetected by visible sync.\n');
    await openCurrentFolderMenu(app, 'project-alpha');
    await app.page.getByRole('menuitem', { name: 'Sync Folder' }).click();
    await expect(fileTreeRow(app.page, 'Externally Added.md')).toBeVisible();
    await fileTreeRow(app.page, 'Externally Added.md').click();
    await expect(app.page.getByRole('region', { name: 'Externally Added.md Markdown document' })).toContainText('Detected by visible sync');
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('a failed save blocks document navigation and Electron window close until persistence recovers', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, 'Welcome.md').click();

    let failWrites = true;
    await app.page.route('**/api/files/**', async (route) => {
      if (failWrites && route.request().method() === 'PUT') {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    const editor = activeMarkdownEditor(app.page);
    await editor.click();
    await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await app.page.keyboard.insertText('\nPersistence must recover before leaving.');
    await expect(app.page.getByText(/Save failed:/)).toBeVisible();

    await fileTreeRow(app.page, 'Second Note.md').click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Welcome.md');
    await app.electron.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect(app.page).toHaveTitle('project-alpha — StashBase');
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Welcome.md');

    failWrites = false;
    await fileTreeRow(app.page, 'Second Note.md').click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Second Note.md');
    expect(app.errors.records.filter((record) => !(
      /request: PUT .*\/api\/files\/Welcome\.md: net::ERR_FAILED/.test(`${record.kind}: ${record.text}`)
      || /console: Failed to load resource: net::ERR_FAILED/.test(`${record.kind}: ${record.text}`)
    ))).toEqual([]);
    app.errors.records.splice(0, app.errors.records.length);
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('J03 exposes both versions and blocks navigation until a save conflict is resolved', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  const source = path.join(fixture.workspaces.projectA, 'Welcome.md');
  const editorMarker = 'Unsaved editor version remains recoverable.';
  const diskMarker = 'Newer external-tool version remains recoverable.';
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, 'Welcome.md').click();

    const editor = activeMarkdownEditor(app.page);
    await editor.click();
    await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await app.page.keyboard.insertText(`\n${editorMarker}`);
    await expect(app.page.getByText('Unsaved', { exact: true })).toBeVisible();
    fs.writeFileSync(source, `# External update\n\n${diskMarker}\n`, 'utf8');

    const resolver = app.page.getByRole('region', { name: 'Conflict detected in Welcome.md' });
    await expect(resolver).toBeVisible();
    await expect(resolver).toContainText(diskMarker);
    await expect(resolver).toContainText(editorMarker);

    await fileTreeRow(app.page, 'Second Note.md').click();
    await expect(resolver).toBeVisible();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Welcome.md');

    await resolver.getByRole('button', { name: 'Reload from Disk' }).click();
    await expect(resolver).toHaveCount(0);
    await expect(activeMarkdownEditor(app.page)).toContainText(diskMarker);
    await expect(activeMarkdownEditor(app.page)).not.toContainText(editorMarker);
    await expect.poll(() => fs.readFileSync(source, 'utf8')).toContain(diskMarker);
    await fileTreeRow(app.page, 'Second Note.md').click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Second Note.md');
    expect(app.errors.records.filter((record) => !(
      /console: Failed to load resource: the server responded with a status of 409 \(Conflict\)/
        .test(`${record.kind}: ${record.text}`)
    ))).toEqual([]);
    app.errors.records.splice(0, app.errors.records.length);
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('J03 recovery reload flushes a live edit before replacing the renderer', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  const source = path.join(fixture.workspaces.projectA, 'Welcome.md');
  const marker = 'Saved through the recovery reload barrier.';
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, 'Welcome.md').click();

    const editor = activeMarkdownEditor(app.page);
    await editor.click();
    await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await app.page.keyboard.insertText(`\n${marker}`);
    await expect(app.page.getByText('Unsaved', { exact: true })).toBeVisible();

    const reloaded = app.page.waitForEvent('load');
    await app.page.evaluate(() => {
      const bridge = (window as unknown as {
        electron?: { reloadWindow?: () => Promise<boolean> };
      }).electron;
      void bridge?.reloadWindow?.();
    });
    await reloaded;
    await app.page.waitForFunction(() => document.body.dataset.bootSettled === '1');
    await dismissEmbeddingKeyPrompt(app.page);

    await expect.poll(() => fs.readFileSync(source, 'utf8')).toContain(marker);
    await fileTreeRow(app.page, 'Welcome.md').click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Welcome.md');
    await expect(activeMarkdownEditor(app.page)).toContainText(marker);
    const unexpectedErrors = app.errors.records.filter((record) => !(
      record.kind === 'request'
      && (
        /GET .*\/api\/files: net::ERR_ABORTED$/u.test(record.text)
        || /GET .*\/api\/index-status\?.*: net::ERR_ABORTED$/u.test(record.text)
      )
    ));
    expect(unexpectedErrors).toEqual([]);
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('real pointer drag reorders root files and moves a nested file to the target level', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    const second = fileTreeRow(app.page, 'Second Note.md');
    const welcome = fileTreeRow(app.page, 'Welcome.md');
    await second.dragTo(welcome);
    await expect.poll(async () => {
      const paths = await app!.page.getByRole('treeitem').evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.path));
      return paths.indexOf('Second Note.md') > paths.indexOf('Welcome.md');
    }).toBe(true);

    const nestedFolder = fileTreeRow(app.page, 'nested');
    await second.dragTo(nestedFolder);
    await expect(fileTreeRow(app.page, 'nested/Second Note.md')).toBeVisible();
    await expect.poll(() => fs.existsSync(path.join(fixture.workspaces.projectA, 'nested', 'Second Note.md'))).toBe(true);
    expect(fs.existsSync(path.join(fixture.workspaces.projectA, 'Second Note.md'))).toBe(false);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});
