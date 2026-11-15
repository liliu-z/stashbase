import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import type { VoiceModelPort } from '@/features/settings/application/voice-model-port';
import { useSettingsCommand } from '@/features/settings/hooks/use-settings-command';
import { SettingsGroup, SettingsList, SettingsRow } from '@/features/settings/ui/rows';
import { voiceModelQueryKey, type VoiceModelState } from '@/shared/domain/voice-typing';
import { FailureNotice } from '@/shared/ui/failure-notice';

function description(state: VoiceModelState | undefined): string {
  if (!state) return 'Checking availability…';
  switch (state.phase) {
    case 'ready':
      return 'Ready · Works offline on this computer';
    case 'downloading':
      return `Downloading model · ${Math.round(state.downloadedBytes / 1_000_000)} / ${Math.round(state.totalBytes / 1_000_000)} MB`;
    case 'paused':
      return 'Download paused';
    case 'verifying':
      return 'Checking voice model…';
    case 'failed':
      return state.error ?? 'Preparation failed. Retry when your connection is available.';
    case 'unsupported':
      return state.error ?? 'Voice typing is unavailable on this computer.';
    case 'missing':
      return 'Waiting to prepare voice typing';
  }
}

export function VoiceTypingGroup({ port }: { port: VoiceModelPort }) {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: voiceModelQueryKey,
    queryFn: ({ signal }) => port.load(signal),
    retry: false,
    refetchInterval: (currentQuery) =>
      ['downloading', 'verifying', 'missing'].includes(currentQuery.state.data?.phase ?? '')
        ? 1000
        : false,
  });
  const command = useSettingsCommand(
    'voice-model',
    (action: 'stop' | 'resume' | 'retry', signal) => port.command(action, signal),
    {
      onDone: (value) => {
        cache.setQueryData(voiceModelQueryKey, value);
      },
      onSettled: () => {
        void cache.invalidateQueries({ queryKey: voiceModelQueryKey });
      },
    },
  );
  const state = query.data;
  const action =
    state?.phase === 'downloading' || state?.phase === 'verifying'
      ? 'stop'
      : state?.phase === 'paused'
        ? 'resume'
        : state?.phase === 'failed' || state?.phase === 'missing'
          ? 'retry'
          : null;
  const percent = state
    ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
    : 0;
  return (
    <SettingsGroup title="Voice typing">
      <SettingsList>
        <SettingsRow
          title="English dictation"
          detail={
            <div className="flex flex-col gap-1.5">
              <span role="status">
                {query.isError ? 'Voice typing status could not be checked.' : description(state)}
              </span>
              {state?.phase === 'downloading' && (
                <div
                  aria-label="Voice model download"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  role="progressbar"
                  className="h-1 w-full overflow-hidden rounded-full bg-hover"
                >
                  <div className="h-full bg-foreground" style={{ width: `${percent}%` }} />
                </div>
              )}
            </div>
          }
          trail={
            action ? (
              <Button
                size="compact"
                variant="tertiary"
                disabled={command.busy}
                onClick={() => command.run(action)}
              >
                {action === 'stop' ? 'Stop' : action === 'resume' ? 'Resume' : 'Retry'}
              </Button>
            ) : undefined
          }
        />
      </SettingsList>
      {command.failure && <FailureNotice failure={command.failure} />}
    </SettingsGroup>
  );
}
