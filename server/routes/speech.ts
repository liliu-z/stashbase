import type express from 'express';
import { z } from 'zod';
import {
  speechAudioSchema, speechFinishSchema, speechJobSchema, speechModelCommandSchema,
  speechModelStatusSchema, speechStartSchema,
} from '../../shared/protocols/http/speech.ts';
import { currentWindowId, getCurrentFolder } from '../folder.ts';
import { guardExplicitFolder, sendError } from '../http.ts';
import { speechModel, speechService } from '../speech/index.ts';

export function mount(app: express.Express, model = speechModel, service = speechService): void {
  app.get('/api/speech/model', async (_req, res) => {
    try { await model.initialize(); res.json(speechModelStatusSchema.parse(model.status())); }
    catch (error) { sendError(res, error); }
  });
  app.post('/api/speech/model', async (req, res) => {
    const parsed = speechModelCommandSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Choose Stop, Resume, or Retry.' }); return; }
    try { res.json(speechModelStatusSchema.parse(await model.command(parsed.data.action))); }
    catch (error) { sendError(res, error); }
  });
  app.post('/api/speech/jobs', async (req, res) => {
    const parsed = speechStartSchema.safeParse(req.body);
    if (!parsed.success || typeof req.query.folder !== 'string' || !req.query.folder) {
      res.status(400).json({ error: 'Choose a project conversation for voice typing.' }); return;
    }
    try {
      if (!(await guardExplicitFolder(req, res))) return;
      const folder = getCurrentFolder();
      if (!folder) { res.status(412).json({ error: 'Open a project before using voice typing.' }); return; }
      res.json(speechJobSchema.parse(await service.start(currentWindowId(), folder, parsed.data.conversation, parsed.data.id)));
    } catch (error) { sendError(res, error); }
  });
  const jobId = (req: express.Request, res: express.Response) => {
    const parsed = z.string().uuid().safeParse(req.params.id);
    if (parsed.success) return parsed.data;
    res.status(400).json({ error: 'That voice recording is invalid.' });
    return null;
  };
  app.get('/api/speech/jobs/:id', (req, res) => {
    const id = jobId(req, res);
    if (!id) return;
    try { res.json(speechJobSchema.parse(service.status(currentWindowId(), id))); }
    catch (error) { sendError(res, error); }
  });
  app.post('/api/speech/jobs/:id/audio', async (req, res) => {
    const id = jobId(req, res);
    if (!id) return;
    const parsed = speechAudioSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'The recording returned invalid audio.' }); return; }
    try { res.json(speechJobSchema.parse(await service.push(currentWindowId(), id, parsed.data.sequence, parsed.data.pcm))); }
    catch (error) { sendError(res, error); }
  });
  app.post('/api/speech/jobs/:id/finish', async (req, res) => {
    const id = jobId(req, res);
    if (!id) return;
    const parsed = speechFinishSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'The recording returned an invalid sequence.' }); return; }
    try { res.json(speechJobSchema.parse(await service.finish(currentWindowId(), id, parsed.data.sequence))); }
    catch (error) { sendError(res, error); }
  });
  app.post('/api/speech/jobs/:id/retry', async (req, res) => {
    const id = jobId(req, res);
    if (!id) return;
    if (!z.object({}).strict().safeParse(req.body ?? {}).success) { res.status(400).json({ error: 'No transcription options are accepted.' }); return; }
    try { res.json(speechJobSchema.parse(await service.retry(currentWindowId(), id))); }
    catch (error) { sendError(res, error); }
  });
  app.delete('/api/speech/jobs/:id', async (req, res) => {
    const id = jobId(req, res);
    if (!id) return;
    try { await service.cancel(currentWindowId(), id); res.json({ ok: true }); }
    catch (error) { sendError(res, error); }
  });
}
