'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  applicationWindowWebPreferences,
  isAllowedApplicationUrl,
  secureApplicationWindow,
  authorizeApplicationMicrophone,
} = require('./window-security.cjs');

test('application windows use the restrictive replacement preferences by default', () => {
  assert.deepEqual(applicationWindowWebPreferences({ preloadPath: '/app/preload.cjs' }), {
    preload: '/app/preload.cjs',
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    experimentalFeatures: false,
    allowRunningInsecureContent: false,
    additionalArguments: [],
  });
});

test('application URL policy accepts only the configured renderer origin', () => {
  assert.equal(isAllowedApplicationUrl('app://renderer/', 'app://renderer'), true);
  assert.equal(isAllowedApplicationUrl('app://renderer/assets/app.js', 'app://renderer'), true);
  assert.equal(isAllowedApplicationUrl('app://other/', 'app://renderer'), false);
  assert.equal(isAllowedApplicationUrl('https://example.com/', 'app://renderer'), false);
  assert.equal(
    isAllowedApplicationUrl('http://127.0.0.1:8090/path', 'http://127.0.0.1:8090'),
    true,
  );
  assert.equal(
    isAllowedApplicationUrl('http://127.0.0.1:8091/path', 'http://127.0.0.1:8090'),
    false,
  );
});

test('application windows deny popups, unexpected navigation, webviews, and permissions', () => {
  const webContents = new EventEmitter();
  let openHandler;
  let permissionCheck;
  let permissionRequest;
  webContents.setWindowOpenHandler = (handler) => { openHandler = handler; };
  webContents.session = {
    setPermissionCheckHandler(handler) { permissionCheck = handler; },
    setPermissionRequestHandler(handler) { permissionRequest = handler; },
  };

  secureApplicationWindow({ webContents }, 'app://renderer');
  assert.deepEqual(openHandler({ url: 'https://example.com' }), { action: 'deny' });

  let prevented = false;
  webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'app://renderer/');
  assert.equal(prevented, false);
  webContents.emit(
    'will-navigate',
    { preventDefault() { prevented = true; } },
    'https://example.com/',
  );
  assert.equal(prevented, true);

  prevented = false;
  webContents.emit('will-attach-webview', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(permissionCheck(), false);
  let permissionGranted = true;
  permissionRequest(null, 'camera', (allowed) => { permissionGranted = allowed; });
  assert.equal(permissionGranted, false);
});

test('application windows grant the clipboard only to their own origin', () => {
  const webContents = new EventEmitter();
  let permissionCheck;
  let permissionRequest;
  webContents.setWindowOpenHandler = () => {};
  webContents.session = {
    setPermissionCheckHandler(handler) { permissionCheck = handler; },
    setPermissionRequestHandler(handler) { permissionRequest = handler; },
  };

  secureApplicationWindow({ webContents }, 'app://renderer');

  const decide = (permission, details) => {
    let granted = null;
    permissionRequest(null, permission, (allowed) => { granted = allowed; }, details);
    return granted;
  };

  // The write a Settings panel or the transcript asks for. Chromium requests it
  // under this name; the window's own driven pass is what pins the spelling.
  assert.equal(
    decide('clipboard-sanitized-write', { requestingUrl: 'app://renderer/index.html' }),
    true,
  );

  // A frame at any other origin is refused, including the opaque origin a
  // sandboxed document preview runs at, which reports no requesting URL.
  const fromElsewhere = 'clipboard-sanitized-write';
  assert.equal(decide(fromElsewhere, { requestingUrl: 'https://example.com/' }), false);
  assert.equal(decide(fromElsewhere, { requestingUrl: '' }), false);
  assert.equal(decide(fromElsewhere, {}), false);
  assert.equal(decide(fromElsewhere, undefined), false);

  // Reading the clipboard is not the write, and stays denied.
  assert.equal(decide('clipboard-read', { requestingUrl: 'app://renderer/index.html' }), false);

  // Nothing else is granted, whoever asks.
  assert.equal(decide('media', { requestingUrl: 'app://renderer/index.html' }), false);
  assert.equal(decide('geolocation', { requestingUrl: 'app://renderer/index.html' }), false);

  // And nothing is granted ambiently, the clipboard included.
  assert.equal(permissionCheck(), false);
});

test('microphone access requires an armed live application main frame and never grants video', () => {
  const contents = new EventEmitter();
  let request;
  let check;
  contents.setWindowOpenHandler = () => {};
  contents.session = {
    setPermissionCheckHandler(handler) { check = handler; },
    setPermissionRequestHandler(handler) { request = handler; },
  };
  const win = { webContents: contents };
  secureApplicationWindow(win, 'app://renderer');
  const details = { isMainFrame: true, requestingUrl: 'app://renderer/index.html', mediaTypes: ['audio'] };
  const decide = (source, value) => {
    let allowed;
    request(source, 'media', (answer) => { allowed = answer; }, value);
    return allowed;
  };
  assert.equal(decide(contents, details), false);
  assert.equal(authorizeApplicationMicrophone(win, true), true);
  assert.equal(decide(contents, details), true);
  assert.equal(check(contents, 'media', 'app://renderer', { ...details, mediaType: 'audio' }), true);
  assert.equal(check(contents, 'media', 'app://renderer', { ...details, mediaType: 'video' }), false);
  assert.equal(decide(contents, { ...details, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(decide(contents, { ...details, mediaTypes: ['video'] }), false);
  assert.equal(decide(contents, { ...details, isMainFrame: false }), false);
  assert.equal(decide(contents, { ...details, requestingUrl: 'https://example.com/' }), false);
  assert.equal(decide(new EventEmitter(), details), false);
  authorizeApplicationMicrophone(win, false);
  assert.equal(decide(contents, details), false);
  authorizeApplicationMicrophone(win, true);
  Object.defineProperty(win, 'webContents', { get() { throw new Error('Window has been destroyed'); } });
  assert.doesNotThrow(() => contents.emit('destroyed'));
  assert.equal(decide(contents, details), false);
});
