import { vi } from 'vite-plus/test';

import type { AppDependencies } from '@/app/dependencies';
import type { GalleryPort } from '@/features/gallery/public';

import { agentCatalogPort, agentContextPort, agentPersonaApi, agentSessionPort } from './agent';
import { documentsApi } from './documents';
import { preparationControlApi, preparationStatusApi } from './preparation';
import { exactSearchApi, indexDecisionApi, semanticSearchApi } from './retrieval';
import {
  accountPort,
  agentRuntimePort,
  appearancePort,
  embedderPort,
  mcpAccessPort,
} from './settings';
import { folderPicker, workspaceAdapters } from './workspace';

/** The shop's port. The index answers null by default, so a test that does not
 *  care about the gallery still renders the bundled snapshot rather than an
 *  empty shelf. */
export function galleryPort(overrides: Partial<GalleryPort> = {}): GalleryPort {
  return {
    loadIndex: vi.fn(async () => null),
    ...overrides,
  };
}

/** The whole dependency graph the shell is composed from. Every port is a
 *  `vi.fn`, so a test asserts on calls without building the rest. Override
 *  one slice at a time; each slice is complete on its own. */
export function appDependencies(overrides: Partial<AppDependencies> = {}): AppDependencies {
  const adapters = overrides.workspace?.adapters ?? workspaceAdapters();
  return {
    initialAppearance: null,
    recordUsage: vi.fn(),
    agent: {
      catalog: agentCatalogPort(),
      context: agentContextPort(),
      persona: agentPersonaApi(),
      session: agentSessionPort().port,
    },
    documents: documentsApi(),
    gallery: galleryPort(),
    project: { api: adapters.project, folderPicker: folderPicker(), lifecycle: adapters.lifecycle },
    preparation: { controlApi: preparationControlApi(), statusApi: preparationStatusApi() },
    retrieval: {
      decisionApi: indexDecisionApi(),
      exactSearchApi: exactSearchApi(),
      semanticSearchApi: semanticSearchApi(),
    },
    settings: {
      accountApi: accountPort(),
      agentRuntimeApi: agentRuntimePort(),
      appearanceApi: appearancePort(),
      setAppearance: async () => undefined,
      systemTextApi: { listFonts: async () => [], spellcheckLanguages: async () => [] },
      telemetryApi: {
        load: async () => ({ enabled: true, available: false }),
        update: async (change) => ({
          available: false,
          ...change,
        }),
      },
      embedderApi: embedderPort(),
      mcpAccessApi: mcpAccessPort(),
      localComponentApi: {
        load: async () => ({ status: 'not-installed', error: null }),
        retry: async () => ({ status: 'downloading', error: null }),
      },
    },
    // Outside Electron, so there is no updater to reach.
    updates: null,
    workspace: { adapters, revealLabel: 'Show in file manager' },
    ...overrides,
  };
}
