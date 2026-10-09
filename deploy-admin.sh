#!/bin/sh
# Publish BOTH pages to tornclubhouse.spill298.workers.dev:
#   /         the leaders' page   (index.html)
#   /games    the members' page   (games.html)
#
# dist/ is built fresh and holds only those two files, so the tracker token and
# the worker source can never be served by accident. Leaving games.html out does
# not merely skip it, it takes /games off the air.
#
# The build stamp in each page footer is rewritten here, at deploy time. It used
# to be hand-edited, so it lied: two different builds both claimed 16:43 and
# there was no way to tell from the page which one you were looking at.
set -e
cd "$(dirname "$0")"
STAMP=$(date -u "+%Y-%m-%d %H:%M")
rm -rf dist && mkdir dist
sed "s|build 2026-[0-9-]* [0-9:]*|build $STAMP UTC|" index.html > dist/index.html
sed "s|const BUILD = \"[^\"]*\"|const BUILD = \"$STAMP UTC\"|" games.html > dist/games.html
grep -q "build $STAMP UTC" dist/index.html || { echo "index.html stamp did not apply"; exit 1; }
grep -q "$STAMP UTC"       dist/games.html || { echo "games.html stamp did not apply"; exit 1; }
echo "stamping $STAMP UTC"
npx wrangler deploy --config wrangler.admin.toml
