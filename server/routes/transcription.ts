/** Global transcription settings/model management plus active-folder transcript reads. */
import express from 'express';
import {
  getTranscriptionPreferences,
  setTranscriptionPreferences,
  type TranscriptionModelId,
} from '../app-config.ts';
import {
  removeTranscriptionModel,
  startTranscriptionModelDownload,
  TRANSCRIPTION_MODELS,
  installedTranscriptionModelPath,
} from '../transcription-models.ts';
import {
  configuredTranscriptionBlock,
  maybeConvertAudio,
  readAudioTranscript,
} from '../audio-transcription.ts';
import {
  getTranscriptionProvider,
  isTranscriptionProviderRegistered,
  listTranscriptionProviderSettings,
} from '../transcription-provider.ts';
import { LOCAL_TRANSCRIPTION_PROVIDER_ID } from '../whisper-cpp-provider.ts';
import { getScheduledConversion } from '../conversion.ts';
import { listPreparationProblems, readProgress } from '../conversion-status.ts';
import { isAudioFile } from '../format.ts';
import { resolveExisting } from '../files.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { sendError } from '../http.ts';
import { errorMessage, logger } from '../log.ts';
import { reconcileLibraryFolders } from '../state.ts';
import { normalizeTranscriptionLanguage } from '../../shared/transcription.ts';

const log = logger('routes/transcription');

export function mount(app: express.Express): void {
  app.get('/api/transcription/settings', (_req, res) => {
    const preferences = getTranscriptionPreferences();
    res.json({
      ...preferences,
      providers: listTranscriptionProviderSettings(),
    });
  });

  app.put('/api/transcription/preferences', (req, res) => {
    try {
      const modelId = req.body?.modelId;
      const language = req.body?.language;
      const providerId = req.body?.providerId;
      const current = getTranscriptionPreferences();
      const nextProviderId = providerId === undefined ? current.providerId : requireProviderId(providerId);
      if (providerId !== undefined && nextProviderId !== current.providerId && modelId === undefined) {
        throw httpError(400, 'transcription model id is required when changing provider');
      }
      const preferences = setTranscriptionPreferences({
        ...(providerId !== undefined ? { providerId: nextProviderId } : {}),
        ...(modelId !== undefined ? { modelId: requireModelForProvider(modelId, nextProviderId) } : {}),
        ...(language !== undefined ? { language: requireLanguage(language) } : {}),
      });
      if (
        preferences.providerId !== LOCAL_TRANSCRIPTION_PROVIDER_ID
        || installedTranscriptionModelPath(requireModelId(preferences.modelId))
      ) {
        void reconcileLibraryFolders('transcription preferences changed').catch((err: unknown) => {
          log.warn(`transcription preference reconcile failed: ${errorMessage(err)}`);
        });
      }
      res.json(preferences);
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/transcription/models/:id/download', (req, res) => {
    try {
      const id = requireModelId(req.params.id);
      const download = startTranscriptionModelDownload(id);
      res.status(download.status === 'downloading' ? 202 : 200).json({ id, download });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.delete('/api/transcription/models/:id', async (req, res) => {
    try {
      const id = requireModelId(req.params.id);
      await removeTranscriptionModel(id);
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/audio/transcript', (req, res) => {
    try {
      const rel = typeof req.query.path === 'string' ? req.query.path.trim() : '';
      if (!rel || !isAudioFile(rel)) return res.status(415).json({ error: 'audio path required' });
      const sourceAbs = resolveExisting(rel);
      if (!sourceAbs) return res.status(404).json({ error: 'file not found' });
      const transcript = readAudioTranscript(sourceAbs);
      if (transcript) return res.json({ status: 'ready', transcript });

      const scheduled = getScheduledConversion(sourceAbs);
      if (scheduled) {
        return res.json({
          status: 'pending',
          progress: scheduled.state === 'running'
            ? readProgress(sourceAbs)
            : {
                phase: scheduled.state === 'yielded' ? 'yielded' : 'queued',
                lane: scheduled.lane,
                tasksAhead: scheduled.tasksAhead ?? 0,
              },
        });
      }
      const problem = listPreparationProblems().find((item) => filesystemPath.equal(item.path, sourceAbs));
      if (problem) {
        if (problem.entry.status === 'cancelled') {
          return res.json({ status: 'cancelled' });
        }
        return res.json({ status: 'failed', error: problem.entry.lastError ?? 'transcription failed' });
      }
      const block = configuredTranscriptionBlock();
      if (block) return res.json({ status: 'blocked', ...block });
      maybeConvertAudio(sourceAbs, { urgency: 'interactive' });
      return res.json({ status: 'pending', progress: { phase: 'queued', lane: 'heavy', tasksAhead: 0 } });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}

function requireProviderId(value: unknown): string {
  if (typeof value === 'string' && value.trim() && isTranscriptionProviderRegistered(value.trim())) {
    return value.trim();
  }
  throw httpError(400, 'unsupported transcription provider');
}

export function requireModelForProvider(value: unknown, providerId: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw httpError(400, 'transcription model id is required');
  }
  const modelId = value.trim();
  const provider = getTranscriptionProvider(providerId);
  if (!provider || provider.resolveSelection(modelId).status === 'invalid-model') {
    throw httpError(400, 'unsupported transcription model');
  }
  return modelId;
}

function requireModelId(value: unknown): TranscriptionModelId {
  if (typeof value === 'string' && TRANSCRIPTION_MODELS.some((model) => model.id === value)) {
    return value as TranscriptionModelId;
  }
  throw httpError(400, 'unsupported transcription model');
}

function requireLanguage(value: unknown): string {
  const normalized = normalizeTranscriptionLanguage(value);
  if (normalized) return normalized;
  throw httpError(400, 'transcription language must be `auto` or a language code');
}

function httpError(status: number, message: string): Error {
  const error = new Error(message);
  (error as { status?: number }).status = status;
  return error;
}
