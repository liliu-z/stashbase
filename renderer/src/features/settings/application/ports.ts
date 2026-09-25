import type {
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
} from '@/features/settings/domain/appearance';
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
  prepareAgent(
    id: AgentId,
    action: 'check' | 'bootstrap' | 'login' | 'update',
    signal: AbortSignal,
  ): Promise<AgentCatalog>;
  updateDebug(patch: AgentDebugPatch, signal: AbortSignal): Promise<AgentCatalog>;
  getAllowance(signal: AbortSignal): Promise<AgentAllowance>;
}

export type AgentRuntimeFailureKind = TransportFailureKind;

export type AgentRuntimeError = FeatureError;
export const AgentRuntimeError = featureErrorClass('AgentRuntimeError');

/** Both calls resolve the full triple, because the server's answer is what the
 *  window applies. */
export interface AppearancePort {
  load(signal: AbortSignal): Promise<AppearancePreferences>;
  update(change: AppearanceChange, signal: AbortSignal): Promise<AppearancePreferences>;
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
  signInStatus(flowId: string, signal: AbortSignal): Promise<HostedSignInStatus>;
  signOut(signal: AbortSignal): Promise<HostedAccount>;
  startSignIn(signal: AbortSignal): Promise<HostedSignIn>;
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

export interface LocalComponentPort {
  load(signal: AbortSignal): Promise<LocalComponentStatus>;
  retry(signal: AbortSignal): Promise<LocalComponentStatus>;
}
