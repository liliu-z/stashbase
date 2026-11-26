import { z } from 'zod';

export const NOTIFICATIONS_CAPABILITY = 'notifications';
export const NOTIFICATIONS_SYNC = 'notifications:sync';
export const NOTIFICATIONS_READ = 'notifications:read';
export const NOTIFICATIONS_OPEN_SETTINGS = 'notifications:open-settings';
export const NOTIFICATIONS_ACTIVITY = 'notifications:activity';
export const NOTIFICATIONS_OPEN_SESSION = 'notifications:open-session';
export const NOTIFICATIONS_SET_ENABLED = 'notifications:set-enabled';
export const NOTIFICATIONS_CHANGED = 'notifications:changed';
export const NOTIFICATIONS_ACTIVATE = 'notifications:activate';

const identifier = z.string().min(1).max(1200);
const sessionActivitySchema = z.object({
  id: identifier,
  project: z.string().max(160),
  conversation: z.string().max(160),
  state: z.enum(['working', 'waiting']),
  detail: z.string().max(80),
}).strict();
export const sessionActivitiesSchema = z.array(sessionActivitySchema).max(256).superRefine((items, ctx) => {
  if (new Set(items.map((item) => item.id)).size !== items.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Session identities must be unique.' });
});
export const sessionActivationSchema = z.object({ id: identifier }).strict();
export type SessionActivity = z.infer<typeof sessionActivitySchema>;
export const notificationKindSchema = z.enum(['agent-confirmation', 'agent-completed', 'agent-failed']);
/** Register each new producer here with its own bounded data, then supply its
 * presentation in the main-process catalog. No arbitrary URLs or actions cross. */
const eventFields = {
  id: identifier,
  project: z.string().max(160),
  conversation: z.string().max(160),
};
const notificationEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent-confirmation'), ...eventFields }).strict(),
  z.object({ kind: z.literal('agent-completed'), ...eventFields }).strict(),
  z.object({ kind: z.literal('agent-failed'), ...eventFields }).strict(),
]);
export const notificationBatchSchema = z.object({
  kind: notificationKindSchema,
  events: z.array(notificationEventSchema).max(256),
}).strict().superRefine((batch, context) => {
  if (batch.events.some((event) => event.kind !== batch.kind)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification kinds must match their batch.' });
  }
  if (new Set(batch.events.map((event) => event.id)).size !== batch.events.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification identities must be unique within a batch.' });
  }
});
export const notificationActivationSchema = z.object({
  kind: notificationKindSchema,
  id: identifier,
}).strict();
export const notificationPreferenceSchema = z.object({
  enabled: z.boolean(),
  categories: z.object({
    'agent-confirmation': z.boolean(),
    'agent-completed': z.boolean(),
    'agent-failed': z.boolean(),
  }).strict(),
}).strict();
export const notificationUpdateSchema = z.object({
  enabled: z.boolean(),
  kind: notificationKindSchema.optional(),
}).strict();
export type NotificationPreferences = z.infer<typeof notificationPreferenceSchema>;
const notificationSettingsTargetSchema = z.enum(['macos', 'windows', 'gnome', 'kde', 'manual']);
export type NotificationSettingsTarget = z.infer<typeof notificationSettingsTargetSchema>;
export const notificationStatusSchema = notificationPreferenceSchema.extend({
  supported: z.boolean(),
  settingsTarget: notificationSettingsTargetSchema,
  delivery: z.enum(['unknown', 'sent', 'failed']),
}).strict();
export type NotificationKind = z.infer<typeof notificationKindSchema>;
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
export type NotificationBatch = z.infer<typeof notificationBatchSchema>;
export type NotificationActivation = z.infer<typeof notificationActivationSchema>;
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;
