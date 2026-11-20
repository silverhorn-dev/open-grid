#!/bin/sh
# Baut das APK der Android-App in Docker (kein lokales Android-SDK noetig) und legt es mit Versionsdatei
# nach android/dist/ (opengrid.apk + opengrid.apk.json). Der Router liefert es aus, wenn es unter
# ANDROID_APK_PATH liegt (Standard: data/opengrid.apk).
#
#   sh android/build.sh            # Debug-Build (Debug-Schluessel aus dem Cache-Volume, zum Testen)
#   sh android/build.sh release    # Release, signiert mit OPENGRID_KEYSTORE (+ _PASSWORD, KEY_ALIAS, KEY_PASSWORD)
#
# Ohne Bind-Mounts (docker create + docker cp): laeuft so auch im Jenkins, wo der Agent den Docker-Daemon des
# Hosts nutzt und der Workspace dort nicht existiert. Gradle-Cache und Debug-Schluessel liegen im Volume
# opengrid-android-gradle; damit bleibt der Debug-Schluessel gleich und neue APKs lassen sich ueber alte
# installieren (gilt je Docker-Host: lokal und Jenkins haben verschiedene Debug-Schluessel).
set -eu
cd "$(dirname "$0")"
variant="${1:-debug}"
image=opengrid-android-build
docker build -q -t "$image" . >/dev/null
task="assemble$(echo "$variant" | cut -c1 | tr a-z A-Z)$(echo "$variant" | cut -c2-)"
env_args=""
if [ "$variant" = "release" ]; then
    : "${OPENGRID_KEYSTORE:?OPENGRID_KEYSTORE fehlt}"
    : "${OPENGRID_KEYSTORE_PASSWORD:?OPENGRID_KEYSTORE_PASSWORD fehlt}"
    # Ohne Angabe: Alias "opengrid", Schluessel-Passwort = Keystore-Passwort.
    OPENGRID_KEY_ALIAS="${OPENGRID_KEY_ALIAS:-opengrid}"
    OPENGRID_KEY_PASSWORD="${OPENGRID_KEY_PASSWORD:-$OPENGRID_KEYSTORE_PASSWORD}"
    export OPENGRID_KEY_ALIAS OPENGRID_KEY_PASSWORD
    env_args="-e OPENGRID_KEYSTORE=/keystore.jks -e OPENGRID_KEYSTORE_PASSWORD -e OPENGRID_KEY_ALIAS -e OPENGRID_KEY_PASSWORD"
fi
# shellcheck disable=SC2086
cid=$(docker create -v opengrid-android-gradle:/cache/gradle -e ANDROID_USER_HOME=/cache/gradle/android-user $env_args \
    "$image" sh -c "mkdir -p /cache/gradle/android-user && gradle --no-daemon -q $task")
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
# Nur die Quellen, keine lokalen Build-Reste.
tar -c --exclude=./dist --exclude=./app/build --exclude=./.gradle --exclude=./build . | docker cp - "$cid:/src"
[ "$variant" = "release" ] && docker cp "$OPENGRID_KEYSTORE" "$cid:/keystore.jks"
docker start -a "$cid"
mkdir -p dist
docker cp "$cid:/src/app/build/outputs/apk/$variant/app-$variant.apk" dist/opengrid.apk
version_code=$(sed -n 's/^ *versionCode = \([0-9]*\).*/\1/p' app/build.gradle.kts)
version_name=$(sed -n 's/^ *versionName = "\(.*\)".*/\1/p' app/build.gradle.kts)
printf '{"versionCode":%s,"versionName":"%s"}\n' "$version_code" "$version_name" > dist/opengrid.apk.json
echo "android/dist/opengrid.apk ($version_name, $version_code, $variant)"
