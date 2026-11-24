import type {
  ReferralAccount,
  ReferralGrants,
  ReferralHistory,
  ReferralPreview,
} from '@/features/settings/domain/referrals';

export interface ReferralPort {
  load(generation: string, signal: AbortSignal): Promise<ReferralAccount>;
  preview(generation: string, code: string, signal: AbortSignal): Promise<ReferralPreview>;
  accept(
    input: {
      generation: string;
      campaignVersionId: string;
      referralRevision: string;
      code: string;
    },
    signal: AbortSignal,
  ): Promise<void>;
  skip(generation: string, signal: AbortSignal): Promise<void>;
  history(generation: string, cursor: string | null, signal: AbortSignal): Promise<ReferralHistory>;
  grants(generation: string, cursor: string | null, signal: AbortSignal): Promise<ReferralGrants>;
}
