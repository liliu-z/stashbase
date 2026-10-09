import { useEffect } from 'react';

import { listenForDesktopActivity } from '@/platform/telemetry';
import type { TelemetryEvent } from '@/protocols/http/telemetry';

export function useDesktopUsage(
  record: (event: TelemetryEvent) => void,
  mode: 'welcome' | 'documents' | 'chat',
) {
  useEffect(() => {
    record({ event: 'app_opened' });
  }, [record]);
  useEffect(() => listenForDesktopActivity(record, mode), [mode, record]);
}
