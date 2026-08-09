# Use Cases

StashBase fits two common ways of working.

Some engineers and students already have a large collection of local material:
requirements, design docs, papers, course notes, scanned PDFs, meeting records,
and files produced by earlier Agents. They want an Agent to find and use that
material without uploading it again or explaining the same background in every
session.

Others start with a long-running Agent conversation. As they explore a design
or research problem, the discussion branches into alternatives and side
questions. They need a stable Canvas that shows the current design, confirmed
decisions, open alternatives, and unresolved questions, so they can explore a
branch without losing the main thread.

The journeys below describe the work users are trying to complete. Preparation,
semantic search, Canvas, and Agent access are supporting capabilities within
those journeys, not separate use cases.

## What Canvas Means

A Canvas is a normal Markdown document that holds the current shared state of
long-running work. The conversation can branch; the Canvas keeps the main line.
When the user confirms a conclusion, they can ask the Agent to write the
decision and its reasoning back into the document.

StashBase does not automatically detect or merge conversation branches. The
user decides what becomes part of the Canvas.

A slide deck outline is one practical form of Canvas. The user and Agent can
work out the audience, core message, slide order, and supporting evidence in
Markdown, then hand the settled outline to a presentation tool. StashBase
organizes the source material and narrative; it is not the slide editor.

> Chat is for exploring. Canvas is for converging.

The workspace follows that progression without asking the user to choose a
mode. A folder opens with Chat as the primary surface and the file list still
visible. Opening a source or creating the Canvas reveals the document beside
the same conversation; closing the last document lets Chat expand again.

## 1. Take an Engineering Project from Requirements to Delivery

A freelance developer or engineering team may start with a contract, statement
of work, PRD, acceptance criteria, technical specifications, and an existing
codebase. The requirements are often spread across several long documents, so
it is easy to miss a constraint or forget why an earlier decision was made.

```text
Requirements
  → find relevant specifications and project history
  → compare technical options
  → converge on a design in Canvas
  → implement with a coding Agent
  → check the delivery against the original requirements
```

The engineer adds the project folder to StashBase and asks the Agent to turn
the contract or PRD into a checklist. Semantic search helps the Agent find
related specifications, meeting notes, ADRs, and previous design decisions
even when the wording is different.

During technical research, the Agent can compare candidate frameworks,
benchmarks, papers, or architecture proposals. The discussion may branch as
new trade-offs appear. A design document serves as the Canvas: it keeps the
current design, accepted decisions, alternatives still under consideration,
and open questions. Once the engineer chooses an option, the Agent writes the
decision and reasoning back into that document.

The same project material is then available to Claude Code, Codex, or another
connected Agent. Before delivery, the Agent can compare the implementation and
supporting documents with the original checklist, marking items as satisfied,
missing, or still unclear. The engineer remains responsible for the final
review.

The result is one continuous workflow from requirements to implementation.
Research, design, code, and delivery checks stay connected through ordinary
local files rather than being scattered across unrelated chat sessions. The
same material can also become the outline for an architecture review or client
presentation before the slides are produced elsewhere.

**Related areas:** [Local File Workspace](design/library.md),
[Search and Retrieval](design/search.md), [Markdown](design/markdown.md),
[Agent Panel](design/agent-panel.md)

## 2. Complete a Course or Research Project

A student may begin with an assignment brief, grading rubric, course slides,
textbooks, papers, lecture recordings, experiment notes, and an early project
idea. Some of the material is difficult to search, and the final report must
still match the original requirements.

```text
Assignment or research question
  → search papers, course material, and recordings
  → compare methods and evidence
  → keep the research plan in Canvas
  → run experiments and record progress
  → write the report
  → check it against the rubric
```

StashBase makes long PDFs and scanned material searchable, extracts text from
images, and turns audio or video into timestamped transcripts. The student can
find where a lecturer explained a concept, compare methods across several
papers, or ask the Agent to produce a reading note that links back to the
source material.

As the project develops, a Markdown document becomes the Canvas for the current
research question, chosen approach, experiment plan, confirmed findings, and
open questions. The student and Agent can explore alternatives in conversation,
then write only the conclusions the student accepts back into the Canvas.

Daily logs and experiment notes remain in the same folder. Later, the Agent can
use them to prepare a weekly update, experiment report, internship summary, or
thesis section. It can also shape the source material into a slide deck outline
for a class presentation, lab update, or thesis defense. Before submission, it
can compare the code and report with the assignment brief or grading rubric and
flag possible omissions for the student to review.

The result is a project whose sources, decisions, progress, and final report
remain connected. Work completed today becomes useful context for the next
experiment, report, or Agent session.

**Related areas:** [Preparation](design/preparation.md),
[Search and Retrieval](design/search.md), [Markdown](design/markdown.md),
[Agent Panel](design/agent-panel.md)

## 3. Turn a Personal Technical Archive into Long-Term Agent Context

An engineer or student may already have years of technical notes, project
documents, papers, books, screenshots, recordings, and old Agent output stored
in ordinary folders. They often remember that something exists but not its
filename, exact wording, or location.

```text
Existing local folders
  → prepare hard-to-read formats
  → index the content
  → retrieve by meaning
  → let an Agent read and use the sources
  → write new notes and documents back
```

The user adds selected folders to StashBase without reorganizing or importing
them into a new storage model. PDFs, DOCX files, images, audio, and video gain
searchable representations while the original files remain visible in their
existing locations.

Source code and unsupported document/data formats remain unchanged on disk but
stay outside the Files and search surfaces. The folder view explains that
boundary, counts the hidden categories, and avoids presenting unsupported-only
subtrees as mysteriously empty imported folders.

The user can search for “Why did this project reject PostgreSQL?” or “Which
papers compared these two methods?” without remembering the original wording.
Results point back to the source files, making it easy to check the surrounding
context.

The built-in Agent and connected external Agents use the same library. They can
search and read authorized material, then write a design note, literature
summary, report, or project record back into an ordinary folder. That new file
is indexed and becomes context for later work.

The result is a technical archive that grows more useful over time. Users keep
their existing folders, while every new note, decision, and Agent-produced
document can support the next search or conversation.

**Related areas:** [Local File Workspace](design/library.md),
[Preparation](design/preparation.md), [Search and Retrieval](design/search.md),
[Agent Panel](design/agent-panel.md)
