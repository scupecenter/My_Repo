# Map tiles (ops note)

- Contract 0.15.341, migration 0412. The setting is `ui.features`, section `map`. Default: off, empty address.
- The tile address must be a path on this server containing `{z}`, `{x}` and `{y}`; no host, no `//`, no `..`. The API rejects anything else (422), so the page security policy (`img-src 'self' data: blob:`) needs no change.
- The installer serves `/tiles/` from `TILES_DIR` only when that variable is set; the location repeats the four security headers and the CSP line like the other locations (`tools/install/test-nginx-headers.sh` checks them).
- No new dependency, no outside account, no outside request.
