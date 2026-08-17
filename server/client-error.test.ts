import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createClientErrorHandler, prepareClientErrorLog } from './client-error.ts';

const require = createRequire(import.meta.url);

test('renderer errors are redacted before entering a bug-reportable application log', () => {
  const homeDir = process.platform === 'win32'
    ? 'C:\\Users\\Sensitive User'
    : '/Users/Sensitive User';
  const separator = process.platform === 'win32' ? '\\' : '/';
  const secrets = {
    message: 'message-secret-value',
    stack: 'stack-secret-value',
    component: 'component-secret-value',
    query: 'query-secret-value',
  };

  const output = prepareClientErrorLog({
    message: `render failed token=${secrets.message}`,
    stack: `at render (${homeDir}${separator}private${separator}view.tsx) password=${secrets.stack}`,
    componentStack: `\nComponent apiKey=${secrets.component}`,
    url: `http://127.0.0.1:8090/?access_token=${secrets.query}`,
    at: '2026-08-11T12:00:00.000Z',
  }, {
    prepareText: (text) => {
      // Use a stable fixture home while exercising the production redactor.
      const { prepareBugReportText } = require('../electron/bug-report-redaction.cjs');
      return prepareBugReportText(text, { homeDir });
    },
  });

  assert.match(output, /^client render error @ 2026-08-11T12:00:00\.000Z/);
  assert.match(output, /\[REDACTED\]/);
  assert.equal(output.includes(homeDir), false);
  for (const secret of Object.values(secrets)) assert.equal(output.includes(secret), false);
});

test('renderer error logging fails closed and still acknowledges the sink request', () => {
  const warnings: string[] = [];
  let response: unknown;
  const handler = createClientErrorHandler({ warn: (message) => warnings.push(message) });

  handler({
    body: { message: 'token=must-not-reach-the-log' },
  } as never, {
    json(value: unknown) {
      response = value;
      return this;
    },
  } as never, (() => {}) as never);

  assert.deepEqual(response, { ok: true });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('must-not-reach-the-log'), false);

  const rejected = prepareClientErrorLog({ message: 'raw-private-value' }, {
    prepareText: () => ({ ok: false, redactionCount: 0, findingCount: 1 }),
  });
  assert.equal(rejected, 'client render error omitted: privacy scan failed');
  assert.equal(rejected.includes('raw-private-value'), false);
});
