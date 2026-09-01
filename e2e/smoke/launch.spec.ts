import { expect, test } from '@playwright/test';
import type { Page } from 'playwright';
import type { LaunchedApp } from '../support/app.ts';
import { launchApp } from '../support/app.ts';
import { createAppFixture } from '../support/fixtures.ts';
import { appShell, openLibraryFolder, settingsButton } from '../support/locators.ts';

async function expectChatExpanded(page: Page): Promise<void> {
  const chat = page.getByRole('complementary', { name: 'Agent chat' });
  await expect(chat).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide chat panel' })).toHaveAttribute('aria-expanded', 'true');
  await expect(chat.getByRole('tab', { selected: true })).toBeInViewport();
}

test('user can launch into the empty library workspace', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'empty' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    const skipAiIndex = app.page.getByRole('button', { name: 'Not now', exact: true });
    await expect(skipAiIndex).toBeHidden();
    await expect(app.page).toHaveTitle('StashBase');
    await expect(appShell(app.page)).toBeVisible();
    await expect(app.page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible();
    await expect(settingsButton(app.page)).toBeVisible();
    await expect(app.page.getByText('Add a folder to your Wiki.')).toBeVisible();
    await expectChatExpanded(app.page);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});

test('user launches an existing library with Chat expanded', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await expectChatExpanded(app.page);
    await openLibraryFolder(app.page, 'project-alpha');
    const notNow = app.page.getByRole('button', { name: 'Not now', exact: true });
    await expect(notNow).toBeVisible();
    await notNow.click();
    await expect(notNow).toBeHidden();
    await expectChatExpanded(app.page);
    app.errors.assertNone();
  } finally {
    await app?.close();
    await fixture.cleanup();
  }
});
