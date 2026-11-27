## What and why


## Checklist
- [ ] CHANGELOG entry added at the top of `pmis/CHANGELOG.md`, with every choice made
- [ ] Contract first: `pmis/contracts/openapi.yaml` updated (Versions list and version line), `npm run gen:api` leaves no diff
- [ ] Tests added or updated; API and web checks pass locally
- [ ] Migration (if any): additive, number unique on `main` and in open pull requests, mirror in `pmis/db/sql` numbered one less and byte-identical
- [ ] New table (if any): `data_reset_plan` decision, `pmis_reset_owner` grants, row in `pmis/docs/ops/data-reset.md`
- [ ] No accumulating SQL function rebuilt from an old body (patched, or carries every earlier part)
- [ ] No permission, role, grant or default change unless it is the stated purpose of this pull request
- [ ] Permissions come from the responsibility matrix; a new register has matrix rows and Settings
- [ ] `en.json` and `ar.json` keys added
- [ ] No secret, real data or real address; the term is "Site Master"

## Places covered
List every register and screen the change covers.

## Places left out
List every place deliberately left out, with the reason. Write "none" if there is none.
