# Expiry radar (0360, screen 0760)

The daily job `expiry_radar_notify()` writes an in-app notice to the Matrix holders of a register row when a date that ends something is close (permit valid to, lease expiry, billing conversion, equipment due date). One notice for the tightest lead time reached.

## Settings screen (contract 0.15.640)
Settings > Alerts > Expiry radar (System Admin or a delegate of `admin.settings` for all regions). It edits the setting `expiry.radar`:
- the switch (off: no notice is written);
- for each watched register: the date field (any active date field of an active, enabled register) and 1 to 6 lead times, 1 to 365 days;
- saved with a reason, If-Match and an audit row `expiry_radar_update` (before and after). `GET` and `PUT /settings/expiry-radar`.

## What stays where
- Who is warned: the Matrix row of the register and region (unchanged).
- Mail: the kind `expiry_radar` is mailed only when added in Alerts > Mail (unchanged).
- Records are never changed by the radar.
