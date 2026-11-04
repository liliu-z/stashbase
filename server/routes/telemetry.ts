import type express from 'express';
import { rendererTelemetryRequestSchema, telemetryPreferencesRequestSchema } from '../../shared/protocols/http/telemetry.ts';
import { telemetry } from '../telemetry.ts';
import { sendError } from '../http.ts';
import { writeDiagnostics } from '../write-diagnostics.ts';

export function mount(app: express.Express, service = telemetry): void {
  app.get('/api/telemetry', (_req, res) => {
    try { res.json(service.preferences()); } catch (error) { sendError(res, error); }
  });
  app.get('/api/telemetry/delivery', (_req, res) => {
    res.json({ delivery: service.delivery(), write_diagnostics: service.diagnosticAdmission?.() ? writeDiagnostics.health() : null });
  });
  app.put('/api/telemetry', (req, res) => {
    const parsed = telemetryPreferencesRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid telemetry preferences' });
    try { res.json(service.update(parsed.data)); } catch (error) { sendError(res, error); }
  });
  app.post('/api/telemetry/events', (req, res) => {
    const parsed = rendererTelemetryRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid telemetry event' });
    const status = service.captureRenderer(parsed.data);
    res.status(status === 'retry' ? 503 : 200).json({ status,
      ...(!service.rendererDeliveryCurrent(parsed.data) ? { reset_delivery: true } : {}),
    });
  });
}
