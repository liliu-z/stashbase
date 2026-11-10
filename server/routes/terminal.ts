/**
 * Agent CLI registry routes: enumerate the supported CLIs (with their
 * installed-state). The chat panel reads these to populate its launchers;
 * the CLIs themselves run via structured agent bridges, not a PTY.
 */
import express from 'express';
import { discoverAgentRuntimes, type AgentRuntimeDescriptor } from '../agent-contract.ts';
import { ensureAgentModelCatalog } from '../agent-model-catalog.ts';
import { sendError } from '../http.ts';
import {
  getAgentRuntimeDebugState,
  setAgentRuntimeDebugState,
  type NativeAgentId,
} from '../agent-runtime-paths.ts';
import {
  agentSupportsInAppUpdate,
  beginAgentBootstrap,
  loginAgentBootstrap,
  recheckAgentBootstrap,
  stopAgentBootstrap,
  updateAgentBootstrap,
} from '../agent-runtime-installer.ts';
import type { AgentId } from '../../shared/agent-protocol.ts';
import { isNativeAgentId } from '../native-agents.ts';

function agentId(value: unknown): AgentId | null {
  return value === 'stashbase' || isNativeAgentId(value) ? value : null;
}

function nativeAgentId(value: unknown): NativeAgentId | null {
  return isNativeAgentId(value) ? value : null;
}

async function agentCatalogResponse() {
  return { clis: await discoverAgentRuntimes(), debug: getAgentRuntimeDebugState() };
}

/** A runtime that can run a turn gets its catalog memory completed before
 * the listing answers: one runtime-level read when nothing is remembered, or
 * when what is remembered names no default, so the first Chat on a fresh
 * install can name its model. The memory decides whether a read is due, and
 * a read that fails is not retried until its pause has passed, so a runtime
 * that cannot answer never slows the listing twice in a row.
 *
 * Installed is not enough. A runtime not yet signed in cannot list its models,
 * and Antigravity's `-p /model` then waits about a minute on a sign-in of its
 * own, holding the very listings that follow a sign-in in progress. */
export function primesModelCatalog(runtime: AgentRuntimeDescriptor): boolean {
  return runtime.capabilities.models && runtime.installed && runtime.state === 'available'
    && runtime.bootstrap.phase === 'ready';
}

async function primeAgentModelCatalogs(): Promise<void> {
  await Promise.all(
    (await discoverAgentRuntimes())
      .filter(primesModelCatalog)
      .map((runtime) => ensureAgentModelCatalog(runtime.id)),
  );
}

export function mount(app: express.Express): void {
  // Agent CLI registry. The renderer reads this to populate the launchers
  // and know each CLI's installed-state.
  app.get('/api/terminal/clis', async (_req, res) => {
    await primeAgentModelCatalogs();
    res.json(await agentCatalogResponse());
  });

  /** Explicit first-send consent. Verify discovered launchers, install a
   * missing or broken runtime, then establish authentication and MCP readiness. */
  app.post('/api/terminal/clis/:id/bootstrap', async (req, res) => {
    const id = agentId(req.params.id);
    if (!id) {
      res.status(404).json({ error: 'Unsupported agent runtime.' });
      return;
    }
    try {
      if (id === 'stashbase') {
        res.json(await agentCatalogResponse());
        return;
      }
      beginAgentBootstrap(id);
      res.status(202).json(await agentCatalogResponse());
    } catch (error) {
      sendError(res, error);
    }
  });

  /** Explicit recheck after the user installs or repairs a CLI outside the
   * app. This may perform idempotent MCP preparation for a discovered runtime
   * but never starts a managed download when the CLI is still missing. */
  app.post('/api/terminal/clis/:id/check', async (req, res) => {
    const id = agentId(req.params.id);
    if (!id) {
      res.status(404).json({ error: 'Unsupported agent runtime.' });
      return;
    }
    try {
      if (id === 'stashbase') {
        res.json(await agentCatalogResponse());
        return;
      }
      recheckAgentBootstrap(id);
      res.json(await agentCatalogResponse());
    } catch (error) {
      sendError(res, error);
    }
  });

  /** Launch the selected native executable's provider-owned browser login.
   * This never installs another CLI or handles provider credentials itself. */
  app.post('/api/terminal/clis/:id/login', async (req, res) => {
    const id = nativeAgentId(req.params.id);
    if (!id) {
      res.status(404).json({ error: 'Unsupported agent runtime.' });
      return;
    }
    try {
      loginAgentBootstrap(id);
      res.status(202).json(await agentCatalogResponse());
    } catch (error) {
      sendError(res, error);
    }
  });

  /** Stop waiting on a preparation the reader started, such as a browser
   * sign-in that may never come back. Answers once the run has released its
   * processes, so a Sign in that follows starts a new attempt instead of
   * joining the stopped one. Authorization given in the browser stays. */
  app.post('/api/terminal/clis/:id/stop', async (req, res) => {
    const id = nativeAgentId(req.params.id);
    if (!id) {
      res.status(404).json({ error: 'Unsupported agent runtime.' });
      return;
    }
    try {
      await stopAgentBootstrap(id);
      res.json(await agentCatalogResponse());
    } catch (error) {
      sendError(res, error);
    }
  });

  /** Update through the provider's official native installer. Offered where a chat
   * reports the runtime too old for its model and on the Settings row; the
   * provider owns the resulting installation and old npm copies stay intact. */
  app.post('/api/terminal/clis/:id/update', async (req, res) => {
    const id = nativeAgentId(req.params.id);
    if (!id) {
      res.status(404).json({ error: 'Unsupported agent runtime.' });
      return;
    }
    if (!agentSupportsInAppUpdate(id)) {
      res.status(400).json({ error: 'This agent uses an explicit executable override. Remove the override to update its native installation through StashBase.' });
      return;
    }
    try {
      updateAgentBootstrap(id);
      res.status(202).json(await agentCatalogResponse());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/terminal/debug', async (req, res) => {
    try {
      setAgentRuntimeDebugState(req.body ?? {});
      res.json(await agentCatalogResponse());
    } catch (error) {
      sendError(res, error);
    }
  });
}
