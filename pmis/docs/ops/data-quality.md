# Data quality report

Settings > Data > Quality shows a read-only report of data that looks wrong and the setting that switches its checks on.

- The report writes nothing. It reads sites, tasks and document slots with the regions of the person (the `sites` view), and a region filter can narrow it further.
- Rows name the site and what is wrong. They never show the value of a field.
- Checks (each is switched on in the setting `data_quality.report`):
  - `site_required_empty`: active sites where a chosen site field is empty. The fields come from a closed list in the setting.
  - `dates_out_of_order`: tasks whose planned or actual start is after the planned or actual date.
  - `site_without_contractor`: active sites where no task has an external party (contractor or team).
  - `orphan_ids`: id columns that point to a record that no longer exists (constraint names and counts from `fk_orphan_report()`, see relations-map 4.5). System Admin or a settings viewer only.
  - `missing_photos`: slots whose type has `photo_rules.min_count` (D6) and fewer current image files than that minimum.
- Setting: `GET`/`PUT /settings/data-quality`, System Admin or an all-regions delegate of settings edit, a reason, a step-up and If-Match, one audit row `data_quality_update`.
- No new table, so nothing is added to the data reset plan. Nothing is public, no permission is widened, nothing is deleted or hidden.
