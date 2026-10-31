import {
  featureErrorClass,
  type FeatureError,
  type FeatureFailureKind,
} from '@/shared/domain/feature-error';

/** One project's Math switch. Both calls resolve the full record, because the
 *  server's answer is what the window applies: a project with no record reads
 *  back off, and a write echoes the state that was actually stored. */
export interface MathModePort {
  load(scope: string, signal: AbortSignal): Promise<boolean>;
  save(scope: string, enabled: boolean, signal: AbortSignal): Promise<boolean>;
}

export type MathModeFailureKind = FeatureFailureKind<'rejected'>;

export type MathModeError = FeatureError<'rejected'>;
export const MathModeError = featureErrorClass<'rejected'>('MathModeError');
