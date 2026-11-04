import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { TelemetryPort } from '@/features/settings/application/telemetry-port';
import { useTelemetry } from '@/features/settings/hooks/use-telemetry';
import { SettingsGroup, SettingsList, SettingsRow } from '@/features/settings/ui/rows';
import { FailureNotice } from '@/shared/ui/failure-notice';

const TELEMETRY_DETAILS_URL =
  'https://github.com/liliu-z/stashbase/blob/main/docs/usage-statistics.md';

export function TelemetryGroup({
  port,
  onOpenExternal,
}: {
  port: TelemetryPort;
  onOpenExternal(href: string): void;
}) {
  const model = useTelemetry(port);
  return (
    <SettingsGroup title="Privacy">
      <SettingsList>
        <SettingsRow
          title="Share usage statistics"
          detail={
            <>
              {model.preferences?.available === false
                ? 'This build does not send usage statistics or error diagnostics.'
                : 'Sends activity and error details, such as messages, file paths and stack traces, to help fix problems. Failed writes also keep restricted diagnostic records with the full paths involved. Credentials are filtered from routine reports; document and chat text is not recorded. Signing in links this to your account.'}{' '}
              <Button
                size="compact"
                variant="ghost"
                onClick={() => onOpenExternal(TELEMETRY_DETAILS_URL)}
              >
                View details
              </Button>
            </>
          }
          trail={
            <Switch
              checked={model.preferences?.enabled ?? false}
              disabled={model.busy || !model.preferences}
              label="Share usage statistics"
              labelHidden
              onToggle={() => model.change({ enabled: !model.preferences?.enabled })}
            />
          }
        />
      </SettingsList>
      {model.failure && <FailureNotice failure={model.failure} />}
    </SettingsGroup>
  );
}
