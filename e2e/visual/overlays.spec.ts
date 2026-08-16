import { expect, test } from '@playwright/test';
import { EXACT_SEARCH_PHRASE, seedJourneyWorkspaces } from '../fixtures/journey-workspaces.ts';
import {
  dismissEmbeddingSetup,
  expectLinuxScreenshot,
  launchVisualApp,
  openFixtureFolder,
  openSettings,
  setVisualViewport,
} from './visual-helpers.ts';

test('Settings and quick-access overlays preserve light and dark composition', async ({}, testInfo) => {
  const visual = await launchVisualApp('one-folder', testInfo);
  try {
    const { page } = visual.app;
    await setVisualViewport(page, 1280, 820);
    await openFixtureFolder(page);
    await dismissEmbeddingSetup(page);

    await openSettings(page);
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const theme = page.getByRole('group', { name: 'Theme' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(settings.getByText('Changes apply immediately and are saved for every window.')).toBeVisible();
    await expectLinuxScreenshot(page, 'settings-appearance-light.png');

    await theme.getByText('Dark', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(theme.getByText('Dark', { exact: true })).toHaveAttribute('data-pressed', '');
    await expectLinuxScreenshot(page, 'settings-appearance-dark.png');

    await theme.getByText('Light', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(settings).toBeHidden();

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+O' : 'Control+O');
    const quickOpen = page.getByRole('dialog', { name: 'Quick Open' });
    await expect(quickOpen).toBeVisible();
    await quickOpen.getByRole('combobox').fill('Welcome');
    await expect(quickOpen.getByRole('option').filter({ hasText: 'Welcome.md' })).toBeVisible();
    await expectLinuxScreenshot(page, 'quick-open.png');

    await page.keyboard.press('Escape');
    await expect(quickOpen).toBeHidden();
    await page.keyboard.press('F1');
    const palette = page.getByRole('dialog', { name: 'Command Palette' });
    await expect(palette).toBeVisible();
    await palette.getByRole('combobox').fill('>settings');
    await expect(palette.getByRole('option').filter({ hasText: 'Open Settings' })).toBeVisible();
    await expectLinuxScreenshot(page, 'command-palette.png');
  } finally {
    await visual.close();
  }
});

test('cross-folder exact search keeps grouped result identity visible', async ({}, testInfo) => {
  const visual = await launchVisualApp('two-folders', testInfo);
  seedJourneyWorkspaces(visual.fixture);
  try {
    const { page } = visual.app;
    await setVisualViewport(page, 1280, 820);
    await openFixtureFolder(page);
    await dismissEmbeddingSetup(page);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+F' : 'Control+Shift+F');
    const search = page.getByRole('dialog', { name: 'Search library' });
    await expect(search).toBeVisible();
    await search.getByRole('button', { name: 'Exact', exact: true }).click();
    await search.getByRole('combobox').fill(EXACT_SEARCH_PHRASE);
    await expect(search.getByText('project-alpha', { exact: true })).toBeVisible();
    await expect(search.getByText('project-beta', { exact: true })).toBeVisible();
    await expect(search.getByRole('option', { name: /Journey Markdown\.md/ })).toBeVisible();
    await expect(search.getByRole('option', { name: /Cross Folder Result\.md/ })).toBeVisible();

    await page.waitForTimeout(500);
    await expectLinuxScreenshot(page, 'library-search-cross-folder.png');
  } finally {
    await visual.close();
  }
});
