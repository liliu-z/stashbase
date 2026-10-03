import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { AccountProvider } from '@/features/settings/hooks/account-context';
import {
  accountPort,
  agentRuntimePort,
  appearancePort,
  embedderPort,
  mcpAccessPort,
} from '@/test/fakes/settings';
import { withQueryClient } from '@/test/query';

import ManagedSettings from './managed-settings';
import type { SettingsTarget } from './settings-types';

afterEach(cleanup);

function Harness({ initial = 'general' }: { initial?: SettingsTarget }) {
  const [section, setSection] = useState<SettingsTarget>(initial);
  return (
    <AccountProvider port={accountPort()} openExternal={vi.fn()}>
      <ManagedSettings
        agentRuntimeApi={agentRuntimePort()}
        appearanceApi={appearancePort()}
        embedderApi={embedderPort()}
        mcpAccessApi={mcpAccessPort()}
        onClose={vi.fn()}
        onSectionChange={setSection}
        open
        section={section}
      />
    </AccountProvider>
  );
}

it('keeps preferences in General and reaches both optional configurations through Advanced', async () => {
  withQueryClient(<Harness />);
  const user = userEvent.setup();
  await screen.findByRole('radiogroup', { name: 'Mode' });
  const nav = screen.getByLabelText('Settings sections');
  expect(within(nav).getAllByRole('button')).toHaveLength(3);
  for (const name of ['General', 'Agents', 'Advanced']) {
    expect(within(nav).getByRole('button', { name })).toBeDefined();
  }
  await user.click(within(nav).getByRole('button', { name: 'Advanced' }));
  await user.click(screen.getByRole('button', { name: 'Configure search' }));
  await screen.findByPlaceholderText('Paste your API key');
  await user.click(screen.getByRole('button', { name: 'Back to Advanced' }));
  await user.click(screen.getByRole('button', { name: 'Configure connection' }));
  await screen.findByRole('button', { name: 'Copy configuration' });
  expect(screen.queryByRole('button', { name: 'Show token' })).toBeNull();
  await user.click(screen.getByRole('tab', { name: 'HTTP' }));
  expect(screen.getByRole('button', { name: 'Show token' })).toBeDefined();
});

it('opens the search configuration directly and can return to the Advanced index', async () => {
  withQueryClient(<Harness initial="search" />);
  await screen.findByPlaceholderText('Paste your API key');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Back to Advanced' }));
  expect(screen.getByRole('button', { name: 'Configure connection' })).toBeDefined();
});
