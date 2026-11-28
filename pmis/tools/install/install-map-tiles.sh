#!/usr/bin/env bash
# Telecom Site Delivery Workspace: build the road map tiles for the site map on THIS server (owner decision 2026-11-28: OpenStreetMap data,
# rendered here, zoom 5 to 11, credit shown). Runs once, on its own after install-ubuntu.sh:   sudo bash pmis/tools/install/install-map-tiles.sh
#
# What it does: downloads the free country extract from Geofabrik (OpenStreetMap data, ODbL licence, about 77 MB), loads it into a TEMPORARY database,
# draws roads, road names, towns and the coast into 256 px PNG tiles {z}/{x}/{y}.png for zoom 5 to 11 (11,084 tiles, about 100 MB), copies them to
# TILES_DIR (default /srv/tiles), then drops the temporary database and the download. Nothing is sent anywhere; the map reads the tiles from this server only.
# After it ends: set TILES_DIR in the install environment and re-run install-ubuntu.sh (serves /tiles/), then in Settings > Screens > Map turn the map on with the
# address /tiles/{z}/{x}/{y}.png, zoom 5 to 11 and the credit line "(c) OpenStreetMap contributors" (the script prints these values).
#
# Options:  --list           print the number of tiles per zoom and exit (no root needed)
#           --dry-run        check disk, memory and tools, print the plan, change nothing
#           --zoom-max N     highest zoom (default 11; every level up multiplies the size by about 4)
#           --dir PATH       where the tiles go (default $TILES_DIR or /srv/tiles)
# Running it again replaces the tiles with a fresh render. The outline map stays the fallback when no tiles exist.
set -euo pipefail

ZOOM_MIN=5
ZOOM_MAX=11
DIR="${TILES_DIR:-/srv/tiles}"
MODE=run
# Area drawn: the country and a small margin (degrees).
LON_MIN=9.3; LON_MAX=25.2; LAT_MIN=19.4; LAT_MAX=33.3
PBF_URL="https://download.geofabrik.de/africa/libya/libya-latest.osm.pbf"
DB=gsdn_tiles
WORK=/var/tmp/gsdn-tiles-work

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) MODE=list ;;
    --dry-run) MODE=dry ;;
    --zoom-max) ZOOM_MAX="${2:?--zoom-max needs a number}"; shift ;;
    --dir) DIR="${2:?--dir needs a path}"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$ZOOM_MAX" =~ ^[0-9]+$ ]] && (( ZOOM_MAX >= ZOOM_MIN && ZOOM_MAX <= 14 )) || { echo "--zoom-max must be between $ZOOM_MIN and 14" >&2; exit 2; }

# Tile counts per zoom for the area (Web Mercator, 256 px tiles).
tile_counts() {
  python3 - "$ZOOM_MIN" "$ZOOM_MAX" "$LON_MIN" "$LON_MAX" "$LAT_MIN" "$LAT_MAX" <<'PY'
import math, sys
zmin, zmax = int(sys.argv[1]), int(sys.argv[2])
lon0, lon1, lat0, lat1 = map(float, sys.argv[3:7])
def tx(lon, z): return (lon + 180) / 360 * 2 ** z
def ty(lat, z):
    s = math.sin(math.radians(lat)); return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * 2 ** z
total = 0
for z in range(zmin, zmax + 1):
    n = (math.floor(tx(lon1, z)) - math.floor(tx(lon0, z)) + 1) * (math.floor(ty(lat0, z)) - math.floor(ty(lat1, z)) + 1)
    total += n
    print(f"zoom {z}: {n} tiles")
print(f"total: {total} tiles")
PY
}

if [[ $MODE == list ]]; then tile_counts; exit 0; fi

TOTAL=$(tile_counts | awk '/^total:/ {print $2}')
# Rough size: 9 KB per tile on average (desert tiles are tiny, towns are larger).
NEED_MB=$(( TOTAL * 9 / 1024 + 1 ))
echo "==> Plan: zoom $ZOOM_MIN to $ZOOM_MAX, $TOTAL tiles, about ${NEED_MB} MB in $DIR"

free_mb() { df -Pm "$1" | awk 'NR==2 {print $4}'; }
CHECK_DIR="$DIR"; [[ -d $DIR ]] || CHECK_DIR="$(dirname "$DIR")"
[[ -d $CHECK_DIR ]] || CHECK_DIR=/
FREE_TILES=$(free_mb "$CHECK_DIR"); FREE_WORK=$(free_mb "$(dirname "$WORK")")
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
echo "    free disk at $CHECK_DIR: ${FREE_TILES} MB, free at /var/tmp: ${FREE_WORK} MB, memory: ${MEM_MB} MB"
(( FREE_TILES >= NEED_MB * 3 )) || { echo "Not enough free disk for the tiles (need about $((NEED_MB * 3)) MB with room to spare)." >&2; exit 1; }
(( FREE_WORK >= 1500 )) || { echo "Not enough free disk in /var/tmp for the temporary data (need about 1500 MB)." >&2; exit 1; }
(( MEM_MB >= 1500 )) || { echo "At least 1.5 GB memory is needed to load the map data." >&2; exit 1; }

if [[ $MODE == dry ]]; then
  echo "==> Dry run: would install osm2pgsql, PostgreSQL with PostGIS, Mapnik and Noto fonts; download $PBF_URL (checked with its md5);"
  echo "    load it into the temporary database '$DB'; render the tiles; copy them to $DIR; drop the database and $WORK. Nothing changed."
  exit 0
fi

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }

echo "==> Installing osm2pgsql, PostgreSQL + PostGIS, Mapnik and Noto fonts (Arabic and Latin names)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq osm2pgsql postgresql postgis python3-mapnik fonts-noto-core fonts-noto-ui-core curl >/dev/null
systemctl enable -q --now postgresql

cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
rm -rf "$WORK"; mkdir -p "$WORK"; chmod 755 "$WORK"

echo "==> Downloading the country extract (OpenStreetMap data, ODbL) from Geofabrik"
curl -fsSL -o "$WORK/country.osm.pbf" "$PBF_URL"
curl -fsSL -o "$WORK/country.osm.pbf.md5" "$PBF_URL.md5"
( cd "$WORK" && sed 's#  .*#  country.osm.pbf#' country.osm.pbf.md5 | md5sum -c --quiet - ) || { echo "The download does not match its checksum; try again." >&2; exit 1; }

echo "==> Loading it into the temporary database '$DB'"
sudo -u postgres dropdb --if-exists "$DB"
sudo -u postgres createdb "$DB"
sudo -u postgres psql -q -d "$DB" -c 'CREATE EXTENSION postgis; CREATE EXTENSION hstore;'
chmod 644 "$WORK/country.osm.pbf"
sudo -u postgres osm2pgsql --create --slim --drop --hstore -C 700 --number-processes 2 -d "$DB" -S /usr/share/osm2pgsql/default.style "$WORK/country.osm.pbf" >/dev/null

echo "==> Drawing the tiles (this takes a while; it runs once)"
cat > "$WORK/style.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<Map srs="epsg:3857" background-color="#e9eef2" font-directory="/usr/share/fonts/truetype/noto">
  <Style name="land"><Rule><PolygonSymbolizer fill="#f4f1ea"/></Rule></Style>
  <Style name="coast"><Rule><LineSymbolizer stroke="#8aa4b5" stroke-width="1"/></Rule></Style>
  <Style name="boundary"><Rule><MaxScaleDenominator>20000000</MaxScaleDenominator><LineSymbolizer stroke="#b090b0" stroke-width="0.8" stroke-dasharray="6,3"/></Rule></Style>
  <Style name="roads">
    <Rule><Filter>[highway] = 'motorway' or [highway] = 'trunk'</Filter><LineSymbolizer stroke="#e8924f" stroke-width="2.4"/></Rule>
    <Rule><Filter>[highway] = 'primary'</Filter><LineSymbolizer stroke="#f0b25f" stroke-width="1.8"/></Rule>
    <Rule><Filter>[highway] = 'secondary'</Filter><MaxScaleDenominator>2000000</MaxScaleDenominator><LineSymbolizer stroke="#f5d78a" stroke-width="1.4"/></Rule>
    <Rule><Filter>[highway] = 'tertiary' or [highway] = 'unclassified' or [highway] = 'residential'</Filter><MaxScaleDenominator>600000</MaxScaleDenominator><LineSymbolizer stroke="#ffffff" stroke-width="1"/><LineSymbolizer stroke="#c8c8c8" stroke-width="0.4"/></Rule>
  </Style>
  <Style name="roadnames">
    <Rule><Filter>[highway] = 'motorway' or [highway] = 'trunk' or [highway] = 'primary' or [highway] = 'secondary'</Filter><MaxScaleDenominator>1100000</MaxScaleDenominator><TextSymbolizer face-name="Noto Sans Regular" size="10" fill="#444" halo-fill="#ffffffcc" halo-radius="1.5" placement="line" spacing="250" avoid-edges="true" repeat-distance="400">[label]</TextSymbolizer></Rule>
    <Rule><Filter>[highway] = 'tertiary' or [highway] = 'residential' or [highway] = 'unclassified'</Filter><MaxScaleDenominator>300000</MaxScaleDenominator><TextSymbolizer face-name="Noto Sans Regular" size="9" fill="#555" halo-fill="#ffffffcc" halo-radius="1.2" placement="line" spacing="200" avoid-edges="true">[label]</TextSymbolizer></Rule>
  </Style>
  <Style name="places">
    <Rule><Filter>[place] = 'city'</Filter><TextSymbolizer face-name="Noto Sans Bold" size="14" fill="#222" halo-fill="#ffffffdd" halo-radius="2" allow-overlap="false">[label]</TextSymbolizer></Rule>
    <Rule><Filter>[place] = 'town'</Filter><MaxScaleDenominator>4000000</MaxScaleDenominator><TextSymbolizer face-name="Noto Sans Bold" size="11" fill="#333" halo-fill="#ffffffdd" halo-radius="1.6">[label]</TextSymbolizer></Rule>
    <Rule><Filter>[place] = 'village' or [place] = 'suburb' or [place] = 'hamlet'</Filter><MaxScaleDenominator>600000</MaxScaleDenominator><TextSymbolizer face-name="Noto Sans Regular" size="9" fill="#444" halo-fill="#ffffffdd" halo-radius="1.2">[label]</TextSymbolizer></Rule>
  </Style>
  <Layer name="land" srs="epsg:3857"><StyleName>land</StyleName><Datasource><Parameter name="type">postgis</Parameter><Parameter name="dbname">$DB</Parameter><Parameter name="table">(SELECT way FROM planet_osm_polygon WHERE "natural" IS NULL AND boundary = 'administrative' AND admin_level = '2') AS t</Parameter><Parameter name="geometry_field">way</Parameter></Datasource></Layer>
  <Layer name="boundary" srs="epsg:3857"><StyleName>boundary</StyleName><Datasource><Parameter name="type">postgis</Parameter><Parameter name="dbname">$DB</Parameter><Parameter name="table">(SELECT way FROM planet_osm_line WHERE boundary = 'administrative' AND admin_level IN ('2','4')) AS t</Parameter><Parameter name="geometry_field">way</Parameter></Datasource></Layer>
  <Layer name="coast" srs="epsg:3857"><StyleName>coast</StyleName><Datasource><Parameter name="type">postgis</Parameter><Parameter name="dbname">$DB</Parameter><Parameter name="table">(SELECT way FROM planet_osm_line WHERE "natural" = 'coastline') AS t</Parameter><Parameter name="geometry_field">way</Parameter></Datasource></Layer>
  <Layer name="roads" srs="epsg:3857"><StyleName>roads</StyleName><Datasource><Parameter name="type">postgis</Parameter><Parameter name="dbname">$DB</Parameter><Parameter name="table">(SELECT way, highway FROM planet_osm_line WHERE highway IN ('motorway','trunk','primary','secondary','tertiary','unclassified','residential') ORDER BY z_order) AS t</Parameter><Parameter name="geometry_field">way</Parameter></Datasource></Layer>
  <Layer name="roadnames" srs="epsg:3857"><StyleName>roadnames</StyleName><Datasource><Parameter name="type">postgis</Parameter><Parameter name="dbname">$DB</Parameter><Parameter name="table">(SELECT way, highway, coalesce(tags->'name:ar', name) AS label FROM planet_osm_line WHERE highway IN ('motorway','trunk','primary','secondary','tertiary','unclassified','residential') AND name IS NOT NULL) AS t</Parameter><Parameter name="geometry_field">way</Parameter></Datasource></Layer>
  <Layer name="places" srs="epsg:3857"><StyleName>places</StyleName><Datasource><Parameter name="type">postgis</Parameter><Parameter name="dbname">$DB</Parameter><Parameter name="table">(SELECT way, place, coalesce(tags->'name:ar', name) AS label FROM planet_osm_point WHERE place IN ('city','town','village','suburb','hamlet') AND name IS NOT NULL ORDER BY CASE place WHEN 'city' THEN 0 WHEN 'town' THEN 1 ELSE 2 END) AS t</Parameter><Parameter name="geometry_field">way</Parameter></Datasource></Layer>
</Map>
XML
cat > "$WORK/render.py" <<'PY'
import math, os, sys
import mapnik
zmin, zmax = int(sys.argv[1]), int(sys.argv[2])
lon0, lon1, lat0, lat1 = map(float, sys.argv[3:7])
out, style = sys.argv[7], sys.argv[8]
R = 6378137.0
def tx(lon, z): return (lon + 180) / 360 * 2 ** z
def ty(lat, z):
    s = math.sin(math.radians(lat)); return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * 2 ** z
def merc(x, y, z):
    n = 2 ** z; lon = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
m = mapnik.Map(256, 256); mapnik.load_map(m, style); m.buffer_size = 64
done = 0
for z in range(zmin, zmax + 1):
    for x in range(math.floor(tx(lon0, z)), math.floor(tx(lon1, z)) + 1):
        os.makedirs(f"{out}/{z}/{x}", exist_ok=True)
        for y in range(math.floor(ty(lat1, z)), math.floor(ty(lat0, z)) + 1):
            x0, y1 = merc(x, y, z); x1, y0 = merc(x + 1, y + 1, z)
            m.zoom_to_box(mapnik.Box2d(x0, y0, x1, y1))
            mapnik.render_to_file(m, f"{out}/{z}/{x}/{y}.png", "png8")
            done += 1
    print(f"zoom {z} done ({done} tiles)", flush=True)
PY
chown -R postgres "$WORK"; mkdir -p "$WORK/out"; chown postgres "$WORK/out"
sudo -u postgres python3 "$WORK/render.py" "$ZOOM_MIN" "$ZOOM_MAX" "$LON_MIN" "$LON_MAX" "$LAT_MIN" "$LAT_MAX" "$WORK/out" "$WORK/style.xml"

echo "==> Checking the result"
COUNT=$(find "$WORK/out" -name '*.png' | wc -l)
(( COUNT == TOTAL )) || { echo "Expected $TOTAL tiles but found $COUNT; the existing tiles in $DIR were not touched." >&2; exit 1; }
SAMPLE=$(find "$WORK/out/$ZOOM_MAX" -name '*.png' -size +2k | head -1)
[[ -n $SAMPLE ]] || { echo "No tile with drawn content was found; the existing tiles in $DIR were not touched." >&2; exit 1; }

echo "==> Copying the tiles to $DIR"
mkdir -p "$DIR"
rm -rf "$DIR".new; cp -r "$WORK/out" "$DIR".new
chmod -R a+rX "$DIR".new
rm -rf "$DIR".old; [[ -d $DIR ]] && mv "$DIR" "$DIR".old
mv "$DIR".new "$DIR"; rm -rf "$DIR".old
echo "==> Done: $COUNT tiles, $(du -sm "$DIR" | cut -f1) MB in $DIR"
echo "    Next: set TILES_DIR=$DIR when you run install-ubuntu.sh, then in Settings > Screens > Map:"
echo "    address /tiles/{z}/{x}/{y}.png, smallest zoom $ZOOM_MIN, largest zoom $ZOOM_MAX, credit line: (c) OpenStreetMap contributors"
