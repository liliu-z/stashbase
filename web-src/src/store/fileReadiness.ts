import type { PreparationFailure } from '../api';
import type { State } from './state';

export interface FileReadiness {
  preparationFailure: PreparationFailure | undefined;
  preparationCancellation: PreparationFailure | undefined;
}

export function preparationFailureMatchesTarget(failurePath: string, target: string): boolean {
  if (failurePath === target) return true;
  const slash = target.lastIndexOf('/');
  const dir = slash >= 0 ? target.slice(0, slash + 1) : '';
  const base = slash >= 0 ? target.slice(slash + 1) : target;
  return failurePath === `${dir}.${base}.md`;
}

type PreparationState = Pick<State, 'preparationFailures'>;

export function getPreparationProblem(s: PreparationState, path: string): PreparationFailure | undefined {
  return s.preparationFailures.find((f) => preparationFailureMatchesTarget(f.path, path));
}

export function getPreparationFailure(s: PreparationState, path: string): PreparationFailure | undefined {
  const problem = getPreparationProblem(s, path);
  return problem?.status === 'cancelled' ? undefined : problem;
}

export function getPreparationCancellation(s: PreparationState, path: string): PreparationFailure | undefined {
  const problem = getPreparationProblem(s, path);
  return problem?.status === 'cancelled' ? problem : undefined;
}

export function getFileReadiness(s: PreparationState, path: string): FileReadiness {
  return {
    preparationFailure: getPreparationFailure(s, path),
    preparationCancellation: getPreparationCancellation(s, path),
  };
}

/** Folder-level status uses the same semantics as file rows. */
export function hasAggregatePreparationFailure(failures: PreparationFailure[]): boolean {
  return failures.some((failure) => failure.status !== 'cancelled');
}
