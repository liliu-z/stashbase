import { afterEach, expect, it, vi } from 'vite-plus/test';

import { httpClient } from '@/test/fakes/http';

import { createUsageRecorder, listenForDesktopActivity } from './telemetry';

afterEach(() => vi.useRealTimers());

function input(name: string, trusted = true) {
  const event = new Event(name);
  Object.defineProperty(event, 'isTrusted', { value: trusted });
  return event;
}

it('counts real foreground input across days without a heartbeat or collecting input data', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const record = vi.fn();
  const dispose = listenForDesktopActivity(record, 'documents');
  vi.advanceTimersByTime(86400_000);
  expect(record).not.toHaveBeenCalled();
  window.dispatchEvent(input('keydown', false));
  expect(record).not.toHaveBeenCalled();
  window.dispatchEvent(input('keydown'));
  window.dispatchEvent(input('wheel'));
  expect(record).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(86400_000);
  window.dispatchEvent(input('pointerdown'));
  expect(record).toHaveBeenCalledTimes(2);
  expect(record).toHaveBeenLastCalledWith({ event: 'app_active', mode: 'documents' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  vi.advanceTimersByTime(60_000);
  window.dispatchEvent(input('keydown'));
  expect(record).toHaveBeenCalledTimes(2);
  dispose();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  window.dispatchEvent(input('keydown'));
  expect(record).toHaveBeenCalledTimes(2);
});

it('coalesces editing bursts before HTTP and never accepts host-only account or billing facts', async () => {
  vi.useFakeTimers();
  const client = httpClient();
  const request = vi.spyOn(client, 'request').mockRejectedValue(new Error('offline'));
  const record = createUsageRecorder(client);
  for (let index = 0; index < 50; index++)
    record({ event: 'document_engaged', activity: 'edit', format: 'md' });
  record({ event: 'account_login_result', outcome: 'success' });
  record({ event: 'subscription_observed', plan: 'pro', paid: true, cancel_at_period_end: false });
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0].body).toEqual({
    event: 'document_engaged',
    activity: 'edit',
    format: 'md',
  });
  vi.advanceTimersByTime(60_000);
  record({ event: 'document_engaged', activity: 'edit', format: 'md' });
  expect(request).toHaveBeenCalledTimes(2);
});

it('an immediate terminal outcome waits for its own start without delaying other turns', async () => {
  const client = httpClient();
  let release!: () => void;
  const request = vi.spyOn(client, 'request').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ body: null, status: 200 });
      }),
  );
  const record = createUsageRecorder(client);
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  record({ event: 'agent_turn_started', runtime: 'codex', turn_id: first });
  record({
    event: 'agent_turn_finished',
    runtime: 'codex',
    turn_id: first,
    outcome: 'blocked',
    duration: 'under_10s',
  });
  record({ event: 'agent_turn_started', runtime: 'claude', turn_id: second });
  expect(request).toHaveBeenCalledTimes(2);
  release();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls[2]?.[0].body).toMatchObject({
    event: 'agent_turn_finished',
    turn_id: first,
  });
});
