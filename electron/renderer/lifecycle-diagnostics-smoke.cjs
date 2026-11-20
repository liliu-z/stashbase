const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, net } = require('electron');
const { WebSocketServer } = require('ws');
const { attachWindowDiagnostics, attachChildProcessDiagnostics } = require('./lifecycle-diagnostics.cjs');
const { createNativeDiagnostics } = require('../../dist/electron/diagnostics/native.cjs');

const root = process.env.STASHBASE_SMOKE_ROOT;
assert.ok(root, 'the smoke runner owns the isolated profile and cleanup');
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});

async function run() {
  await app.whenReady();
  await verifyServerStartup();
  const windowId = randomUUID(), hostId = randomUUID();
  // Explicit fixture collector: no network delivery and no real preferences.
  const native = createNativeDiagnostics({ available: true, distribution: 'source', version: 'fixture',
    directory: path.join(root, 'diagnostics'), read: () => ({}) });
  const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(sockets, 'listening');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  attachWindowDiagnostics(win, { windowId, appSessionId: randomUUID(), hostInstanceId: () => hostId,
    record: (...args) => native.record(...args), quitting: () => false });
  try {
    await win.loadURL('data:text/html,<title>Lifecycle verification</title><p>Isolated connection fixture</p>');
    const connected = once(sockets, 'connection');
    await win.webContents.executeJavaScript(`window.fixtureSocket = new WebSocket('ws://127.0.0.1:${sockets.address().port}'); void 0`);
    const [peer] = await connected;
    const closed = once(peer, 'close');
    const gone = once(win.webContents, 'render-process-gone');
    // Kill only this fixture's renderer. forcefullyCrashRenderer uses a
    // fatal crash path that can wait for OS core dumping on hosted Linux.
    const rendererPid = win.webContents.getOSProcessId();
    assert.ok(rendererPid > 0 && rendererPid !== process.pid);
    process.kill(rendererPid, 'SIGKILL');
    const [, details] = await gone;
    assert.notEqual(details.reason, 'clean-exit');
    // The separate network service can retain the socket after renderer
    // death on Linux. Release the owning window before awaiting its socket.
    win.destroy();
    const [code] = await closed;
    // Chromium's surviving network service may send Going Away even when
    // the renderer is killed. Correlate the real exit rather than infer it
    // from the socket code; a lost transport instead reports 1006.
    assert.ok(code === 1001 || code === 1006, `unexpected close code: ${code}`);
    const records = [];
    native.drain(record => { records.push(record); return true; });
    assert.deepEqual(records.map(record => record.context.stage).sort(), ['closed', 'exit', 'loaded']);
    assert.ok(records.every(record => record.context.window_id === windowId && record.context.host_instance_id === hostId));
    assert.ok(records.every(record => record.context.pid > 0));
    const exit = records.find(record => record.context.stage === 'exit');
    assert.equal(exit.severity, 'error');
    assert.equal(exit.context.reason, details.reason);
    assert.equal(exit.diagnostic.exit_code, details.exitCode);
    assert.equal(records.find(record => record.context.stage === 'closed').severity, 'info');
    console.log(JSON.stringify({ scenario: 'renderer-crash-correlation', closeCode: code, reason: details.reason, records: records.length, correlated: true }));
  } finally {
    if (!win.isDestroyed()) win.destroy();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    native.clear();
  }
  await verifyNetworkExit(native, hostId);
  await verifyIntentionalClose();
}

async function verifyServerStartup() {
  const { createServerStartTelemetry } = require('../../dist/electron/diagnostics/server-start.cjs');
  const { startServer, probeServerHealth } = require('../main-probe.cjs');
  const http = require('node:http');
  const received = [];
  const sink = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push(...JSON.parse(body).batch);
    response.end('{}');
  });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  const unused = http.createServer();
  await new Promise(resolve => unused.listen(0, '127.0.0.1', resolve));
  const port = unused.address().port;
  await new Promise(resolve => unused.close(resolve));
  const reporter = createServerStartTelemetry({ available: true, distribution: 'source', version: 'fixture',
    directory: path.join(root, 'startup-events'), read: () => ({}),
    // Explicit local replacement: even enabled fixture collection cannot reach
    // the production destination. Exercise Electron's real network stack.
    fetch: (_url, init) => net.fetch(`http://127.0.0.1:${sink.address().port}/capture`, init),
  });
  const attempt = reporter.begin(randomUUID());
  let child;
  try {
    await reporter.flush();
    assert.equal(received[0].event, 'server_start_initiated');
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    await assert.rejects(startServer({ packaged: true, port, timeoutMs: 300, onStage: attempt.stage,
      probe: (instanceId, timeout = 100) => probeServerHealth(port, timeout,
        { protocolVersion: 1, appRoot: root, resourcesPath: root, instanceId }),
      spawn: () => {
        child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
        return child;
      },
    }), error => { attempt.failed(error, error.startupContext); return /did not come up/.test(error.message); });
    await reporter.settle();
    assert.deepEqual(received.map(event => event.event), ['server_start_initiated', 'server_start_failed']);
    assert.equal(received[1].properties.context.probe_result, 'connection_refused');
    assert.equal(received[1].properties.stage, 'waiting_ready');
    assert.equal(received[1].properties.attempt_id, received[0].properties.attempt_id);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log('real Electron startup timeout delivered before any host or renderer, using only a local collector');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    sink.closeAllConnections();
    await new Promise(resolve => sink.close(resolve));
  }
}

async function verifyIntentionalClose() {
  const { registerWindowLifecycle } = require('../../dist/electron/window/lifecycle.cjs');
  const { AGENT_SESSION_CLOSE } = require(path.join(root, 'agent-protocol.cjs'));
  const server = require('node:http').createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Intentional close verification</title>');
  });
  const sockets = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const order = [];
  let peer;
  const lifecycle = registerWindowLifecycle({
    BrowserWindow, ipcMain: { handle() {} }, expectedOrigins: new Set(), hasCapability: () => false,
    isLiveWindow: candidate => candidate === win && !win.isDestroyed(),
    beforeClose: async () => {
      assert.equal(win.isDestroyed(), false);
      const closed = once(peer, 'close');
      peer.close(AGENT_SESSION_CLOSE.code, AGENT_SESSION_CLOSE.reason);
      await closed;
      const result = await win.webContents.executeJavaScript('window.fixtureClosed');
      assert.deepEqual(result, { errors: [], events: [{ kind: 'exited', message: null }] });
      order.push('host-retired');
    },
  });
  lifecycle.attach(win);
  try {
    await win.loadURL(`http://127.0.0.1:${sockets.address().port}/`);
    const connected = once(sockets, 'connection');
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'session-api.js'), 'utf8') + `;
      (() => {
        const errors = [], events = [];
        let finish;
        window.fixtureClosed = new Promise(resolve => { finish = resolve; });
        window.fixtureConnection = FixtureSession.createAgentSessionAdapter({
            request: async () => { throw Error('Unexpected HTTP request'); },
            reportError: error => errors.push(error.message),
          }, 'http://127.0.0.1:${sockets.address().port}').connect(
            { agent: 'claude', scope: { kind: 'folder', path: '/fixture' } },
            { onEvent: event => events.push(event), onInvalidResponse: () => errors.push('invalid frame'),
              onClose: () => finish({ errors, events }) },
          );
      })();`);
    [peer] = await connected;
    lifecycle.approveClose(win); // Saves were accepted by the shared barrier.
    const closed = once(win, 'closed');
    win.on('closed', () => order.push('window-closed'));
    win.close();
    await closed;
    assert.deepEqual(order, ['host-retired', 'window-closed']);
    console.log('real Electron intentional close retires the socket before window destruction without a renderer error');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function verifyNetworkExit(native, hostId) {
  attachChildProcessDiagnostics(app, { appSessionId: randomUUID(), hostInstanceId: () => hostId,
    record: (...args) => native.record(...args) });
  const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(sockets, 'listening');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL('data:text/html,<title>Network lifecycle verification</title>');
    const address = `ws://127.0.0.1:${sockets.address().port}`;
    await win.webContents.executeJavaScript(`Promise.all(Array.from({length:3}, () => new Promise(resolve => {
      const socket = new WebSocket(${JSON.stringify(address)}); socket.onopen = resolve;
      (window.fixtureSockets ??= []).push(socket);
    }))).then(() => undefined)`);
    const closed = [...sockets.clients].map(socket => once(socket, 'close'));
    assert.equal(closed.length, 3);
    const network = app.getAppMetrics().find(metric => metric.serviceName === 'network.mojom.NetworkService');
    assert.ok(network && network.pid > 0 && network.pid !== process.pid);
    const gone = new Promise(resolve => {
      const listener = (_event, details) => {
        if (details.serviceName !== 'network.mojom.NetworkService') return;
        app.off('child-process-gone', listener);
        resolve(details);
      };
      app.on('child-process-gone', listener);
    });
    process.kill(network.pid, 'SIGKILL');
    const details = await gone;
    const closeCodes = (await Promise.all(closed)).map(([code]) => code);
    assert.deepEqual(closeCodes, [1006, 1006, 1006]);
    const records = [];
    native.drain(record => { records.push(record); return true; });
    const exit = records.find(record => record.context.process === 'network-service');
    assert.ok(exit, 'network service exit must be distinguishable from other utility exits');
    assert.equal(exit.context.host_instance_id, hostId);
    assert.equal(exit.context.reason, details.reason);
    assert.equal(exit.diagnostic.exit_code, details.exitCode);
    // The renderer remains responsive, and Chromium recreates its network service.
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      window.recoveredSocket = new WebSocket(${JSON.stringify(address)});
      recoveredSocket.onopen = () => resolve(); recoveredSocket.onerror = reject;
    })`);
    console.log(JSON.stringify({ scenario: 'network-process-exit-correlation', closeCodes, reason: details.reason, reconnected: true }));
  } finally {
    win.destroy();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    native.clear();
  }
}
run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
