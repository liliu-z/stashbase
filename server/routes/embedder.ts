/**
 * Embedder routes: manage the global embedding provider key and validate
 * a key without persisting it.
 *
 * Search by meaning uses an OpenAI, OpenRouter, or Requesty key supplied by the user.
 * Each Folder is configured as one MFS Internal namespace.
 */
import express from 'express';
import { logger, errorMessage } from '../log.ts';
import { getCurrentFolder } from '../folder.ts';
import {
  getEmbedderConfig,
  isEmbedderProvider,
  setApiKey,
  shouldBackfillAfterKeyChange,
} from '../app-config.ts';
import type { EmbedderProvider } from '../app-config.ts';
import { bootBindAllFolders, reconcileProjectFolders, resetIndexerRuntime } from '../state.ts';
import { sendError, validateEmbedderKey } from '../http.ts';
import type { ApiKeySaveResult, EmbedderState } from '../../shared/embedding.ts';

const log = logger('routes/embedder');

function parseProvider(raw: unknown, fallback: EmbedderProvider): EmbedderProvider | null {
  if (raw == null || raw === '') return fallback;
  return isEmbedderProvider(raw) ? raw : null;
}

const PROVIDER_LABELS: Record<EmbedderProvider, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  requesty: 'Requesty',
};

function providerLabel(provider: EmbedderProvider): string {
  return PROVIDER_LABELS[provider];
}

export function mount(app: express.Express): void {
  let revision = 0;
  let mutationTail = Promise.resolve();
  const superseded = () => Object.assign(new Error('Embedding settings changed during this request. Try again.'), { status: 409 });
  const apply = (version: number, work: () => Promise<void>) => {
    const pending = mutationTail.then(async () => {
      if (version !== revision) throw superseded();
      await work();
      if (version !== revision) throw superseded();
    });
    mutationTail = pending.catch(() => {});
    return pending;
  };
  // Embedder status: active provider + whether a key is configured.
  app.get('/api/embedder', async (_req, res) => {
    const cfg = getEmbedderConfig();
    const state: EmbedderState = {
      provider: cfg.provider,
      hasKey: !!cfg.apiKey,
      model: cfg.model,
    };
    res.json(state);
  });

  // Set / rotate the active embedding key. A definite provider rejection
  // blocks the save so a typo can't blow away a working key. A network
  // / transient validation failure still saves the key: offline/proxied
  // machines need to configure first and let indexing report connectivity.
  app.put('/api/embedder/key', async (req, res) => {
    const current = getEmbedderConfig();
    const provider = parseProvider(req.body?.provider, current.provider);
    if (!provider) return res.status(400).json({ error: 'unknown embedder provider' });
    const rawKey = typeof req.body?.key === 'string'
      ? req.body.key
      : '';
    const key = rawKey.trim();
    if (!key) return res.status(400).json({ error: 'key required' });
    const version = ++revision;
    const check = await validateEmbedderKey(provider, key);
    if (version !== revision) { sendError(res, superseded()); return; }
    const warning = check.ok ? undefined : check.error;
    if (!check.ok && check.status < 500) return res.status(check.status).json({ error: check.error });
    let backfillStarted = false;
    let runtimeWarning: string | undefined;
    try {
      await apply(version, async () => {
        const previous = getEmbedderConfig();
        const shouldBackfill = shouldBackfillAfterKeyChange(previous.provider, provider, !!previous.apiKey);
        setApiKey(key, provider);
        try {
          await resetIndexerRuntime({ forgetBindings: true });
          await bootBindAllFolders();
          if (version !== revision) return;
          if (shouldBackfill) {
            const cur = getCurrentFolder();
            log.info(`${providerLabel(provider)} key set: starting semantic backfill${cur ? ` (active folder: ${cur})` : ''}`);
            backfillStarted = true;
            void reconcileProjectFolders(`${providerLabel(provider)} embedder key set`)
              .catch((err: unknown) => log.warn(`key set: semantic backfill failed: ${errorMessage(err)}`));
          }
        } catch (err: unknown) {
          log.warn(`key set: runtime reset/rebind failed: ${errorMessage(err)}`);
          runtimeWarning = 'Key saved, but search could not restart. Try again or restart StashBase.';
        }
      });
      const saved = getEmbedderConfig();
      const result: ApiKeySaveResult = {
        hasKey: true,
        provider: saved.provider,
        model: saved.model,
        backfillStarted,
        ...((runtimeWarning || warning) ? { warning: runtimeWarning || warning } : {}),
      };
      res.json(result);
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Remove the key: automatic searches use grep; explicit hybrid reports
  // missing configuration. Existing vectors remain stored.
  app.delete('/api/embedder/key', async (_req, res) => {
    const version = ++revision;
    try {
      await apply(version, async () => {
        setApiKey(undefined);
        try {
          await resetIndexerRuntime({ forgetBindings: true });
          await bootBindAllFolders();
        } catch (err: unknown) {
          log.warn(`key delete: runtime reset failed: ${errorMessage(err)}`);
        }
      });
      const cfg = getEmbedderConfig();
      res.json({ hasKey: !!cfg.apiKey, provider: cfg.provider, model: cfg.model });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}
