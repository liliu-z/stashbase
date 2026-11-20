import type express from 'express';
import { agentPreferencesSchema, projectAgentPreferenceUpdateSchema } from '../../shared/protocols/http/agent-preferences.ts';
import { readAppConfigStrict, writeAppConfigStrict, type AppConfigFile } from '../app-config.ts';
import { exactRegisteredFolderRootAsync } from '../folder.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { sendError } from '../http.ts';

function preferences(config: AppConfigFile) {
  const projects = config.agentPreferences ?? [];
  // Existing project choices supply defaults until that Agent has a user-wide choice.
  const defaultModels = Object.assign({}, ...projects.map(entry => entry.models), config.lastSelectedModels);
  const defaultEfforts = Object.assign({}, ...projects.map(entry => entry.efforts), config.lastSelectedEfforts);
  return agentPreferencesSchema.parse({
    // With no user-wide choice yet, inherit an already remembered project choice.
    defaultAgent: config.lastSelectedAgent ?? projects.at(-1)?.agent ?? 'stashbase',
    defaultModels,
    defaultEfforts,
    projects,
  });
}

/** Project and user-wide choices share one atomic config write. */
export function mount(app: express.Express): void {
  app.get('/api/agent-preferences', (_req, res) => {
    try {
      res.json(preferences(readAppConfigStrict()));
    } catch (error) { sendError(res, error); }
  });
  app.put('/api/agent-preferences', async (req, res) => {
    try {
      const parsed = projectAgentPreferenceUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid project agent choice.' });
      const { agent, effort, model } = parsed.data;
      if (!filesystemPath.isAbsolute(parsed.data.scope)) return res.status(400).json({ error: 'Project must be an absolute path.' });
      readAppConfigStrict();
      const scope = await exactRegisteredFolderRootAsync(parsed.data.scope);
      if (!scope) return res.status(404).json({ error: 'Project is no longer registered.' });
      const config = readAppConfigStrict();
      if (!config.recentFolders?.some(folder => filesystemPath.equal(folder.path, scope))) return res.status(404).json({ error: 'Project is no longer registered.' });
      const snapshot = preferences(config);
      const existing = snapshot.projects;
      const selectingAgent = effort === undefined && model === undefined;
      const previous = existing.find(entry => filesystemPath.equal(entry.scope, scope));
      const updated = {
        ...previous,
        scope,
        // Editing an older conversation's model or effort must not change
        // the Agent explicitly chosen for future chats in this project.
        agent: selectingAgent ? agent : previous?.agent ?? agent,
        ...(model === undefined ? {} : { models: { ...previous?.models, [agent]: model } }),
        ...(effort === undefined ? {} : { efforts: { ...previous?.efforts, [agent]: effort } }),
      };
      config.agentPreferences = [...existing.filter(entry => !filesystemPath.equal(entry.scope, scope)), updated];
      config.lastSelectedAgent = selectingAgent ? agent : snapshot.defaultAgent;
      config.lastSelectedModels = { ...snapshot.defaultModels, ...(model === undefined ? {} : { [agent]: model }) };
      config.lastSelectedEfforts = { ...snapshot.defaultEfforts, ...(effort === undefined ? {} : { [agent]: effort }) };
      writeAppConfigStrict(config);
      res.json(updated);
    } catch (error) { sendError(res, error); }
  });
}
