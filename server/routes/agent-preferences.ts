import type express from 'express';
import { agentPreferencesSchema, projectAgentPreferenceUpdateSchema } from '../../shared/protocols/http/agent-preferences.ts';
import { readAppConfigStrict, writeAppConfigStrict } from '../app-config.ts';
import { exactRegisteredFolderRootAsync } from '../folder.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { sendError } from '../http.ts';

/** Explicit project choices share the atomic config owner with Agent Instructions. */
export function mount(app: express.Express): void {
  app.get('/api/agent-preferences', (_req, res) => {
    try {
      res.json(agentPreferencesSchema.parse(readAppConfigStrict().agentPreferences ?? []));
    } catch (error) { sendError(res, error); }
  });
  app.put('/api/agent-preferences', async (req, res) => {
    try {
      const parsed = projectAgentPreferenceUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid project Agent choice.' });
      const { agent, effort, persona } = parsed.data;
      if (!filesystemPath.isAbsolute(parsed.data.scope)) return res.status(400).json({ error: 'Project must be an absolute path.' });
      readAppConfigStrict();
      const scope = await exactRegisteredFolderRootAsync(parsed.data.scope);
      if (!scope) return res.status(404).json({ error: 'Project is no longer registered.' });
      const config = readAppConfigStrict();
      if (!config.recentFolders?.some(folder => filesystemPath.equal(folder.path, scope))) return res.status(404).json({ error: 'Project is no longer registered.' });
      const existing = agentPreferencesSchema.parse(config.agentPreferences ?? []);
      const previous = existing.find(entry => filesystemPath.equal(entry.scope, scope));
      const updated = {
        ...previous,
        scope,
        // Editing an older conversation's effort or persona must not change
        // the Agent explicitly chosen for future chats in this project.
        agent: effort === undefined && persona === undefined ? agent : previous?.agent ?? agent,
        ...(effort === undefined ? {} : { efforts: { ...previous?.efforts, [agent]: effort } }),
        ...(persona === undefined ? {} : { persona }),
      };
      config.agentPreferences = [...existing.filter(entry => !filesystemPath.equal(entry.scope, scope)), updated];
      writeAppConfigStrict(config);
      res.json(updated);
    } catch (error) { sendError(res, error); }
  });
}
