#!/bin/sh
# Publishes to tornclubhouse.spill298.workers.dev:
#   /<private path>/   the leaders' page, with the tracker token baked in
#   /games             the members' page
#   /                  a stub that gives nothing away
#
# The two secrets live in files git ignores, and are only ever written into
# dist/ (also ignored). This repo is public, so neither may be committed:
#   TRACKER_TOKEN.txt  the tracker token
#   ADMIN_PATH.txt     the private path the leaders' page is served at
#
# The build stamp in each footer is rewritten from the clock here. It used to be
# hand-edited, so it lied: two different builds both claimed the same time and
# there was no way to tell from the page which one you had.
set -e
cd "$(dirname "$0")"

[ -f TRACKER_TOKEN.txt ] || { echo "TRACKER_TOKEN.txt is missing"; exit 1; }
[ -f ADMIN_PATH.txt ]    || { echo "ADMIN_PATH.txt is missing"; exit 1; }
TOK=$(sed -n 's/^TRACKER_TOKEN=//p' TRACKER_TOKEN.txt | tr -d ' \r\n')
APATH=$(tr -d ' \r\n' < ADMIN_PATH.txt)
STAMP=$(date -u "+%Y-%m-%d %H:%M")
[ -n "$TOK" ]   || { echo "no token found in TRACKER_TOKEN.txt"; exit 1; }
[ -n "$APATH" ] || { echo "no path found in ADMIN_PATH.txt"; exit 1; }

rm -rf dist && mkdir -p "dist/$APATH"

# leaders' page: stamped, and the token baked in for this copy only
sed -e "s|build 2026-[0-9-]* [0-9:]*\( UTC\)\{0,1\}|build $STAMP UTC|" \
    -e "s|const BAKED_TOK = \"\"|const BAKED_TOK = \"$TOK\"|" \
    index.html > "dist/$APATH/index.html"

# members' page: stamped, no token of ours in it
sed "s|const BUILD = \"[^\"]*\"|const BUILD = \"$STAMP UTC\"|" games.html > dist/games.html

# the bare address no longer serves the leaders' page
cat > dist/index.html <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CK Clubhouse</title>
<style>body{background:#12161A;color:#C9D1D9;font:16px/1.6 system-ui,sans-serif;
display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}
a{color:#E3A008}</style></head><body><div>
<p><a href="/games">Champagne Killers clubhouse &rsaquo;</a></p>
</div></body></html>
HTML

grep -q "build $STAMP UTC" "dist/$APATH/index.html" || { echo "leaders' stamp did not apply"; exit 1; }
grep -q "$STAMP UTC"        dist/games.html          || { echo "members' stamp did not apply"; exit 1; }
grep -q "$TOK"             "dist/$APATH/index.html"  || { echo "token did not bake in"; exit 1; }
grep -rq "$TOK" dist/index.html dist/games.html      && { echo "token leaked into a public file"; exit 1; }

echo "stamping $STAMP UTC   leaders' page at /$APATH/"
npx wrangler deploy --config wrangler.admin.toml
