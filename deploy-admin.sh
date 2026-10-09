#!/bin/sh
# Publish BOTH pages to tornclubhouse.spill298.workers.dev:
#   /         the leaders' page      (index.html)
#   /games    the members' page      (games.html)
# dist/ is built fresh and holds only those two files, so the tracker token and
# the worker source can never be served by accident. Leaving games.html out of
# dist does not just skip it — it takes /games off the air, because an assets
# worker serves exactly what is in the directory and nothing else.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
cp index.html dist/index.html
cp games.html dist/games.html
npx wrangler deploy --config wrangler.admin.toml
