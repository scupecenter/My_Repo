import { z } from "zod";

/** The notification kinds a destination may listen to (the database checks the same list). */
export const OUTBOUND_EVENT_KINDS = [
  "task_assigned",
  "task_rejected",
  "reassigned",
  "assignment_request",
  "followed_change",
  "site_draft_assigned",
  "site_draft_approved",
  "site_draft_returned",
  "absence_alert",
  "import_batch",
] as const;

const reason = z.string().trim().min(3).max(1000);

/** PUT /settings/integrations/outbound/enabled (contract 0.15.475). */
export const outboundEnabledPutSchema = z.object({ reason, enabled: z.boolean() }).strict();

/** POST and PUT of a destination. A webhook needs an https URL; the secret is required on create and optional (kept) on update. */
export const outboundDestinationSchema = z
  .object({
    reason,
    kind: z.enum(["webhook", "email"]),
    label: z.string().trim().min(1).max(120),
    target: z.string().trim().min(5).max(500),
    secret: z.string().min(16).max(200).optional(),
    events: z.array(z.enum(OUTBOUND_EVENT_KINDS)).min(1).max(OUTBOUND_EVENT_KINDS.length),
    active: z.boolean().default(true),
  })
  .strict();

export const outboundArchiveSchema = z.object({ reason, archived: z.boolean().default(true) }).strict();
