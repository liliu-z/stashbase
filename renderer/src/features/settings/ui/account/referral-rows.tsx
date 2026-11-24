/** Settings controls and history for the signed-in reader's invitations. */
import { Button } from '@/components/ui/button';
import { InputField, InputGroup } from '@/components/ui/input-group';
import { formatCredits } from '@/features/settings/domain/agent-allowance';
import {
  accountDate,
  invitationEligibility,
  invitationProgress,
  referralActivityLabel,
  type ReferralActivity,
  type ReferralTerms,
} from '@/features/settings/domain/referrals';
import type { ReferralViewModel } from '@/features/settings/hooks/use-referrals';
import {
  SettingsGroup,
  SettingsList,
  SettingsMessage,
  SettingsRow,
} from '@/features/settings/ui/rows';
import { FailureNotice } from '@/shared/ui/failure-notice';

const draftError = {
  code_unavailable: 'This invitation code is unavailable.',
  campaign_unavailable: 'This invitation campaign is unavailable.',
  capacity_reached: 'This invitation campaign is full right now.',
};

function Terms({ terms, recipient }: { terms: ReferralTerms; recipient: 'inviter' | 'invitee' }) {
  return (
    <div className="text-caption leading-relaxed text-muted-foreground">
      <p>
        You receive{' '}
        {formatCredits(recipient === 'inviter' ? terms.inviterCredits : terms.inviteeCredits)} Agent
        credits.
        {recipient === 'inviter' ? ' Your friend' : ' Your inviter'} receives{' '}
        {formatCredits(recipient === 'inviter' ? terms.inviteeCredits : terms.inviterCredits)} Agent
        credits.
      </p>
      <p>
        Accept within {terms.claimDays} days of signup. A qualifying Plus or Pro payment is due
        within {terms.paymentDays} days of accepting. Allow {terms.confirmationDays} days for
        payment confirmation. Credits expire {terms.grantDays} days after issue.
      </p>
      <p>Enrollment closes {accountDate(terms.enrollmentClosesAt)}.</p>
    </div>
  );
}

function InvitationForm({ referrals }: { referrals: ReferralViewModel }) {
  const { busy, code, data, preview } = referrals;
  if (!data) return null;
  if (data.binding) {
    return (
      <SettingsRow
        as="li"
        title="Your accepted invitation"
        detail={invitationProgress(data.binding)}
      >
        <Terms terms={data.binding.terms} recipient="invitee" />
      </SettingsRow>
    );
  }
  const eligible = data.claimEligibility === 'eligible';
  if (!eligible && !referrals.decisionNeeded) {
    const reason = invitationEligibility(data.claimEligibility);
    return reason ? <SettingsMessage as="li" message={reason} /> : null;
  }
  return (
    <SettingsRow as="li" title="Use an invitation">
      {eligible ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && code.trim()) referrals.inspect();
          }}
        >
          <InputGroup className="max-w-xs grow">
            <InputField
              label="Invitation code"
              resting="outline"
              autoComplete="off"
              disabled={busy}
              maxLength={64}
              onChange={referrals.setCode}
              placeholder="Enter invitation code"
              spellCheck={false}
              value={code}
            />
          </InputGroup>
          <Button disabled={busy || !code.trim()} size="compact" variant="tertiary" type="submit">
            Check code
          </Button>
        </form>
      ) : (
        <p className="text-caption text-muted-foreground">
          {invitationEligibility(data.claimEligibility)}
        </p>
      )}
      {preview?.available && <Terms terms={preview.terms} recipient="invitee" />}
      {preview?.available === false && (
        <p role="status" className="text-caption text-muted-foreground">
          {draftError[preview.reason]}
        </p>
      )}
      {busy && (
        <p role="status" className="text-caption text-muted-foreground">
          Checking invitation…
        </p>
      )}
      {referrals.decisionNeeded && (
        <div className="flex flex-wrap gap-2">
          {eligible && preview?.available && (
            <Button disabled={busy} size="compact" onClick={referrals.accept}>
              Accept invitation
            </Button>
          )}
          <Button disabled={busy} size="compact" variant="ghost" onClick={referrals.skip}>
            Continue without invitation
          </Button>
        </div>
      )}
    </SettingsRow>
  );
}

function RecentActivity({ items }: { items?: readonly ReferralActivity[] | undefined }) {
  const unique = new Map<string, ReferralActivity>();
  for (const item of items ?? []) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return (
    <SettingsRow
      as="li"
      title="Recent reward activity"
      detail={unique.size ? undefined : 'No recent reward activity.'}
    >
      {[...unique.values()].map((item) => {
        const amount =
          item.beforeCredits !== undefined &&
          item.afterCredits !== undefined &&
          (item.kind === 'issuance'
            ? `${formatCredits(item.afterCredits)} credits`
            : `Entitlement ${formatCredits(item.beforeCredits)} → ${formatCredits(item.afterCredits)} credits`);
        return (
          <p key={item.id} className="text-caption text-muted-foreground">
            {referralActivityLabel(item)}
            {amount && ` · ${amount}`} · {accountDate(item.at)}
          </p>
        );
      })}
    </SettingsRow>
  );
}

export function ReferralRows({ referrals }: { referrals: ReferralViewModel }) {
  const { data, history, grants } = referrals;
  const invitation = data?.invitation;
  return (
    <SettingsGroup title="Invitations and rewards">
      <SettingsList as="ul">
        {referrals.failure && (
          <li className="px-3 py-2">
            <FailureNotice failure={referrals.failure} />
          </li>
        )}
        {!data && (
          <SettingsMessage
            as="li"
            message={referrals.failed ? 'Could not load invitations.' : 'Checking invitations…'}
            {...(referrals.failed ? { onRetry: referrals.refresh } : {})}
          />
        )}
        {invitation && (
          <SettingsRow as="li" title="Share an invitation" detail={invitation.code}>
            <Terms terms={invitation.terms} recipient="inviter" />
            <div className="flex flex-wrap gap-2">
              <Button size="compact" variant="tertiary" onClick={() => referrals.copy('link')}>
                Copy invite link
              </Button>
              <Button size="compact" variant="ghost" onClick={() => referrals.copy('code')}>
                Copy code
              </Button>
              {referrals.copied && (
                <span role="status" className="text-caption">
                  Copied {referrals.copied}.
                </span>
              )}
            </div>
          </SettingsRow>
        )}
        <InvitationForm referrals={referrals} />
        <SettingsRow
          as="li"
          title="Invitation progress"
          detail={
            data
              ? data.summary.registered === 0
                ? 'No friends have accepted an invitation yet.'
                : `${data.summary.registered} accepted · ${data.summary.confirming} confirming · ${data.summary.rewarded} rewarded`
              : undefined
          }
        >
          {history.items.map((item) => (
            <p key={item.referralId} className="text-caption text-muted-foreground">
              {item.friendLabel} · {invitationProgress(item)}
            </p>
          ))}
          {history.failed && (
            <SettingsMessage
              message="Could not load invitation progress."
              onRetry={() => void history.retry()}
            />
          )}
          {history.hasMore && (
            <Button
              size="compact"
              variant="ghost"
              disabled={history.busy}
              onClick={() => void history.more()}
            >
              More invitations
            </Button>
          )}
        </SettingsRow>
        <SettingsRow
          as="li"
          title="Reward grants"
          detail={grants.empty ? 'No rewards issued yet.' : undefined}
        >
          {grants.items.map((grant) => (
            <p key={grant.grantId} className="text-caption text-muted-foreground">
              {formatCredits(grant.availableCredits)} of {formatCredits(grant.entitlementCredits)}{' '}
              credits
              {' · '}
              {grant.availability}
              {' · '}Expires {accountDate(grant.expiresAt)}
              {grant.lastAdjustment && ` · Adjusted ${accountDate(grant.lastAdjustment.at)}`}
            </p>
          ))}
          {grants.failed && (
            <SettingsMessage
              message="Could not load rewards."
              onRetry={() => void grants.retry()}
            />
          )}
          {grants.hasMore && (
            <Button
              size="compact"
              variant="ghost"
              disabled={grants.busy}
              onClick={() => void grants.more()}
            >
              More rewards
            </Button>
          )}
        </SettingsRow>
        {data && <RecentActivity items={data.activity} />}
      </SettingsList>
    </SettingsGroup>
  );
}
