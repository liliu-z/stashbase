/**
 * One account per window.
 *
 * `useAccount` keeps the open browser flow in local state, so every caller
 * that runs it holds a different sign-in: a flow started from one surface is
 * invisible to the others, and two of them can be open at once. The surfaces
 * that offer sign-in are spread across the window — the sidebar's footer row,
 * the composer's runtime picker, Settings' Agents section — and they are all
 * talking about the same account, so the hook runs once here and they read
 * what it publishes.
 */
'use client';

import { createContext, useContext, type ReactNode } from 'react';

import type { AccountPort } from '@/features/settings/application/ports';
import { useAccount, type AccountViewModel } from '@/features/settings/hooks/use-account';

const AccountContext = createContext<AccountViewModel | null>(null);

export function AccountProvider({
  children,
  openExternal,
  port,
}: {
  children: ReactNode;
  openExternal: (href: string) => Promise<boolean> | void;
  port: AccountPort;
}) {
  const account = useAccount(port, openExternal);
  return <AccountContext value={account}>{children}</AccountContext>;
}

/** The window's account. Throws rather than falling back, because a surface
 *  that offers sign-in outside the provider would start a flow nothing else
 *  can see — the failure this context exists to prevent. */
export function useAccountView(): AccountViewModel {
  const account = useContext(AccountContext);
  if (account === null) {
    throw new Error('useAccountView requires an AccountProvider above it');
  }
  return account;
}
