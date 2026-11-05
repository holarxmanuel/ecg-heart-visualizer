#!/usr/bin/env bash
# Builds the ECGV Android app and publishes it at https://ecgv.stream/download/ECGV.apk.
# The phone app is its own app: it carries the whole interface (simulator,
# DSP, 3D heart) inside the APK, so it works with no network, and talks to
# ecgv.stream for the live stream when online. No Android Studio needed.
#   ./build.sh          rebuild the same version
#   ./build.sh bump     next version (phones only update to a higher version)
# Toolchain: ~/apkbuild. Signing key: ~/ecgv-signing (never lose it).
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME=~/apkbuild/jdk ANDROID_HOME=~/apkbuild/sdk
export ECGV_KEYSTORE_PASSWORD="$(cat ~/ecgv-signing/keystore-password.txt)"
if [ "${1:-}" = "bump" ]; then
  python3 - <<'PY'
import re
p = "app/build.gradle"; s = open(p).read()
code = int(re.search(r"versionCode (\d+)", s).group(1)) + 1
a, b, c = re.search(r"versionName '(\d+)\.(\d+)\.(\d+)'", s).groups()
s = re.sub(r"versionCode \d+", f"versionCode {code}", s)
s = re.sub(r"versionName '[^']+'", f"versionName '{a}.{b}.{int(c) + 1}'", s)
open(p, "w").write(s); print("version", f"{a}.{b}.{int(c)+1}", "code", code)
PY
fi
# 1. The interface, built exactly as the website is, then packed into the APK.
(cd ../frontend && npm run build > /dev/null)
WEB=app/src/main/assets/web
rm -rf "$WEB" && mkdir -p "$WEB" && cp -r ../frontend/dist/. "$WEB/"
# The project review slides (9 MB) are for the website, not the app.
rm -rf "$WEB/slides"
# 2. The app.
./gradlew -q assembleRelease > build.log 2>&1 || { tail -40 build.log; exit 1; }
mkdir -p dist
cp app/build/outputs/apk/release/app-release.apk dist/ECGV.apk
python3 - <<'PY'
import json, hashlib, os, re
s = open("app/build.gradle").read()
code = int(re.search(r"versionCode (\d+)", s).group(1))
info = {"version": re.search(r"versionName '([^']+)'", s).group(1), "code": code,
        "min_code": int(os.environ.get("ECGV_MIN_CODE", code)), "url": "/download/ECGV.apk",
        "bytes": os.path.getsize("dist/ECGV.apk"), "sha256": hashlib.sha256(open("dist/ECGV.apk", "rb").read()).hexdigest()}
json.dump(info, open("dist/android.json", "w"))
print("built", info)
PY
