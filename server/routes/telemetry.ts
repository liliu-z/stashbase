import type express from 'express';
import { rendererTelemetryEventSchema, telemetryPreferencesRequestSchema } from '../../shared/protocols/http/telemetry.ts';
import { telemetry } from '../telemetry.ts';
import { sendError } from '../http.ts';

export function mount(app: express.Express, service = telemetry): void {
  app.get('/api/telemetry', (_req, res) => {
    try { res.json(service.preferences()); } catch (error) { sendError(res, error); }
  });
  app.put('/api/telemetry', (req, res) => {
    const parsed = telemetryPreferencesRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid telemetry preferences' });
    try { res.json(service.update(parsed.data)); } catch (error) { sendError(res, error); }
  });
  app.post('/api/telemetry/events', (req, res) => {
    const parsed = rendererTelemetryEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid telemetry event' });
    service.capture(parsed.data);
    res.status(204).end();
  });
}
