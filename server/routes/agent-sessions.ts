/** One project-scoped history surface for all built-in Agents. */
import express from 'express';
import {
  agentSessionEmptyResponseSchema,
  agentSessionInfoSchema,
  agentSessionListResponseSchema,
  agentSessionRenameRequestSchema,
  agentSessionReplaySchema,
} from '../../shared/protocols/http/agent-sessions.ts';
import { agentAdapter, resolveAgentSessionScope } from '../agent-contract.ts';
import { agentPersonaLibrary } from '../agent-persona.ts';
import { registeredFolderRoots } from '../folder.ts';
import { sendError } from '../http.ts';

function historyFor(id: string) {
  const adapter = agentAdapter(id);
  if (!adapter) {
    const error = new Error('agent runtime not found') as Error & { status: number };
    error.status = 404;
    throw error;
  }
  return adapter.history;
}

/** Validate membership before invoking native history. */
function historyFolderOf(req: express.Request): string {
  const resolved = resolveAgentSessionScope(req.query.scope, req.query.folder, registeredFolderRoots());
  if (!resolved.ok) {
    const error = new Error(resolved.message) as Error & { status: number };
    error.status = 400;
    throw error;
  }
  return resolved.scope.path;
}

export function mount(app: express.Express): void {
  app.get('/api/agents/:agent/sessions', async (req, res) => {
    try {
      const rows = await historyFor(req.params.agent).list(historyFolderOf(req));
      res.json(agentSessionListResponseSchema.parse(rows));
    } catch (err) {
      sendError(res, err);
    }
  });
  app.get('/api/agents/:agent/sessions/:id/messages', async (req, res) => {
    try {
      res.json(await historyFor(req.params.agent).messages(req.params.id, historyFolderOf(req)));
    } catch (err) {
      sendError(res, err);
    }
  });
  app.get('/api/agents/:agent/sessions/:id/replay', async (req, res) => {
    try {
      const history = historyFor(req.params.agent);
      if (!history.replay) return res.status(404).json({ error: 'replay metadata unavailable' });
      const replay = await history.replay(req.params.id, historyFolderOf(req));
      // The persona is StashBase's record, not the runtime's transcript.
      const persona = agentPersonaLibrary().chatPersona(req.params.agent, req.params.id);
      res.json(agentSessionReplaySchema.parse({ ...(replay as object), persona }));
    } catch (err) {
      sendError(res, err);
    }
  });
  app.patch('/api/agents/:agent/sessions/:id', async (req, res) => {
    const request = agentSessionRenameRequestSchema.safeParse(req.body);
    if (!request.success) return res.status(400).json({ error: 'title required' });
    try {
      const { title } = request.data;
      const row = await historyFor(req.params.agent).rename(
        req.params.id,
        title,
        historyFolderOf(req),
      );
      res.json(agentSessionInfoSchema.parse(row));
    } catch (err) {
      sendError(res, err);
    }
  });
  app.delete('/api/agents/:agent/sessions/:id', async (req, res) => {
    try {
      await historyFor(req.params.agent).remove(req.params.id, historyFolderOf(req));
      try { agentPersonaLibrary().forgetChat(req.params.agent, req.params.id); } catch { /* an orphan record is harmless */ }
      res.json(agentSessionEmptyResponseSchema.parse({}));
    } catch (err) {
      sendError(res, err);
    }
  });
}
