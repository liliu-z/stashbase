import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  errorMessage,
  type TranscriptionModelId,
  type TranscriptionSettings,
} from '../../api';
import { useApp } from '../../store/AppContext';
import { TRANSCRIPTION_LANGUAGE_OPTIONS } from '../../../../shared/transcription.ts';

export function TranscriptionPanel() {
  const { actions } = useApp();
  const [settings, setSettings] = useState<TranscriptionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyModel, setBusyModel] = useState<TranscriptionModelId | null>(null);
  const [nonce, setNonce] = useState(0);
  const preferenceGeneration = useRef(0);

  const load = useCallback(async (expectedGeneration = preferenceGeneration.current) => {
    const next = await api.transcriptionSettings();
    if (expectedGeneration !== preferenceGeneration.current) return next;
    setSettings(next);
    setError(null);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      const expectedGeneration = preferenceGeneration.current;
      try {
        const next = await api.transcriptionSettings();
        if (cancelled) return;
        if (expectedGeneration === preferenceGeneration.current) {
          setSettings(next);
          setError(null);
        }
        if (next.providers.some((provider) => provider.models.some((model) => (
          model.operation?.status === 'downloading' || model.operation?.status === 'verifying'
        )))) {
          timer = setTimeout(refresh, 700);
        }
      } catch (err: unknown) {
        if (!cancelled) setError(errorMessage(err));
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [nonce]);

  async function chooseModel(providerId: string, modelId: string) {
    if (!settings || (settings.providerId === providerId && modelId === settings.modelId)) return;
    const generation = ++preferenceGeneration.current;
    setSettings({ ...settings, providerId, modelId });
    try {
      await api.setTranscriptionPreferences({ providerId, modelId });
      if (generation === preferenceGeneration.current) setNonce((value) => value + 1);
    } catch (err: unknown) {
      if (generation !== preferenceGeneration.current) return;
      setError(errorMessage(err));
      void load(generation).catch(() => undefined);
    }
  }

  async function chooseLanguage(language: string) {
    if (!settings) return;
    const generation = ++preferenceGeneration.current;
    const previous = settings.language;
    setSettings({ ...settings, language });
    try {
      await api.setTranscriptionPreferences({ language });
      if (generation === preferenceGeneration.current) setNonce((value) => value + 1);
    } catch (err: unknown) {
      if (generation !== preferenceGeneration.current) return;
      setSettings((current) => current ? { ...current, language: previous } : current);
      setError(errorMessage(err));
    }
  }

  async function download(modelId: TranscriptionModelId) {
    setBusyModel(modelId);
    setError(null);
    try {
      await api.downloadTranscriptionModel(modelId);
      setNonce((value) => value + 1);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setBusyModel(null);
    }
  }

  async function remove(modelId: TranscriptionModelId, confirmRemoval = true) {
    if (confirmRemoval) {
      const confirmed = await actions.confirm(`Remove the downloaded ${modelId} transcription model? Existing transcripts stay available.`);
      if (!confirmed) return;
    }
    setBusyModel(modelId);
    setError(null);
    try {
      await api.removeTranscriptionModel(modelId);
      setNonce((value) => value + 1);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setBusyModel(null);
    }
  }

  if (!settings && !error) return <div className="settings-panel-loading">Loading…</div>;
  if (!settings) {
    return (
      <div className="settings-panel">
        <div className="settings-error">Couldn’t load transcription settings: {error}</div>
        <button type="button" className="settings-secondary-btn" onClick={() => setNonce((value) => value + 1)}>Retry</button>
      </div>
    );
  }

  const selectedProvider = settings.providers.find((provider) => provider.id === settings.providerId)
    ?? settings.providers[0];

  return (
    <div className="settings-panel">
      <div className="settings-section">
        <div className="settings-section-title">Transcription provider and model</div>
        <div className="settings-section-hint">
          {selectedProvider?.description ?? 'Choose the provider and model used for audio transcription.'}
        </div>
        {settings.providers.length > 1 && (
          <select
            className="settings-select"
            value={selectedProvider?.id ?? ''}
            onChange={(event) => {
              const provider = settings.providers.find((candidate) => candidate.id === event.target.value);
              const model = provider?.models[0];
              if (provider && model) void chooseModel(provider.id, model.id);
            }}
          >
            {settings.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select>
        )}
        {selectedProvider?.runtimeError && (
          <div className="settings-error">Transcription runtime unavailable: {selectedProvider.runtimeError}</div>
        )}
        <div className="transcription-model-list">
          {(selectedProvider?.models ?? []).map((model) => {
            const operation = model.operation ?? { status: 'idle' as const };
            const downloading = operation.status === 'downloading';
            const verifying = operation.status === 'verifying';
            const progress = operation.status === 'downloading' && operation.totalBytes > 0
              ? Math.min(100, (operation.receivedBytes / operation.totalBytes) * 100)
              : 0;
            return (
              <div key={model.id} className={'transcription-model-row' + (settings.providerId === selectedProvider?.id && settings.modelId === model.id ? ' selected' : '')}>
                <label>
                  <input
                    type="radio"
                    name="transcription-model"
                    checked={settings.providerId === selectedProvider?.id && settings.modelId === model.id}
                    onChange={() => { if (selectedProvider) void chooseModel(selectedProvider.id, model.id); }}
                  />
                  <span>
                    <strong>{model.label}</strong>
                    {(model.sizeBytes || model.speed || model.accuracy) && (
                      <small>{[model.sizeBytes ? formatBytes(model.sizeBytes) : '', model.speed, model.accuracy].filter(Boolean).join(' · ')}</small>
                    )}
                    {model.resourceUse && <small>{model.resourceUse} · multilingual</small>}
                  </span>
                </label>
                <div className="transcription-model-action">
                  {model.management === 'provider' ? (
                    <span className="settings-section-hint">{model.available ? 'Available' : 'Unavailable'}</span>
                  ) : downloading ? (
                    <>
                      <span className="transcription-download-progress" title={`${progress.toFixed(0)}%`}>
                        <span style={{ width: `${progress}%` }} />
                      </span>
                      <button type="button" className="settings-secondary-btn" disabled={busyModel === model.id} onClick={() => { void remove(model.id as TranscriptionModelId, false); }}>
                        Cancel
                      </button>
                    </>
                  ) : verifying ? (
                    <span className="settings-section-hint">Verifying…</span>
                  ) : model.available ? (
                    <button type="button" className="settings-secondary-btn" disabled={busyModel === model.id} onClick={() => { void remove(model.id as TranscriptionModelId); }}>
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="settings-primary-btn"
                      disabled={busyModel === model.id || !!selectedProvider?.runtimeError}
                      title={selectedProvider?.runtimeError ? 'Install or repair the local transcription runtime first.' : undefined}
                      onClick={() => { void download(model.id as TranscriptionModelId); }}
                    >
                      {operation.status === 'failed' ? 'Retry download' : 'Download'}
                    </button>
                  )}
                </div>
                {operation.status === 'failed' && <div className="settings-error transcription-model-error">{operation.error}</div>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Preferred language</div>
        <div className="settings-section-hint">
          Auto-detect evaluates every long-recording chunk independently. A different language can be chosen for an individual Reprocess attempt.
        </div>
        <select
          className="settings-select"
          value={settings.language}
          onChange={(event) => { void chooseLanguage(event.target.value); }}
        >
          {TRANSCRIPTION_LANGUAGE_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {error && <div className="settings-error">{error}</div>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}
