import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, userEvent } from 'storybook/test';

import type { AccountPort } from '@/features/settings/application/ports';
import { useAccount } from '@/features/settings/hooks/use-account';

import { AccountAccessDialog } from './account-access-dialog';
import { emptyReferrals } from './account-story-fixtures';

const person = {
  signedIn: true,
  email: 'writer@example.com',
  displayName: null,
  avatarUrl: null,
  offers: [],
};
const anonymous = { ...person, signedIn: false, email: null };
const port: AccountPort = {
  referrals: emptyReferrals,
  avatar: async () => null,
  load: async () => anonymous,
  markOfferSeen: async () => anonymous,
  resetOffers: async () => anonymous,
  signInStatus: async () => ({ state: 'pending' }),
  signOut: async () => anonymous,
  startSignIn: async () => ({ flowId: 'google', url: 'https://accounts.google.com' }),
  sendEmail: async () => ({ flowId: 'email' }),
  verifyEmail: async () => person,
  cancelEmail: async () => {},
  methods: async () => ({ email: person.email, google: true }),
  sendEmailProof: async () => {},
  verifyEmailProof: async () => {},
  sendLinkCode: async () => {},
  linkGoogle: async () => ({ ticket: 'link', url: 'https://accounts.google.com' }),
  unlinkGoogle: async () => {},
  linkStatus: async () => ({ state: 'pending' }),
};
function View() {
  const account = useAccount(port, () => undefined);
  return account.account ? <AccountAccessDialog account={account} port={port} /> : null;
}
const meta = {
  title: 'Settings/Account access',
  component: View,
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
export const EmailLogin: Story = {};

export const EmailCode: Story = {
  play: async () => {
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Email' }),
      'writer@example.com',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send email code' }));
    await screen.findByRole('textbox', { name: 'Six-digit code' });
  },
};
