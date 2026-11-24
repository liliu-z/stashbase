import type { CreditBreakdown } from '@/features/settings/domain/agent-catalog';

const zero = '0.000000000';
const date = '2099-11-05T10:00:00.000Z';
export const BONUS_ONLY_CREDITS: CreditBreakdown = {
  creditUnit: 'credits-v1',
  asOf: date,
  agentAvailableCredits: '0.500000000',
  base: {
    grantedCredits: '1.000000000',
    availableCredits: zero,
    consumedCredits: '0.750000000',
    reservedCredits: '0.150000000',
    provisionalCredits: '0.100000000',
    windowStartedAt: date,
    windowEndsAt: date,
  },
  bonus: {
    entitlementCredits: '0.500000000',
    availableCredits: '0.500000000',
    consumedCredits: zero,
    reservedCredits: zero,
    provisionalCredits: zero,
    nextExpiry: { at: date, availableCredits: '0.500000000' },
  },
};
