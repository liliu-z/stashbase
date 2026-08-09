import type { OnboardingPreferences, UnsupportedFileSummary } from './apiTypes';

export const UNSUPPORTED_NOTICE_VERSION = 1;

export interface UnsupportedNoticeCategories {
  sourceCode: boolean;
  other: boolean;
}

export function hasUnsupportedNotice(categories: UnsupportedNoticeCategories | null): boolean {
  return categories !== null && (categories.sourceCode || categories.other);
}

export function unseenUnsupportedNotice(
  summary: UnsupportedFileSummary | undefined,
  preferences: OnboardingPreferences,
): UnsupportedNoticeCategories | null {
  if (!summary) return null;
  const categories = {
    sourceCode: summary.sourceCode > 0
      && (preferences.sourceCodeNoticeVersion ?? 0) < UNSUPPORTED_NOTICE_VERSION,
    other: summary.other > 0
      && (preferences.unsupportedFormatsNoticeVersion ?? 0) < UNSUPPORTED_NOTICE_VERSION,
  };
  return hasUnsupportedNotice(categories) ? categories : null;
}

export function unsupportedNoticeForDetails(
  summary: UnsupportedFileSummary | undefined,
): UnsupportedNoticeCategories | null {
  if (!summary) return null;
  const categories = {
    sourceCode: summary.sourceCode > 0,
    other: summary.other > 0,
  };
  return hasUnsupportedNotice(categories) ? categories : null;
}

export function retainAvailableUnsupportedNotice(
  categories: UnsupportedNoticeCategories | null,
  summary: UnsupportedFileSummary | undefined,
): UnsupportedNoticeCategories | null {
  if (!categories || !summary) return null;
  const retained = {
    sourceCode: categories.sourceCode && summary.sourceCode > 0,
    other: categories.other && summary.other > 0,
  };
  return hasUnsupportedNotice(retained) ? retained : null;
}

export function unsupportedSummaryForNotice(
  summary: UnsupportedFileSummary,
  categories: UnsupportedNoticeCategories,
): UnsupportedFileSummary {
  return {
    sourceCode: categories.sourceCode ? summary.sourceCode : 0,
    other: categories.other ? summary.other : 0,
    otherExtensions: categories.other ? summary.otherExtensions : [],
  };
}

export function onboardingPatchForNotice(
  categories: UnsupportedNoticeCategories,
): Partial<OnboardingPreferences> {
  return {
    ...(categories.sourceCode ? { sourceCodeNoticeVersion: UNSUPPORTED_NOTICE_VERSION } : {}),
    ...(categories.other ? { unsupportedFormatsNoticeVersion: UNSUPPORTED_NOTICE_VERSION } : {}),
  };
}

export function formatUnsupportedExtensions(
  otherExtensions: UnsupportedFileSummary['otherExtensions'],
): string {
  const top = otherExtensions.slice(0, 3).map((entry) => entry.extension);
  const remaining = otherExtensions.length - top.length;
  return remaining > 0
    ? `${top.join(', ')} and ${remaining} more format${remaining === 1 ? '' : 's'}`
    : top.join(', ');
}
