import { z } from "zod";

const boundedText = (maximum: number) => z.string().max(maximum);

/** `GET /api/project/agent-context-file?path=<folder>/<relative>` — what an
 *  Agent should read for one project source: the source itself, or its
 *  current prepared text when the format is prepared. */
export const agentContextFileResponseSchema = z
  .object({
    available: z.boolean(),
    folder: boundedText(2_000),
    kind: z.enum(["direct", "derived"]),
    path: boundedText(16_384),
    reason: boundedText(4_096),
    sourceFormat: boundedText(64),
    sourcePath: boundedText(16_384),
  })
  .strict();

export const agentContextFileFailureSchema = z
  .object({
    code: z.string().trim().min(1).max(64).optional(),
    error: z.string().trim().min(1).max(500),
  })
  .passthrough();

const agentAttachOutcomeSchema = z
  .object({
    error: boundedText(4_096).optional(),
    name: boundedText(2_000),
    path: boundedText(16_384).optional(),
  })
  .strict();

/** `POST /api/agent/attach` — multipart files plus their explicit registered
 * project `folder`; transient uploads are written outside every project
 *  folder, answered in request order. */
export const agentAttachResponseSchema = z
  .object({ files: z.array(agentAttachOutcomeSchema).max(50) })
  .strict();
