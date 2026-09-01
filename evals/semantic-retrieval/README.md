# Semantic Retrieval Evaluation

This credentialed AI Eval measures J05 meaning-based ranking quality separately
from deterministic retrieval correctness. Run it from the repository root:

```bash
pnpm eval:semantic-retrieval
pnpm eval:semantic-retrieval --out release.nosync/j05-openai-1.txt
```

The command uses the OpenAI or OpenRouter key already saved in **StashBase
Settings > Similarity Search**. It does not read credentials from environment variables,
launch Electron, touch the user's library, or reuse the product vector store.
It creates an isolated temporary library and store, indexes the versioned
fixtures through `MfsIndexer`, and searches through the production Retrieval
Interface. The temporary data is removed after the run. `--out` additionally
writes the report to a file for release evidence; the report never contains a
credential.

## Dataset and scoring

`v1/dataset.json` owns the dataset version, corpus manifest, natural-language
queries, relevance judgments, `K`, thresholds, and baseline records. Its 22
synthetic documents contain no user data. Twenty-two paraphrased judgments
cover multiple intents for direct Markdown, HTML, JSON, and PDF source identity
backed by prepared Markdown evidence. Similarity Search is evaluated at K=3 so
plausible distractors materially affect both retrieval and rank.

Retrieval ranks **chunks**, not documents. The runner therefore asks the index
for `topK * CHUNK_FETCH_MULTIPLIER` chunks and collapses them to distinct
sources before scoring, so K always counts documents and one long source cannot
occupy every slot. `scripts/semantic-retrieval-metrics.ts` rejects a ranking
that still repeats a source, which keeps that collapse from silently
regressing.

The corpus deliberately mixes short single-chunk notes with sources long enough
to split across several chunks — `corpus/facilities-handbook.md`,
`corpus/onboarding-handbook.md`, and the prepared `prepared/field-guide.md` —
and judges queries against a specific section of each. Without those, the Eval
would report nothing about chunking even though chunking changes are one of its
documented triggers.

The report names the dataset schema/version, commit, provider, model, Recall@K,
and mean reciprocal rank (MRR). Each query prints its acceptable source set,
ordered Similarity Search results, and—where a deliberately paraphrased query
makes the contrast useful—Exact Search results. Misses therefore show both the
expected evidence and unexpected top results. A report produced from a dirty
working tree says so, because the commit it names is then not what ran.

Version 1's proposed aggregate thresholds are:

- Recall@3 >= 0.90
- MRR >= 0.80

Every judgment names exactly one acceptable source, so Recall@3 takes values of
`k/22`: 0.90 allows **at most two complete misses** out of twenty-two queries
(20/22 = 0.909, 19/22 = 0.864). Read the thresholds as that miss budget rather
than as generous tolerance — they absorb rank movement, not a systematic
regression. Provider responses and ranking can vary slightly, so the gate uses
aggregate thresholds rather than requiring a fixed order or a perfect score.
Change the dataset version whenever corpus meaning or relevance judgments
change. A threshold change requires review with the result that motivated it;
do not lower a threshold merely to accept a regression.

The command reports `CALIBRATION` and does not fail on quality thresholds until
the dataset contains at least three retained baseline runs for each supported
BYOK path, OpenAI and OpenRouter. This prevents unobserved target numbers from
silently becoming a release gate. For calibration, select one provider in
Settings, run the command three times, retain each complete report with the PR
or release evidence, then add its provider, exact model, date, unique evidence
reference, Recall@3, and MRR to `baselineRuns`. Repeat for the other provider.
Review the collected distributions before activating or changing thresholds.
The dataset parser rejects duplicate run IDs, unknown providers, invalid
metrics, malformed dates, and judgments that name more acceptable sources than
K has slots. Baseline records must never contain credentials.

Baselines are keyed by provider **and exact model**, so configuring a model the
dataset has no baseline for returns the run to `CALIBRATION` and the process
exit status stops gating. That is deliberate — an unmeasured model has no
baseline to be judged against — but it means the gate state is a fact the
release checklist has to read off the report, not something a passing exit
status can be trusted to imply.

## Execution placement

This evaluation is a credentialed release check, not required source CI or
scheduled CI. It makes paid external embedding requests and depends on a
locally authorized BYOK provider, while required CI must remain credential-free
and deterministic. Run it when retrieval ranking, chunking, embedding model, or
provider behavior changes and record the complete report with the release or
review evidence. While the report says `CALIBRATION`, retain it as baseline
evidence but do not claim a passing semantic-quality gate.

`pnpm test:retrieval` covers the metrics, manifest, and runner deterministically
and parses the shipped `v1` manifest against its fixtures, so corpus drift is
caught without credentials.
