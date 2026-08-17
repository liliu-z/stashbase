import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { LaunchedApp } from '../support/app.ts';
import { launchApp } from '../support/app.ts';
import { createAppFixture } from '../support/fixtures.ts';
import {
  dismissEmbeddingKeyPrompt,
  fileTreeRow,
  openLibraryFolder,
  settingsButton,
  settingsDialog,
  settingsTab,
} from '../support/locators.ts';
import { primaryKey } from './journey-helpers.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_EXTRACTOR = path.resolve(HERE, '..', 'fixtures', 'fake-extractor.mjs');
const OCR_PHRASE = 'screenshot evidence becomes searchable';
const CLIPBOARD_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('J04 stops clipboard-image offers after opt-out', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  const config = JSON.parse(fs.readFileSync(fixture.configFile, 'utf8')) as Record<string, unknown>;
  config.capture = { clipboardImageImport: true };
  fs.writeFileSync(fixture.configFile, `${JSON.stringify(config, null, 2)}\n`);
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);
    await app.electron.evaluate(({ clipboard, nativeImage }, pixel) => {
      clipboard.writeImage(nativeImage.createFromDataURL(pixel));
    }, CLIPBOARD_PIXEL);

    await app.page.evaluate(() => (
      window as Window & { electron?: { setAgentComposerFocused?: (focused: boolean) => void } }
    ).electron?.setAgentComposerFocused?.(false));
    const offer = app.page.getByRole('dialog', { name: 'Add image to StashBase?' });
    await app.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit('focus'));
    await expect(offer).toBeVisible();
    await offer.getByRole('button', { name: 'Dismiss' }).click();

    await settingsButton(app.page).click();
    await settingsTab(app.page, 'General').click();
    const clipboardCapture = settingsDialog(app.page).getByRole('checkbox', {
      name: 'Offer to add clipboard screenshots',
    });
    await expect(clipboardCapture).toBeChecked();
    await clipboardCapture.uncheck();
    await expect(clipboardCapture).not.toBeChecked();
    await settingsDialog(app.page).getByRole('button', { name: 'Close settings' }).click();

    await app.electron.evaluate(({ BrowserWindow, clipboard, nativeImage }, pixel) => {
      const image = nativeImage.createFromDataURL(pixel).resize({ width: 2, height: 2 });
      clipboard.writeImage(image);
      BrowserWindow.getAllWindows()[0]?.emit('focus');
    }, CLIPBOARD_PIXEL);
    await app.page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(offer).toBeHidden();
    app.errors.assertNone();
  } finally {
    try {
      await app?.electron.evaluate(({ clipboard }) => clipboard.clear());
    } catch { /* Electron may already be closed after a failed assertion. */ }
    await app?.close();
    await fixture.cleanup();
  }
});

test('J04 accepts an opted-in screenshot as a visible source and retrieves its prepared text', async ({}, testInfo) => {
  const fixture = await createAppFixture({ membership: 'one-folder' });
  fixture.env.STASHBASE_EXTRACT_BIN = FAKE_EXTRACTOR;
  fixture.env.STASHBASE_FAKE_OCR_TEXT = OCR_PHRASE;
  let app: LaunchedApp | undefined;
  try {
    app = await launchApp(fixture, testInfo);
    await openLibraryFolder(app.page, 'project-alpha');
    await dismissEmbeddingKeyPrompt(app.page);

    await settingsButton(app.page).click();
    await settingsTab(app.page, 'General').click();
    const clipboardCapture = settingsDialog(app.page).getByRole('checkbox', {
      name: 'Offer to add clipboard screenshots',
    });
    await expect(clipboardCapture).not.toBeChecked();
    await clipboardCapture.check();
    await expect.poll(() => {
      const config = JSON.parse(fs.readFileSync(fixture.configFile, 'utf8')) as {
        capture?: { clipboardImageImport?: boolean };
      };
      return config.capture?.clipboardImageImport;
    }).toBe(true);
    await settingsDialog(app.page).getByRole('button', { name: 'Close settings' }).click();

    const imageReady = await app.electron.evaluate(({ clipboard, nativeImage }, pixel) => {
      const image = nativeImage.createFromDataURL(pixel);
      clipboard.writeImage(image);
      return !image.isEmpty();
    }, CLIPBOARD_PIXEL);
    expect(imageReady).toBe(true);
    // Headless Electron does not acquire native OS focus. Drive the same main
    // process focus boundary that a user returning from the screenshot tool
    // triggers; the shipping clipboard read, offer, and import path stay real.
    await app.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit('focus'));

    const offer = app.page.getByRole('dialog', { name: 'Add image to StashBase?' });
    await expect(offer).toBeVisible();
    await offer.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(offer).toBeHidden();

    await expect.poll(() => (
      fs.readdirSync(fixture.workspaces.projectA).find((name) => /^clipboard-.*\.png$/u.test(name))
    )).toBeTruthy();
    const sourceName = fs.readdirSync(fixture.workspaces.projectA)
      .find((name) => /^clipboard-.*\.png$/u.test(name));
    expect(sourceName).toBeTruthy();
    await expect(fileTreeRow(app.page, sourceName!)).toBeVisible();

    await app.page.keyboard.press(`${primaryKey}+Shift+F`);
    const search = app.page.getByRole('dialog', { name: 'Search library' });
    await search.getByRole('button', { name: 'Exact', exact: true }).click();
    await search.getByRole('combobox').fill(OCR_PHRASE);
    await expect(search.getByRole('option', { name: new RegExp(sourceName!) })).toBeVisible();
    await search.getByRole('option', { name: new RegExp(sourceName!) }).click();
    await expect(app.page.getByRole('img', { name: sourceName! })).toBeVisible();
    const escapedSource = sourceName!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(app.errors.records.filter((record) => !(
      record.kind === 'request'
      && new RegExp(`HEAD .*/api/files/${escapedSource}: net::ERR_ABORTED$`, 'u').test(record.text)
    ))).toEqual([]);
  } finally {
    try {
      await app?.electron.evaluate(({ clipboard }) => clipboard.clear());
    } catch { /* Electron may already be closed after a failed assertion. */ }
    await app?.close();
    await fixture.cleanup();
  }
});
