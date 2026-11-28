# Thumbnails and the data reset

Thumbnails are derived data kept under the key prefix `thumbs/`, beside the originals. They are never a source of truth and are made again on request.

- Full data reset: when the files of the deleted rows move to the quarantine, the thumbnails of those files move with them (found by reading the `thumbs/` folder, so a thumbnail made under an older size setting is found too). They are not recorded as rows because they are not in the database.
- Withdrawal of a file: the row and the original stay (hide, never delete). The generated thumbnails of the current size settings are removed. A failure never stops the withdrawal.
- No new table, no migration, no new setting.
