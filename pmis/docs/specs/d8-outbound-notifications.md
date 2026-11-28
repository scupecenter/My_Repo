# D8: outbound notifications to a webhook or an email address

Status: built in this PR (migration 0613, contract 0.15.475). Source: the D8 spec (docs/plans/2026-11-27-spec-d8-webhooks-email-out.md). The picks below were relayed by the parent on 2026-11-28 10:08 and are listed in the PR body as assumptions to confirm.

## What it does
An admin turns on Settings > Alerts > Outbound. From then on, each new in-app notification of a chosen kind is also sent to every active destination that listens to that kind. Off by default; nothing is sent, queued or called while it is off.

## Reused, not duplicated
- Notifications table and kinds: the events are the existing notification kinds (`outbound_event_kinds()`), no second event catalogue.
- Email: the existing mail outbox (`mail_enqueue_internal`, its worker, SMTP and retry settings).
- Secret: the existing AES-256-GCM helper and key (`encryptSecret`, `TOTP_ENC_KEY`); the destination id is the authenticated data. The secret is write-only.
- Lock: the `disable_export` security lock stops all sending.
- Worker: the same pattern as the mail worker (claim with SKIP LOCKED and a lease, mark, one job_runs row `outbound_send`).

## Payload
`event`, `title`, `notification_id`, `task_id`, `link`, `at`. Never the recipient, never the body.

## Webhook
https only; the host must resolve to public addresses (loopback, private, link-local, carrier-grade NAT, unique-local, multicast are refused, checked at save and again at send); no credentials in the URL; redirects are not followed; 10 s timeout; headers `x-gsdn-timestamp` and `x-gsdn-signature: sha256=<hex>` (HMAC SHA-256 over `<timestamp>.<body>`). 3 attempts (after 1 and 5 minutes), then `dead`.

## Data
`outbound_destinations` (configuration, kept by a data reset, archived never deleted) and `outbound_deliveries` (a log, one row per destination and notification). Setting `integrations.outbound_enabled`. Every change is audited with a reason; the audit rows never hold the secret.

## Known limit
The address is checked just before the request, but the request resolves the name again. A name that changes its answer in between could pass the check. An egress firewall on the API host closes that gap; recommended.
