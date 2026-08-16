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
  saveStatus,
} from '../support/locators.ts';
import {
  JOURNEY_CSV,
  JOURNEY_JSON,
  JOURNEY_MARKDOWN,
  seedJourneyWorkspaces,
} from '../fixtures/journey-workspaces.ts';
import { openedExternalUrls, stubExternalBrowser } from './journey-helpers.ts';

const FRONTMATTER = '---\ntitle: Journey fixture\ntags:\n  - regression\n---\n';

test('Markdown preserves frontmatter across editing and safely routes links and images', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  seedJourneyWorkspaces(fixture);
  const sourceFile = path.join(fixture.workspaces.projectA, JOURNEY_MARKDOWN);
  const remoteRequests: string[] = [];
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    app.page.on('request', (request) => {
      if (request.url().includes('remote.invalid')) remoteRequests.push(request.url());
    });
    await stubExternalBrowser(app.electron);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, JOURNEY_MARKDOWN).click();

    const editor = activeMarkdownEditor(app.page);
    await expect(editor).toBeVisible();
    await expect(activeDocument(app.page)).toContainText('Journey Markdown');
    await expect(activeDocument(app.page)).not.toContainText('title: Journey fixture');
    await editor.click({ position: { x: 12, y: 12 } });
    await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await app.page.keyboard.insertText('\nEdited through the journey.');
    await expect(saveStatus(app.page)).toBeVisible();
    await expect.poll(() => fs.readFileSync(sourceFile, 'utf8')).toContain('Edited through the journey.');
    expect(fs.readFileSync(sourceFile, 'utf8').startsWith(FRONTMATTER)).toBe(true);

    await app.page.getByRole('button', { name: 'Switch to Reading View' }).click();
    const reading = app.page.getByRole('region', { name: 'Journey Markdown.md Markdown document' });
    await expect(reading).toContainText('Edited through the journey.');
    await expect(reading.getByRole('table')).toContainText('Table journey');
    await expect(reading.getByRole('listitem').filter({ hasText: 'Completed task journey' })).toBeVisible();
    await expect(reading.getByRole('button', { name: 'ts', exact: true })).toBeVisible();
    await expect(reading.getByText('const regressionJourney = true;', { exact: true })).toBeVisible();
    await expect(reading.getByRole('note', { name: 'Note' })).toContainText('Alert journey content.');
    await expect(reading.getByRole('math')).toContainText(/E\s*=\s*m\s*c\s*2/);
    const localImage = activeDocument(app.page).locator('img[src*="/asset/"]').first();
    await expect(localImage).toHaveAttribute('src', /\/asset\//);
    expect(remoteRequests).toEqual([]);
    await localImage.click();
    const lightbox = app.page.getByRole('dialog', { name: 'Image preview' });
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByRole('button', { name: 'Download image' })).toBeVisible();
    await lightbox.getByRole('button', { name: 'Zoom in' }).click();
    await expect(lightbox).toContainText('120%');
    await lightbox.getByRole('button', { name: 'Zoom out' }).click();
    await expect(lightbox).toContainText('100%');
    await app.page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();

    await activeDocument(app.page).getByRole('link', { name: 'Open external fixture' }).click();
    await expect.poll(() => openedExternalUrls(app!.electron)).toEqual(['https://example.com/stashbase-e2e']);
    await expect(app.page).toHaveURL(/^http:\/\/127\.0\.0\.1:/);

    await activeDocument(app.page).getByRole('link', { name: 'Open Second Note' }).click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Second Note.md');
    await expect(activeDocument(app.page)).toContainText('Opened through Quick Open');
    await documentTab(app.page, JOURNEY_MARKDOWN).click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', JOURNEY_MARKDOWN);
    expect(fs.readFileSync(sourceFile, 'utf8')).toContain('Edited through the journey.');

    await app.page.getByRole('button', { name: 'Switch to Live Editing' }).click();
    await expect(editor).toBeVisible();
    // Click the final paragraph directly before creating the empty paragraph
    // required by the slash menu. Chromium's document-end shortcut can leave
    // ProseMirror's retained virtual selection at its earlier heading.
    const finalParagraph = editor.locator('p').last();
    await finalParagraph.selectText();
    await app.page.keyboard.press('ArrowRight');
    await app.page.keyboard.press('Enter');
    await app.page.keyboard.insertText('/');
    // Crepe keeps command items for hidden menu groups mounted. Restrict the
    // lookup to its shown slash menu before selecting the exact visible label. The
    // list item also contains icon text, so matching the whole item is brittle.
    const slashMenu = activeDocument(app.page).locator('.milkdown-slash-menu[data-show="true"]');
    await expect(slashMenu).toBeVisible();
    const headingCommand = slashMenu.getByText('Heading 1', { exact: true });
    await expect(headingCommand).toBeVisible();
    await headingCommand.click();
    await app.page.keyboard.insertText('Slash journey heading');
    await expect(saveStatus(app.page)).toBeVisible();
    await expect.poll(() => fs.readFileSync(sourceFile, 'utf8')).toContain('# Slash journey heading');
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('JSON opens as a source-preserving tree and invalid source remains editable', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  seedJourneyWorkspaces(fixture);
  const sourceFile = path.join(fixture.workspaces.projectA, JOURNEY_JSON);
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, JOURNEY_JSON).click();

    const region = app.page.getByRole('region', { name: 'JSON document' });
    const tree = region.getByRole('tree', { name: 'JSON values' });
    await expect(tree).toBeVisible();
    await expect(tree).toContainText('"fixture"');
    await expect(tree).toContainText('"raw journey"');
    await expect(region.getByRole('button', { name: 'Tree', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(tree.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    const treeItems = tree.getByRole('treeitem');
    await treeItems.first().focus();
    await app.page.keyboard.press('End');
    await expect(treeItems.last()).toHaveAttribute('aria-selected', 'true');
    await app.page.keyboard.press('Home');
    await expect(treeItems.first()).toHaveAttribute('aria-selected', 'true');
    await app.page.keyboard.press('ArrowDown');
    await expect(treeItems.nth(1)).toHaveAttribute('aria-selected', 'true');
    await app.page.keyboard.press('ArrowLeft');
    await expect(treeItems.first()).toHaveAttribute('aria-selected', 'true');

    await region.getByRole('button', { name: 'Source' }).click();
    const source = region.locator('.cm-content');
    await expect(source).toContainText('"fixture": "raw journey"');
    await expect(source).toHaveAttribute('contenteditable', 'false');
    await region.getByRole('button', { name: 'Tree', exact: true }).click();
    await app.page.getByRole('button', { name: 'Switch to Live Editing' }).click();
    const fixtureRow = tree.getByRole('treeitem').filter({ hasText: '"fixture"' });
    await fixtureRow.getByRole('button', { name: 'Edit', exact: true }).click();
    const treeEditor = region.getByRole('group', { name: 'Edit $.fixture' });
    await treeEditor.getByRole('button', { name: 'Cancel' }).click();
    await expect(fixtureRow).toBeFocused();
    await fixtureRow.getByRole('button', { name: 'Edit', exact: true }).click();
    await treeEditor.getByLabel('JSON value').fill('"tree journey"');
    await treeEditor.getByRole('button', { name: 'Apply' }).click();
    await expect(fixtureRow).toBeFocused();
    await expect(tree).toContainText('"tree journey"');
    await expect(saveStatus(app.page)).toBeVisible();
    await expect.poll(() => fs.readFileSync(sourceFile, 'utf8')).toContain('"fixture": "tree journey"');

    await region.getByRole('button', { name: 'Source' }).click();
    await expect(source).toHaveAttribute('contenteditable', 'true');
    await expect(source).toContainText('"fixture": "tree journey"');
    await source.click();
    await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await app.page.keyboard.insertText('\nmalformed tail');
    await expect(saveStatus(app.page)).toBeVisible();
    await expect.poll(() => fs.readFileSync(sourceFile, 'utf8')).toContain('malformed tail');
    await expect(region.getByRole('button', { name: 'Tree', exact: true })).toBeDisabled();
    await expect(region).toContainText(/line \d+, column \d+/u);
    await app.page.getByRole('button', { name: 'Switch to Reading View' }).click();
    await expect(source).toHaveAttribute('contenteditable', 'false');
    await expect(source).toContainText('malformed tail');
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('CSV displays tabular data by default, toggles Source mode, and preserves BOM and CRLF across editing', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  seedJourneyWorkspaces(fixture);
  const sourceFile = path.join(fixture.workspaces.projectA, JOURNEY_CSV);
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await stubExternalBrowser(app.electron);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, JOURNEY_CSV).click();

    const region = app.page.getByRole('region', { name: 'CSV document' });
    await expect(region).toBeVisible();
    await expect(region.getByRole('button', { name: 'Table', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // Switch to Source mode
    await region.getByRole('button', { name: 'Source', exact: true }).click();
    const source = region.locator('.cm-content');
    await expect(source).toBeVisible();
    await expect(source).toContainText('101,Alice,engineer');
    await expect(source).toHaveAttribute('contenteditable', 'false');

    // Switch to Live Editing mode
    await app.page.getByRole('button', { name: 'Switch to Live Editing' }).click();
    await expect(source).toHaveAttribute('contenteditable', 'true');
    await source.click();
    await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await app.page.keyboard.insertText('\n103,Charlie,manager');

    await expect(saveStatus(app.page)).toBeVisible();
    await expect.poll(() => fs.readFileSync(sourceFile, 'utf8')).toContain('103,Charlie,manager');
    const diskContent = fs.readFileSync(sourceFile, 'utf8');
    expect(diskContent.startsWith('\uFEFF')).toBe(true);
    expect(diskContent.includes('\r\n')).toBe(true);

    // Switch back to Table mode
    await region.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(region.getByRole('button', { name: 'Table', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // Test invalid CSV unclosed quote disables Table mode
    await region.getByRole('button', { name: 'Source', exact: true }).click();
    await source.click();
    await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await app.page.keyboard.insertText('\n"unclosed quote line');
    await expect(saveStatus(app.page)).toBeVisible();
    await expect.poll(() => fs.readFileSync(sourceFile, 'utf8')).toContain('unclosed quote line');
    await expect(region.getByRole('button', { name: 'Table', exact: true })).toBeDisabled();
    await expect(region).toContainText(/Unclosed quote detected/u);

    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});
