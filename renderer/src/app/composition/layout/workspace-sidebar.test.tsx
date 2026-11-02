import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { Providers } from '@/app/providers';
import { App } from '@/app/shell';
import { appDependencies } from '@/test/fakes/app';
import { assetApi, documentAdapters, documentsApi } from '@/test/fakes/documents';
import {
  accountPort,
  agentRuntimePort,
  IDLE_ALLOWANCE,
  SIGNED_IN_ACCOUNT,
  SIGNED_OUT_ACCOUNT,
} from '@/test/fakes/settings';
import { filesApi, workspaceAdapters } from '@/test/fakes/workspace';

afterEach(cleanup);

/** A lazily mounted surface is allowed this long to arrive. */
const LAZY = { timeout: 10_000 };
/** And a test that waits for one has to outlive that wait: Vitest bounds a
 *  test at five seconds by default, which no `LAZY` wait can ever reach. The
 *  headroom above ten is for the slowest runner under coverage instrumentation,
 *  where this file's work costs about ten times what it does locally. */
const LAZY_TEST_MS = 20_000;

describe('account row', () => {
  it('sits at the foot of the sidebar and offers email and Google sign-in', async () => {
    const account = accountPort();
    const openExternal = vi.fn(async () => true);
    const base = appDependencies();
    render(
      <Providers>
        <App
          dependencies={appDependencies({
            documents: { ...base.documents, openExternal },
            settings: { ...base.settings, accountApi: account },
          })}
        />
      </Providers>,
    );

    // The row is the action alone; the free-credits offer lives in
    // Settings → Account, not in the sidebar's label.
    const signIn = await screen.findByRole('button', { name: 'Sign in' });
    await userEvent.setup().click(signIn);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(account.startSignIn).toHaveBeenCalledOnce());
    expect(openExternal).toHaveBeenCalledWith('https://accounts.example/sign-in');
    // The dialog stays on its browser wait, so stopping it there offers the
    // choices again without leaving.
    const dialog = within(screen.getByRole('dialog', { name: 'Sign in to StashBase' }));
    expect(
      await dialog.findByText('Finish signing in to StashBase in your browser.'),
    ).not.toBeNull();
    await userEvent.setup().click(dialog.getByRole('button', { name: 'Stop waiting' }));
    await userEvent
      .setup()
      .click(await dialog.findByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(account.startSignIn).toHaveBeenCalledTimes(2));
  });

  it(
    'recovers account loading and shares the browser wait with Settings across reopening',
    async () => {
      const account = accountPort(SIGNED_OUT_ACCOUNT, {
        load: vi
          .fn()
          .mockRejectedValueOnce(new Error('Disconnected'))
          .mockResolvedValue(SIGNED_OUT_ACCOUNT),
      });
      const base = appDependencies();
      render(
        <Providers>
          <App
            dependencies={appDependencies({ settings: { ...base.settings, accountApi: account } })}
          />
        </Providers>,
      );
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Retry' }));
      await user.click(await screen.findByRole('button', { name: 'Sign in' }));
      await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
      await screen.findByText('Finish signing in to StashBase in your browser.');
      // Leaving the dialog leaves the browser wait running for the window.
      await user.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await user.click(screen.getByRole('button', { name: 'Settings' }));
      await user.click(await screen.findByRole('button', { name: 'Account' }, LAZY));
      let dialog = within(screen.getByRole('dialog', { name: 'Settings' }));
      expect(dialog.getByText('Finish signing in to StashBase in your browser.')).not.toBeNull();
      expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Sign in' }).disabled).toBe(
        true,
      );
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await user.click(screen.getByRole('button', { name: 'Settings' }));
      dialog = within(await screen.findByRole('dialog', { name: 'Settings' }));
      await user.click(dialog.getByRole('button', { name: 'Account' }));
      await user.click(await dialog.findByRole('button', { name: 'Stop waiting' }));
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' }).disabled).toBe(
        false,
      );
      expect(account.startSignIn).toHaveBeenCalledOnce();
    },
    LAZY_TEST_MS,
  );

  it('refreshes credits on menu open and does not present stale credit after a refresh failure', async () => {
    let fail = false;
    let remainingPercent = 78;
    const getAllowance = vi.fn(async () => {
      if (fail) throw new Error('Offline');
      return { ...IDLE_ALLOWANCE, remainingPercent, reservedPercent: 25 };
    });
    const base = appDependencies();
    render(
      <Providers>
        <App
          dependencies={appDependencies({
            settings: {
              ...base.settings,
              accountApi: accountPort(SIGNED_IN_ACCOUNT),
              agentRuntimeApi: agentRuntimePort({ getAllowance }),
            },
          })}
        />
      </Providers>,
    );
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Account: Ada Lovelace' });
    await waitFor(() => expect(getAllowance).toHaveBeenCalled());
    remainingPercent = 15;
    await user.click(trigger);
    expect(await screen.findByText('15%')).not.toBeNull();
    expect(screen.queryByText('78%')).toBeNull();
    expect(screen.getByText('25% temporarily reserved')).not.toBeNull();
    await user.keyboard('{Escape}');
    fail = true;
    await user.click(trigger);
    expect(await screen.findByText('Unavailable')).not.toBeNull();
    expect(screen.queryByText('15%')).toBeNull();
  });

  it('names the signed-in person and offers credits, plans, and sign-out from a menu', async () => {
    const account = accountPort(SIGNED_IN_ACCOUNT);
    const base = appDependencies();
    render(
      <Providers>
        <App
          dependencies={appDependencies({
            settings: { ...base.settings, accountApi: account },
          })}
        />
      </Providers>,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Account: Ada Lovelace' }));
    let menu = await screen.findByRole('menu');
    // The menu opens with the person as the initials disc — never a
    // provider picture — beside the name and email.
    expect(within(menu).getByText('AL')).not.toBeNull();
    expect(within(menu).getByText('ada@example.com')).not.toBeNull();
    expect(within(menu).getByText('Agent credits')).not.toBeNull();
    expect(await within(menu).findByText('100%')).not.toBeNull();
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(4);
    expect(within(menu).getByRole('menuitem', { name: 'Settings' })).not.toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).not.toBeNull();

    await user.click(within(menu).getByRole('menuitem', { name: 'Sign-in methods' }));
    const accountSettings = within(await screen.findByRole('dialog', { name: 'Settings' }));
    await accountSettings.findByRole('button', { name: 'Disconnect Google' });
    expect(screen.queryByRole('dialog', { name: 'Sign-in methods' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Account: Ada Lovelace' }));
    menu = await screen.findByRole('menu');

    // Plans and billing lands on the subscription, beside the credits.
    await user.click(within(menu).getByRole('menuitem', { name: 'Plans and billing' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Settings' }));
    expect(await dialog.findByText('Free · Credits refresh each month.')).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Account: Ada Lovelace' }));
    await user.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Sign out' }),
    );
    await waitFor(() => expect(account.signOut).toHaveBeenCalledOnce());
    expect(await screen.findByRole('button', { name: 'Sign in' })).not.toBeNull();
  });
});

describe('account banners', () => {
  it('offers sign-in while signed out and remembers Not now', async () => {
    const account = accountPort({ ...SIGNED_OUT_ACCOUNT, offers: ['sign-in'] });
    const base = appDependencies();
    render(
      <Providers>
        <App
          dependencies={appDependencies({ settings: { ...base.settings, accountApi: account } })}
        />
      </Providers>,
    );
    const user = userEvent.setup();

    expect(await screen.findByText('Sign in for free agent credits every month.')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(account.markOfferSeen).toHaveBeenCalledWith('sign-in', expect.anything()),
    );
    expect(screen.queryByText('Sign in for free agent credits every month.')).toBeNull();
  });
});

describe('titlebar band', () => {
  it(
    'steps the document history, or the open Chats while Chats shows, and starts a draft from the New tab',
    async () => {
      const files = filesApi({
        createEntry: vi.fn(async (_folder, _kind, parent, name) => ({
          path: parent ? `${parent}/${name}` : name,
        })),
      });
      const adapters = workspaceAdapters({ files });
      render(
        <Providers>
          <App
            dependencies={appDependencies({
              documents: documentsApi({
                adapters: documentAdapters({
                  asset: assetApi({
                    load: vi.fn(async () => ({
                      kind: 'source' as const,
                      url: 'data:text/html,',
                      version: 'v1',
                    })),
                  }),
                }),
              }),
              workspace: { adapters, revealLabel: 'Show in file manager' },
            })}
          />
        </Providers>,
      );

      // The strip's plus, the way into a New tab and from there a draft, sits
      // on the card's title row rather than in the sidebar band: a draft is a
      // document, and the card is where documents show.
      const plus = await screen.findByRole('button', { name: 'New tab' });
      expect(plus.closest('header')).not.toBeNull(); // dom-contract: the title row is the window's one header
      const back = await screen.findByRole<HTMLButtonElement>('button', { name: 'Back' });
      expect(back.disabled).toBe(true);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Forward' }).disabled).toBe(
        true,
      );
      expect(screen.queryByRole('button', { name: 'Previous chat' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Next chat' })).toBeNull();

      // In Chats mode the band's slot steps the open Chats instead, and the
      // Documents strip leaves the column with its mode.
      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: 'Search' }));
      await user.click(screen.getByRole('tab', { name: 'Chats' }));
      expect(await screen.findByRole('button', { name: 'Previous chat' })).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Next chat' })).not.toBeNull();
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
      expect(screen.queryByRole('tab', { name: 'Files' })).toBeNull();
      // The strip leaves the title row with the documents, plus and all.
      await waitFor(
        () => expect(screen.queryByRole('button', { name: 'New tab' })).toBeNull(),
        LAZY,
      );
      // Documents comes back to the panel it left on, Search, not to Files.
      await user.click(screen.getByRole('tab', { name: 'Documents' }));
      expect(await screen.findByRole('button', { name: 'Back' })).not.toBeNull();
      expect(screen.getByRole('tab', { name: 'Search' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      await user.click(screen.getByRole('tab', { name: 'Files' }));

      // Collapsing the sidebar leaves the strip's plus where it was, and hands
      // the one pair of history arrows to the titlebar rather than doubling
      // them.
      const plusAgain = await screen.findByRole('button', { name: 'New tab' });
      await user.click(screen.getByRole('button', { name: 'Hide files sidebar' }));
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1));
      expect(screen.getByRole('button', { name: 'New tab' })).toBe(plusAgain);

      // The plus seats the New tab, selected, with its page in the document
      // slot. Create text note makes Untitled.md at the root while nothing is
      // selected and opens it at once as a kept tab, which takes the New tab
      // away.
      await user.click(plusAgain);
      expect(screen.getByRole('tab', { name: 'New tab' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      await user.click(screen.getByRole('button', { name: 'Create text note' }));
      expect(await screen.findByRole('tab', { name: 'Untitled.md' }, LAZY)).not.toBeNull();
      await screen.findByRole('textbox', { name: 'Markdown editor' }, LAZY);
      expect(screen.queryByRole('tab', { name: 'New tab' })).toBeNull();
      expect(files.createEntry).toHaveBeenCalledWith(
        expect.any(String),
        'file',
        '',
        'Untitled.md',
        expect.any(AbortSignal),
      );
      await user.click(screen.getByRole('button', { name: 'New tab' }));
      await user.click(screen.getByRole('button', { name: 'Create interactive note' }));
      expect(await screen.findByRole('tab', { name: 'index.html' }, LAZY)).not.toBeNull();
      await screen.findByTitle('index.html HTML preview', {}, LAZY);
      expect(screen.queryByRole('tab', { name: 'New tab' })).toBeNull();
      expect(files.createInteractiveNote).toHaveBeenCalledWith(
        expect.any(String),
        '',
        expect.any(AbortSignal),
      );
    },
    LAZY_TEST_MS,
  );
});
