# Automation centre

Settings > Alerts > Automation (System Admin only). It shows what the system does for you when something happens: "When ... then notify ...".

- Every automation is an alert rule. The only action is a notification. Nothing is changed in any record, state or permission.
- Each card shows the condition in words, who is notified, whether it is on, and when it last ran and for how many targets.
- Templates are ready-made rules (weekly status missing, an issue idle for 7 days, and the kinds you already have). "Use this template" asks for a reason and creates a normal alert rule that is switched on. Change it later in Manage rules.
- The system runs the rules every day. Each run is listed under Recent runs with "System" as the one who ran it. A run that notified someone is also in the Audit Log as `alert_rule_run`, with no user.
- Who may manage the rules did not change: System Admin.
