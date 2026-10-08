import type express from 'express';
import { agentPersonaListSchema, agentPersonaSchema } from '../../shared/protocols/http/agent-persona.ts';
import { agentPersonaLibrary } from '../agent-persona.ts';
import { sendError } from '../http.ts';

/** The reader's persona library. Which persona a Chat runs under travels with
 * its connection; a project's choice for new Chats is an Agent preference. */
export function mount(app: express.Express): void {
  app.get('/api/agent-personas', (_req, res) => {
    try {
      res.json(agentPersonaListSchema.parse(agentPersonaLibrary().list()));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/agent-personas', (req, res) => {
    try {
      res.json(agentPersonaSchema.parse(agentPersonaLibrary().create(req.body)));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.put('/api/agent-personas/:id', (req, res) => {
    try {
      res.json(agentPersonaSchema.parse(agentPersonaLibrary().update(req.params.id, req.body)));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.delete('/api/agent-personas/:id', (req, res) => {
    try {
      agentPersonaLibrary().remove(req.params.id);
      res.json({});
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}
