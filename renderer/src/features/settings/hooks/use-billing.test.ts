import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { AgentRuntimeError } from '@/features/settings/application/ports';
import {
  accountPort,
  agentRuntimePort,
  FREE_BILLING,
  SIGNED_IN_ACCOUNT,
  SIGNED_OUT_ACCOUNT,
} from '@/test/fakes/settings';
import { createTestQueryClient, queryWrapper } from '@/test/query';

import { useAccount } from './use-account';
import { useBilling } from './use-billing';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('billing browser handoff', () => {
  it.each(['portal', 'checkout', 'change'] as const)(
    'recovers an expired account after a %s refusal without replaying or reading signed-out billing',
    async (action) => {
      let current = SIGNED_IN_ACCOUNT;
      const accountPortFixture = accountPort(current, { load: vi.fn(async () => current) });
      const refuse = vi.fn(async () => {
        current = SIGNED_OUT_ACCOUNT;
        throw new AgentRuntimeError('unauthorized', 'Sign in first.');
      });
      const port = agentRuntimePort({
        openBillingPortal: refuse,
        startCheckout: refuse,
        changeBilling: refuse,
      });
      const openExternal = vi.fn();
      const view = renderHook(
        () => {
          const account = useAccount(accountPortFixture, openExternal);
          return {
            account,
            billing: useBilling(port, openExternal, account.account?.signedIn === true),
          };
        },
        { wrapper: queryWrapper(createTestQueryClient()) },
      );
      await waitFor(() => expect(view.result.current.account.account?.signedIn).toBe(true));
      await waitFor(() => expect(view.result.current.billing.status).not.toBeNull());
      act(() => {
        if (action === 'portal') view.result.current.billing.manage();
        else if (action === 'checkout') view.result.current.billing.subscribe('price_plus');
        else view.result.current.billing.change({ action: 'cancel' });
      });
      await waitFor(() => expect(view.result.current.account.account?.signedIn).toBe(false));
      await waitFor(() => expect(view.result.current.billing.busy).toBe(false));
      expect(accountPortFixture.signOut).not.toHaveBeenCalled();
      expect(refuse).toHaveBeenCalledOnce();
      expect(port.getBillingStatus).toHaveBeenCalledOnce();
      expect(view.result.current.billing.status).toEqual(FREE_BILLING);
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it.each(['active', 'trialing'])(
    'confirms %s rights when returning after a long checkout',
    async (subscriptionStatus) => {
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
        status: subscriptionStatus,
        canManage: true,
        planName: 'Plus',
        paidThrough: '2099-01-01T00:00:00Z',
      };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_010);
      });
      expect(view.result.current.confirming).toBeNull();
    },
  );

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
