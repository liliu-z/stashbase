import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { agentRuntimePort, FREE_BILLING } from '@/test/fakes/settings';
import { createTestQueryClient, queryWrapper } from '@/test/query';

import { useBilling } from './use-billing';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('billing browser handoff', () => {
  it('restarts confirmation when returning after a long checkout', async () => {
    let status = FREE_BILLING;
    const port = agentRuntimePort({ getBillingStatus: vi.fn(async () => status) });
    const view = renderHook(() => useBilling(port, vi.fn(), true), {
      wrapper: queryWrapper(createTestQueryClient()),
    });
    await waitFor(() => expect(view.result.current.status).not.toBeNull());
    vi.useFakeTimers();
    await act(async () => {
      view.result.current.subscribe('price_plus');
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125_000);
    });
    expect(view.result.current.confirming).toBe('slow');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(view.result.current.confirming).toBe('waiting');
    status = {
      ...FREE_BILLING,
      status: 'active',
      canManage: true,
      planName: 'Plus',
      paidThrough: '2099-01-01T00:00:00Z',
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_010);
    });
    expect(view.result.current.confirming).toBeNull();
  });

  it('reports browser refusal instead of silently completing a Portal action', async () => {
    const port = agentRuntimePort({
      startCheckout: vi.fn(async () => {
        throw new Error('Unavailable');
      }),
    });
    const view = renderHook(
      () =>
        useBilling(
          port,
          vi.fn(async () => false),
          true,
        ),
      {
        wrapper: queryWrapper(createTestQueryClient()),
      },
    );
    await waitFor(() => expect(view.result.current.status).not.toBeNull());
    act(() => view.result.current.subscribe('price_plus'));
    await waitFor(() => expect(view.result.current.failure?.message).toContain('payment page'));
    act(() => view.result.current.manage());
    await waitFor(() => expect(port.openBillingPortal).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(view.result.current.failure?.message).toContain('subscription management'),
    );
  });
});
