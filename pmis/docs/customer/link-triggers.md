# Link triggers: a register change proposes a new version of another record

A link trigger watches one register and, when a condition is met, proposes a new version of a linked record. It never changes an approved record by itself.

1. An administrator opens Settings, Alerts, Link triggers, and adds a trigger. Each trigger is off until it is switched on, one link at a time.
2. Press "Preview" to see what the trigger would propose now. A preview changes nothing.
3. The daily job creates a proposal for each match and sends a notification to the holders of the entry. It also writes one audit row with the counts.
4. The holder opens "Link proposals", reads the before and after values and presses "Apply" or "Dismiss".
5. "Apply" creates a new version of the record as the holder and saves the values. The responsibility matrix and the approval chain apply as for any manual change. The approved version stays as it is until the new version is approved.

Nothing is written in place on an approved record. Permissions are not changed.
