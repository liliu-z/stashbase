import { expect, test } from '@playwright/test';
import { fileTreeRow, folderSwitcherTrigger } from '../support/locators.ts';
import {
  dismissEmbeddingSetup,
  expectLinuxScreenshot,
  launchVisualApp,
  openFixtureFolder,
  setVisualViewport,
} from './visual-helpers.ts';

test('active-folder workspace shell keeps its redesigned composition', async ({}, testInfo) => {
  const visual = await launchVisualApp('one-folder', testInfo);
  try {
    const { page } = visual.app;
    await setVisualViewport(page, 1280, 820);
    await openFixtureFolder(page);
    await dismissEmbeddingSetup(page);

    await expect(page.getByRole('complementary', { name: 'Agent chat' }).getByRole('tab', { selected: true })).toBeInViewport();
    await expect(page.locator('aside.sidebar')).toBeVisible();
    await expect(page.locator('#sideHead')).toContainText('project-alpha');
    await expect(fileTreeRow(page, 'nested')).toBeVisible();
    // The titlebar folder switcher carries the window's folder identity.
    await expect(folderSwitcherTrigger(page)).toBeVisible();
    await expect(folderSwitcherTrigger(page)).toContainText('project-alpha');
    await expect(page.getByRole('alert').filter({ hasText: 'Sign in to StashBase' })).toBeVisible();

    await expectLinuxScreenshot(page, 'workspace-folder.png');
  } finally {
    await visual.close();
  }
});

test('empty library keeps the redesigned zero-state composition', async ({}, testInfo) => {
  const visual = await launchVisualApp('empty', testInfo);
  try {
    const { page } = visual.app;
    await setVisualViewport(page, 1280, 820);

    await expect(page.getByRole('complementary', { name: 'Agent chat' }).getByRole('tab', { selected: true })).toBeInViewport();
    // Empty library: the boot chat leads with the Gallery band under its
    // composer while the sidebar's launcher group carries Gallery and
    // Choose Folder (the menu duplicates stay in the titlebar Library
    // switcher).
    await expect(page.getByRole('heading', { name: 'Explore Gallery' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose Folder…', exact: true })).toBeVisible();
    // The first grid cell is the snapshot's download card: one whole-card
    // button, a fixed 16:9 cover strip over the caption, fully enabled
    // with no folder open — browsing and downloading need no precondition.
    const galleryCell = page.locator('.templates-grid > li').first();
    const galleryCard = galleryCell.getByRole('button', { name: /How to Start a Startup/ });
    await expect(galleryCard).toBeVisible();
    await expect(galleryCard).toBeEnabled();
    const coverStrip = galleryCard.locator('span[aria-hidden="true"]').first();
    const [cellBox, cardBox, coverBox] = await Promise.all([
      galleryCell.boundingBox(),
      galleryCard.boundingBox(),
      coverStrip.boundingBox(),
    ]);
    expect(cellBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(coverBox).not.toBeNull();
    expect(cardBox!.x).toBeGreaterThanOrEqual(cellBox!.x);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(cellBox!.x + cellBox!.width);
    expect(coverBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
    expect(coverBox!.x + coverBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    // With no folder open the switcher trigger reads "Library".
    await expect(folderSwitcherTrigger(page)).toContainText('Library');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Sign in to StashBase' })).toBeVisible();

    await expectLinuxScreenshot(page, 'workspace-empty.png');
  } finally {
    await visual.close();
  }
});

test('available update floats above persistent account utilities', async ({}, testInfo) => {
  const visual = await launchVisualApp('empty', testInfo);
  try {
    const { electron, page } = visual.app;
    await setVisualViewport(page, 1280, 820);
    await electron.evaluate(({ BrowserWindow, app: electronApp }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('updates:state', {
        phase: 'available',
        currentVersion: electronApp.getVersion(),
        autoCheckEnabled: true,
        availableVersion: '9.9.9',
        releaseUrl: 'https://github.com/liliu-z/stashbase/releases/latest',
      });
    });

    await expect(page.getByRole('button', { name: 'Update to StashBase 9.9.9' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();

    await expectLinuxScreenshot(page, 'workspace-update-banner.png');
  } finally {
    await visual.close();
  }
});
