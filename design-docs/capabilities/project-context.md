# Project Context

## Scope

Documents, search, built-in agents, and external MCP clients can use project
material as evidence. Preparation and indexing are optional support for writing;
an empty project and a conversation without references are valid.

## Preparation and Evidence

- Keep original sources authoritative. Extracted text and indexes stay hidden;
  agent-written documents remain ordinary project files.
- Apply search and preparation exclusions within the selected project. A project
  remains searchable when its parent path is hidden, including a cloud drive's
  internal mount path; hidden directories inside the project stay excluded.
- Publish only complete, current preparation output. Partial, stale, cancelled,
  or orphaned output cannot serve as evidence. Empty completed OCR, including a
  textless PDF, is a valid non-searchable result; an OCR execution failure is not.
  PDFs with missing extracted text try local OCR without changing the original.
  The [format matrix](project-files.md#format-capability-matrix)
  defines which sources participate.
- Preview, preparation, and semantic-index readiness are separate. Background work
  prioritizes interaction without blocking unrelated documents or conversation.
  Image OCR only adds search text, so the image viewer says nothing about its
  progress or result; PDF and DOCX viewers show their preparation state.
- Local PDF/OCR components download on first demand and work offline thereafter.
  Updating the app reuses an installed component when that component is unchanged.
  Failed setup offers retry beside a waiting document, or one retry on next launch.
  Cancelled source demand cannot silently resume; independently requested component
  installation may continue. Downloads do not send source bytes or steal focus.
- An unsupported native component is a capability limitation, not a setup retry.
  Explain the limitation without downloading incompatible binaries or blocking
  project browsing and editing. Search can be unavailable on systems where its
  native backend cannot run; neither search mode may pretend to succeed there.
- Startup verifies local database loading, disk read/write, and preparation-state
  access before project work begins. A failure explains recovery appropriate to
  the installed app or source checkout, while browsing and editing remain available.
  Checks preserve existing data; relaunch verifies repairs.
- Explicit source cancellation remains stopped until Reprocess. Shutdown interruption
  is recoverable. Storage failure must not report durable cancellation or silently
  restart work whose state cannot be established.

## Retrieval and Access Differences

Agents prefer StashBase discovery for project documents, without a mandatory
search or directory listing before reading a known path. Native reads and
searches can cover unavailable tools or material outside their coverage, such
as code and configuration. Prepared text is the first choice for project PDFs,
DOCX, and XLSX; missing, incomplete, or insufficient text, or a request for
original-source analysis, permits inspecting the original content with native
tools. These choices preserve the requested scope, file-write intent, and
runtime permissions, including for installations.

| Caller or mode | Required behavior |
|---|---|
| By keyword | Works without account or embedding setup. |
| By meaning | Opt-in with a Settings embedding key; preparation can finish while vectors are still indexing. |
| Agent context | Always bound to the conversation's project. |
| External MCP | Select one authorized registered project explicitly. |
| Tool search without an explicit mode | Use keyword without an embedding key, hybrid with one, according to current configuration. |

A project-bound Chat may omit the search tool's project parameter. The runtime
carries the Chat's identity to the tool host, which supplies its bound project;
the agent does not need to repeat the folder in each call.

Search offers a direct setup entry when search by meaning is not configured.
An explicit search mode is honored. Missing configuration or provider failure
cannot silently change strategies. Removing the embedding key retains keyword
search and prepared-file access; StashBase Agent credits never configure search.

## Failure and Recovery

Every result resolves to an authorized visible source with its available locator.
Visibility alone does not grant retrieval or tool access. Missing results,
invalid identity, and failures never broaden project scope.

Keep empty results distinct from failed or partial work. Withhold known-stale
evidence, show remaining usable results, and recover the affected preparation,
index, or provider state. Bounded reads identify their extent. Transport
correctness does not establish search-by-meaning relevance. Representative
quality evaluation is deferred; [J05](../../code-review/journey-coverage.md#j05-search)
records the evidence gap.

An unreadable child directory must not stop other readable files from updating.
Skip that subtree, retain its existing index and prepared state, and identify the
directory in the project's Search warning with a retry action, including when
only keyword search is configured. Missing inventory is not proof of deletion.
After access returns, the next sync updates or removes retained entries normally
and clears the warning after a successful run. An unreadable project root or
unexpected scan failure still stops reconciliation without cleaning unseen files.

## Related Journeys

[J04](../journeys/README.md#j04-prepare-a-hard-to-read-file),
[J05](../journeys/README.md#j05-search-and-open-source-evidence),
[J08](../journeys/README.md#j08-connect-an-external-agent-through-mcp),
[J10](../journeys/README.md#j10-turn-a-local-project-into-durable-agent-assisted-work),
[J12](../journeys/README.md#j12-build-wiki-pages-from-a-local-folder).

Implementation: [preparation and retrieval](../../code-review/architecture.md#preparation-and-retrieval).
Credentials: [Account and Settings](account-settings.md).
