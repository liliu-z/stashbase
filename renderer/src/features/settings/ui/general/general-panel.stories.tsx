import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { SoftwareUpdateRow } from '@/shared/domain/software-update';

import { GeneralPanel } from './general-panel';
import { LocalComponentRecovery } from './local-component-recovery';

const softwareUpdate: SoftwareUpdateRow = {
  autoCheckEnabled: true,
  busy: false,
  actionLabel: 'Check for updates',
  act: () => undefined,
  failure: null,
  setAutoCheck: () => undefined,
  status: 'StashBase is up to date.',
  version: '2.0.0',
};

function GeneralHarness({ updates = null }: { updates?: SoftwareUpdateRow | null }) {
  return (
    <GeneralPanel
      appearanceApi={{
        load: async () => ({
          theme: 'system',
          uiScale: 'default',
          readingTextSize: 'default',
          readingFont: 'serif',
        }),
        update: async (change) => ({
          theme: 'system',
          uiScale: 'default',
          readingTextSize: 'default',
          readingFont: 'serif',
          ...change,
        }),
      }}
      softwareUpdate={updates}
    />
  );
}

const meta = {
  title: 'Settings/GeneralPanel',
  decorators: [
    (Story) => (
      <QueryClientProvider client={new QueryClient()}>
        <Story />
      </QueryClientProvider>
    ),
  ],
  parameters: { fluidCanvas: { width: '40rem', minHeight: '20rem' } },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** A build with no updater behind it: General says nothing about updates. */
export const Default: Story = { render: () => <GeneralHarness /> };

/** A packaged build, where the running version and the auto-check choice both
 *  have a home. */
export const WithSoftwareUpdates: Story = {
  render: () => <GeneralHarness updates={softwareUpdate} />,
};

export const ComponentDownloadFailed: Story = {
  render: () => (
    <LocalComponentRecovery
      port={{
        load: async () => ({ status: 'failed', error: 'network' }),
        retry: async () => ({ status: 'downloading', error: null }),
      }}
    />
  ),
};
