/**
 * The signed-in StashBase account as the renderer reasons about it: who is
 * signed in, and how a browser sign-in ends.
 *
 * Signing in identifies the bundled Agent's free or subscribed credits. Search
 * by meaning runs on a key the reader brings, so no fact here says anything
 * about search, and no search surface reads the account.
 */

export interface HostedAccount {
  /** The server's own route for the provider's picture, or null when the
   *  provider gave none. The picture itself is fetched as bytes. */
  readonly avatarUrl: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly signedIn: boolean;
}

export interface HostedSignIn {
  readonly flowId: string;
  readonly url: string;
}

/** A browser sign-in ends exactly three ways, and only the failure carries a
 *  sentence, so the poll result cannot report an error without one. */
export type HostedSignInStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'complete' }
  | { readonly state: 'error'; readonly error: string };

/** What a row calls the signed-in person: the provider's display name, else
 *  the email, else a stable label so a missing profile never blanks the row. */
export function accountLabel(account: HostedAccount): string {
  return account.displayName ?? account.email ?? 'StashBase account';
}

/** The one letter that stands in for a picture the provider did not give. */
function accountInitial(account: HostedAccount): string {
  const first = (account.displayName ?? account.email ?? '').trim().charAt(0);
  return first ? first.toUpperCase() : '?';
}

/** Up to two letters for the avatar disc: the first letters of the display
 *  name's first two words, or the single initial the account offers. */
export function accountInitials(account: HostedAccount): string {
  const words = (account.displayName ?? '')
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  const first = words[0]?.charAt(0) ?? '';
  const second = words[1]?.charAt(0) ?? '';
  return first && second ? `${first}${second}`.toUpperCase() : accountInitial(account);
}
