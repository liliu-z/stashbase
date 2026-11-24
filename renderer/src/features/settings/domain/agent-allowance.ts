import type { AgentAllowance } from './agent-catalog';

export function reservedCreditsDetail(allowance: AgentAllowance): string | null {
  const percent = allowance.reservedPercent ?? 0;
  if (percent <= 0) return null;
  return `${percent < 1 ? '<1' : Math.round(percent)}% temporarily reserved`;
}

// The API publishes fixed-point credits. Remove display padding without
// passing their integral or fractional digits through floating point.
export function formatCredits(credits: string): string {
  return credits.replace(/\.?0+$/u, '');
}

export function creditHoldDetail(
  breakdown: NonNullable<AgentAllowance['creditBreakdown']>,
): string {
  const sources = [breakdown.base, breakdown.bonus];
  const total = (key: 'reservedCredits' | 'provisionalCredits') => {
    const digits = sources
      .reduce((sum, source) => sum + BigInt(source[key].replace('.', '')), 0n)
      .toString()
      .padStart(10, '0');
    return formatCredits(`${digits.slice(0, -9)}.${digits.slice(-9)}`);
  };
  return `${total('reservedCredits')} reserved · ${total('provisionalCredits')} estimated fees`;
}
