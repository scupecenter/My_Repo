# SLA penalty calculator (2026-11-28)

Penalty = days late x the daily rate of the contractor, never more than the cap. Shown per contractor in the performance view (Reports > Contractors).

- Days late (computed on read, nothing stored): the snags of the contractor past their target date while open, or closed after it (`target_date`), plus the delay days of its issues (the same two sources the performance view already reads). Both parts are shown next to the total.
- Rates: the optional `penalty` part of the guarded setting `contractors.performance` (Settings > Registers > Contractors): a default rate per day, a currency, an optional cap per contractor and a rate per contractor. Same right, reason, If-Match and audit as the thresholds. No rate means no penalty. No new table, endpoint or permission.
- Money visibility: the amount, the rate and the stored rates are shown only to a caller who can edit the setting or may read the financial advances. Everyone who may read the view sees the days late.
- Dashboard scorecard: unchanged. That card carries no amounts by design; proposal: add a total of days late there (no amounts) if wanted.
- Not included: invoicing or deducting the penalty (the invoices register is untouched), a grace period, per-snag rates.
