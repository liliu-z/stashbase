import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator } from 'playwright';
import type { LaunchedApp } from '../support/app.ts';
import { launchApp } from '../support/app.ts';
import { createAppFixture } from '../support/fixtures.ts';
import {
  activeDocumentTab,
  activeMarkdownEditor,
  dismissEmbeddingKeyPrompt,
  fileTreeRow,
  folderSwitcherTrigger,
  openLibraryFolder,
  saveStatus,
} from '../support/locators.ts';
import { primaryKey } from './journey-helpers.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = path.resolve(HERE, '..', 'fixtures', 'fake-codex-app-server.mjs');
const FAKE_EXTRACTOR = path.resolve(HERE, '..', 'fixtures', 'fake-extractor.mjs');
const PNG_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function activeAgentPanel(page: LaunchedApp['page']): Locator {
  return page.locator('[role="tabpanel"]:not([aria-hidden="true"]) .agent-view');
}

function configureFakeAgent(fixture: Awaited<ReturnType<typeof createAppFixture>>): void {
  fixture.env.STASHBASE_CODEX_BIN = FAKE_CODEX;
  fixture.env.STASHBASE_AGENT_DISCOVERY_POLICY = 'system-only';
  fixture.env.STASHBASE_FAKE_MCP_PORT = String(fixture.port);
}

async function selectCodex(page: LaunchedApp['page']): Promise<void> {
  await page.getByRole('button', { name: 'Choose agent for new chat' }).click();
  await page.getByRole('menuitem', { name: 'Codex' }).click();
}

test('J12 builds source-linked Wiki Pages independently from first-folder Similarity Search setup', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  configureFakeAgent(fixture);
  const sourceFile = path.join(fixture.workspaces.projectA, 'Welcome.md');
  const originalSource = fs.readFileSync(sourceFile, 'utf8');
  const wikiFile = path.join(fixture.workspaces.projectA, 'wiki', 'index.md');
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await expect(app.page.getByRole('heading', { name: 'Set up Similarity Search' })).toBeVisible();
    await app.page.getByRole('button', { name: 'Not now', exact: true }).click();
    await selectCodex(app.page);
    await app.page.getByRole('button', { name: 'New Chat', exact: true }).click();

    const panel = activeAgentPanel(app.page);
    const heading = panel.getByRole('heading', { name: 'Your Wiki is here.' });
    const buildWikiPages = panel.getByRole('button', { name: 'Build Wiki', exact: true });
    await expect(heading).toBeVisible();
    await expect(buildWikiPages).toBeVisible();
    const [panelBox, headingBox, buildWikiPagesBox] = await Promise.all([
      panel.boundingBox(),
      heading.boundingBox(),
      buildWikiPages.boundingBox(),
    ]);
    expect(panelBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    expect(buildWikiPagesBox).not.toBeNull();
    if (!panelBox || !headingBox || !buildWikiPagesBox) throw new Error('Build Wiki empty-state geometry is unavailable');
    const panelCenter = panelBox.y + panelBox.height / 2;
    const actionGroupCenter = (headingBox.y + buildWikiPagesBox.y + buildWikiPagesBox.height) / 2;
    expect(Math.abs(actionGroupCenter - panelCenter)).toBeLessThan(panelBox.height * 0.15);

    await buildWikiPages.click();
    await expect(app.page.getByRole('heading', { name: 'Set up Similarity Search' })).toHaveCount(0);
    await expect(panel.getByText('Build or update Wiki Pages from these Sources.', { exact: true })).toBeVisible();
    await expect(panel.getByText('Allow Codex to write wiki/index.md?')).toBeVisible();

    await panel.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(panel.getByText('wiki/index.md now maps the folder.')).toBeVisible();
    await expect(fileTreeRow(app.page, 'wiki')).toBeVisible();
    await expect.poll(() => fs.readFileSync(wikiFile, 'utf8')).toContain('[Welcome](../Welcome.md)');
    expect(fs.existsSync(path.join(fixture.workspaces.projectA, 'WIKI.md'))).toBe(false);
    expect(fs.readFileSync(sourceFile, 'utf8')).toBe(originalSource);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('J07 converges an approved Agent write into a reviewed durable Canvas', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  configureFakeAgent(fixture);
  const canvasFile = path.join(fixture.workspaces.projectA, 'Canvas.md');
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await fileTreeRow(app.page, 'Welcome.md').click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Welcome.md');

    await selectCodex(app.page);
    await app.page.getByRole('button', { name: 'New Chat', exact: true }).click();
    const chatTab = app.page.getByRole('tablist', { name: 'Chat sessions' }).getByRole('tab', { selected: true });
    const panel = activeAgentPanel(app.page);
    const composer = panel.locator('[aria-label="Message agent"]');
    await expect(composer).toHaveAttribute('contenteditable', 'true');
    await composer.fill('journey:j07 converge canvas');
    await panel.getByRole('button', { name: 'Send message' }).click();

    await expect(panel.getByText('Allow Codex to write Canvas.md?')).toBeVisible();
    await panel.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(panel.getByText('Canvas.md now contains the accepted conclusions.')).toBeVisible();
    await expect(fileTreeRow(app.page, 'Canvas.md')).toBeVisible();
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', 'Welcome.md');

    await fileTreeRow(app.page, 'Canvas.md').click();
    const editor = activeMarkdownEditor(app.page);
    await expect(editor).toContainText('Accepted conclusion from the scoped conversation.');
    await editor.click();
    await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await app.page.keyboard.insertText('\nReviewed by the user.');
    await expect(saveStatus(app.page)).toBeVisible();
    await expect.poll(() => fs.readFileSync(canvasFile, 'utf8')).toContain('Reviewed by the user.');

    // The document tab's × is pointer-only chrome (aria-hidden inside
    // role="tab"), addressed by its tooltip title rather than a role query.
    await app.page.getByTitle('Close Canvas.md').click();
    await expect(app.page.getByRole('tab', { name: 'Canvas.md' })).toHaveCount(0);
    await fileTreeRow(app.page, 'Canvas.md').click();
    await expect(activeMarkdownEditor(app.page)).toContainText('Reviewed by the user.');
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('J11 creates a project only after approval and continues the same conversation there', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  configureFakeAgent(fixture);
  const projectName = 'conversation-project';
  const projectFolder = path.join(fixture.folderHome, projectName);
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await expect(app.page).toHaveTitle('StashBase');
    await selectCodex(app.page);
    await app.page.getByRole('button', { name: 'New Chat', exact: true }).click();
    let panel = activeAgentPanel(app.page);
    let composer = panel.locator('[aria-label="Message agent"]');
    await expect(panel.getByRole('button', { name: 'Session scope: Library' })).toBeVisible();
    await expect(composer).toHaveAttribute('contenteditable', 'true');

    await composer.fill('journey:j11 create project denied');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText(`Allow Codex to create ${projectName}?`)).toBeVisible();
    await panel.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(panel.getByText('permission declined')).toBeVisible();
    expect(fs.existsSync(projectFolder)).toBe(false);
    await folderSwitcherTrigger(app.page).click();
    await expect(app.page.getByRole('menuitemradio', { name: new RegExp(`^${projectName}`) })).toHaveCount(0);
    await app.page.keyboard.press('Escape');

    await expect(composer).toHaveAttribute('contenteditable', 'true');
    await composer.fill('journey:j11 create project approved');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText(`Allow Codex to create ${projectName}?`)).toBeVisible();
    await panel.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(panel.getByText(`${projectName} is ready and this conversation moved into it.`)).toBeVisible();

    await expect(app.page).toHaveTitle(`${projectName} — StashBase`);
    // This is the first folder activated in the Library-scoped journey, so
    // the independent one-time Similarity Search setup offer may open after project rebind.
    await dismissEmbeddingKeyPrompt(app.page);
    await expect(folderSwitcherTrigger(app.page)).toContainText(projectName);
    panel = activeAgentPanel(app.page);
    composer = panel.locator('[aria-label="Message agent"]');
    await expect(panel.getByRole('button', { name: `Session folder: ${projectName}` })).toBeVisible();
    await expect(panel.getByText('journey:j11 create project denied', { exact: true })).toBeVisible();
    await expect(panel.getByText('journey:j11 create project approved', { exact: true })).toBeVisible();
    await expect.poll(() => fs.existsSync(projectFolder)).toBe(true);
    expect(fs.existsSync(path.join(projectFolder, 'AGENTS.md'))).toBe(false);

    await expect(composer).toHaveAttribute('contenteditable', 'true');
    await composer.fill('journey:j11 continue in project');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText('Allow Codex to write Project Plan.md?')).toBeVisible();
    await panel.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(panel.getByText(`Project Plan.md was written inside ${projectName}.`)).toBeVisible();
    await expect(fileTreeRow(app.page, 'Project Plan.md')).toBeVisible();
    await expect.poll(() => fs.readFileSync(path.join(projectFolder, 'Project Plan.md'), 'utf8'))
      .toContain('Accepted goal from the continued project conversation.');
    expect(fs.existsSync(path.join(fixture.folderHome, 'Project Plan.md'))).toBe(false);
    await expect(panel.getByRole('button', { name: `Session folder: ${projectName}` })).toBeVisible();
    await expect(app.page.getByRole('tablist', { name: 'Chat sessions' }).getByRole('tab', { selected: true }))
      .toContainText('journey:j11 create project denied');
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('J10 retrieves project evidence and turns it into a reviewed searchable result', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  configureFakeAgent(fixture);
  fixture.env.STASHBASE_EXTRACT_BIN = FAKE_EXTRACTOR;
  const resultName = 'Core Loop.md';
  const resultFile = path.join(fixture.workspaces.projectA, resultName);
  const sourceName = 'Prepared Evidence.png';
  const evidence = 'J10 prepared screenshot evidence.';
  const reviewedMarker = 'Durable review marker: J10-accepted-2026.';
  fixture.env.STASHBASE_FAKE_OCR_TEXT = evidence;
  fs.writeFileSync(path.join(fixture.workspaces.projectA, sourceName), PNG_PIXEL);
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    await fileTreeRow(app.page, sourceName).click();
    await expect(app.page.getByRole('img', { name: sourceName })).toBeVisible();

    await app.page.keyboard.press(`${primaryKey}+Shift+F`);
    let search = app.page.getByRole('dialog', { name: 'Search library' });
    await search.getByRole('button', { name: 'Exact', exact: true }).click();
    await search.getByRole('combobox').fill(evidence);
    await expect(search.getByRole('option', { name: new RegExp(sourceName.replace('.', '\\.')) })).toBeVisible();
    await search.getByRole('option', { name: new RegExp(sourceName.replace('.', '\\.')) }).click();
    await expect(activeDocumentTab(app.page)).toHaveAttribute('title', sourceName);

    await selectCodex(app.page);
    await app.page.getByRole('button', { name: 'New Chat', exact: true }).click();
    const panel = activeAgentPanel(app.page);
    const composer = panel.locator('[aria-label="Message agent"]');
    await expect(panel.getByRole('button', { name: /Session folder: project-alpha/ })).toBeVisible();
    await expect(composer).toHaveAttribute('contenteditable', 'true');
    await composer.fill('journey:j10 synthesize retrieved evidence');
    await panel.getByRole('button', { name: 'Send message' }).click();

    await expect(panel.getByText(`Allow Codex to write ${resultName}?`)).toBeVisible();
    await panel.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(panel.getByText(`${resultName} contains the retrieved project evidence.`)).toBeVisible();
    await expect(fileTreeRow(app.page, resultName)).toBeVisible();

    await fileTreeRow(app.page, resultName).click();
    const editor = activeMarkdownEditor(app.page);
    await expect(editor).toContainText(evidence);
    await expect(editor).toContainText(sourceName);
    await editor.click();
    await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await app.page.keyboard.insertText(`\n${reviewedMarker}`);
    await expect(saveStatus(app.page)).toBeVisible();
    await expect.poll(() => fs.readFileSync(resultFile, 'utf8')).toContain(reviewedMarker);
    await app.page.getByTitle(`Close ${resultName}`).click();

    const selectedChat = app.page.getByRole('tablist', { name: 'Chat sessions' }).getByRole('tab', { selected: true });
    // Delete on the focused tab is the keyboard close path; the visual ×
    // is pointer-only (aria-hidden), so it no longer resolves as a button.
    await selectedChat.press('Delete');

    await app.page.keyboard.press(`${primaryKey}+Shift+F`);
    search = app.page.getByRole('dialog', { name: 'Search library' });
    await search.getByRole('button', { name: 'Exact', exact: true }).click();
    await search.getByRole('combobox').fill(reviewedMarker);
    await expect(search.getByRole('option', { name: new RegExp(resultName.replace('.', '\\.')) })).toBeVisible();
    await search.getByRole('option', { name: new RegExp(resultName.replace('.', '\\.')) }).click();
    await expect(activeMarkdownEditor(app.page)).toContainText(reviewedMarker);
    const escapedSource = sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(app.errors.records.filter((record) => !(
      record.kind === 'request'
      && new RegExp(`HEAD .*/api/files/${escapedSource.replace(/ /g, '%20')}: net::ERR_ABORTED$`, 'u').test(record.text)
    ))).toEqual([]);
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});
