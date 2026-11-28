# Automation centre

Settings > Alerts > Automation (System Admin only). It shows what the system does for you when something happens: "When ... then notify ...".

- Every automation is an alert rule. The only action is a notification. Nothing is changed in any record, state or permission.
- Each card shows the condition in words, who is notified, whether it is on, and when it last ran and for how many targets.
- Templates are ready-made rules (weekly status missing, an issue idle for 7 days, and the kinds you already have). "Use this template" asks for a reason and creates a normal alert rule that is switched on. Change it later in Manage rules.
- The system runs the rules every day. Each run is listed under Recent runs with "System" as the one who ran it. A run that notified someone is also in the Audit Log as `alert_rule_run`, with no user.
- Who may manage the rules did not change: System Admin.

## Default rules and the weekly data-completeness reminder

The daily run puts a small set of rules in place the first time it runs, if a System Admin exists:

- One "idle record" rule per main register that is enabled (acquisition, procurement, change control, issues, risks, RF design, permits, GECOL, HLC). It tells the people of that module about a record that stayed in its entry state for 14 days.
- A weekly data-completeness rule. Once a week, for each region with active sites that have missing data (a delivery scenario not set, or a task with no actual date while a later task already has one), the people who work on the sites of that region get one notification with the count and a link to the sites with data gaps.

These are ordinary rules. You can edit them, change the days or the audience, or switch them off in the Automation centre; once switched off they are not switched on again. You can also create your own "Data gaps in sites" rule with a minimum number of sites.

## Closed record with an open linked record

The rule kind "Closed record with an open linked record" checks the register links declared in Settings. Once a week, for each link that has at least the minimum number of approved records whose linked record (in the other register) is still open, neither approved nor voided, the audience of the rule gets one notification with the count. Leave the register and field empty to check every link. It only sends a notification; no record is changed.

## Preview and log of a rule

Each rule card has two buttons. "Preview now" shows what the rule would send today (how many items and how many notifications, with the targets) and sends nothing; it also works for a rule that is switched off. "Log" shows the last times the rule fired. Both are for System Admins and only read.
