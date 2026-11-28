# HTTPS security headers (nginx)

The API does not set `Strict-Transport-Security`: nginx ends TLS in front of it, and the installer (`tools/install/install-ubuntu.sh`) writes the headers there.

The HTTPS server sends `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`.
nginx drops server-level `add_header` lines inside a `location` that has its own `add_header`. So `/assets/`, `/mockServiceWorker.js`, `/sw.js` and `/manifest.webmanifest` (Field mode, 0411: both `no-cache`) and `/index.html` repeat the four headers (SEC-5, phase 1 security review). `/api/` sets none of its own and inherits them.

Check on a live server:

    curl -sI https://SERVER/ | grep -i -E 'strict-transport|x-content-type|x-frame|referrer-policy'
    curl -sI https://SERVER/assets/<any file> | grep -i strict-transport

If you add a location with its own `add_header`, repeat the four lines there. `tools/install/test-nginx-headers.sh` (also run by CI) fails when one is missing.

## Content-Security-Policy (SEC-3)

The installer sends the policy as `Content-Security-Policy-Report-Only` by default, so nothing is blocked while violations are collected. Browsers post them to `POST /api/v1/csp-report`; the API logs a short line (`csp violation ... directive=... blocked=<origin> page=<path>`) the first time and every 100th time it sees the same one.

    sudo journalctl -u gsdn-pmis-api | grep 'csp violation'

When no unexpected line appears after normal use in English and Arabic, turn it on: `sudo CSP_MODE=enforce ./install-ubuntu.sh` (kept in `install.conf`; `CSP_MODE=off` removes it, `CSP_MODE=report-only` goes back). The policy allows only this server's own scripts, styles (inline styles are needed by React), images (also `data:` and `blob:`), fonts, connections, and `blob:` frames for the PDF preview. Anything from another origin shows up as a violation: if one is added to the product later, the policy line in `install-ubuntu.sh` must be changed with it.
