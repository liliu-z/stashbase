import { focusManager } from '@tanstack/react-query';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import type { TelemetryPort } from '@/features/settings/application/telemetry-port';
import { withQueryClient } from '@/test/query';

import { TelemetryGroup } from './telemetry-group';

afterEach(cleanup);
function fixture() {
  let saved = { enabled: true, available: true };
  const port: TelemetryPort = {
    load: async () => saved,
    update: vi.fn(async (change) => {
      saved = { ...saved, ...change };
      return saved;
    }),
  };
  return port;
}
it('persists opt-out from Settings without another confirmation', async () => {
  const port = fixture();
  withQueryClient(<TelemetryGroup port={port} onOpenExternal={() => undefined} />);
  const toggle = await screen.findByRole('switch', { name: 'Share usage statistics' });
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  await userEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  expect(port.update).toHaveBeenCalledWith({ enabled: false }, expect.any(AbortSignal));
});
it('keeps the confirmed choice and explains a failed write', async () => {
  const port = fixture();
  port.update = async () => {
    throw new Error('Could not save');
  };
  withQueryClient(<TelemetryGroup port={port} onOpenExternal={() => undefined} />);
  const toggle = await screen.findByRole('switch', { name: 'Share usage statistics' });
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  await userEvent.click(toggle);
  await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  expect(toggle.getAttribute('aria-checked')).toBe('true');
});
it('opens the event documentation without changing collection', async () => {
  const port = fixture();
  const open = vi.fn();
  withQueryClient(<TelemetryGroup port={port} onOpenExternal={open} />);
  await userEvent.click(await screen.findByRole('button', { name: 'View details' }));
  expect(open).toHaveBeenCalledWith(expect.stringContaining('usage-statistics.md'));
  expect(port.update).not.toHaveBeenCalled();
});

it('refreshes the durable choice when returning from another window', async () => {
  const port = fixture();
  withQueryClient(<TelemetryGroup port={port} onOpenExternal={() => undefined} />);
  const toggle = await screen.findByRole('switch', { name: 'Share usage statistics' });
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  act(() => focusManager.setFocused(false));
  await port.update({ enabled: false }, new AbortController().signal);
  act(() => focusManager.setFocused(true));
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  focusManager.setFocused(undefined);
});
