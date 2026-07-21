import { useEffect, useMemo, useRef, useState } from 'react';
import {
  audioPreviewAssetUrl,
  versionedAssetUrl,
} from '../api';
import {
  audioPreviewProgressCopy,
  audioTranscriptStatusCopy,
  findAudioSeekSegment,
} from '../audio-transcript.ts';
import { AudioPlaybackPosition } from '../audio-playback.ts';
import { useApp } from '../store/AppContext';
import { openSettings } from './SettingsModal';
import { TRANSCRIPTION_LANGUAGE_OPTIONS } from '../../../shared/transcription.ts';
import { useAudioFallbackController } from './audio/useAudioFallbackController.ts';
import { useAudioTranscriptController } from './audio/useAudioTranscriptController.ts';

export function AudioPreview({ name }: { name: string }) {
  const { state, activeTab, actions } = useApp();
  const version = activeTab?.file?.name === name ? activeTab.file.version ?? '' : '';
  const directSrc = useMemo(() => versionedAssetUrl(name, version), [name, version]);
  const fallbackSrc = useMemo(() => audioPreviewAssetUrl(name, version), [name, version]);
  const [positionMs, setPositionMs] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackPositionRef = useRef(new AudioPlaybackPosition());
  const fallback = useAudioFallbackController({
    name,
    folder: state.folderPath,
    directSrc,
    fallbackSrc,
  });
  const transcription = useAudioTranscriptController({
    name,
    folder: state.folderPath,
    version,
    conversionRevision: state.conversionRevision,
  });

  useEffect(() => {
    setPositionMs(0);
    playbackPositionRef.current.setSourceIdentity(JSON.stringify([state.folderPath, name, version]));
  }, [name, state.folderPath, version]);

  useEffect(() => {
    const highlight = activeTab?.pendingHighlight;
    const transcript = transcription.state?.status === 'ready' ? transcription.state.transcript : null;
    if (!highlight || !transcript) return;
    const segment = findAudioSeekSegment(
      highlight.audioSeekText ?? highlight.chunkText,
      transcript.segments,
      highlight.audioSeekMs,
    );
    if (segment && audioRef.current) {
      playbackPositionRef.current.remember(segment.startMs);
      playbackPositionRef.current.apply(audioRef.current);
      setPositionMs(segment.startMs);
      actions.consumePendingHighlight();
    }
  }, [actions, activeTab?.pendingHighlight, transcription.state]);

  function seek(startMs: number) {
    const audio = audioRef.current;
    if (!audio) return;
    playbackPositionRef.current.remember(startMs);
    playbackPositionRef.current.apply(audio);
    setPositionMs(startMs);
    void audio.play().catch(() => undefined);
  }

  const statusCopy = audioTranscriptStatusCopy(transcription.state);
  const fallbackProgressCopy = audioPreviewProgressCopy(fallback.progress);
  const transcript = transcription.state?.status === 'ready' ? transcription.state.transcript : null;

  return (
    <div className="audio-preview">
      <div className="audio-player-card">
        <div className="audio-player-title">{name.split('/').pop()}</div>
        <audio
          key={`${state.folderPath}:${fallback.playbackSrc}`}
          ref={audioRef}
          controls
          preload="metadata"
          src={fallback.playbackSrc}
          onLoadedMetadata={(event) => playbackPositionRef.current.apply(event.currentTarget)}
          onTimeUpdate={(event) => {
            const nextPositionMs = Math.round(event.currentTarget.currentTime * 1000);
            playbackPositionRef.current.remember(nextPositionMs);
            setPositionMs(nextPositionMs);
          }}
          onError={fallback.markUnplayable}
        />
        {fallback.preparing && (
          <div className="audio-player-hint">
            <span>{fallbackProgressCopy}</span>
            {fallback.progress?.status === 'converting' && fallback.progress.totalMs > 0 && (
              <progress
                className="audio-preview-progress"
                max={100}
                value={fallback.progress.percent}
                aria-label="Compatible audio preview progress"
              />
            )}
            <button type="button" onClick={fallback.cancel}>Cancel</button>
          </div>
        )}
        {fallback.usingFallback && !fallback.preparing && !fallback.error && (
          <div className="audio-player-hint">Using a browser-compatible local preview.</div>
        )}
        {fallback.error && (
          <div className="audio-player-hint error">
            <span>{fallback.error}</span>
            <button type="button" onClick={() => { void fallback.prepare(); }}>Retry</button>
          </div>
        )}
      </div>

      <div className="audio-transcript-pane">
        <div className="audio-transcript-header">
          <div>
            <strong>Transcript</strong>
            {transcript && (
              <span className="audio-transcript-meta">
                {transcript.language} · {transcript.provider.model} · {formatTimestamp(transcript.source.durationMs)}
              </span>
            )}
          </div>
          {(transcription.state?.status === 'ready' || transcription.state?.status === 'failed' || transcription.state?.status === 'cancelled') && (
            <div className="audio-retry-controls">
              <select value={transcription.retryLanguage} onChange={(event) => transcription.setRetryLanguage(event.target.value)} disabled={transcription.retryBusy}>
                <option value="">Use Settings default</option>
                {TRANSCRIPTION_LANGUAGE_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" disabled={transcription.retryBusy} onClick={() => { void transcription.reprocess(); }}>
                {transcription.retryBusy ? 'Starting…' : 'Reprocess'}
              </button>
            </div>
          )}
          {transcription.state?.status === 'pending' && (
            <button type="button" disabled={transcription.cancelBusy} onClick={() => { void transcription.cancel(); }}>
              {transcription.cancelBusy ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </div>

        {transcription.error && <div className="audio-transcript-state error">{transcription.error}</div>}
        {!transcription.error && statusCopy && (
          <div
            className={'audio-transcript-state' + (transcription.state?.status === 'failed' ? ' error' : '')}
            role="status"
            aria-live="polite"
          >
            <span>{statusCopy}</span>
            {transcription.state?.status === 'blocked' && (
              <button type="button" onClick={() => openSettings('transcription')}>Open Settings</button>
            )}
          </div>
        )}
        {transcript && transcript.segments.length === 0 && (
          <div className="audio-transcript-empty">No speech was detected.</div>
        )}
        {transcript && transcript.segments.length > 0 && (
          <div className="audio-segments">
            {transcript.segments.map((segment) => (
              <button
                key={segment.id}
                type="button"
                className={'audio-segment' + (positionMs >= segment.startMs && positionMs < segment.endMs ? ' current' : '')}
                onClick={() => seek(segment.startMs)}
              >
                <span className="audio-segment-time">{formatTimestamp(segment.startMs)}</span>
                <span className="audio-segment-text">{segment.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTimestamp(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
