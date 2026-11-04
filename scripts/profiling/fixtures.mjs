// Deterministic test projects. Regenerated on every run so results never
// depend on what an earlier run saved.

import fs from "node:fs";
import path from "node:path";

function writeNotes(projectDirectory, { topics, notesPerTopic }) {
  for (let topic = 0; topic < topics; topic++) {
    const directory = path.join(projectDirectory, "notes", `topic-${topic}`);
    fs.mkdirSync(directory, { recursive: true });
    for (let note = 0; note < notesPerTopic; note++) {
      fs.writeFileSync(
        path.join(directory, `note-${note}.md`),
        `# Note ${topic}-${note}\n\nSome body text for note ${note}.\n`,
      );
    }
  }
}

// About 124 KB: 2,305 editor paragraphs in sections of a heading, a prose
// paragraph with inline marks, and a three-item `-` list.
function longMarkdownDocument(targetBytes) {
  const blocks = [];
  for (let section = 1; blocks.join("\n\n").length < targetBytes; section++) {
    blocks.push(
      `## Section ${section}`,
      `Some **bold** prose with a [link](https://example.com/${section}) and \`code\` that keeps going for a while so the paragraph is realistic in length, more words here.`,
      `- item one ${section}\n- item two\n- item three`,
    );
  }
  return `# Big document\n\n${blocks.join("\n\n")}\n`;
}

/** 300 short notes plus one long Markdown document, `big.md`. */
export function writeEditingProject(projectDirectory) {
  fs.rmSync(projectDirectory, { recursive: true, force: true });
  fs.mkdirSync(projectDirectory, { recursive: true });
  writeNotes(projectDirectory, { topics: 10, notesPerTopic: 30 });
  const documentPath = path.join(projectDirectory, "big.md");
  const original = longMarkdownDocument(120 * 1024);
  fs.writeFileSync(documentPath, original);
  return { documentName: "big.md", documentPath, original, markdownFiles: 301 };
}

// Text near the top of each budget document. The runner treats a file as open
// once its marker is on screen, whichever editor renders it.
export const BUDGET_MARKERS = {
  small: "Small file marker sentence.",
  big: "Big file marker sentence.",
};

// Every budget fixture file carries this modification time, so rewriting the
// project between runs leaves it exactly as the primed index last saw it and
// starts no resync during the measurements.
const BUDGET_FILE_TIME = new Date("2026-01-01T00:00:00Z");

/** 1,000 notes in 20 folders, a 120 KB Markdown file and a 3-line one. */
export function writeBudgetProject(projectDirectory) {
  fs.rmSync(projectDirectory, { recursive: true, force: true });
  fs.mkdirSync(projectDirectory, { recursive: true });
  for (let folder = 1; folder <= 20; folder++) {
    const directory = path.join(projectDirectory, `folder-${String(folder).padStart(2, "0")}`);
    fs.mkdirSync(directory);
    for (let note = 1; note <= 50; note++) {
      fs.writeFileSync(path.join(directory, `note-${note}.md`), `# Note ${folder}-${note}\n\nSome body text for note ${note}.\n`);
    }
  }
  fs.writeFileSync(path.join(projectDirectory, "small.md"), `# Small\n\n${BUDGET_MARKERS.small}\n`);
  const big = longMarkdownDocument(120 * 1024).replace("# Big document\n\n", `# Big document\n\n${BUDGET_MARKERS.big}\n\n`);
  fs.writeFileSync(path.join(projectDirectory, "big.md"), big);
  for (const entry of fs.readdirSync(projectDirectory, { recursive: true })) {
    fs.utimesSync(path.join(projectDirectory, entry), BUDGET_FILE_TIME, BUDGET_FILE_TIME);
  }
  return { small: "small.md", big: "big.md", folders: 20, markdownFiles: 1002 };
}
