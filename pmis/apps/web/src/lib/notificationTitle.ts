/** Inbox titles in the user's language (visual review 2026-11-27, item 1). The server stores the title in English; the display maps the known
 * titles (and the few with a code or name in them) to i18n keys under `inbox.*`, and shows anything else exactly as stored (it is data). English
 * shows the stored text as is. */
import type { TFunction } from 'i18next';

const EXACT: Record<string, string> = {
  "A new site was approved": "t_a_new_site_was_approved",
  "Approval reminder": "t_approval_reminder",
  "Approval escalated": "t_approval_escalated",
  "Task idle": "t_task_idle",
  "Level has no holder": "t_level_has_no_holder",
  "No holder for a task level": "t_no_holder_for_a_task_level",
  "No holder for a register level": "t_no_holder_for_a_register_level",
  "No holder for a snag level": "t_no_holder_for_a_snag_level",
  "No holder for a permit draft": "t_no_holder_for_a_permit_draft",
  "You were mentioned": "t_you_were_mentioned",
  "A task is ready to start": "t_a_task_is_ready_to_start",
  "A followed site changed": "t_a_followed_site_changed",
  "A followed record changed": "t_a_followed_record_changed",
  "A snag waits for photos of the fix": "t_a_snag_waits_for_photos_of_the_fix",
  "Photos of a snag fix wait for your approval": "t_photos_of_a_snag_fix_wait_for_your_approval",
  "A snag you fixed was approved and closed": "t_a_snag_you_fixed_was_approved_and_closed",
  "A snag fix was returned to you": "t_a_snag_fix_was_returned_to_you",
  "A snag fix was returned": "t_a_snag_fix_was_returned",
  "A register record waits for you": "t_a_register_record_waits_for_you",
  "A register record was returned to you": "t_a_register_record_was_returned_to_you",
  "A register record was returned": "t_a_register_record_was_returned",
  "Approval path changed to two levels": "t_approval_path_changed_to_two_levels",
  "A task is waiting for your approval (L2)": "t_a_task_is_waiting_for_your_approval_l2",
  "A record is waiting for your approval (L2)": "t_a_record_is_waiting_for_your_approval_l2",
  "Procurement approved: HLC execution data can be entered": "t_procurement_approved_hlc_execution_data_can_be_entered",
  "A task was returned to you": "t_a_task_was_returned_to_you",
  "A task was returned": "t_a_task_was_returned",
  "Review the type of a contractor": "t_review_the_type_of_a_contractor",
  "A task was reassigned to you": "t_a_task_was_reassigned_to_you",
  "A task of yours was reassigned": "t_a_task_of_yours_was_reassigned",
  "Set an L2 holder: a converted task is held": "t_set_an_l2_holder_a_converted_task_is_held",
  "Set an L2 holder: a converted record is held": "t_set_an_l2_holder_a_converted_record_is_held",
  "A permit draft was moved to you": "t_a_permit_draft_was_moved_to_you",
  "Your permit draft was moved": "t_your_permit_draft_was_moved",
  "A new site waits for approval": "t_a_new_site_waits_for_approval",
  "A new site was returned to you": "t_a_new_site_was_returned_to_you",
  "A project data reset waits for your approval": "t_a_project_data_reset_waits_for_your_approval",
  "The project data reset can run soon": "t_the_project_data_reset_can_run_soon",
  "The project data reset is waiting before it can run": "t_the_project_data_reset_is_waiting_before_it_can_run",
  "A running order no longer matches its team or contract": "t_a_running_order_no_longer_matches_its_team_or_contract",
  "An email could not be delivered": "t_an_email_could_not_be_delivered",
  "Assignment requested": "t_assignment_requested",
  "Confirm a tentative holiday": "t_confirm_a_tentative_holiday",
  "Email change to approve": "t_email_change_to_approve",
  "Phone change to approve": "t_phone_change_to_approve",
  "Notification policy: a protected setting changed": "t_notification_policy_a_protected_setting_changed",
  "Tomorrow Plan is empty": "t_tomorrow_plan_is_empty",
  "You are exempt from the GSDN Workspace MFA requirement": "t_you_are_exempt_from_the_gsdn_workspace_mfa_requirement",
  "Your MFA exemption was revoked": "t_your_mfa_exemption_was_revoked",
  "Your upload was approved by a System Admin": "t_your_upload_was_approved_by_a_system_admin",
  "Rows of your upload were returned": "t_rows_of_your_upload_were_returned",
  "Rows of your upload were decided": "t_rows_of_your_upload_were_decided",
  "Your email change was approved": "t_your_email_change_was_approved",
  "Your email change was rejected": "t_your_email_change_was_rejected",
  "Your phone change was approved": "t_your_phone_change_was_approved",
  "Your phone change was rejected": "t_your_phone_change_was_rejected",
  "A team safety certificate has expired": "t_a_team_safety_certificate_has_expired",
  "A team safety certificate expires soon": "t_a_team_safety_certificate_expires_soon",
  "Holiday dates are tentative": "t_holiday_dates_are_tentative"
};

const PATTERNS: [RegExp, string][] = [
  [/^SLA escalation: (.+)$/, 'p_sla_escalation'],
  [/^Reminder: (.+)$/, 'p_reminder'],
  [/^A site moved to your region: (.+)$/, 'p_site_moved_region'],
  [/^Absence recorded: (.+)$/, 'p_absence_recorded'],
  [/^Weekly summary, week of (.+)$/, 'p_weekly_summary'],
  [/^(.+) waits for your approval$/, 'p_waits_approval'],
  [/^(.+) was returned with a note$/, 'p_returned_note'],
  [/^(.+): nobody can act on the (.+) level\.$/, 'p_nobody_level'],
];

export function notificationTitle(title: string, lang: string, t: TFunction): string {
  if (lang.startsWith('en')) return title;
  const key = EXACT[title];
  if (key) return t(`inbox.${key}`);
  for (const [re, k] of PATTERNS) {
    const m = re.exec(title);
    if (m) return t(`inbox.${k}`, { x: m[1], y: m[2] ?? '' });
  }
  return title;
}

/** True when a literal the server writes (whole title, or the fixed part of a title with a code or name after it) has a mapping. Used by the CI guard. */
export function isMappedTitleLiteral(lit: string): boolean {
  const l = lit.trim();
  if (EXACT[l]) return true;
  return PATTERNS.some(([re]) => re.test(`${l} x`) || re.test(`${l}x`) || re.test(l));
}
