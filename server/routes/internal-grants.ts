import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeHtml } from '../html.ts';
import { sendError } from '../http.ts';
import { currentWindowId } from '../folder.ts';

interface Grant {
  windowId: string;
  filePath: string;
}

const serverPreviewGrants = new Map<string, Grant>();

export function getGrant(grantId: string): Grant | undefined {
  return serverPreviewGrants.get(grantId);
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function mountInternalGrantsRoute(
  app: express.Express,
  token: string,
): void {
  // Register a grant
  app.post('/api/internal/grants', (req, res) => {
    if (!tokenMatches(req.header('x-stashbase-shutdown-token'), token)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const { grantId, windowId, filePath } = req.body;
    if (typeof grantId !== 'string' || typeof windowId !== 'string' || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'invalid payload' });
    }
    serverPreviewGrants.set(grantId, { windowId, filePath });
    res.json({ ok: true });
  });

  // Revoke a grant
  app.delete('/api/internal/grants/:grantId', (req, res) => {
    if (!tokenMatches(req.header('x-stashbase-shutdown-token'), token)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    serverPreviewGrants.delete(req.params.grantId);
    res.json({ ok: true });
  });

  // Get external file text content
  app.get('/api/grant/:grantId/text', (req, res) => {
    const grant = getGrant(req.params.grantId);
    if (!grant) return res.status(404).end();

    const reqWindowId = currentWindowId();
    if (grant.windowId !== reqWindowId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    try {
      const content = fs.readFileSync(grant.filePath, 'utf8');
      res.json({ content });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Serve transient file assets
  app.get('/asset-preview-grant/:grantId', (req, res) => {
    const grant = getGrant(req.params.grantId);
    if (!grant) return res.status(404).end();

    const reqWindowId = currentWindowId();
    if (grant.windowId !== reqWindowId) {
      return res.status(403).end();
    }

    const abs = grant.filePath;
    const ext = path.extname(abs).toLowerCase();

    if (ext === '.html' || ext === '.htm') {
      try {
        const raw = fs.readFileSync(abs, 'utf8');
        const { preparedHtml } = analyzeHtml(raw);
        res.type('text/html').send(preparedHtml);
      } catch (err: unknown) {
        sendError(res, err);
      }
      return;
    }

    res.sendFile(abs);
  });
}
