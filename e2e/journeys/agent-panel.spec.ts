import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator } from 'playwright';
import type { LaunchedApp } from '../support/app.ts';
import { launchApp } from '../support/app.ts';
import { createAppFixture } from '../support/fixtures.ts';
import { dismissEmbeddingKeyPrompt, fileTreeRow, openLibraryFolder } from '../support/locators.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = path.resolve(HERE, '..', 'fixtures', 'fake-codex-app-server.mjs');
const HISTORY_MATH_REPLY = String.raw`Restored formula from history:

\[
\boxed{a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 + a_9 + a_{10} + a_{11} + a_{12} + a_{13} + a_{14} + a_{15} + a_{16} + a_{17} + a_{18} + a_{19} + a_{20} = 210}
\]`;

type ProtocolRecord = {
  event?: string;
  decision?: string;
  prompt?: string;
  turnId?: string;
  cwd?: string;
  params?: Record<string, unknown>;
};

function activeAgentPanel(page: LaunchedApp['page']): Locator {
  return page.locator('[role="tabpanel"]:not([aria-hidden="true"]) .agent-view');
}

function protocolRecords(logFile: string): ProtocolRecord[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProtocolRecord);
}

test('J06 lists bring-your-own Agents before the zero-install Built-in Agent', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await app.page.getByRole('button', { name: 'New Chat', exact: true }).click();
    const panel = activeAgentPanel(app.page);
    await expect(panel.getByText('Sign in to StashBase', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Open account settings' })).toBeVisible();

    await app.page.getByRole('button', { name: 'Choose agent for new chat' }).click();
    const agents = app.page.getByRole('menuitem');
    await expect(agents).toHaveCount(3);
    await expect(agents.nth(0)).toHaveText('Codex');
    await expect(agents.nth(1)).toHaveText('Claude Code');
    await expect(agents.nth(2)).toContainText('Built-in');
    await expect(agents.nth(2)).toContainText('Sign in for free credits');
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('J06 keeps Similarity Search in session scope and Agent Instructions in the panel toolbar', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  const protocolLog = path.join(fixture.artifacts, 'fake-codex-instructions.jsonl');
  fixture.env.STASHBASE_CODEX_BIN = FAKE_CODEX;
  fixture.env.STASHBASE_AGENT_DISCOVERY_POLICY = 'system-only';
  fixture.env.STASHBASE_FAKE_CODEX_LOG = protocolLog;
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await app.page.route('**/api/embedder', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        provider: 'openai', hasKey: true, authorized: true, source: 'openai',
        model: 'fixture-model', account: { signedIn: false, active: false },
      }) });
    });
    // Install the deterministic Similarity Search response before folder activation so
    // the Chat starts with the retrieval policy genuinely available.
    await app.page.reload();
    await app.page.waitForFunction(() => document.body.dataset.bootSettled === '1');
    await openLibraryFolder(app.page, 'project-alpha');

    await app.page.getByRole('button', { name: 'Choose agent for new chat' }).click();
    await app.page.getByRole('menuitem', { name: 'Codex' }).click();
    await app.page.getByRole('button', { name: 'New Chat', exact: true }).click();
    const panel = activeAgentPanel(app.page);
    const scope = panel.getByRole('button', { name: /Session folder: project-alpha/ });
    await expect(scope).toBeVisible();

    const instructionsButton = app.page.getByRole('button', { name: 'Agent Instructions' });
    await expect(instructionsButton).toBeVisible();
    await instructionsButton.click();
    const instructions = app.page.getByRole('dialog', { name: 'Agent Instructions' });
    await expect(instructions).toBeVisible();
    await instructions.getByRole('textbox', { name: 'Agent Instructions' }).fill('Prefer the primary sources in this folder.');
    await instructions.getByRole('button', { name: 'Save' }).click();
    await expect(instructions).toBeHidden();
    await expect(instructionsButton).toHaveAttribute('data-customized', 'true');
    const savedConfig = JSON.parse(fs.readFileSync(fixture.configFile, 'utf8')) as {
      agentInstructions?: { folders?: Array<{ path: string; text: string }> };
    };
    expect(savedConfig.agentInstructions?.folders).toEqual([{
      path: fixture.workspaces.projectA,
      text: 'Prefer the primary sources in this folder.',
    }]);
    expect(fs.existsSync(path.join(fixture.workspaces.projectA, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.workspaces.projectA, 'CLAUDE.md'))).toBe(false);

    await scope.click();
    let similarity = app.page.getByRole('menuitemcheckbox', { name: 'Similarity Search' });
    await expect(similarity).toHaveAttribute('aria-checked', 'true');
    await similarity.click();
    await expect(similarity).toHaveAttribute('aria-checked', 'false');
    await expect(app.page.getByRole('menu')).toBeVisible();
    await app.page.keyboard.press('Escape');

    const composer = panel.locator('[aria-label="Message agent"]');
    await composer.fill('math reply');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText('Streamed formula:', { exact: false })).toBeVisible();
    await expect.poll(() => protocolRecords(protocolLog)
      .find((entry) => entry.event === 'thread-start')?.params?.developerInstructions)
      .toBe('Prefer the primary sources in this folder.');

    await scope.click();
    await expect(app.page.getByText('Set for this conversation', { exact: true })).toBeVisible();
    const scopeRows = app.page.getByRole('menuitemradio');
    await expect(scopeRows.first()).toBeDisabled();
    similarity = app.page.getByRole('menuitemcheckbox', { name: 'Similarity Search' });
    await expect(similarity).toBeEnabled();
    await expect(similarity).toHaveAttribute('aria-checked', 'false');
    await expect(app.page.getByRole('menuitem', { name: 'Agent Instructions' })).toHaveCount(0);
    await expect(instructionsButton).toBeEnabled();
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('removing a chat folder preserves started work and opens a fresh Library chat', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'two-folders' });
  fixture.env.STASHBASE_CODEX_BIN = FAKE_CODEX;
  fixture.env.STASHBASE_AGENT_DISCOVERY_POLICY = 'system-only';
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    await app.page.getByRole('button', { name: 'Choose agent for new chat' }).click();
    await app.page.getByRole('menuitem', { name: 'Codex' }).click();
    await app.page.getByRole('button', { name: 'New Chat', exact: true }).click();
    let panel = activeAgentPanel(app.page);
    let composer = panel.locator('[aria-label="Message agent"]');
    await expect(composer).toHaveAttribute('contenteditable', 'true');
    await expect(panel.getByRole('button', { name: /Session folder: project-alpha/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeVisible();
    await composer.fill('math reply');
    await expect(composer).toContainText('math reply');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText('Streamed formula:', { exact: false })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeVisible();

    const activeStartedTab = app.page.getByRole('tab', { selected: true });
    const startedPanelId = await activeStartedTab.getAttribute('aria-controls');
    if (!startedPanelId) throw new Error('started chat tab did not expose its controlled panel');
    const startedTab = app.page.locator(`[role="tab"][aria-controls="${startedPanelId}"]`);
    await app.page.getByRole('button', { name: 'More actions for project-alpha' }).click();
    await app.page.getByRole('menuitem', { name: 'Remove from Library' }).click();
    const removal = app.page.getByRole('dialog', { name: 'Remove from Library?' });
    await removal.getByRole('button', { name: 'Remove' }).click();

    await expect(removal).toBeHidden();
    await dismissEmbeddingKeyPrompt(app.page);
    await expect(startedTab).toBeVisible();
    await startedTab.click();
    await expect(startedTab).toHaveAttribute('aria-selected', 'true');
    panel = activeAgentPanel(app.page);
    await expect(panel.getByText('Streamed formula:', { exact: false })).toBeVisible();
    await expect(panel.getByText('project-alpha was removed from Library')).toBeVisible();
    await expect(panel.getByText('This chat is still available, but it can’t continue in that folder.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
    await expect(panel.getByRole('alert')).toHaveCount(0);

    // Browse another member after the removal. The retired conversation
    // remains pinned to its old scope, and its action must still create an
    // explicitly Library-scoped tab rather than inheriting project-beta.
    await openLibraryFolder(app.page, 'project-beta');
    await dismissEmbeddingKeyPrompt(app.page);
    await expect(startedTab).toHaveAttribute('aria-selected', 'false');
    await startedTab.click();
    await expect(startedTab).toHaveAttribute('aria-selected', 'true');
    panel = activeAgentPanel(app.page);
    await expect(panel.getByText('project-alpha was removed from Library')).toBeVisible();
    await panel.getByRole('button', { name: 'New Library Chat' }).click();
    panel = activeAgentPanel(app.page);
    composer = panel.locator('[aria-label="Message agent"]');
    await expect(panel.getByRole('button', { name: 'Session scope: Library' })).toBeVisible();
    await expect(composer).toHaveAttribute('contenteditable', 'true');
    await expect(app.page).toHaveTitle('project-beta — StashBase');
    await expect.poll(() => fs.existsSync(path.join(fixture.workspaces.projectA, 'Welcome.md'))).toBe(true);
    // The status poll already in flight when membership commits receives the
    // route's expected 404; Chromium logs that handled HTTP response as a
    // generic resource error before the renderer's generation fence drops it.
    expect(app.errors.records.filter((record) => !(
      record.kind === 'console'
      && record.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)'
    ))).toEqual([]);
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('Codex chat keeps its folder-bound transcript through approval and interruption', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'two-folders' });
  const protocolLog = path.join(fixture.artifacts, 'fake-codex-protocol.jsonl');
  fixture.env.STASHBASE_CODEX_BIN = FAKE_CODEX;
  fixture.env.STASHBASE_AGENT_DISCOVERY_POLICY = 'system-only';
  fixture.env.STASHBASE_FAKE_CODEX_LOG = protocolLog;
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    await app.page.getByRole('button', { name: 'Choose agent for new chat' }).click();
    await app.page.getByRole('menuitem', { name: 'Codex' }).click();
    await app.page.getByRole('button', { name: 'New Chat', exact: true }).click();
    let panel = activeAgentPanel(app.page);
    let composer = panel.locator('[aria-label="Message agent"]');
    await expect(composer).toHaveAttribute('contenteditable', 'true');
    await expect(panel.getByRole('button', { name: /Session folder: project-alpha/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Model and effort: Default, Default' })).toBeVisible();

    await composer.fill('approval turn');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText('Confirm the deterministic E2E command')).toBeVisible();
    await expect(panel.getByText('printf fake-codex-approved')).toBeVisible();
    await expect.poll(() => protocolRecords(protocolLog).find((entry) => entry.event === 'turn-start' && entry.prompt === 'approval turn')?.params?.cwd)
      .toBe(fixture.workspaces.projectA);

    await panel.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(panel.getByText('Deterministic approval completed.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Model and effort: Fake Codex Model, Default' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect.poll(() => protocolRecords(protocolLog).find((entry) => entry.event === 'approval-response')?.decision)
      .toBe('accept');
    await expect(app.page.getByRole('tab', { name: /approval turn/i })).toHaveAttribute('aria-selected', 'true');

    await openLibraryFolder(app.page, 'project-beta');
    await expect(app.page).toHaveTitle('project-beta — StashBase');
    await dismissEmbeddingKeyPrompt(app.page);
    const approvalTab = app.page.getByRole('tab', { name: /approval turn/i });
    await expect(approvalTab).toBeVisible();
    await expect(approvalTab).toHaveAttribute('aria-selected', 'false');
    await approvalTab.click();
    await expect(approvalTab).toHaveAttribute('aria-selected', 'true');

    panel = activeAgentPanel(app.page);
    composer = panel.locator('[aria-label="Message agent"]');
    await expect(panel.getByText('Deterministic approval completed.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Session folder: project-alpha — set for this conversation' })).toBeVisible();
    await composer.fill('wait for stop');
    await panel.getByRole('button', { name: 'Send message' }).click();
    const stop = panel.getByRole('button', { name: 'Stop agent' });
    await expect(stop).toBeVisible();
    await expect.poll(() => protocolRecords(protocolLog).find((entry) => entry.event === 'turn-start' && entry.prompt === 'wait for stop')?.params?.cwd)
      .toBe(fixture.workspaces.projectA);

    await panel.getByRole('button', { name: 'Edit and resend' }).last().click();
    const inlineEditor = panel.locator('.agent-turn-edit');
    await inlineEditor.locator('textarea').fill('edited wait for stop');
    await inlineEditor.getByRole('button', { name: 'Send', exact: true }).click();

    await expect.poll(() => protocolRecords(protocolLog).find((entry) => entry.event === 'interrupt' && entry.params?.turnId === 'fake-turn-2')?.params?.turnId)
      .toBe('fake-turn-2');
    await expect.poll(() => protocolRecords(protocolLog).find((entry) => entry.event === 'turn-start' && entry.prompt === 'edited wait for stop')?.turnId)
      .toBe('fake-turn-3');
    const editedPrompt = panel.getByText('edited wait for stop', { exact: true });
    const editedWorking = panel.getByText('Codex is working…', { exact: true });
    await expect(editedPrompt).toBeVisible();
    await expect(editedWorking).toBeVisible();
    await expect(panel.getByText(/^You stopped after /)).toBeVisible();
    const editedBox = await editedPrompt.boundingBox();
    const workingBox = await editedWorking.boundingBox();
    expect(editedBox).not.toBeNull();
    expect(workingBox).not.toBeNull();
    expect(workingBox!.y).toBeGreaterThan(editedBox!.y);

    await stop.click();
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(panel.getByRole('alert')).toHaveCount(0);

    await composer.fill('terminal error');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => protocolRecords(protocolLog).find((entry) => entry.event === 'terminal-error')?.turnId)
      .toBe('fake-turn-4');
    await expect(panel.getByText('Deterministic fake Agent failure.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeVisible();
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('Agent chooser reuses only blank chats, drafts freeze scope, and history resumes through the fake runtime', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'two-folders' });
  const protocolLog = path.join(fixture.artifacts, 'fake-codex-protocol.jsonl');
  fixture.env.STASHBASE_CODEX_BIN = FAKE_CODEX;
  fixture.env.STASHBASE_AGENT_DISCOVERY_POLICY = 'system-only';
  fixture.env.STASHBASE_FAKE_CODEX_LOG = protocolLog;
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    const chatTabs = app.page.getByRole('tablist', { name: 'Chat sessions' });
    const initialCount = await chatTabs.getByRole('tab').count();
    await app.page.getByRole('button', { name: 'Choose agent for new chat' }).click();
    await expect(app.page.getByRole('menuitem', { name: 'Codex' })).toBeVisible();
    await app.page.getByRole('menuitem', { name: 'Codex' }).click();
    await app.page.getByRole('button', { name: 'New Chat', exact: true }).click();
    await expect(chatTabs.getByRole('tab')).toHaveCount(initialCount);

    let panel = activeAgentPanel(app.page);
    let composer = panel.locator('[aria-label="Message agent"]');
    await expect(composer).toHaveAttribute('contenteditable', 'true');
    await composer.fill('unsent alpha draft');
    await openLibraryFolder(app.page, 'project-beta');
    await dismissEmbeddingKeyPrompt(app.page);
    await expect(chatTabs.getByRole('tab')).toHaveCount(initialCount + 1);
    // The pointer-only close × is aria-hidden now, so it no longer
    // leaks into the tab's accessible name.
    await chatTabs.getByRole('tab', { name: /^New Chat$/ }).click();
    panel = activeAgentPanel(app.page);
    composer = panel.locator('[aria-label="Message agent"]');
    await expect(panel.getByRole('button', { name: /Session folder: project-alpha/ })).toBeVisible();
    await expect(composer).toContainText('unsent alpha draft');

    await app.page.getByRole('button', { name: 'New Chat', exact: true }).click();
    await expect(chatTabs.getByRole('tab')).toHaveCount(initialCount + 1);
    panel = activeAgentPanel(app.page);
    composer = panel.locator('[aria-label="Message agent"]');
    await expect(panel.locator('[data-draft-empty]')).toHaveAttribute('data-draft-empty', 'true');
    await expect(panel.getByRole('button', { name: 'Session folder: project-beta' })).toBeVisible();
    await expect(composer).toHaveAttribute('contenteditable', 'true');

    await composer.fill('math reply');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.locator('.katex')).toBeVisible();
    await expect(panel.getByText('Streamed formula:', { exact: false })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeVisible();

    const modelButton = panel.getByRole('button', { name: 'Model and effort: Fake Codex Model, Default' });
    await expect(modelButton).toBeEnabled();
    await modelButton.click();
    // The settings pill is two-level: the parent's Model row reads back the
    // current value and its flyout (hover-opened, the native menu idiom)
    // holds the radio list.
    await app.page.getByRole('menuitem', { name: 'Model Fake Codex Model' }).hover();
    await app.page.getByRole('menuitemradio', { name: /Fake Codex Model Two/ }).click();
    await expect(panel.getByRole('button', { name: 'Model and effort: Fake Codex Model Two, Default' })).toBeVisible();
    await composer.fill('wait for stop after model switch');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByRole('button', { name: 'Model and effort: Fake Codex Model Two, Default — available after the current response' })).toBeDisabled();
    await expect.poll(() => protocolRecords(protocolLog).find((entry) => (
      entry.event === 'turn-start' && entry.prompt === 'wait for stop after model switch'
    ))?.params?.model).toBe('fake-codex-model-two');
    await panel.getByRole('button', { name: 'Stop agent' }).click();
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeVisible();

    // Folder-scope chat history lives on the ACTIVE folder header, so
    // switch the window back to project-alpha before resuming its session.
    await openLibraryFolder(app.page, 'project-alpha');
    await expect(app.page).toHaveTitle('project-alpha — StashBase');
    await app.page.getByRole('button', { name: 'Chat history in project-alpha' }).click();
    const history = app.page.getByRole('dialog', { name: 'Chat history in project-alpha' });
    await expect(history.getByRole('button', { name: 'Resume Fixture history session' })).toBeVisible();
    await history.getByRole('button', { name: 'Resume Fixture history session' }).click();
    panel = activeAgentPanel(app.page);
    await expect(panel.getByText('History fixture question')).toBeVisible();
    await expect(panel.getByText('Restored formula from history:')).toBeVisible();
    const displayMath = panel.locator('.katex-display');
    await expect(displayMath).toBeVisible();
    await expect(panel.getByRole('button', { name: /Session folder: project-alpha/ })).toBeVisible();
    const resumedModel = panel.getByRole('button', { name: 'Model and effort: Fake Codex Model, Default' });
    await expect(resumedModel).toBeVisible();
    await expect(resumedModel).toBeEnabled();

    // Copy Reply is a standing button under the reply, not a hover or
    // menu affordance.
    const copyReply = panel.getByRole('button', { name: 'Copy reply' });
    await expect(copyReply).toBeVisible();
    await copyReply.click();
    await expect(app.page.getByText('Copied.', { exact: true })).toBeVisible();
    const copied = await app.electron.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toBe(HISTORY_MATH_REPLY);

    await fileTreeRow(app.page, 'Welcome.md').click();
    await expect(app.page.getByRole('tab', { name: 'Welcome.md' })).toBeVisible();
    const layout = await displayMath.evaluate((element) => {
      const prose = element.closest('.agent-prose');
      const pane = element.closest('.chat-pane-shell');
      if (!(prose instanceof HTMLElement) || !(pane instanceof HTMLElement)) {
        throw new Error('math layout containers are missing');
      }
      return {
        displayClient: element.clientWidth,
        displayScroll: element.scrollWidth,
        proseClient: prose.clientWidth,
        proseScroll: prose.scrollWidth,
        paneClient: pane.clientWidth,
        paneScroll: pane.scrollWidth,
      };
    });
    expect(layout.displayScroll).toBeGreaterThan(layout.displayClient);
    expect(layout.proseScroll).toBeLessThanOrEqual(layout.proseClient + 1);
    expect(layout.paneScroll).toBeLessThanOrEqual(layout.paneClient + 1);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});
