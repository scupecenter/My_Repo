# HTTPS security headers (nginx)

The API does not set `Strict-Transport-Security`: nginx ends TLS in front of it, and the installer (`tools/install/install-ubuntu.sh`) writes the headers there.

The HTTPS server sends `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`.
nginx drops server-level `add_header` lines inside a `location` that has its own `add_header`. So `/assets/`, `/mockServiceWorker.js` and `/index.html` repeat the four headers (SEC-5, phase 1 security review). `/api/` sets none of its own and inherits them.

Check on a live server:

    curl -sI https://SERVER/ | grep -i -E 'strict-transport|x-content-type|x-frame|referrer-policy'
    curl -sI https://SERVER/assets/<any file> | grep -i strict-transport

If you add a location with its own `add_header`, repeat the four lines there. `tools/install/test-nginx-headers.sh` (also run by CI) fails when one is missing.
