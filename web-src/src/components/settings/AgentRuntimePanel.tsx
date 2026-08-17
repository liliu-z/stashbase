import { type ComponentProps, useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type Agent,
  type AgentDiscoveryPolicy,
  type AgentRuntimeDebugState,
  type AgentSetupFailureSimulation,
  type AgentsResponse,
} from '../../api';
import { AGENT_META, AGENTS, type AgentKind } from '../../agentCatalog';
import { ChevronDownIcon, MoreHorizontalIcon } from '../../icons';
import { useApp } from '../../store/AppContext';
import { Button } from '../ui/button';
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuPortal,
  MenuPositioner,
  MenuTrigger,
} from '../ui/menu';
import { Select } from '../ui/select';
import { StatusMessage } from '../ui/status';

const DEFAULT_DEBUG: AgentRuntimeDebugState = {
  enabled: false,
  discoveryPolicy: 'auto',
  nextFailure: 'none',
};

export function AgentRuntimePanel() {
  const { actions, dispatch } = useApp();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [debug, setDebug] = useState<AgentRuntimeDebugState>(DEFAULT_DEBUG);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const activeInstall = useMemo(
    () => agents.some((agent) => (
      agent.bootstrap?.phase === 'installing'
      || agent.bootstrap?.phase === 'authenticating'
      || agent.bootstrap?.phase === 'configuring'
    )),
    [agents],
  );

  const applyResponse = useCallback((response: AgentsResponse) => {
    setAgents(response.clis);
    setDebug(response.debug ?? DEFAULT_DEBUG);
    dispatch({ type: 'AGENTS_LOADED', agents: response.clis });
  }, [dispatch]);

  const refresh = useCallback(async (silent = false) => {
    try {
      applyResponse(await api.listAgents());
    } catch (error) {
      if (!silent) setStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }, [applyResponse]);

  useEffect(() => { void refresh(true); }, [refresh]);
  useEffect(() => {
    if (!activeInstall) return;
    const timer = window.setInterval(() => { void refresh(true); }, 500);
    return () => window.clearInterval(timer);
  }, [activeInstall, refresh]);

  async function install(agent: AgentKind) {
    setBusy(`install:${agent}`);
    setStatus(null);
    try {
      applyResponse(await api.prepareAgent(agent, 'bootstrap'));
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function login(agent: AgentKind) {
    if (agent !== 'codex') return;
    setBusy(`login:${agent}`);
    setStatus(null);
    try {
      applyResponse(await api.prepareAgent(agent, 'login'));
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function uninstall(agent: AgentKind) {
    const label = AGENT_META[agent].name;
    const confirmed = await actions.confirm(
      `Uninstall the StashBase-managed ${label} runtime to free disk space? Any active ${label} chat ends now. Your provider login and history are not affected; the next New Chat prepares the runtime again.`,
      { title: `Uninstall ${label} runtime?`, confirmLabel: 'Uninstall', destructive: true },
    );
    if (!confirmed) return;
    setBusy(`uninstall:${agent}`);
    setStatus(null);
    try {
      applyResponse(await api.resetManagedAgent(agent));
      setStatus({ tone: 'success', text: `${label} managed runtime removed.` });
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function updateDebug(patch: Partial<Omit<AgentRuntimeDebugState, 'enabled'>>) {
    setBusy('debug');
    setStatus(null);
    try {
      applyResponse(await api.setAgentRuntimeDebug(patch));
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function resetFirstRun(agent: AgentKind) {
    const label = AGENT_META[agent].name;
    const confirmed = await actions.confirm(
      `Reset the StashBase-managed ${label} runtime? Your global installation and provider login are not changed.`,
      { title: `Reset ${label} runtime?`, confirmLabel: 'Reset', destructive: true },
    );
    if (!confirmed) return;
    setBusy(`reset:${agent}`);
    setStatus(null);
    try {
      applyResponse(await api.setAgentRuntimeDebug({ discoveryPolicy: 'managed-only' }));
      applyResponse(await api.resetManagedAgent(agent));
      setStatus({ tone: 'success', text: `${label} now simulates a first-time user. Click New Chat to test installation, then return discovery to Auto when finished.` });
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-1 text-base font-semibold">Agent runtimes</div>
      <div className="mb-2.5 text-sm leading-normal text-muted-foreground">
        StashBase uses an existing system Agent when available, or installs an official runtime privately on first New Chat.
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        {AGENTS.map((definition) => {
          const runtime = agents.find((candidate) => candidate.id === definition.id);
          const phase = runtime?.bootstrap?.phase;
          const working = phase === 'installing' || phase === 'authenticating' || phase === 'configuring';
          const description = runtimeDescription(runtime);
          const action = runtimeAction(runtime, working);
          const Icon = definition.Icon;
          return (
            <div key={definition.id} className="flex items-center gap-3 border-t border-border px-3 py-2.5 first:border-t-0">
              <span className="inline-grid size-7 flex-none place-items-center rounded-md border border-border bg-pane [&_svg]:size-4"><Icon /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-semibold text-foreground">{definition.launcherLabel}</span>
                <span className="block truncate text-xs text-muted-foreground">{description}</span>
              </span>
              {action && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy != null || working}
                  onClick={() => void (action.kind === 'login' ? login(definition.id) : install(definition.id))}
                >
                  {action.label}
                </Button>
              )}
              {/* Uninstall applies only to the StashBase-managed install —
                * a system runtime is the user's own and is never removed. */}
              {runtime?.installed && runtime.source === 'managed' && !working && (
                <Menu>
                  <MenuTrigger
                    className="inline-grid size-7 flex-none cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
                    disabled={busy != null}
                    aria-label={`More actions for ${definition.launcherLabel}`}
                    title="More actions"
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </MenuTrigger>
                  <MenuPortal>
                    <MenuPositioner side="bottom" align="end" sideOffset={4} collisionPadding={8}>
                      <MenuPopup aria-label={`${definition.launcherLabel} actions`}>
                        <MenuItem
                          className="text-danger data-highlighted:bg-destructive/10"
                          onClick={() => void uninstall(definition.id)}
                        >
                          Uninstall runtime…
                        </MenuItem>
                      </MenuPopup>
                    </MenuPositioner>
                  </MenuPortal>
                </Menu>
              )}
            </div>
          );
        })}
      </div>

      {debug.enabled && (
        <section className="mt-5 rounded-lg border border-status-warning/30 bg-status-warning/10 p-3">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <div className="text-base font-semibold">Agent bootstrap testing</div>
            <span className="rounded-xs border border-status-warning/30 bg-background px-1.5 py-0.5 text-2xs font-semibold tracking-wide text-status-warning uppercase">
              Development only
            </span>
          </div>
          <p className="mt-0 mb-3 text-sm leading-normal text-muted-foreground">
            These development-only controls change discovery inside StashBase. They never uninstall a global Agent or clear provider credentials.
          </p>
          <label className="flex items-center justify-between gap-3 text-sm text-foreground">
            <span>Discovery source</span>
            <AgentDebugSelect
              value={debug.discoveryPolicy}
              disabled={busy != null}
              onChange={(event) => void updateDebug({ discoveryPolicy: event.target.value as AgentDiscoveryPolicy })}
            >
              <option value="auto">Auto</option>
              <option value="managed-only">Managed only</option>
              <option value="system-only">System only</option>
            </AgentDebugSelect>
          </label>
          <label className="mt-3 flex items-center justify-between gap-3 text-sm text-foreground">
            <span>Next setup result</span>
            <AgentDebugSelect
              value={debug.nextFailure}
              disabled={busy != null}
              onChange={(event) => void updateDebug({ nextFailure: event.target.value as AgentSetupFailureSimulation })}
            >
              <option value="none">Normal</option>
              <option value="installation">Fail installation</option>
              <option value="mcp">Fail MCP connection</option>
            </AgentDebugSelect>
          </label>
          <p className="mt-2 mb-0 text-xs leading-normal text-muted-foreground">
            The failure is injected once, then resets to Normal. Installation failure applies only when setup reaches an install; reset first run to test it with an existing runtime.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy != null} onClick={() => void resetFirstRun('codex')}>
              Reset Codex first run
            </Button>
            <Button variant="outline" size="sm" disabled={busy != null} onClick={() => void resetFirstRun('claude')}>
              Reset Claude first run
            </Button>
          </div>
        </section>
      )}

      {status && (
        <StatusMessage tone={status.tone} className="mt-3 wrap-anywhere">{status.text}</StatusMessage>
      )}
    </div>
  );
}

/** The dev panel's wide selects use an explicit caret so its inset can match
 * the roomy testing surface without changing compact selects elsewhere. */
function AgentDebugSelect(props: ComponentProps<typeof Select>) {
  return (
    <span className="relative min-w-44">
      <Select {...props} className="w-full appearance-none pr-10" />
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-4 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}

/** MCP setup is automatic (startup auto-connect, repeated before native
 * attach), so the healthy states carry no button at all. An affordance
 * appears only when the user must act: nothing is installed or a bootstrap
 * explicitly failed. */
function runtimeAction(runtime: Agent | undefined, working: boolean): { label: string; kind: 'prepare' | 'login' } | null {
  if (working) return { label: 'Preparing…', kind: 'prepare' };
  if (!runtime) return null;
  if (runtime.bootstrap?.phase === 'failed') {
    if (runtime.bootstrap.failure?.stage === 'authentication') return { label: 'Sign in', kind: 'login' };
    return { label: runtime.bootstrap.failure?.stage === 'mcp' ? 'Retry connection' : 'Retry', kind: 'prepare' };
  }
  if (!runtime.installed) return { label: 'Install', kind: 'prepare' };
  return null;
}

function runtimeDescription(runtime: Agent | undefined): string {
  if (!runtime) return 'Checking…';
  const bootstrap = runtime.bootstrap;
  if (bootstrap?.phase === 'failed') return bootstrap.failure?.message ?? 'Setup failed';
  if (bootstrap?.phase === 'installing' || bootstrap?.phase === 'authenticating' || bootstrap?.phase === 'configuring') return bootstrap.message ?? 'Preparing…';
  if (!runtime.installed) return 'Not installed';
  const source = runtime.source === 'managed' ? 'StashBase-managed runtime' : 'System runtime';
  return bootstrap?.phase === 'ready' ? `Ready for Chat · ${source}` : source;
}
