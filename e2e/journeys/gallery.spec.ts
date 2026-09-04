import { expect, test } from '@playwright/test';
import type { LaunchedApp } from '../support/app.ts';
import { launchApp } from '../support/app.ts';
import { createAppFixture } from '../support/fixtures.ts';
import { dismissEmbeddingKeyPrompt, openLibraryFolder } from '../support/locators.ts';

/**
 * The Gallery's two forms: the inline band a bare window's blank Chat
 * derives, and the app-level overlay the sidebar row raises inside a
 * folder window. The fixture pins the index upstream to an unreachable
 * port (see fixtures.ts), so both render the bundled snapshot — the
 * journeys assert the shop and its entry detail, never a live download.
 */

test('a bare window browses the Gallery inline and opens an entry detail', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'empty' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    // The blank Chat derives the band from window state: no folder open.
    await expect(app.page.getByRole('heading', { name: 'Explore Gallery' })).toBeVisible();

    // A card is one whole-card target opening the entry's detail page.
    await app.page.getByRole('button', { name: /How to Start a Startup/ }).click();
    const detail = app.page.getByRole('dialog').filter({ hasText: 'How to Start a Startup' });
    await expect(detail.getByRole('button', { name: 'Make a copy' })).toBeEnabled();

    // What's inside leads with the copy's real file tree (published in
    // the snapshot); How it's built holds the request behind the wiki
    // with its copy-only action.
    await expect(detail.getByText('README.md')).toBeVisible();
    await detail.getByRole('tab', { name: "How it's built" }).click();
    await expect(detail.getByText('Build or update Wiki Pages from these lecture transcripts', { exact: false })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Copy prompt' })).toBeEnabled();

    // Esc leaves the detail; the shop window stays where it was.
    await app.page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(app.page.getByRole('heading', { name: 'Explore Gallery' })).toBeVisible();
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('a folder window reaches the Gallery as an overlay from its sidebar row', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    // A folder window never lends a chat tab to the shop: the sidebar row
    // raises a near-fullscreen overlay instead.
    await app.page.getByRole('button', { name: 'Gallery', exact: true }).click();
    const overlay = app.page.getByRole('dialog', { name: 'Gallery' });
    await expect(overlay.getByRole('heading', { name: 'Gallery' })).toBeVisible();
    await expect(overlay.getByRole('button', { name: /How to Start a Startup/ })).toBeVisible();

    // Esc returns to work; the folder workspace is untouched behind it.
    await app.page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await expect(app.page).toHaveTitle('project-alpha — StashBase');
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});
