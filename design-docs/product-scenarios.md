# Product Scenarios

Product scenarios explain why someone adopts StashBase. They are intentionally
high-level and durable: they describe desired outcomes, not screen sequences or
test fixtures. Observable shipping flows live in
[User Journeys](user-journeys.md).

## Take an Engineering Project from Requirements to Delivery

An engineer starts with requirements, meeting notes, design history, and an
existing codebase spread across ordinary local files. StashBase helps an Agent
retrieve the relevant constraints, compare options, record accepted decisions
in a user-owned document, and check the delivery against the original brief.

The outcome is continuity from requirements through implementation without
moving the project into a proprietary workspace.

Related journeys: [J02](user-journeys.md#j02-add-and-open-a-folder),
[J05](user-journeys.md#j05-search-and-open-source-evidence),
[J06](user-journeys.md#j06-start-and-continue-an-agent-chat), and
[J07](user-journeys.md#j07-converge-chat-into-a-document).

## Complete a Course or Research Project

A student or researcher combines an assignment brief, papers, slides,
recordings, experiments, and notes. StashBase prepares difficult formats,
retrieves evidence across the collection, and keeps accepted conclusions in
ordinary Markdown alongside the source material.

The outcome is a traceable project whose sources, decisions, progress, and
final report remain connected.

Related journeys: [J03](user-journeys.md#j03-read-and-edit-source-documents),
[J04](user-journeys.md#j04-prepare-a-hard-to-read-file),
[J05](user-journeys.md#j05-search-and-open-source-evidence), and
[J07](user-journeys.md#j07-converge-chat-into-a-document).

## Turn a Personal Archive into Long-Term Agent Context

A user already has years of notes, PDFs, images, recordings, and earlier Agent
output. StashBase indexes selected folders in place, keeps generated
representations invisible, and lets built-in or external Agents retrieve the
visible sources and write useful new files back.

The outcome is a local archive that becomes more useful over time while the
user keeps its existing folder structure and ownership.

Related journeys: [J02](user-journeys.md#j02-add-and-open-a-folder),
[J04](user-journeys.md#j04-prepare-a-hard-to-read-file),
[J05](user-journeys.md#j05-search-and-open-source-evidence), and
[J08](user-journeys.md#j08-connect-an-external-agent-through-mcp).

## Maintain Project Data beside Documents

Project folders often include JSON configuration, fixtures, exports, or
partially generated data beside prose. StashBase treats JSON as an ordinary
raw source: users can inspect, search, explicitly edit, and save it without
requiring validity or silently normalizing its text.

The outcome is one source-of-truth workflow for prose and structured project
data.

Related journeys: [J03](user-journeys.md#j03-read-and-edit-source-documents)
and [J05](user-journeys.md#j05-search-and-open-source-evidence).

## Core Product Scenario

Across these scenarios, work can begin with a question or task for an Agent
against an explicit scope. The user may open a source document at any point to
inspect evidence or continue the same work beside it, or may complete the task
entirely in Chat. Documents are optional working surfaces rather than required
entry points. When an outcome needs to persist beyond the conversation, it is
explicitly written into an ordinary source file.

The canonical end-to-end product behavior is
[J10: Turn a local project into durable Agent-assisted work](user-journeys.md#j10-turn-a-local-project-into-durable-agent-assisted-work).
For Chat-first work, [J11: Turn a conversation into a project](user-journeys.md#j11-turn-a-conversation-into-a-project)
creates the durable scope before entering that loop.
The scenarios above vary the source material and desired result; they do not
create separate storage, scope, permission, or Agent models.
