'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerAppearance } = require('../../dist/electron/window/appearance.cjs');

const DEFAULTS = {
  theme: 'system',
  lightTheme: 'stashbase-light',
  darkTheme: 'stashbase-dark',
  uiScale: 'default',
  readingTextSize: 'default', readingFont: 'serif',
  writingFont: null,
  codeFont: null,
  lineSpacing: 'default',
  lineWidth: 'default',
  reduceMotion: 'system',
  spellcheck: true,
  spellcheckLanguage: null,
  focusMode: false,
  typewriterScrolling: false,
  wordCount: false,
};

function harness(context, { remembered, capability = 'window.lifecycle', platform = 'linux' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-'));
  context.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, 'appearance.json');
  if (remembered !== undefined) fs.writeFileSync(filePath, remembered);
  const handlers = new Map();
  const updated = [];
  const backgrounds = [];
  const spelling = { enabled: [], languages: [] };
  const nativeTheme = {
    source: 'system',
    get themeSource() {
      return this.source;
    },
    set themeSource(value) {
      this.source = value;
      updated.forEach((listener) => listener());
    },
    get shouldUseDarkColors() {
      return this.source === 'dark';
    },
    on: (_event, listener) => updated.push(listener),
  };
  const frame = { url: 'app://renderer/' };
  const webContents = { mainFrame: frame };
  const window = {
    isDestroyed: () => false,
    setBackgroundColor: (color) => backgrounds.push(color),
  };
  const appearance = registerAppearance({
    allWindows: () => [window],
    BrowserWindow: { fromWebContents: (candidate) => (candidate === webContents ? window : null) },
    expectedOrigins: new Set(['app://renderer']),
    filePath,
    hasCapability: (_window, granted) => granted === capability,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    isLiveWindow: (candidate) => candidate === window,
    nativeTheme,
    platform,
    spellchecker: {
      availableSpellCheckerLanguages: ['en-US', 'fr'],
      setSpellCheckerEnabled: (enabled) => spelling.enabled.push(enabled),
      setSpellCheckerLanguages: (languages) => spelling.languages.push(languages),
    },
  });
  return {
    appearance,
    backgrounds,
    filePath,
    nativeTheme,
    spelling,
    send: (payload) =>
      handlers.get('window:appearance')({ sender: webContents, senderFrame: frame }, payload),
  };
}

test('a saved appearance reaches native chrome and the next window before its first paint', async (context) => {
  const first = harness(context);
  assert.deepEqual(first.appearance.windowArguments(), []);
  const chosen = { ...DEFAULTS, theme: 'dark', darkTheme: 'catppuccin-mocha', spellcheck: false };
  assert.deepEqual(await first.send(chosen), { ok: true });
  assert.equal(first.nativeTheme.themeSource, 'dark');
  assert.equal(first.appearance.backgroundColor(), '#1e1e2e');
  assert.deepEqual(first.backgrounds.at(-1), '#1e1e2e');
  assert.deepEqual(first.spelling.enabled, [false]);

  const relaunch = harness(context, { remembered: fs.readFileSync(first.filePath, 'utf8') });
  assert.equal(relaunch.nativeTheme.themeSource, 'dark');
  assert.equal(relaunch.appearance.backgroundColor(), '#1e1e2e');
  const [argument] = relaunch.appearance.windowArguments();
  assert.deepEqual(JSON.parse(argument.slice('--stashbase-appearance='.length)), chosen);
});

test('an unreadable or foreign copy leaves the window on the system default', (context) => {
  for (const remembered of ['{', '{"theme":"sepia"}', '[]', JSON.stringify({ theme: 'dark' })]) {
    const window = harness(context, { remembered });
    assert.equal(window.nativeTheme.themeSource, 'system');
    assert.deepEqual(window.appearance.windowArguments(), []);
  }
});

test('a window without the capability or with a malformed record changes nothing', async (context) => {
  const refused = harness(context, { capability: 'other' });
  await refused.send({ ...DEFAULTS, theme: 'dark' });
  assert.equal(refused.nativeTheme.themeSource, 'system');
  assert.equal(fs.existsSync(refused.filePath), false);

  const malformed = harness(context);
  await malformed.send({ ...DEFAULTS, theme: 'dark', extra: true });
  await malformed.send({ ...DEFAULTS, writingFont: 'Inter"}' });
  assert.equal(malformed.nativeTheme.themeSource, 'system');
  assert.equal(fs.existsSync(malformed.filePath), false);
});

test('a spellcheck language is set only where the platform offers a choice', async (context) => {
  const linux = harness(context);
  await linux.send({ ...DEFAULTS, spellcheckLanguage: 'fr' });
  await linux.send({ ...DEFAULTS, spellcheckLanguage: 'de' });
  assert.deepEqual(linux.spelling.languages, [['fr']]);

  const mac = harness(context, { platform: 'darwin' });
  await mac.send({ ...DEFAULTS, spellcheckLanguage: 'fr' });
  assert.deepEqual(mac.spelling.languages, []);
});
