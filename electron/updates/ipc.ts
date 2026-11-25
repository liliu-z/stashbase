/**
 * The desktop update boundary in main: the projection from the update
 * machine's internal state into the snapshot a window may see, the authorized
 * channels that answer with it, and the push to live windows.
 *
 * Main's own state carries installer diagnostics and the development
 * simulation block, and several keys have the value `undefined`. None of that
 * crosses. The projection is
 * the only place that knowledge lives, so a state it cannot describe is
 * refused rather than sent, and main can never push a payload the renderer
 * would reject.
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

import {
  UPDATES_CAPABILITY,
  UPDATES_CHECK_CHANNEL,
  UPDATES_OPEN_RELEASE_PAGE_CHANNEL,
  UPDATES_PRIMARY_ACTION_CHANNEL,
  UPDATES_READ_CHANNEL,
  UPDATES_SET_AUTO_CHECK_CHANNEL,
  UPDATES_SET_SIMULATION_CHANNEL,
  UPDATES_SNAPSHOT_CHANNEL,
  UPDATE_PHASES,
  type UpdateFailureKind,
  type UpdateSimulationValue,
  type UpdatesResult,
  type UpdatesSnapshot,
  updatesSetAutoCheckRequestSchema,
  updatesSetSimulationRequestSchema,
  updatesSnapshotSchema,
} from '../../shared/protocols/electron/updates.ts';
import { authorizeSender, type SenderAuthorization } from '../project/dialog.ts';

export { UPDATES_CAPABILITY };

/** The part of `electron/update-manager.cjs` this boundary calls. The module
 *  is untyped CommonJS, so every answer arrives as an unprojected state. */
export interface UpdateManagerSurface {
  check(): Promise<unknown>;
  getState(): unknown;
  openDownloadPage(): Promise<unknown>;
  primaryAction(): Promise<unknown>;
  refreshPreference(options: { checkIfEnabled: boolean }): Promise<unknown>;
  setUpdateSimulation(value: UpdateSimulationValue): unknown;
}

export interface UpdatesDependencies extends SenderAuthorization {
  /** False in a packaged build, where the simulation channel is never
   *  registered and so has no handler to reach. */
  debugEnabled: boolean;
  onDiagnostic?(error: unknown, operation: string): void;
  ipcMain: Pick<IpcMain, 'handle'>;
  manager: UpdateManagerSurface;
  setAutoCheck(enabled: boolean): Promise<void>;
  windows(): Iterable<BrowserWindow>;
}

export interface UpdatesIpc {
  publish(state: unknown): void;
}

const version = z.string().trim().min(1).max(64);

/** Only the keys the projection reads. A plain object schema strips the rest,
 *  which is where installer diagnostics, simulation controls, and future
 *  unowned metadata stop. */
const managerStateSchema = z.object({
  autoCheckEnabled: z.boolean(),
  availableVersion: version.optional(),
  currentVersion: version,
  checkFailed: z.boolean().optional(),
  percent: z.number().finite().optional(),
  phase: z.enum(UPDATE_PHASES),
});

type ManagerState = z.infer<typeof managerStateSchema>;

function describePhase(state: ManagerState): UpdatesSnapshot | null {
  const shared = {
    autoCheckEnabled: state.autoCheckEnabled,
    currentVersion: state.currentVersion,
  };
  const availableVersion = state.availableVersion;
  switch (state.phase) {
    case 'unsupported':
    case 'store':
    case 'idle':
    case 'checking':
    case 'current':
    case 'error':
      return { ...shared, phase: state.phase };
    case 'ready':
      return availableVersion
        ? { ...shared, availableVersion, phase: 'ready', ...(state.checkFailed ? { checkFailed: true } : {}) }
        : null;
    case 'available':
    case 'installing':
      return availableVersion ? { ...shared, availableVersion, phase: state.phase } : null;
    case 'downloading':
      if (!availableVersion) return null;
      return {
        ...shared,
        availableVersion,
        phase: state.phase,
        ...(state.percent === undefined
          ? {}
          : { percent: Math.min(100, Math.max(0, Math.round(state.percent))) }),
      };
  }
}

function projectSnapshot(state: unknown): UpdatesSnapshot | null {
  const parsed = managerStateSchema.safeParse(state);
  if (!parsed.success) return null;
  const candidate = describePhase(parsed.data);
  if (!candidate) return null;
  const snapshot = updatesSnapshotSchema.safeParse(candidate);
  return snapshot.success ? snapshot.data : null;
}

/** A handler either produced a state to project or the reason it would not
 *  act. Nothing else can come back, so no channel throws across IPC. */
type HandlerOutcome = { kind: UpdateFailureKind } | { state: unknown };

const invalidRequest: HandlerOutcome = { kind: 'invalid-request' };

const refusal = (kind: UpdateFailureKind): UpdatesResult => ({ ok: false, failure: { kind } });

export function registerUpdatesIpc(dependencies: UpdatesDependencies): UpdatesIpc {
  const handle = (
    channel: string,
    body: (payload: unknown) => Promise<HandlerOutcome> | HandlerOutcome,
  ): void => {
    dependencies.ipcMain.handle(
      channel,
      async (event: IpcMainInvokeEvent, payload: unknown): Promise<UpdatesResult> => {
        if (!authorizeSender(event, dependencies, UPDATES_CAPABILITY)) {
          return refusal('unauthorized');
        }
        try {
          const outcome = await body(payload);
          if ('kind' in outcome) return refusal(outcome.kind);
          const snapshot = projectSnapshot(outcome.state);
          return snapshot ? { ok: true, snapshot } : refusal('failed');
        } catch (error) {
          try { dependencies.onDiagnostic?.(error, channel); } catch { /* Preserve IPC result. */ }
          return refusal('failed');
        }
      },
    );
  };

  const manager = dependencies.manager;

  handle(UPDATES_READ_CHANNEL, () => ({ state: manager.getState() }));
  handle(UPDATES_CHECK_CHANNEL, async () => ({ state: await manager.check() }));
  handle(UPDATES_PRIMARY_ACTION_CHANNEL, async () => ({ state: await manager.primaryAction() }));
  handle(UPDATES_OPEN_RELEASE_PAGE_CHANNEL, async () => {
    await manager.openDownloadPage();
    return { state: manager.getState() };
  });
  handle(UPDATES_SET_AUTO_CHECK_CHANNEL, async (payload) => {
    const request = updatesSetAutoCheckRequestSchema.safeParse(payload);
    if (!request.success) return invalidRequest;
    await dependencies.setAutoCheck(request.data.enabled);
    return { state: await manager.refreshPreference({ checkIfEnabled: true }) };
  });
  if (dependencies.debugEnabled) {
    handle(UPDATES_SET_SIMULATION_CHANNEL, async (payload) => {
      const request = updatesSetSimulationRequestSchema.safeParse(payload);
      if (!request.success) return invalidRequest;
      return { state: await manager.setUpdateSimulation(request.data.value) };
    });
  }

  return {
    publish(state: unknown) {
      const snapshot = projectSnapshot(state);
      if (!snapshot) return;
      for (const window of dependencies.windows()) {
        if (!dependencies.isLiveWindow(window)) continue;
        if (!dependencies.hasCapability(window, UPDATES_CAPABILITY)) continue;
        if (window.webContents.isDestroyed()) continue;
        window.webContents.send(UPDATES_SNAPSHOT_CHANNEL, snapshot);
      }
    },
  };
}
