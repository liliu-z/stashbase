import { PropertySymbol, type Document } from 'happy-dom';
import { builtinEnvironments, type Environment } from 'vite-plus/test/runtime';

const base = builtinEnvironments['happy-dom'];

export default {
  ...base,
  async setup(global, options) {
    const original = {
      setTimeout: global.setTimeout,
      clearTimeout: global.clearTimeout,
      setInterval: global.setInterval,
      clearInterval: global.clearInterval,
    };
    const environment = await base.setup(global, options);
    // Vitest aliases window/defaultView to the Node global. Bind timers to the
    // actual DOM owner so its existing abort/close retires vendor callbacks too.
    const window = (global.document as Document)[PropertySymbol.defaultView];
    if (!window) {
      await environment.teardown(global);
      throw new Error('Happy DOM did not expose its owning window.');
    }
    Object.assign(global, {
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
    });
    return {
      async teardown(scope) {
        try {
          await environment.teardown(scope);
        } finally {
          Object.assign(scope, original);
        }
      },
    };
  },
} satisfies Environment;
