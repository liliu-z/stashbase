import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import { expect, screen, userEvent, waitFor } from 'storybook/test';

import { AgentRuntimeError } from '@/features/settings/application/ports';

import { AccountPanel } from './account-panel';
import { AccountProvider } from './account-provider';
import {
  accountRuntimePort,
  signedIn as connectedAccount,
  SIGNED_OUT,
} from './account-story-fixtures';
function View({
  signedIn = true,
  connected = true,
  creditFailure,
}: {
  signedIn?: boolean;
  connected?: boolean;
  creditFailure?: 'expired' | 'network';
}) {
  const { port, runtime } = useMemo(() => {
    let expired = false;
    const runtimePort = accountRuntimePort();
    if (creditFailure)
      runtimePort.getAllowance = async () => {
        expired = creditFailure === 'expired';
        throw new AgentRuntimeError(
          expired ? 'unauthorized' : 'unavailable',
          expired ? 'Sign in first.' : 'ETIMEDOUT',
        );
      };
    return {
      port: {
        ...connectedAccount,
        load: async (signal: AbortSignal) =>
          signedIn && !expired ? connectedAccount.load(signal) : SIGNED_OUT,
        methods: async () => ({ email: 'ada@example.com', google: connected }),
      },
      runtime: runtimePort,
    };
  }, [signedIn, connected, creditFailure]);
  return (
    <AccountProvider port={port} openExternal={() => undefined}>
      <AccountPanel agentRuntimeApi={runtime} />
    </AccountProvider>
  );
}
const meta = {
  title: 'Settings/Account',
  component: View,
  parameters: { fluidCanvas: { width: '40rem', minHeight: '20rem' } },
  decorators: [
    (Story) => (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Story />
      </QueryClientProvider>
    ),
  ],
} satisfies Meta<typeof View>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connected: Story = {};
export const NotConnected: Story = { args: { connected: false } };
export const SignedOut: Story = { args: { signedIn: false } };
export const ExpiredAccount: Story = {
  args: { creditFailure: 'expired' },
  play: async () => {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('button', { name: 'Continue with Google' });
  },
};
export const CreditNetworkFailure: Story = { args: { creditFailure: 'network' } };
export const EmailProof: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect Google' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send email code' }));
    await screen.findByRole('textbox', { name: 'Six-digit code' });
  },
};

export const ConnectEmailEntry: Story = {
  args: { connected: false },
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
  },
};
export const ConnectEmailProof: Story = {
  args: { connected: false },
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send email code' }));
    await screen.findByRole('textbox', { name: 'Six-digit code' });
  },
};

export const VerifyEmailEntry: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Verify email' }));
    await screen.findByRole('dialog', { name: 'Verify email sign-in' });
  },
};
export const VerifyEmailCode: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Verify email' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send email code' }));
    await screen.findByRole('textbox', { name: 'Six-digit code' });
  },
};
