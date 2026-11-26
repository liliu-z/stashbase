import fs from 'node:fs/promises';
import path from 'node:path';

export interface SemanticEvalDataset {
  schemaVersion: 1;
  datasetVersion: string;
  topK: number;
  thresholds: { recallAtK: number; meanReciprocalRank: number };
  baselinePolicy: { minimumRunsPerProvider: number; providers: string[] };
  baselineRuns: SemanticEvalBaselineRun[];
  documents: SemanticEvalDocument[];
  queries: SemanticEvalQuery[];
}

type SemanticEvalDocument =
  | { path: string; kind: 'direct' }
  | { path: string; kind: 'prepared'; preparedText: string };

interface SemanticEvalQuery {
  id: string;
  text: string;
  relevant: string[];
  compareExact?: boolean;
}

interface SemanticEvalBaselineRun {
  provider: string;
  model: string;
  runId: string;
  recordedAt: string;
  recallAtK: number;
  meanReciprocalRank: number;
  evidence: string;
}

export function hasCompleteBaselines(dataset: SemanticEvalDataset, provider?: string, model?: string): boolean {
  const allProvidersComplete = dataset.baselinePolicy.providers.every((declaredProvider) =>
    dataset.baselineRuns.filter((run) => run.provider === declaredProvider).length >= dataset.baselinePolicy.minimumRunsPerProvider,
  );
  if (!allProvidersComplete) return false;
  if (provider == null && model == null) return true;
  if (!provider || !model || !dataset.baselinePolicy.providers.includes(provider)) return false;
  return dataset.baselineRuns.filter((run) => run.provider === provider && run.model === model).length
    >= dataset.baselinePolicy.minimumRunsPerProvider;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) throw new Error(`${label} has unexpected field(s): ${unexpected.join(', ')}`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function unitInterval(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number from 0 to 1`);
  }
  return value;
}

export function resolveDatasetPath(root: string, relativePath: string, label = 'dataset path'): string {
  if (path.isAbsolute(relativePath) || relativePath.includes('\\')) throw new Error(`${label} must be a relative POSIX path`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
    throw new Error(`${label} must stay inside the dataset directory`);
  }
  return resolved;
}

export async function parseSemanticEvalDataset(value: unknown, datasetRoot: string): Promise<SemanticEvalDataset> {
  const raw = record(value, 'dataset');
  exactKeys(raw, ['schemaVersion', 'datasetVersion', 'topK', 'thresholds', 'baselinePolicy', 'baselineRuns', 'documents', 'queries'], 'dataset');
  if (raw.schemaVersion !== 1) throw new Error('dataset.schemaVersion must be 1');
  const datasetVersion = nonEmptyString(raw.datasetVersion, 'dataset.datasetVersion');
  if (!Array.isArray(raw.documents) || raw.documents.length < 10) throw new Error('dataset.documents must contain at least 10 fixtures');
  if (!Array.isArray(raw.queries) || raw.queries.length < 10) throw new Error('dataset.queries must contain at least 10 judgments');
  if (typeof raw.topK !== 'number' || !Number.isInteger(raw.topK) || raw.topK < 1 || raw.topK > 10) {
    throw new Error('dataset.topK must be an integer from 1 to 10');
  }
  const topK = raw.topK as number;
  if (topK >= raw.documents.length) throw new Error('dataset.topK must be smaller than the corpus');
  const thresholdsRaw = record(raw.thresholds, 'dataset.thresholds');
  exactKeys(thresholdsRaw, ['recallAtK', 'meanReciprocalRank'], 'dataset.thresholds');
  const thresholds = {
    recallAtK: unitInterval(thresholdsRaw.recallAtK, 'dataset.thresholds.recallAtK'),
    meanReciprocalRank: unitInterval(thresholdsRaw.meanReciprocalRank, 'dataset.thresholds.meanReciprocalRank'),
  };
  const baselinePolicyRaw = record(raw.baselinePolicy, 'dataset.baselinePolicy');
  exactKeys(baselinePolicyRaw, ['minimumRunsPerProvider', 'providers'], 'dataset.baselinePolicy');
  if (typeof baselinePolicyRaw.minimumRunsPerProvider !== 'number'
    || !Number.isInteger(baselinePolicyRaw.minimumRunsPerProvider)
    || baselinePolicyRaw.minimumRunsPerProvider < 2) {
    throw new Error('dataset.baselinePolicy.minimumRunsPerProvider must be an integer of at least 2');
  }
  const minimumRunsPerProvider = baselinePolicyRaw.minimumRunsPerProvider;
  if (!Array.isArray(baselinePolicyRaw.providers) || baselinePolicyRaw.providers.length === 0) {
    throw new Error('dataset.baselinePolicy.providers must not be empty');
  }
  const providers = baselinePolicyRaw.providers.map((provider, index) => nonEmptyString(provider, `dataset.baselinePolicy.providers[${index}]`));
  if (new Set(providers).size !== providers.length) throw new Error('dataset.baselinePolicy.providers must be unique');
  if (!Array.isArray(raw.baselineRuns)) throw new Error('dataset.baselineRuns must be an array');
  const baselineIds = new Set<string>();
  const baselineEvidence = new Set<string>();
  const baselineRuns = raw.baselineRuns.map((value, index): SemanticEvalBaselineRun => {
    const item = record(value, `dataset.baselineRuns[${index}]`);
    exactKeys(item, ['provider', 'model', 'runId', 'recordedAt', 'recallAtK', 'meanReciprocalRank', 'evidence'], `dataset.baselineRuns[${index}]`);
    const provider = nonEmptyString(item.provider, `dataset.baselineRuns[${index}].provider`);
    if (!providers.includes(provider)) throw new Error(`baseline provider is not declared: ${provider}`);
    const runId = nonEmptyString(item.runId, `dataset.baselineRuns[${index}].runId`);
    if (baselineIds.has(runId)) throw new Error(`duplicate baseline run id: ${runId}`);
    baselineIds.add(runId);
    const recordedAt = nonEmptyString(item.recordedAt, `dataset.baselineRuns[${index}].recordedAt`);
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(recordedAt)
      || Number.isNaN(Date.parse(recordedAt))) throw new Error(`${runId}: recordedAt must be an ISO date`);
    const evidence = nonEmptyString(item.evidence, `${runId}.evidence`);
    if (baselineEvidence.has(evidence)) throw new Error(`duplicate baseline evidence reference: ${evidence}`);
    baselineEvidence.add(evidence);
    return {
      provider,
      model: nonEmptyString(item.model, `${runId}.model`),
      runId,
      recordedAt,
      recallAtK: unitInterval(item.recallAtK, `${runId}.recallAtK`),
      meanReciprocalRank: unitInterval(item.meanReciprocalRank, `${runId}.meanReciprocalRank`),
      evidence,
    };
  });
  const completeBaselines = providers.every((provider) =>
    baselineRuns.filter((run) => run.provider === provider).length >= minimumRunsPerProvider,
  );
  for (const provider of providers) {
    const models = new Set(baselineRuns.filter((run) => run.provider === provider).map((run) => run.model));
    if (models.size > 1) throw new Error(`baseline runs for ${provider} must use one exact model within a dataset version`);
  }
  if (completeBaselines) {
    const recallFloor = Math.min(...baselineRuns.map((run) => run.recallAtK));
    const mrrFloor = Math.min(...baselineRuns.map((run) => run.meanReciprocalRank));
    if (thresholds.recallAtK > recallFloor || thresholds.meanReciprocalRank > mrrFloor) {
      throw new Error('dataset thresholds must not exceed the observed cross-provider baseline floors');
    }
  }

  const documentPaths = new Set<string>();
  const fixturePaths: Array<{ path: string; label: string }> = [];
  const documents = raw.documents.map((value, index): SemanticEvalDocument => {
    const item = record(value, `dataset.documents[${index}]`);
    exactKeys(item, item.kind === 'prepared' ? ['path', 'kind', 'preparedText'] : ['path', 'kind'], `dataset.documents[${index}]`);
    const documentPath = nonEmptyString(item.path, `dataset.documents[${index}].path`);
    resolveDatasetPath(datasetRoot, documentPath, `dataset.documents[${index}].path`);
    if (documentPaths.has(documentPath)) throw new Error(`duplicate document path: ${documentPath}`);
    documentPaths.add(documentPath);
    fixturePaths.push({ path: documentPath, label: `document fixture ${documentPath}` });
    if (item.kind === 'direct') return { path: documentPath, kind: 'direct' };
    if (item.kind !== 'prepared') throw new Error(`dataset.documents[${index}].kind must be direct or prepared`);
    const preparedText = nonEmptyString(item.preparedText, `dataset.documents[${index}].preparedText`);
    resolveDatasetPath(datasetRoot, preparedText, `dataset.documents[${index}].preparedText`);
    if (preparedText === documentPath) throw new Error(`${documentPath}: preparedText must differ from the source`);
    fixturePaths.push({ path: preparedText, label: `prepared fixture ${preparedText}` });
    return { path: documentPath, kind: 'prepared', preparedText };
  });

  const queryIds = new Set<string>();
  const queries = raw.queries.map((value, index): SemanticEvalQuery => {
    const item = record(value, `dataset.queries[${index}]`);
    exactKeys(item, ['id', 'text', 'relevant', 'compareExact'], `dataset.queries[${index}]`);
    const id = nonEmptyString(item.id, `dataset.queries[${index}].id`);
    if (queryIds.has(id)) throw new Error(`duplicate query id: ${id}`);
    queryIds.add(id);
    const text = nonEmptyString(item.text, `dataset.queries[${index}].text`);
    if (!Array.isArray(item.relevant) || item.relevant.length === 0) throw new Error(`${id}: relevant must not be empty`);
    const relevant = item.relevant.map((source, relevantIndex) => nonEmptyString(source, `${id}.relevant[${relevantIndex}]`));
    if (new Set(relevant).size !== relevant.length) throw new Error(`${id}: relevance judgments must be unique`);
    // More acceptable sources than slots makes Recall@K unreachable, which
    // would silently cap the aggregate below any threshold a reviewer sets.
    if (relevant.length > topK) throw new Error(`${id}: relevant must not exceed topK (${topK})`);
    for (const source of relevant) {
      resolveDatasetPath(datasetRoot, source, `${id}.relevant`);
      if (!documentPaths.has(source)) throw new Error(`${id}: relevant source is not in the corpus: ${source}`);
    }
    if (item.compareExact !== undefined && typeof item.compareExact !== 'boolean') throw new Error(`${id}.compareExact must be boolean`);
    return { id, text, relevant, ...(item.compareExact === true ? { compareExact: true } : {}) };
  });

  await Promise.all(fixturePaths.map(async (fixture) => {
    const target = resolveDatasetPath(datasetRoot, fixture.path, fixture.label);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) throw new Error(`${fixture.label} is missing or not a file`);
    const [realRoot, realTarget] = await Promise.all([fs.realpath(datasetRoot), fs.realpath(target)]);
    const realRelative = path.relative(realRoot, realTarget);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(`${fixture.label} resolves outside the dataset directory`);
    }
  }));

  return {
    schemaVersion: 1,
    datasetVersion,
    topK,
    thresholds,
    baselinePolicy: { minimumRunsPerProvider, providers },
    baselineRuns,
    documents,
    queries,
  };
}
