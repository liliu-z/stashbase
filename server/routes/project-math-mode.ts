/** One durable per-project switch: whether `$...$` opens a formula in this
 *  project's Markdown documents and Chat. The server owns the record, so every
 *  window on the folder reads the same state and it survives a restart. The
 *  embedding key and the rest of Settings stay application-wide; this is the
 *  project's own choice. */
import type express from 'express';
import {
  projectMathModeQuerySchema,
  projectMathModeRequestSchema,
  projectMathModeSchema,
} from '../../shared/protocols/http/project-math-mode.ts';
import { getProjectMathMode, setProjectMathMode } from '../app-config.ts';
import { exactRegisteredFolderRootAsync } from '../folder.ts';
import { sendError } from '../http.ts';

/** Only a registered project has a state to keep. An absolute path that was
 *  never opened, or one removed since, answers 404 rather than writing a record
 *  no window will ever read back. */
async function registeredScope(scope: string): Promise<string | null> {
  return exactRegisteredFolderRootAsync(scope);
}

export function mount(app: express.Express): void {
  app.get('/api/project-math-mode', async (req, res) => {
    try {
      const query = projectMathModeQuerySchema.safeParse({ scope: req.query.scope });
      if (!query.success) return res.status(400).json({ error: 'A project path is required.' });
      const scope = await registeredScope(query.data.scope);
      if (!scope) return res.status(404).json({ error: 'Project is no longer registered.' });
      res.json(projectMathModeSchema.parse({ scope, enabled: getProjectMathMode(scope) }));
    } catch (error) { sendError(res, error); }
  });

  app.put('/api/project-math-mode', async (req, res) => {
    try {
      const request = projectMathModeRequestSchema.safeParse(req.body ?? {});
      if (!request.success) return res.status(400).json({ error: 'Invalid math mode request.' });
      const scope = await registeredScope(request.data.scope);
      if (!scope) return res.status(404).json({ error: 'Project is no longer registered.' });
      const enabled = setProjectMathMode(scope, request.data.enabled);
      res.json(projectMathModeSchema.parse({ scope, enabled }));
    } catch (error) { sendError(res, error); }
  });
}
