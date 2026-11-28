# Photo fields (decision 32)

Seven document types of kind `photo` (migration 0470) give a photo field to places that had none. They use the unified documents system, so nothing is built twice: the record page shows the slot, upload and withdrawal are audited, and the Gallery lists the photos by itself (kind `photo`).

| Place | Document type code | Register and record type |
|---|---|---|
| Warehouse, condition at receipt | PHOTO_WH_RECEIPT, PHOTO_WH_RECEIPT_CW | warehouse, te_rn and cw_rn |
| Warehouse, condition at return to the supplier | PHOTO_WH_RETURN | warehouse, sup_dn |
| Demolition, before and after | PHOTO_DEMO_BEFORE, PHOTO_DEMO_AFTER | dismantle |
| Handover (HOTO) | PHOTO_HOTO | readiness_handover |
| HSE safety and incidents | PHOTO_HSE | permits_hse |

Defaults: optional, at least 1 photo, images only (jpg, jpeg, png, webp, heic), 20 MB. Mandatory or optional and the minimum number of photos are changed per type in Settings > Documents > Document types. Switching a type off removes its field. Existing types are never touched by the migration.

Not covered here: field visits and daily reports (no register of their own; see the PR body).
