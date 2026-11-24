/** Controlled account and billing ports for the Settings stories. */
import type { AccountPort, AgentRuntimePort } from '@/features/settings/application/ports';
import type { ReferralPort } from '@/features/settings/application/referral-port';
import type { BillingStatus } from '@/features/settings/domain/billing';
import type { ReferralAccount } from '@/features/settings/domain/referrals';
export const SIGNED_OUT = {
  avatarUrl: null,
  displayName: null,
  email: null,
  offers: [],
  signedIn: false,
} as const;

const EMPTY_REFERRALS: ReferralAccount = {
  referralRevision: '0',
  binding: null,
  invitation: null,
  claimEligibility: 'eligible',
  draft: null,
  checkoutStarted: false,
  summary: {
    registered: 0,
    confirming: 0,
    rewarded: 0,
  },
};

const emptyPage = { creditUnit: 'credits-v1', nextCursor: null } as const;

export const emptyReferrals: ReferralPort = {
  load: async () => EMPTY_REFERRALS,
  preview: async () => ({ available: false, reason: 'code_unavailable' }),
  accept: async () => {},
  skip: async () => {},
  history: async () => ({ ...emptyPage, items: [] }),
  grants: async () => ({ ...emptyPage, items: [] }),
};

const STORY_GENERATION = 's'.repeat(43);
export const signedIn: AccountPort = {
  referrals: emptyReferrals,
  sendEmail: async () => ({ flowId: 'email-flow' }),
  verifyEmail: async () => ({
    ...SIGNED_OUT,
    signedIn: true,
    email: 'ada@example.com',
    generation: STORY_GENERATION,
  }),
  cancelEmail: async () => {},
  methods: async () => ({ email: 'ada@example.com', google: true }),
  sendEmailProof: async () => {},
  verifyEmailProof: async () => {},
  sendLinkCode: async () => {},
  linkGoogle: async () => ({ ticket: 'ticket', url: 'https://accounts.example/link' }),
  unlinkGoogle: async () => {},
  linkStatus: async () => ({ state: 'pending' }),
  avatar: async () => null,
  load: async () => ({
    avatarUrl: null,
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    offers: [],
    signedIn: true,
    generation: STORY_GENERATION,
  }),
  signInStatus: async () => ({ state: 'pending' }),
  markOfferSeen: async () => SIGNED_OUT,
  resetOffers: async () => SIGNED_OUT,
  signOut: async () => SIGNED_OUT,
  startSignIn: async () => ({ flowId: 'flow', url: 'https://accounts.example/sign-in' }),
};

const FREE: BillingStatus = {
  cancelAtPeriodEnd: false,
  canManage: false,
  paidThrough: null,
  planName: null,
  status: 'free',
};

export function accountRuntimePort(): AgentRuntimePort {
  return {
    getAllowance: async () => ({
      remainingPercent: 62,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      windowEndsAt: null,
    }),
    getBillingPlans: async () => [
      {
        amount: 500,
        planKey: 'plus',
        monthlyGrantPicodollars: 4e12,
        available: true,
        currency: 'usd',
        interval: 'month',
        name: 'Plus',
        priceId: 'price_plus',
      },
      {
        amount: 2000,
        planKey: 'pro',
        monthlyGrantPicodollars: 20e12,
        available: true,
        currency: 'usd',
        interval: 'month',
        name: 'Pro',
        priceId: 'price_pro',
      },
    ],
    getBillingStatus: async () => FREE,
    listAgents: async () => ({ runtimes: [], debug: null }),
    openBillingPortal: async () => 'https://billing.stripe.com/p/session/story',
    prepareAgent: async () => ({ runtimes: [], debug: null }),
    changeBilling: async () => {},
    startCheckout: async () => 'https://checkout.stripe.com/c/pay/story',
    updateDebug: async () => ({ runtimes: [], debug: null }),
  };
}

const moment = '2099-11-05T10:00:00.000Z';
const terms = {
  creditUnit: 'credits-v1',
  campaignVersionId: 'afddc733-4250-479c-a313-123000000001',
  inviterCredits: '0.250000000',
  inviteeCredits: '0.500000000',
  qualifyingPlans: ['plus', 'pro'],
  enrollmentOpensAt: moment,
  enrollmentClosesAt: moment,
  hintDays: 14,
  claimDays: 14,
  paymentDays: 45,
  confirmationDays: 7,
  grantDays: 30,
} as const;
const binding = {
  referralId: 'afddc733-4250-479c-a313-123000000002',
  state: 'awaiting_payment',
  reason: null,
  reviewHeld: false,
  boundAt: moment,
  paymentDeadlineAt: moment,
  trial: null,
  paidAt: null,
  confirmationDueAt: null,
  ownGrantId: null,
  rewardedAt: null,
  terms,
} as const;
export const STORY_INVITE_CODE = '1123456789ABC';

export function invitationDemo() {
  let data: ReferralAccount = {
    ...EMPTY_REFERRALS,
    activity: [
      {
        id: 'afddc733-4250-479c-a313-123000000004',
        kind: 'refund',
        reason: 'payment_restored',
        at: moment,
        beforeCredits: '0.250000000',
        afterCredits: '0.500000000',
      },
      {
        id: 'afddc733-4250-479c-a313-123000000004',
        kind: 'refund',
        reason: 'payment_restored',
        at: moment,
        beforeCredits: '0.250000000',
        afterCredits: '0.500000000',
      },
    ],
    invitation: {
      code: '0123456789ABC',
      terms: binding.terms,
      shareUrl: 'https://stashbase.ai/invite/?code=0123456789ABC',
    },
    summary: {
      registered: 1,
      confirming: 0,
      rewarded: 0,
    },
  };
  const referrals: ReferralPort = {
    ...emptyReferrals,
    load: async () => data,
    preview: async (_generation, code) => {
      const preview =
        code === STORY_INVITE_CODE
          ? ({ available: true, code, terms: binding.terms } as const)
          : ({ available: false, reason: 'code_unavailable' } as const);
      data = { ...data, draft: { code, preview, claiming: false } };
      return preview;
    },
    accept: async () => {
      data = {
        ...data,
        binding,
        draft: null,
        referralRevision: '1',
        claimEligibility: 'bound',
        checkoutOffers: [
          { plan: 'plus', priceId: 'price_campaign_plus', amountMinor: 500, currency: 'usd' },
        ],
      };
    },
    skip: async () => {
      data = { ...data, draft: null };
    },
    history: async () => ({
      ...emptyPage,
      items: [{ ...binding, friendLabel: 'Friend 1' }],
    }),
    grants: async () => ({
      ...emptyPage,
      items: [
        {
          grantId: 'afddc733-4250-479c-a313-123000000003',
          referralId: binding.referralId,
          campaignVersionId: terms.campaignVersionId,
          recipientRole: 'inviter',
          source: 'referral_reward',
          scope: 'agent',
          issuedAt: moment,
          expiresAt: moment,
          originalCredits: '0.500000000',
          entitlementCredits: '0.500000000',
          availableCredits: '0.500000000',
          consumedCredits: '0.000000000',
          reservedCredits: '0.000000000',
          provisionalCredits: '0.000000000',
          availability: 'available',
          lastAdjustment: null,
        },
      ],
    }),
  };
  return referrals;
}
