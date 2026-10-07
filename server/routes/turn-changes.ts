/** The text a file held before an Agent turn, read when the reader reviews that
 * turn. `server/turn-changes.ts` owns the record and why it expires. The read leaves the record in place: reviewing is not
 * claiming, and the reader may open the same turn again. */
import type express from 'express';
import {
  turnChangeRequestSchema,
  turnChangeResponseSchema,
} from '../../shared/protocols/http/turn-changes.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { sendError } from '../http.ts';
import { requireProjectStatusFolder, routeError } from '../project-file-access.ts';
import { turnChangeBefore } from '../turn-changes.ts';

export function mount(app: express.Express): void {
  app.get('/api/turn-changes', async (req, res) => {
    const request = turnChangeRequestSchema.safeParse(req.query ?? {});
    if (!request.success) {
      res.status(400).json({ error: 'folder, turn and path are required' });
      return;
    }
    try {
      const folder = await requireProjectStatusFolder(request.data.folder);
      const { turn, path } = request.data;
      if (!filesystemPath.isAbsolute(path) || !filesystemPath.contains(folder, path)) {
        throw routeError('The file is not in this project.', 403, 'PROJECT_SCOPE_MISMATCH');
      }
      const recorded = turnChangeBefore(folder, turn, path);
      if (!recorded) {
        throw routeError('This turn is no longer available to review.', 404, 'TURN_CHANGE_EXPIRED');
      }
      res.json(turnChangeResponseSchema.parse({ folder, turnId: turn, path, ...recorded }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}
