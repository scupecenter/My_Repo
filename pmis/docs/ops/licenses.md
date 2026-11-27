# Licenses of the packages we ship

- The product is all rights reserved (`LICENSE`). The owner has not chosen an open source license.
- Every production dependency must be under a permissive license. The allowlist is in `tools/check-licenses.sh`: MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, Unlicense, OFL-1.1, and the two combined forms `(MIT AND Zlib)` and `(MIT OR GPL-3.0-or-later)` (used under MIT).
- The check runs as a step of the `Dependencies` job in `.github/workflows/security.yml`, so the number of required checks stays 8. A package with any other license fails that job.
- To add an exception, review the package, add it by exact name and version to `skip` in the script, and say why in `THIRD_PARTY_NOTICES.md`.

Run it locally (from `pmis/`):

```bash
(cd apps/api && npm ci --ignore-scripts --omit=dev) && (cd apps/web && npm ci --ignore-scripts --omit=dev) && bash tools/check-licenses.sh
```

Regenerate `THIRD_PARTY_NOTICES.md` after a dependency change: run `npx license-checker-rseidelsohn@4.3.0 --production --json --excludePrivatePackages` in `apps/api` and `apps/web` and update the two tables.

Fonts: the Cairo license text sits next to the font files (`apps/web/src/assets/fonts/OFL.txt`), as the Barlow one does in the reference folder.
