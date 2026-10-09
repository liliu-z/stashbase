/**
 * Agent CLI registry routes: enumerate the supported CLIs (with their
 * installed-state). The chat panel reads these to populate its launchers;
 * the CLIs themselves run via structured agent bridges, not a PTY.
 */
import express from 'express';
import { discoverAgentRuntimes } from '../agent-contract.ts';
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
  updateAgentBootstrap,
} from '../agent-runtime-installer.ts';
import type { AgentId } from '../../shared/agent-protocol.ts';

function agentId(value: unknown): AgentId | null {
  return value === 'stashbase' || value === 'claude' || value === 'codex' ? value : null;
}

function nativeAgentId(value: unknown): NativeAgentId | null {
  return value === 'claude' || value === 'codex' ? value : null;
}

async function agentCatalogResponse() {
  return { clis: await discoverAgentRuntimes(), debug: getAgentRuntimeDebugState() };
}

/** A runtime that can run a turn gets its catalog memory completed before
 * the listing answers: one runtime-level read when nothing is remembered, or
 * when what is remembered names no default, so the first Chat on a fresh
 * install can name its model. The memory decides whether a read is due, and
 * a read that fails is not retried until its pause has passed, so a runtime
 * that cannot answer never slows the listing twice in a row. */
async function primeAgentModelCatalogs(): Promise<void> {
  await Promise.all(
    (await discoverAgentRuntimes())
      .filter((runtime) => runtime.capabilities.models && runtime.installed && runtime.state === 'available')
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

  /** New Chat readiness gate. Existing runtimes only receive the idempotent
   * MCP connection; missing runtimes begin an application-scoped download. */
  app.post('/api/terminal/clis/:id/bootstrap', async (req, res) => {
    const id = agentId(req.params.id);
    if (!id) {
      res.status(404).json({ error: 'Unsupported Agent runtime.' });
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
      res.status(404).json({ error: 'Unsupported Agent runtime.' });
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
      res.status(404).json({ error: 'Unsupported Agent runtime.' });
      return;
    }
    try {
      loginAgentBootstrap(id);
      res.status(202).json(await agentCatalogResponse());
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
      res.status(404).json({ error: 'Unsupported Agent runtime.' });
      return;
    }
    if (!agentSupportsInAppUpdate(id)) {
      res.status(400).json({ error: 'This Agent uses an explicit executable override. Remove the override to update its native installation through StashBase.' });
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
