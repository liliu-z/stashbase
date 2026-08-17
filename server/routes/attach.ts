/**
 * Composer attachments — files a user drags or picks into the chat panel
 * as transient context. Unlike `/api/upload` (which imports into the
 * active folder, where files are indexed + tree-visible + tracked by git),
 * these are written to a throwaway OS temp dir and referenced by absolute
 * path: the agent reads them via its Read tool, but they never land in
 * the user's library.
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeFilename } from '../files.ts';
import { errorMessage, logger } from '../log.ts';

const log = logger('routes/attach');

const upload = multer({
  storage: multer.memoryStorage(),
  // Browsers encode multipart filename parameters as UTF-8. Multer otherwise
  // inherits Busboy's legacy Latin-1 default for parameters without an
  // explicit charset, which corrupts CJK and other non-ASCII basenames.
  defParamCharset: 'utf8',
  limits: { fileSize: 64 * 1024 * 1024, files: 50 },
});

const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60_000;

/** Root for transient attachment files, outside any folder. */
export function attachRoot(): string {
  return path.join(os.tmpdir(), 'stashbase-attachments');
}

/** Create the shared transient root privately, and never follow a pre-existing
 * symlink at that location. */
function ensureAttachmentRoot(): string | null {
  const root = attachRoot();
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    fs.chmodSync(root, 0o700);
    return root;
  } catch {
    return null;
  }
}

/** Only files created by this route may be read back for a restored chat
 * preview. This deliberately rejects arbitrary local paths from a session
 * transcript. */
export function isTransientAttachmentPath(candidate: string): boolean {
  const root = path.resolve(attachRoot());
  const relative = path.relative(root, path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Resolve a preview target only after proving that its real filesystem path
 * remains inside the real attachment root. This blocks transcript-provided
 * paths that enter the temp tree through a symlink and point elsewhere. */
export function transientAttachmentPreviewPath(candidate: string): string | null {
  if (!isTransientAttachmentPath(candidate)) return null;
  try {
    const root = attachRoot();
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realCandidate);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null;
    return fs.statSync(realCandidate).isFile() ? realCandidate : null;
  } catch {
    return null;
  }
}

/** Relative renderer URL for a transient image. The route validates the path
 * again when it is fetched. */
export function transientAttachmentPreviewUrl(filePath: string): string {
  return `/api/agent/attachment-preview?path=${encodeURIComponent(filePath)}`;
}

export function safeAttachmentName(original: string): string {
  const raw = original && original.trim() ? original : 'file';
  const base = path.posix.basename(raw.replace(/\\/g, '/')) || 'file';
  const sanitized = sanitizeFilename(base)
    .replace(/[\x00-\x1f'"]/g, '-')
    .replace(/^\.*/, '')
    .trim();
  return sanitized || 'file';
}

export function cleanupStaleAttachments(root = attachRoot(), maxAgeMs = ATTACHMENT_MAX_AGE_MS, now = Date.now()): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(root, entry.name);
    try {
      const st = fs.statSync(abs);
      if (now - st.mtimeMs > maxAgeMs) fs.rmSync(abs, { recursive: true, force: true });
    } catch (err: unknown) {
      log.warn(`attach: cleanup ${entry.name} failed: ${errorMessage(err)}`);
    }
  }
}

export function uniqueAttachmentName(original: string, used: Set<string>): string {
  const safe = safeAttachmentName(original);
  let candidate = safe;
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${stem}-${i}${ext}`;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

export function mount(app: express.Express): void {
  app.post('/api/agent/attach', (req, res) => {
    upload.array('files', 50)(req, res, (err: unknown) => {
      if (err) {
        sendAttachError(res, err);
        return;
      }
      const files = (req.files as Express.Multer.File[]) ?? [];
      if (files.length === 0) { res.status(400).json({ error: 'no files' }); return; }
      const root = ensureAttachmentRoot();
      if (!root) { res.status(500).json({ error: 'could not secure attachment storage' }); return; }
      cleanupStaleAttachments(root);
      // One throwaway dir per batch so same-named files never collide.
      const dir = path.join(root, randomUUID());
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (err: unknown) {
        res.status(500).json({ error: errorMessage(err) });
        return;
      }
      const out: { name: string; path?: string; error?: string }[] = [];
      const usedNames = new Set<string>();
      for (const f of files) {
        const name = uniqueAttachmentName(f.originalname || 'file', usedNames);
        try {
          const abs = path.join(dir, name);
          fs.writeFileSync(abs, f.buffer, { mode: 0o600 });
          out.push({ name, path: abs });
        } catch (err: unknown) {
          log.warn(`attach: write ${name} failed: ${errorMessage(err)}`);
          out.push({ name, error: errorMessage(err) });
        }
      }
      if (out.every((entry) => entry.error)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      res.json({ files: out });
    });
  });

  app.get('/api/agent/attachment-preview', (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    const type = imageContentType(filePath);
    if (!type) {
      res.status(404).end();
      return;
    }
    const previewPath = transientAttachmentPreviewPath(filePath);
    if (!previewPath) {
      res.status(404).end();
      return;
    }
    res.type(type);
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(previewPath);
  });
}

function imageContentType(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case '.avif': return 'image/avif';
    case '.gif': return 'image/gif';
    case '.jpeg':
    case '.jpg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    default: return null;
  }
}

function sendAttachError(res: express.Response, err: unknown): void {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'file is too large to attach'
      : err.code === 'LIMIT_FILE_COUNT'
        ? 'too many files in one attachment batch'
        : err.message;
    res.status(status).json({ error: message, code: err.code });
    return;
  }
  res.status(400).json({ error: errorMessage(err) });
}
