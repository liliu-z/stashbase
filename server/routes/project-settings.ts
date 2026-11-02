/** Project-local application preferences. The project identity is resolved by
 * the folder registry, while the values stay in StashBase's local config and
 * never create a project file. */
import type express from 'express';

import { readAppConfigStrict, writeAppConfigStrict } from '../app-config.ts';
import { projectRuntimeInstructionsChanged } from '../agent-runtime-instructions.ts';
import { exactRegisteredFolderRootAsync } from '../folder.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { sendError } from '../http.ts';
import {
  projectMathSettingsRequestSchema,
  projectMathSettingsSchema,
} from '../../shared/protocols/http/project-settings.ts';

function current(scope: string) {
  const entry = readAppConfigStrict().projectSettings?.find((candidate) =>
    filesystemPath.equal(candidate.scope, scope),
  );
  return projectMathSettingsSchema.parse({ scope, math_mode: entry?.math_mode ?? false });
}

async function registeredScope(scope: unknown): Promise<string | null> {
  if (typeof scope !== 'string' || !filesystemPath.isAbsolute(scope)) return null;
  const resolved = await exactRegisteredFolderRootAsync(scope);
  if (!resolved) return null;
  const config = readAppConfigStrict();
  return config.recentFolders?.some((folder) => filesystemPath.equal(folder.path, resolved))
    ? resolved
    : null;
}

export function mount(app: express.Express): void {
  app.get('/api/project-settings/math', async (req, res) => {
    try {
      const scope = await registeredScope(req.query.scope);
      if (!scope) return res.status(404).json({ error: 'Project is no longer registered.' });
      res.json(current(scope));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/project-settings/math', async (req, res) => {
    try {
      const parsed = projectMathSettingsRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid project math setting.' });
      const scope = await registeredScope(parsed.data.scope);
      if (!scope) return res.status(404).json({ error: 'Project is no longer registered.' });
      const config = readAppConfigStrict();
      const existing = config.projectSettings ?? [];
      const previous = existing.find((entry) => filesystemPath.equal(entry.scope, scope))?.math_mode ?? false;
      const saved = projectMathSettingsSchema.parse({ scope, math_mode: parsed.data.math_mode });
      config.projectSettings = [
        ...existing.filter((entry) => !filesystemPath.equal(entry.scope, scope)),
        saved,
      ];
      writeAppConfigStrict(config);
      if (previous !== saved.math_mode) projectRuntimeInstructionsChanged(scope);
      res.json(saved);
    } catch (error) {
      sendError(res, error);
    }
  });
}
