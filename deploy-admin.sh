#!/bin/sh
# Publish the leaders' page to tornclubhouse.spill298.workers.dev.
# dist/ is built fresh each time and holds ONLY index.html, so the token file
# and the worker source can never be served by accident.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
cp index.html dist/index.html
npx wrangler deploy --config wrangler.admin.toml
