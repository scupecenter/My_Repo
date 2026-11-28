# Map tiles (ops note)

- Contract 0.15.341, migration 0412. The setting is `ui.features`, section `map`. Default: off, empty address.
- The tile address must be a path on this server containing `{z}`, `{x}` and `{y}`; no host, no `//`, no `..`. The API rejects anything else (422), so the page security policy (`img-src 'self' data: blob:`) needs no change.
- The installer serves `/tiles/` from `TILES_DIR` only when that variable is set; the location repeats the four security headers and the CSP line like the other locations (`tools/install/test-nginx-headers.sh` checks them).
- No new dependency, no outside account, no outside request.

## Building the tiles on this server (`tools/install/install-map-tiles.sh`)

- One command, once: `sudo bash tools/install/install-map-tiles.sh` (`--list` shows the tile counts, `--dry-run` checks the server and changes nothing). `tools/install/test-map-tiles.sh` checks the counts and the dry run without root or network.
- Data: the free country extract of OpenStreetMap from Geofabrik (ODbL licence, about 77 MB, one download, checked with its md5). The only outside request is that download, made by the installer, never by the app or the browser.
- Result: road, road-name, town and coast tiles for zoom 5 to 11 (11,084 tiles, about 100 MB) in `TILES_DIR` (default `/srv/tiles`). The temporary database and the download are removed afterwards. Names show in Arabic when the data has one.
- Then set `TILES_DIR` for `install-ubuntu.sh`, and in Settings > Screens > Map: address `/tiles/{z}/{x}/{y}.png`, zoom 5 to 11, credit line "(c) OpenStreetMap contributors". Without tiles the outline map stays.
- Needs 1.5 GB memory and about 1.5 GB of temporary disk while it runs (one to two hours for the render, once).
