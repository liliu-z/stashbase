import type {
  AccountOffer,
  HostedAccount,
  HostedSignIn,
  HostedSignInStatus,
} from '@/features/settings/domain/account';
import type {
  AgentAllowance,
  AgentCatalog,
  AgentDebugPatch,
} from '@/features/settings/domain/agent-catalog';
import type {
  AppearanceChange,
  AppearancePreferences,
  SystemFont,
} from '@/features/settings/domain/appearance';
import type { BillingChange, BillingPlan, BillingStatus } from '@/features/settings/domain/billing';
import type { LocalComponentStatus } from '@/features/settings/domain/local-component';
import type { McpAccess, McpHttpAccess } from '@/features/settings/domain/mcp-access';
import type { AgentId } from '@/shared/domain/agent-id';
import {
  featureErrorClass,
  type FeatureError,
  type FeatureFailureKind,
  type TransportFailureKind,
} from '@/shared/domain/feature-error';

export interface AgentRuntimePort {
  listAgents(signal: AbortSignal): Promise<AgentCatalog>;
  /** Starts a preparation step, or `stop`s waiting on one the reader started,
   *  such as a browser sign-in; the answer is the catalog that follows. */
  prepareAgent(
    id: AgentId,
    action: 'check' | 'bootstrap' | 'login' | 'stop' | 'update',
    signal: AbortSignal,
  ): Promise<AgentCatalog>;
  updateDebug(patch: AgentDebugPatch, signal: AbortSignal): Promise<AgentCatalog>;
  getAllowance(signal: AbortSignal): Promise<AgentAllowance>;
  /** The public plan catalog. */
  getBillingPlans(signal: AbortSignal): Promise<readonly BillingPlan[]>;
  getBillingStatus(signal: AbortSignal): Promise<BillingStatus>;
  changeBilling(input: BillingChange, signal: AbortSignal): Promise<void>;
  /** A Stripe Checkout page for this account and plan; promotion codes are
   *  entered there. */
  startCheckout(priceId: string, signal: AbortSignal): Promise<string>;
  /** The Stripe Customer Portal for an existing subscription. */
  openBillingPortal(signal: AbortSignal): Promise<string>;
}

export type AgentRuntimeFailureKind = TransportFailureKind;

export type AgentRuntimeError = FeatureError;
export const AgentRuntimeError = featureErrorClass('AgentRuntimeError');

/** Both calls resolve the full record, because the server's answer is what the
 *  window applies. */
export interface AppearancePort {
  load(signal: AbortSignal): Promise<AppearancePreferences>;
  update(change: AppearanceChange, signal: AbortSignal): Promise<AppearancePreferences>;
}

/** A setting owned by a registered project's local application identity, not
 * by its source files. The snake_case field mirrors config.json deliberately. */
export interface ProjectMathPort {
  load(scope: string, signal: AbortSignal): Promise<{ scope: string; math_mode: boolean }>;
  update(
    scope: string,
    mathMode: boolean,
    signal: AbortSignal,
  ): Promise<{ scope: string; math_mode: boolean }>;
}

/** What this computer offers the appearance settings: its installed fonts and
 *  the languages its spellchecker knows. Both stay on the device. */
export interface SystemTextPort {
  listFonts(): Promise<readonly SystemFont[]>;
  /** Empty where the system picks the language itself (macOS). */
  spellcheckLanguages(): Promise<readonly string[]>;
}

/** The StashBase account, which identifies the bundled Agent's free or subscribed credits. A
 *  sign-in is a browser round trip the server owns: the renderer starts it,
 *  hands the URL to the browser, and polls until the server says the flow
 *  finished. Sign-out answers with the signed-out account. */
export interface AccountPort {
  /** The provider's picture as bytes, or null when there is none to show.
   *  Optional throughout: a missing picture is an initials fallback, never a
   *  failure. */
  avatar(signal: AbortSignal): Promise<Blob | null>;
  load(signal: AbortSignal): Promise<HostedAccount>;
  /** Records a banner as taken up or declined; answers the account. */
  markOfferSeen(offer: AccountOffer, signal: AbortSignal): Promise<HostedAccount>;
  /** Development: shows every banner again; answers the account. */
  resetOffers(signal: AbortSignal): Promise<HostedAccount>;
  signInStatus(flowId: string, signal: AbortSignal): Promise<HostedSignInStatus>;
  signOut(signal: AbortSignal): Promise<HostedAccount>;
  startSignIn(signal: AbortSignal): Promise<HostedSignIn>;
  sendEmail(email: string, signal: AbortSignal): Promise<{ flowId: string }>;
  verifyEmail(flowId: string, otp: string, signal: AbortSignal): Promise<HostedAccount>;
  cancelEmail(flowId: string): Promise<void>;
  methods(signal: AbortSignal): Promise<{ email: string; google: boolean }>;
  /** Current mailbox proof; never creates or replaces a login session. */
  sendEmailProof(signal: AbortSignal): Promise<void>;
  verifyEmailProof(otp: string, signal: AbortSignal): Promise<void>;
  sendLinkCode(signal: AbortSignal): Promise<void>;
  linkGoogle(otp: string, signal: AbortSignal): Promise<{ ticket: string; url: string }>;
  unlinkGoogle(otp: string, signal: AbortSignal): Promise<void>;
  linkStatus(
    ticket: string,
    signal: AbortSignal,
  ): Promise<{ state: 'pending' | 'complete' | 'error' }>;
}

/** The MCP page reads access details and changes how they are reached; it
 *  never configures a third-party client. Each write answers with the listener
 *  state it produced, so the panel never has to guess what took effect. */
export interface McpAccessPort {
  status(signal: AbortSignal): Promise<McpAccess>;
  rotateToken(signal: AbortSignal): Promise<McpHttpAccess>;
  setDockerAccess(enabled: boolean, signal: AbortSignal): Promise<McpHttpAccess>;
  setDockerPort(port: number, signal: AbortSignal): Promise<McpHttpAccess>;
}

export type SettingsFailureKind = FeatureFailureKind<'invalid-request'>;

export type SettingsError = FeatureError<'invalid-request'>;
export const SettingsError = featureErrorClass<'invalid-request'>('SettingsError');
export const AccountAccessError = featureErrorClass<'invalid-request'>('AccountAccessError');

export interface LocalComponentPort {
  load(signal: AbortSignal): Promise<LocalComponentStatus>;
  retry(signal: AbortSignal): Promise<LocalComponentStatus>;
}
