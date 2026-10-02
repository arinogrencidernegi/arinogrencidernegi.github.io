#!/bin/sh
# Siteyi https://arin.web.app adresine yükler.
# Yalnız git'te izlenen site dosyaları gider; admin.html ve yerel tasarım görselleri gitmez.
set -e
cd "$(dirname "$0")"
rm -rf dist
mkdir dist
git ls-files | grep -v -E '^(tests/|\.gitignore$|\.firebaserc$|firebase\.json$|deploy-firebase\.sh$)' | while read -r f; do
  mkdir -p "dist/$(dirname "$f")"
  cp "$f" "dist/$f"
done
ls dist
firebase deploy --only hosting --project arin-ogrenci-dernegi --non-interactive
