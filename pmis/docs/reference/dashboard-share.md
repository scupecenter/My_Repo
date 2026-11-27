# Dashboard share links (0546, contract 0.15.501)

A durable, revocable link to a read-only dashboard view, from the owner's decision of 2026-11-26 00:51.

## What a link is

A link is only an envelope: a label plus the GET /dashboard query (`ref_date`, `region_id`, `cluster_code`, `scenario`, `stream`, `view`, `exclude_overrides`). It grants nothing by itself. Whoever opens it signs in with their own account, and the data they see comes from the normal GET /dashboard of *that* user, so role tabs and region visibility are always the opener's own — a person without `dashboard.view` can open the envelope but the dashboard still refuses them.

## Create

Dashboard toolbar → Share. Pick a label, an expiry (7, 30, 90 or 365 days; default 30) and give a reason (required, audited). The dialog copies the full link `/dashboard/shared/<token>`.

## Manage

Settings → Dashboard → Share links lists your links (a System Admin sees everyone's) with opens, state (active / expired / revoked) and Revoke, which also takes a reason. Revoking or expiry closes the link: opening it afterwards answers `410 gone`, an unknown token is a plain `404`.

## Audit

Every create, open, refusal (expired or revoked) and revoke is in `audit_log` (`dashboard_share_created`, `dashboard_share_opened`, `dashboard_share_refused`, `dashboard_share_revoked`) with the actor and reason.

## API

- `POST /dashboard/share-links` — `{ label?, params, days?, reason }` → the link, its `token` and `path`.
- `GET /dashboard/share-links` — my links (all links for a System Admin).
- `POST /dashboard/share-links/:id/revoke` — `{ reason }` → closes the link.
- `GET /dashboard/shared/:token` — the envelope (`label` + `params`), counts and audits the open. 404 unknown, 410 expired or revoked.

Everything goes through definer doors (`dashboard_share_create`, `dashboard_share_revoke`, `dashboard_share_resolve`) that check the right, take the reason and audit; see migration `0546_dashboard_share_links`.
