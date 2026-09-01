import type express from 'express';
import type { AgentInstructionsScope } from '../../shared/agent-instructions.ts';
import { getAgentInstructions, setAgentInstructions } from '../agent-instructions.ts';
import { exactMemberFolderRootAsync } from '../folder.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { sendError } from '../http.ts';

function requestError(message: string, status = 400): Error {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

async function resolveScope(value: unknown): Promise<AgentInstructionsScope> {
  if (typeof value !== 'string' || !value.trim()) {
    throw requestError('scope must be an absolute library-folder path');
  }
  if (!filesystemPath.isAbsolute(value)) {
    throw requestError('folder scope must be an absolute path');
  }
  const member = await exactMemberFolderRootAsync(value);
  if (!member) throw requestError('folder is not in your library', 404);
  return { kind: 'folder', path: member };
}

export function mount(app: express.Express): void {
  app.get('/api/agent-instructions', async (req, res) => {
    try {
      res.json(getAgentInstructions(await resolveScope(req.query.scope)));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.put('/api/agent-instructions', async (req, res) => {
    try {
      const scope = await resolveScope(req.body?.scope);
      res.json(setAgentInstructions(scope, req.body?.text));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}
