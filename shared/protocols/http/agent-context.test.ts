import assert from "node:assert/strict";
import test from "node:test";

import {
  agentAttachResponseSchema,
  agentContextFileResponseSchema,
} from "./agent-context.ts";

const direct = {
  available: true,
  folder: "research",
  kind: "direct",
  path: "/project/research/notes.md",
  reason: "Structured text files are the readable source.",
  sourceFormat: "md",
  sourcePath: "notes.md",
};

test("context file accepts direct and derived answers", () => {
  assert.equal(agentContextFileResponseSchema.parse(direct).kind, "direct");
  const derived = agentContextFileResponseSchema.parse({
    ...direct,
    available: false,
    kind: "derived",
    path: "/project/research/paper.pdf",
    reason: "Searchable text is pending.",
    sourceFormat: "pdf",
    sourcePath: "paper.pdf",
  });
  assert.equal(derived.kind, "derived");
  assert.equal(derived.available, false);
});

test("context file rejects an unknown kind", () => {
  assert.equal(
    agentContextFileResponseSchema.safeParse({ ...direct, kind: "remote" })
      .success,
    false,
  );
});

test("attach response accepts mixed outcomes and rejects extra fields", () => {
  const parsed = agentAttachResponseSchema.parse({
    files: [
      { name: "shot.png", path: "/tmp/stashbase-attachments/1/shot.png" },
      { error: "write failed", name: "big.bin" },
    ],
  });
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[1]?.error, "write failed");
  assert.equal(
    agentAttachResponseSchema.safeParse({
      files: [{ name: "a", path: "/a", size: 1 }],
    }).success,
    false,
  );
});
