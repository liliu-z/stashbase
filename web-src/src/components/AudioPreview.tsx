import { useEffect, useMemo, useRef, useState } from 'react';
import {
  audioPreviewAssetUrl,
  versionedAssetUrl,
} from '../api';
import {
  audioPreviewProgressCopy,
  audioTranscriptStatusCopy,
  findAudioSeekSegment,
} from '../audioTranscript.ts';
import { AudioPlaybackPosition } from '../audioPlayback.ts';
import { basename } from '../lib/paths';
import { useApp } from '../store/AppContext';
import { emptyStateClass } from './emptyState';
import { openSettings } from './SettingsModal';
import { TRANSCRIPTION_LANGUAGE_OPTIONS } from '../../../shared/transcription.ts';
import { useAudioFallbackController } from './audio/useAudioFallbackController.ts';
import { useAudioTranscriptController } from './audio/useAudioTranscriptController.ts';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { StatusMessage } from './ui/status';

export function AudioPreview({ name }: { name: string }) {
  const { state, activeTab, actions } = useApp();
  const isExternal = activeTab?.file?.name === name && Boolean(activeTab.file.isExternal);
  const version = activeTab?.file?.name === name ? activeTab.file.version ?? '' : '';
  // Out-of-folder tab: every URL and prepare/transcript request must carry
  // the file's own member folder instead of the window's.
  const sourceFolder = activeTab?.file?.name === name ? activeTab.file.folder : undefined;
  const sourceGrantId = activeTab?.file?.name === name ? activeTab.file.grantId : undefined;
  const requestFolder = sourceFolder ?? state.folderPath;
  const directSrc = useMemo(
    () => versionedAssetUrl(name, version, sourceFolder, sourceGrantId),
    [name, version, sourceFolder, sourceGrantId],
  );
  const fallbackSrc = useMemo(() => audioPreviewAssetUrl(name, version, sourceFolder), [name, version, sourceFolder]);
  const [positionMs, setPositionMs] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackPositionRef = useRef(new AudioPlaybackPosition());
  const fallback = useAudioFallbackController({
    name,
    folder: requestFolder,
    directSrc,
    fallbackSrc,
    enabled: !isExternal,
  });
  const transcription = useAudioTranscriptController({
    name,
    folder: requestFolder,
    version,
    conversionRevision: state.conversionRevision,
    enabled: !isExternal,
  });

  useEffect(() => {
    setPositionMs(0);
    playbackPositionRef.current.setSourceIdentity(JSON.stringify([requestFolder, name, version, sourceGrantId]));
  }, [name, requestFolder, version, sourceGrantId]);

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
    <div className="grid h-full w-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-pane">
      <div className="border-b border-border bg-card px-6 pt-5 pb-4">
        <div className="mb-2.5 truncate font-semibold">{basename(name)}</div>
        <audio
          key={`${state.folderPath}:${fallback.playbackSrc}`}
          ref={audioRef}
          className="block w-[min(760px,100%)]"
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
          <div className={HINT_CLASS}>
            <span>{fallbackProgressCopy}</span>
            {fallback.progress?.status === 'converting' && fallback.progress.totalMs > 0 && (
              /* The app progress recipe (6px capsule, muted track, accent
               * fill — see AgentRuntimeProgress) expressed on the native
               * element: appearance-none lets the webkit pseudo-elements
               * take the track/fill roles; accent-accent stays as the
               * fallback should appearance ever revert to native. */
              <progress
                className="h-1.5 w-[min(180px,28vw)] appearance-none overflow-hidden rounded-full accent-accent [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-accent"
                max={100}
                value={fallback.progress.percent}
                aria-label="Compatible audio preview progress"
              />
            )}
            <Button variant="outline" size="xs" onClick={fallback.cancel}>Cancel</Button>
          </div>
        )}
        {fallback.usingFallback && !fallback.preparing && !fallback.error && (
          <div className={HINT_CLASS}>Using a browser-compatible local preview.</div>
        )}
        {fallback.error && (
          <div className={`${HINT_CLASS} text-destructive`}>
            <span>{fallback.error}</span>
            <Button variant="outline" size="xs" onClick={() => { void fallback.prepare(); }}>Retry</Button>
          </div>
        )}
      </div>

      <div className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden px-6 pt-4.5 pb-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <strong>Transcript</strong>
            {transcript && (
              <span className="ml-2.5 text-xs text-muted-foreground">
                {transcript.language} · {transcript.provider.model} · {formatTimestamp(transcript.source.durationMs)}
              </span>
            )}
          </div>
          {!isExternal && (transcription.state?.status === 'ready' || transcription.state?.status === 'failed' || transcription.state?.status === 'cancelled') && (
            <div className="flex items-center gap-1.5">
              <Select
                value={transcription.retryLanguage}
                onChange={(event) => transcription.setRetryLanguage(event.target.value)}
                disabled={transcription.retryBusy}
              >
                <option value="">Use Settings default</option>
                {TRANSCRIPTION_LANGUAGE_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
              </Select>
              <Button variant="outline" size="sm" disabled={transcription.retryBusy} onClick={() => { void transcription.reprocess(); }}>
                {transcription.retryBusy ? 'Starting…' : 'Reprocess'}
              </Button>
            </div>
          )}
          {!isExternal && transcription.state?.status === 'pending' && (
            <Button variant="outline" size="sm" disabled={transcription.cancelBusy} onClick={() => { void transcription.cancel(); }}>
              {transcription.cancelBusy ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}
        </div>

        {isExternal && (
          <div className={`${emptyStateClass} row-start-3`}>Transcripts are only generated for library files.</div>
        )}
        {!isExternal && transcription.error && (
          <StatusMessage tone="error" className={TRANSCRIPT_STATE_CLASS}>{transcription.error}</StatusMessage>
        )}
        {!isExternal && !transcription.error && statusCopy && (
          <StatusMessage
            tone={transcription.state?.status === 'failed' ? 'error' : 'info'}
            role="status"
            aria-live="polite"
            className={TRANSCRIPT_STATE_CLASS}
          >
            <span>{statusCopy}</span>
            {transcription.state?.status === 'blocked' && (
              <Button variant="outline" size="sm" onClick={() => openSettings('transcription')}>Open Settings</Button>
            )}
          </StatusMessage>
        )}
        {!isExternal && transcript && transcript.segments.length === 0 && (
          <div className={`${emptyStateClass} row-start-3`}>No speech was detected.</div>
        )}
        {!isExternal && transcript && transcript.segments.length > 0 && (
          <div className="row-start-3 grid min-h-0 content-start gap-0.5 overflow-auto">
            {transcript.segments.map((segment) => (
              <button
                key={segment.id}
                type="button"
                className={
                  'grid w-full cursor-pointer grid-cols-[68px_minmax(0,1fr)] gap-3 rounded-md border-0 px-2.5 py-2 text-left [font:inherit] text-foreground' +
                  /* Playing reads from the surface like selection — the
                   * neutral active wash, not an accent tint; the timestamp
                   * column already carries the accent moment. */
                  (positionMs >= segment.startMs && positionMs < segment.endMs
                    ? ' bg-active'
                    : ' bg-transparent hover:bg-muted')
                }
                onClick={() => seek(segment.startMs)}
              >
                <span className="text-sm text-accent tabular-nums">{formatTimestamp(segment.startMs)}</span>
                <span className="leading-[1.55]">{segment.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const HINT_CLASS = 'mt-1.5 flex items-center gap-2 text-xs text-muted-foreground';
const TRANSCRIPT_STATE_CLASS = 'flex items-center justify-between gap-3 px-3 py-2.5';

function formatTimestamp(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
