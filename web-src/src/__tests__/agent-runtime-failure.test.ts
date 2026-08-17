import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFailurePresentation } from '../components/agent/runtimeFailurePresentation';

test('installation failures offer only installation recovery', () => {
  const result = runtimeFailurePresentation({
    phase: 'failed',
    failure: {
      stage: 'installation',
      code: 'operation-failed',
      message: 'Download failed.',
      retryable: true,
      manualRecovery: 'install-command',
    },
  }, 'Codex');

  assert.equal(result.title, 'Couldn’t install Codex');
  assert.equal(result.retryLabel, 'Retry');
  assert.equal(result.manualAction, 'copy-install-command');
  assert.equal(result.manualLabel, 'Copy install command');
});

test('MCP failures never expose an install command', () => {
  const result = runtimeFailurePresentation({
    phase: 'failed',
    failure: {
      stage: 'mcp',
      code: 'operation-failed',
      message: 'Config is read-only.',
      retryable: true,
      manualRecovery: 'mcp-settings',
    },
  }, 'Codex');

  assert.equal(result.title, 'Couldn’t connect StashBase to Codex');
  assert.equal(result.retryLabel, 'Retry connection');
  assert.equal(result.manualAction, 'open-mcp-settings');
  assert.equal(result.manualLabel, 'View manual setup');
});

test('Codex authentication failures start in-app browser login', () => {
  const result = runtimeFailurePresentation({
    phase: 'failed',
    failure: {
      stage: 'authentication',
      code: 'authentication-required',
      message: 'Codex is installed, but it is not signed in.',
      retryable: true,
    },
  }, 'Codex');

  assert.equal(result.title, 'Sign in to Codex');
  assert.equal(result.retryLabel, 'Sign in with ChatGPT');
  assert.equal(result.primaryAction, 'start-codex-login');
  assert.equal(result.manualAction, undefined);
});

test('Codex authentication status failures retry preparation without opening login', () => {
  const result = runtimeFailurePresentation({
    phase: 'failed',
    failure: {
      stage: 'authentication',
      code: 'authentication-check-failed',
      message: 'Could not check Codex sign-in.',
      retryable: true,
    },
  }, 'Codex');

  assert.equal(result.title, 'Couldn’t check Codex sign-in');
  assert.equal(result.retryLabel, 'Retry');
  assert.equal(result.primaryAction, 'retry-bootstrap');
});

test('one-shot simulated failures keep recovery focused on retry', () => {
  const result = runtimeFailurePresentation({
    phase: 'failed',
    failure: {
      stage: 'mcp',
      code: 'simulated',
      message: 'Simulated MCP configuration failure.',
      retryable: true,
    },
  }, 'Claude Code');

  assert.equal(result.retryLabel, 'Retry connection');
  assert.equal(result.manualAction, undefined);
  assert.equal(result.manualLabel, undefined);
});
