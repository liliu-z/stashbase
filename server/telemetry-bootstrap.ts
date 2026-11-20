import fs from 'node:fs';
import path from 'node:path';
import { appDataRoot } from './local-data.ts';
import { usageIdentity, usageIdentitySchema, type UsageIdentity } from './telemetry-state.ts';

export const serverStartTelemetryRoot = () => path.join(appDataRoot(), 'server-start-telemetry');

/** Main cannot write the host's app-config. Publish an initial anonymous seed
 * separately; the host adopts it only while telemetry has never been initialized.
 * Later sign-in/opt-out/account transitions remain exclusively host-owned. */
export function initialUsageIdentity(directory = serverStartTelemetryRoot(), now = Date.now()): UsageIdentity | undefined {
  const file = path.join(directory, 'identity.json');
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) {
      const identity = usageIdentity({ enabled: true }, now);
      try { fs.writeFileSync(file, JSON.stringify(identity), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    return usageIdentitySchema.omit({ userId: true }).strict().parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch { return undefined; }
}

export function clearServerStartTelemetry(directory = serverStartTelemetryRoot()): void {
  try { fs.rmSync(directory, { recursive: true, force: true }); }
  catch { /* A failed analytics cleanup must not block privacy preferences. */ }
}
