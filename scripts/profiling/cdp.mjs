// A minimal Chrome DevTools Protocol client for one StashBase window.

import { setTimeout as delay } from "node:timers/promises";

async function pageTarget(debugPort, origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = targets.find((target) => target.type === "page" && target.url.startsWith(origin));
      if (page) return page;
    } catch {
      // Electron has not opened the debugging port yet.
    }
    await delay(250);
  }
  throw new Error(`No StashBase window at ${origin} appeared on debugging port ${debugPort}.`);
}

export async function connectToWindow({ debugPort, origin, timeoutMs = 60_000 }) {
  const target = await pageTarget(debugPort, origin, timeoutMs);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('close', () => {
    for (const call of pending.values()) call.reject(new Error('The inspected window closed.'));
    pending.clear();
  });
  const listeners = new Set();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) { reject(new Error('The inspected window is unavailable.')); return; }
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };

  // A window on a hidden workspace or behind another window loses page focus,
  // and then synthesized keys never reach the editor.
  const holdFocus = async () => {
    await send("Page.bringToFront");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  };

  const waitFor = async (expression, { timeoutMs = 30_000, what = expression } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return;
      } catch {
        // The page may be mid-navigation.
      }
      await delay(200);
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}`);
  };

  const reload = async () => {
    await send("Page.enable");
    const loaded = new Promise((resolve) => {
      const listener = (message) => {
        if (message.method !== "Page.loadEventFired") return;
        listeners.delete(listener);
        resolve();
      };
      listeners.add(listener);
    });
    await send("Page.reload", { ignoreCache: true });
    await loaded;
    await holdFocus();
  };

  const type = async (text, intervalMs) => {
    for (const character of text) {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: character,
        unmodifiedText: character,
        key: character,
      });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: character });
      await delay(intervalMs);
    }
  };

  // Hidden windows never paint, so capture from the compositor's view instead.
  const screenshot = async () => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: false,
      optimizeForSpeed: true,
    });
    return Buffer.from(data, "base64");
  };

  await holdFocus();
  // The target reports its URL before the document commits.
  await waitFor(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`, {
    timeoutMs,
    what: `the window to load ${origin}`,
  });
  return {
    send,
    evaluate,
    waitFor,
    reload,
    type,
    screenshot,
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => socket.close(),
  };
}
