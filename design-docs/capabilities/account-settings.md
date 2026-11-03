# Account and Settings

## Scope and Access

Settings, first-send access, and external-client setup share current configuration
and recovery rules. Local browsing, editing, preview, and keyword search require
no account.

| Capability | Access source |
|---|---|
| Default Agent | StashBase account with free or subscribed agent credits |
| Codex / Claude / Antigravity | The native runtime's installation and authentication |
| Search by meaning | User-supplied embedding key in Settings, billed independently |
| External HTTP MCP | Current Settings token; separate opt-in for Docker access |

Selecting an agent is not login or installation consent. Account sign-in does not
enable search. Credentials remain outside projects, renderer persistence, and
agent history; supplied environment variables do not configure BYOK access.

When credits or billing reports lost authentication, account surfaces refresh
the host-owned account state. Confirmed expiry restores Sign in and refreshes
Default Agent readiness. Network failures keep the signed-in identity and Retry.
An old refusal or pending account read cannot replace a newer login; recovery
never repeats a billing action or a message automatically.

## Settings Organization

Settings owns lasting preferences and connection configuration:

The navigation has seven sections: Account, Appearance, Editor, Agents,
Notifications, General, and Advanced. Each section opens at its top. Unavailable
platform capabilities stay named and disabled in navigation.

- **Account:** signed-in identity, primary email and Google connection status,
  connection/disconnection, credits and subscription, and sign-out. The account
  menu's Sign-in methods and Plans and billing entries both open this page.
  Account and billing remain available independently of agent runtime readiness.
- **Appearance:** user-wide theme and interface preferences:
  - **Theme:** a mode (match system, light, dark) plus a light theme and a dark
    theme chosen separately: StashBase's own (the defaults, and the Paper and
    Green reading pairs, whose ink is tinted to their page) and published
    palettes (Catppuccin, Tokyo Night, Rosé Pine, Gruvbox, Nord). Every theme
    keeps body and secondary text at WCAG AA on its surfaces. The theme also governs native
    menus, dialogs, and the window background from launch.
  - **Interface:** interface size, which reaches all chrome text, and reduce
    motion (match system or on).
- **Editor:** document presentation and writing aids:
  - **Documents:** how document text looks: the document font, chosen from the two included reading fonts
    (Serif, the default, and Sans) or any font installed on the computer; the
    code font, from the bundled monospace or installed monospaced fonts; and
    reading text size (a slider of seven steps), line spacing, and line width.
    The document's Appearance menu edits the same font, text size, line width
    and line spacing, and offers the page colour as a pair: choosing White,
    Paper or Green sets the light and the dark theme together, beside the
    mode.
  - **Writing:** what helps while writing: spellcheck and its language (where
    the system offers a choice), focus mode, typewriter scrolling, and word
    count.

  Every appearance value is a preset or a step except the two font names, which are
  validated as names before they are stored. An installed writing font
  overrides the Serif/Sans preset and keeps that preset's size steps and
  measure; choosing Serif or Sans again clears it. A chosen font that is later
  uninstalled stays selected, is marked as not installed, and falls back to
  the included default. The installed-font list never leaves the device.
  Custom colors, custom CSS, imported editor themes, and per-project
  appearance are out of scope.
- **Notifications:** desktop delivery and system permission recovery. A persisted "Enable desktop notifications" switch is
  shared across desktop windows and enabled by default. Separate "Waiting for approval",
  "Chat finished" and "Chat did not finish" switches also default on. The master switch
  preserves these choices when turned off. Changing one category preserves other
  windows' category changes. Notifications cover pending agent approvals/questions
  and submitted task outcomes while the app is in the background; user-requested
  stops stay quiet. Disabled outcome notifications are not replayed later.
  The status explains
  unsupported systems and failed delivery; it does not equate API support with OS
  authorization. System settings and Focus/Do Not Disturb remain authoritative.
  An always-available system permission row explains how to allow notifications
  after declining. Its button opens the notification settings on macOS, Windows,
  GNOME or KDE; other Linux desktops or missing settings applications receive
  manual instructions. Launch failures retain those steps and offer Retry.
  Returning to the app refreshes notification-service availability and the
  settings entry point. OS authorization remains explicitly unknown: opening
  settings or delivering a notification does not establish permission. Recovery
  neither changes the app's switches nor replays old task outcomes.
  While StashBase runs, its system menu-bar/tray entry has an Open StashBase
  action, a Running section and Quit. Running shows only sessions with work still
  in progress, including startup, pending confirmation and stopping. Completed,
  failed and stopped work leaves the list. Rows show conversation titles; duplicate
  titles include the project. Selecting a chat opens its window and chat;
  a pending approval receives focus but is never approved. Counts live in
  the tray tooltip, keeping the menu quiet. Empty sections are omitted; without
  work the menu says No running chats. Notification opt-out does not hide work.
  The menu does not change the platform's existing last-window-close behavior.
  Upcoming scheduled tasks belong in a separate Upcoming section, ordered by
  next execution time and labelled with that time. This is an agreed presentation
  requirement, not an implemented scheduler: until a scheduling owner supplies
  live tasks and activation identities, no empty or fabricated task list appears.
  Background notifications mark the Dock/taskbar icon: a dot on macOS, an overlay
  on Windows, and a count where Linux launcher integration supports it. Pending
  confirmations retain the mark until resolved; background outcomes are
  acknowledged when their owning window is opened. Opt-out, retirement and
  application shutdown clear the corresponding marks. System permissions may
  suppress OS badges, and Linux desktops without a tray/launcher host may omit
  these surfaces without interrupting work.
- **Agents:** runtime installation, connection, and updates for Default, Codex,
  Claude, and Antigravity. An Open account shortcut leads to account settings. An installed runtime shows its
  version and offers Update when StashBase can select the resulting installation.
  Install and Update both use the provider's official native installer, without
  an installation-method choice. Updating an npm installation selects the
  verified native copy for subsequent sessions and leaves the npm copy intact.
  Explicit executable overrides remain authoritative; an override outside the
  native installation must be removed before updating through StashBase.
  The first explicit connection verifies that a discovered executable runs.
  A broken leftover launcher follows the official installation path in that
  same attempt, without first asking the reader to diagnose a sign-in failure.
  Discovery during startup never authorizes installation or repair.
  Each native agent checks its own sign-in status before readiness and offers
  its provider's browser sign-in when needed. An agent already signed in opens
  no browser, and sign-in completes as soon as the agent reports a signed-in
  account, even if its login command keeps waiting. The reader is asked for the
  browser only once the agent opens it; until then the row says StashBase is
  checking the agent's sign-in. While the browser step runs, its row offers Stop
  waiting, which ends the agent's login and leaves it signed out, offering Sign
  in again. It also offers the sign-in page the agent printed when that page
  finishes sign-in by itself, as Codex's does. Claude's printed page asks for a
  code to paste into its terminal, so Claude offers none. Antigravity has no separate
  sign-in command: its sign-in opens the browser from a terminal session
  StashBase starts, a pseudo-terminal on macOS and Linux and a console window on
  Windows, and closes it once Antigravity reports a signed-in account. It prints
  no sign-in page, so its wait offers none.
  A signed-in account the provider refuses, for example outside its available
  regions, reads as Account not accepted with the provider's own sentence. It
  offers a recheck, not another sign-in. So does a sign-in check the agent
  could not answer, which can come from an installed copy that does not run.
  Antigravity's check asks Google, so for a working Antigravity installation
  that Retry signs in, opening the browser when the check still cannot answer.
  A broken executable instead offers installation repair. The first-send
  connection follows this same recovery action before continuing its held send.
  An expired or invalid sign-in reported by a status check or a running
  conversation restores the sign-in action without clearing credentials.
  A later cached signed-in status cannot dismiss that refusal; recovery requires
  a successful explicit sign-in.
  Setup and update failures show the failed operation, stage, and available
  diagnostic in place, including service refusals and download errors.
  A runtime that reports a model its
  installed version cannot run leads its row with that model instead of its
  readiness; the requirement shown is the runtime's own, never one StashBase
  worked out.
- **General:** software updates and usage statistics/privacy preferences.
- **Advanced:** search by meaning and external apps (MCP). Search links directly
  to its configuration without discarding the current query. MCP reveals HTTP
  credentials only for that connection method; Docker details follow explicit
  configuration. Port changes require Docker access to be off. Development builds
  may also expose the document revision review disclosure here; production builds do not.

PDF/OCR setup is automatic. Waiting documents expose failed-download recovery
through the same shared component owner. Help owns bug reporting; development
simulators use a separate development-only entry. Neither belongs in normal Settings.

## Shared State and Recovery

- Long settings pages scroll inside their content pane. Hidden accessibility
  labels and status messages stay within that pane's positioning boundary;
  revealing a lower control must not scroll away the dialog title or close action.

- Settings declare their scope. Project agent preferences follow the project;
  missing model and effort choices inherit user-wide defaults separately for
  each agent, while an explicit project reset to Default takes precedence.
  Current account and embedding configuration are shared across windows.
- A failed read is not an empty configuration. Failed writes preserve unrelated
  settings and report failure; disposable caches cannot overwrite unreadable state.
- Later changes supersede pending validation or authentication. Stale completion
  cannot restore a removed key or signed-out account. Reconfigure only the dependent
  service; report a persisted change separately from a failed runtime restart.
- One browser sign-in wait serves each window's surfaces and survives closing
  Settings. Cancelling the local wait does not revoke browser authorization;
  new attempts and sign-out retire prior local continuations across windows.
- Every browser wait, for the account, connecting Google, or a native agent,
  reads "Finish signing in to {Name} in your browser.", where {Name} is the
  agent or StashBase. It offers the page it opened again, for a browser that
  did not open, and one Stop waiting. A browser that does not open never
  leaves a wait without a way on, and it does not spend a Google connection's
  email code. Claude is the exception: the page its login prints ends with a
  code to paste into its terminal, which StashBase does not relay, so its wait
  offers Stop waiting alone. A Claude sign-in finished in a terminal still
  completes the wait.
- The account's sign-in dialog stays open through its own browser wait.
  Leaving it leaves the wait running for the window, where the sign-in banner
  and Settings show it; opening sign-in again returns to the dialog on that
  wait. A first send waiting on the account is let go when the reader leaves
  the dialog, as [First Send](../journeys/chat.md#first-send) describes.
- Network/provider failure preserves credentials. Clear a session only on explicit
  sign-out or confirmed invalidation; repair does not implicitly send or replay work.
- Account sign-in offers Google or a six-digit email code through Better Auth.
  Email entry and verification stay inside the desktop application. Email entry
  places its full-width Send email code action before the Google alternative;
  the close control dismisses login without a separate Not now action. New emails
  create an account; using the original verified email preserves its identity,
  credits and subscription. Codes expire after five minutes; resend shows a
  cooldown and failed delivery never appears as a successful send. After delivery,
  the same form retains the destination email and adds a focused six-digit code
  field below it. Resend and its cooldown sit inside the code field's trailing
  action. The full-width primary action becomes Sign in, above the Google
  alternative. The email remains directly editable without a separate change
  action. Editing it retires the old attempt, clears the code and returns to
  sending while preserving the cooldown, so a code cannot target another mailbox.
- Settings → Account directly shows the primary email and Google connection,
  with explicit Connect Google / Disconnect Google actions. The account menu
  links to this same status page.
  The overview does not show a verification form or resend countdown. A successful
  change closes the verification dialog and shows its result on Account; a new change still
  respects the existing resend cooldown. Connecting or disconnecting Google requires a fresh code
  sent to that email. Verification opens a separate modal using the login layout, without the Google
  login alternative or its separator: a read-only
  destination email, a full-width Send email code action, then a focused code
  field with trailing resend/countdown after delivery. The primary action becomes
  Verify and connect/disconnect Google; the close control dismisses verification.
  The destination cannot be edited: this proves the current account, rather than
  changing its email or starting a separate login. Connecting then opens Google
  consent in the browser. Email codes remain enabled under the existing account
  rules; no activation flag is introduced. The Email row's Verify email entry
  opens the same modal for the current mailbox, using an authenticated mailbox
  proof and closing with an Email verified result. This does not create or replace
  the login session. Closing either proof aborts local work, clears its error,
  and prevents late responses from opening consent or changing the result.
  Starting another action clears the previous success message. Settings never embeds proof
  inputs or a resend countdown in its rows.
  A Google identity already owned by another account cannot be connected; there
  is no automatic merge. Disconnecting leaves email sign-in available.
- Account sessions use the StashBase API's Better Auth service.
  Desktop sessions remain host-owned and separate from browser sessions; signing
  out of the website does not sign the desktop out. Short-lived API tokens renew
  through the active server session. A switch from Supabase requires one fresh
  sign-in; existing subscriptions retain their imported user identity.
- Installed desktop apps return from the browser through their registered app
  protocol. Source development keeps the browser result visible and asks the
  developer to return to the running window; it must not launch generic Electron
  or replace the installed application's protocol handler.
- Desktop account authentication follows the operating system's proxy settings,
  including automatic proxy configuration. Sign-in failures identify the failed
  stage and the available DNS, connection, proxy, certificate or timeout code,
  with recovery guidance. Authorization codes, tokens and proxy credentials
  never appear in these diagnostics. A failed exchange requires a new sign-in
  attempt; it is not silently retried or sent directly around a failed proxy.
- A runtime too old for a chosen model is repaired where it failed: the turn
  offers the runtime's update, the conversation reconnects on the updated
  runtime, and the refused request is sent again. Settings offers the same
  update without a conversation. A failed installation or update retries that
  operation; reconnecting an existing copy alone does not count as an update.
  Retrying a failed first installation uses a copy that now runs, including
  one the user installed another way, instead of downloading again.
  Connecting a copy whose sign-in check could not answer checks the same way
  that it runs, and installs the official native copy when it does not, such
  as an npm or Homebrew copy missing its platform binary. The other copy stays.
  Identical setup requests share progress. A different request during setup is
  explicitly refused, naming the running operation. Service sentences state the
  cause only; the surface showing them offers Retry. Downloads,
  installation, and sign-in have bounded waits; timeout releases their process
  ownership before retry becomes available.
- A persona applies from its Chat's next message; a running turn keeps its
  guidance. It does not rewrite native instruction files or
  change permissions.
- External MCP rotation invalidates the old token. Disable retires exposed access
  promptly, including unfinished requests, while ordinary local work remains usable.

Default Agent reduces each model call's output budget to fit the remaining
credits. If a conservative UTF-8 input estimate leaves too little output, the
service can buffer up to half that input estimate at platform risk, while retaining
the full supplier reservation. User charges never exceed their reserved credits;
actual usage releases any surplus. A smaller budget may shorten or truncate the
response; remaining credits do not guarantee completion of a whole task. When the
buffered input and minimum output cannot fit, report insufficient credits for this request,
without claiming the balance is zero. A shorter conversation can reduce input
cost; otherwise the user can wait for refill or manage their plan.

The sidebar and Settings read the same available-credit snapshot. Refresh it when
opening the account menu, returning to the window, and finishing a Default Agent
turn (including failures and cancellations); poll while the signed-in surface is
mounted so other-device usage and settlement become visible. A stalled credit
refresh has a bounded wait, preserves sign-in, and can recover on a later read.
Desktop credit refresh uses the same system proxy as sign-in, including PAC;
it must not require a separate direct Internet connection after successful login.
A failed refresh
must not present an old percentage as current. Display temporarily reserved
credits separately from available credits: active requests and unconfirmed fees
both hold capacity, and that capacity is already excluded from the available
percentage. A refusal involving reservations explains the hold and directs the
reader to current credits rather than claiming all credits are spent.

## Other Settings Decisions

- Automatic update checks run throughout an open application, every 15 minutes
  and on foreground return or system wake, with a shared five-minute activity
  throttle. Disabling automatic checks still permits a manual check at any time.
  A check that finds a release, automatic or manual, downloads it in the
  background without a notice. The sidebar speaks up only when the download is
  ready, offering Restart to update. Ready downloads remain eligible for
  automatic checks, and Settings offers Check again alongside Restart to update.
  A matching release reuses the existing download; a newly selected release
  replaces it, with installation unavailable until that download finishes.
  A failed recheck preserves the ready installer and explains that the latest
  version could not be checked. A failed replacement download offers Retry and
  never installs the superseded package. A finished download never restarts the
  application by itself: installation is that explicit click, or the same action
  in Settings, and waits for affected document saves. Restart checks the latest
  release again and downloads its replacement, if needed, before requesting
  saves or closing windows, skipping intermediate releases. If that check fails,
  it shows the failed-recheck notice without installing; the reader can then
  explicitly restart into the disclosed ready version or choose Check again.
  Failure leaves the current application and downloaded update recoverable. Relaunch waits
  for the previous local service to release its port before opening the replacement.
  The same choice governs the background checks for newer agent runtime
  releases ([Agent Sessions](agent-sessions.md)).
  Development notification previews have no authority to invoke the updater.
  Offline, network-change, suspended-network and DNS failures during a check
  remain retryable and report as warnings. Repeated identical check warnings
  are counted in hourly windows; download, installation, certificate and
  integrity failures remain errors. Update requests that receive no headers or
  data for 60 seconds fail and remain retryable; a download that continues to
  make progress has no fixed total-duration limit.
- Packaged desktop builds and source runs disclose default-on usage statistics
  and detailed error diagnostics under one opt-out. Reports distinguish source
  from packaged activity without treating source use as necessarily development.
  Signing in associates the preceding anonymous
  activity with the stable StashBase account, across installations. Installation
  and person identities remain separate; signing out or switching accounts retires
  the prior anonymous identity. No hardware fingerprint or document/chat content
  participates. Local activity remains usable without signing in.
  Diagnostic explanations, paths, stack traces, nested causes and bounded process
  output are retained to support debugging. Known credential patterns are filtered;
  documents, chats, arbitrary provider payloads and whole logs are not collected.
  Bounded offline delivery preserves occurrence time and identity, follows the
  operating system's proxy settings like sign-in, and keeps undelivered events
  long enough to survive several weeks between uses. A submitted
  agent turn can retain content-free progress and its result across restarts.
  Once an agent accepts a task, reporting its execution does not depend on the
  interface's submission report arriving first. Short reporting retries never
  resend the task, block writing, or replay activity across an account/privacy change.
  If a prior host left no result, recovery reports an interrupted turn with an
  unknown outcome; it does not infer success, failure, or an exact end time.
  Lost connections and recoverable tool errors remain distinct from confirmed
  task failures. Content-free Agent/MCP file-operation outcomes and per-turn tool
  success/failure counts describe observed work separately from human foreground
  engagement. Actual HTML interaction counts as foreground reading; merely
  loading a page or running its scripts does not. Neither a successful tool nor
  a completed turn establishes that the user's goal was achieved.
  Delivery checkpoints distinguish observed refusals and losses from low use.
  They remain partial evidence: a closed renderer, unreadable storage or missing
  later checkpoint can leave delivery unknown. Opt-out stops
  pending delivery and erases queued work; re-enabling never backfills disabled
  activity. A signed-in account can be associated again after re-enabling.
  [Usage statistics](../../docs/usage-statistics.md) owns the event definitions,
  identity conventions, measurement limits and operator return views.
  Automated tests and explicitly suppressed development or packaged checks
  disable collection before startup without
  changing the user's saved preference or analytics state.
- Bug reporting is a separate explicit review and local handoff. The approved
  snapshot cannot change during preparation; StashBase does not submit the report.

## Related Journeys

[J01](../journeys/README.md#j01-complete-onboarding-and-reach-first-value),
[J06](../journeys/README.md#j06-start-and-continue-an-agent-chat),
[J08](../journeys/README.md#j08-connect-an-external-agent-through-mcp),
[J09](../journeys/README.md#j09-prepare-and-hand-off-a-bug-report).

[Chat](../journeys/chat.md) owns first-send interaction. Implementation:
[credentials](../../code-review/architecture.md#credentials-and-external-access),
[updates](../../code-review/architecture.md#native-lifecycle-and-updates), and
[reporting](../../code-review/architecture.md#bug-report).


## Default Agent Subscriptions

A window that is signed out shows a banner in the notice strip, with or
without a folder open: "Sign in for free agent credits every month." with Sign in
and Not now. It states what signing in gives, neither a commitment to use the
Default Agent nor the allowance's terms, which Settings → Account shows. A completed sign-in or Not now answers it for
the installation until the next sign-out, which brings it back: signed out, the
reader is where the banner first found them. The sidebar account row
opens account access, and the banner starts the same sign-in.

Plus and Pro add hosted Default Agent capacity; local files, writing tools,
Claude, Codex, and Antigravity access, and BYOK search remain independent. Settings → Account shows
the signed-in account's plan, beside its credits; Plans and billing in the
sidebar account menu opens it there. A Free account sees each tier with its price and
Subscribe; a subscribed account sees its plan, paid-through or end date, and
Manage or cancel while the plan still renews. After cancellation, the same
portal action reads Manage billing, since nothing is left to cancel. Subscribe asks the hosted API, as the desktop account, for a
Stripe Checkout page and opens it in the system browser, so paying never requires
a website sign-in. Manage or cancel opens the Stripe Customer Portal the same
way. The desktop host holds the session token and verifies that the returned page
is Stripe-hosted; the renderer receives only that page, and no desktop session
token travels in a link. Promotion codes are entered on the Checkout page, which
shows the discount and renewal terms. Opening billing never sends a draft.

After Checkout opens, Settings shows that it is waiting for payment and polls
subscription rights, also re-reading them when the window regains focus. It stops
polling after two minutes and keeps the purchase buttons hidden until the reader
refreshes or dismisses the wait. Returning to the app restarts this bounded
confirmation window, including after a long Checkout. Management remains available
while confirmation is pending. Portal opening names the browser handoff; failures
clear the busy state and offer a retry. Billing HTTP requests have a twenty-second
HTTP deadline shared by retries; authentication retains its separate bounded
refresh call. System browser acknowledgement has a
ten-second deadline. Dismiss only closes the local wait and does not cancel a plan.
Confirmed rights refresh the credit balance. Portal return also polls for updated
rights, including cancellation and plan changes. Cancellation explicitly says
renewal is canceled and gives the remaining access date.
The browser returns to the website's pricing page, whose Return to StashBase button
works without a website session. Its data-free native link only focuses the app; The website remains an independent purchase
path for a browser-signed-in account.

Stripe owns prices, promotion codes, and payment management. The hosted API owns
subscription rights and usage. A discounted subscription receives its full tier
allowance. The first-ever Plus subscription receives its first month free with a
card and automatic renewal through a native Stripe trial, then renews at $5/month. Stripe sends a reminder seven days before the trial ends, with a cancellation link; the operator enables and verifies this Dashboard setting. It includes the full Plus
allowance and cannot combine with other promotions. Previous subscriptions or
trials make an account ineligible; abandoned Checkout does not. Canceling renewal
preserves access until the current month ends. Subscription credits follow the confirmed trial period and then each successfully paid monthly billing period.
A paid upgrade preserves consumption and adds the allowance difference in proportion
to the settled payment over the monthly price difference, capped by the new tier.
Free credits use a separate calendar-month window anchored by first hosted use,
with month-end clamping and no rollover; there is no first-week grant. Paid
allowances replace the free ceiling: Plus costs $5/month, and Pro costs $20/month
with ten times the Plus allowance. Customer-facing copy states no credit amounts
in dollars. Canceling during the trial keeps Plus until it ends without a charge;
upgrading to Pro during it ends the trial, charges Pro's full monthly price and
starts a new paid month with its full allowance after payment confirmation.
Paid upgrades use Stripe prorations. Downgrades take effect at the next renewal:
the current plan and allowance remain unchanged, with no current-period refund.
Settings and the website show the scheduled target and date, with confirmed
actions to withdraw the downgrade, cancel automatic renewal, or resume renewal.
These account actions remain available while a Stripe schedule prevents Portal
subscription editing. Pending changes display confirmation progress and block
conflicting actions until the API finishes or reports a definitive failure.
Cancellation retains access until paid-through, then returns to Free.
A browser success redirect is not evidence of payment; pending confirmation stays
visible until the API confirms rights. Failed billing does not discard local work.

Unconfirmed fees stop occupying user credits after five minutes from the first
uncertain outcome. Reading credits or retrying triggers due refunds even when
the background recovery worker is delayed. Refunds are permanent for the user;
late provider accounting changes platform cost only. Normal active generations
do not become free just because execution lasts five minutes. Service safety
limits still apply to repeated failures and platform-paid waivers.
