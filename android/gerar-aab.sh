#!/usr/bin/env bash
# Gera o arquivo para a Google Play (.aab) assinado com a chave de envio.
#
# Uso (no computador de quem guarda a chave):
#   1. Instale o JDK 17 e as ferramentas de linha de comando do Android
#      (ou o Android Studio) e aceite a licença do Android SDK.
#   2. Copie a chave para android/upload-key.jks (ela NÃO vai para o Git).
#   3. Aumente "appVersionCode" (e "appVersion") em android/twa-manifest.json
#      E em android/app/build.gradle (versionCode / versionName) a cada envio.
#   4. Rode:  ANDROID_HOME=/caminho/do/sdk VAIRO_KEY_PASSWORD='senha' ./gerar-aab.sh
#
# Saída: android/vairo-<versão>.aab (assinado) e android/vairo-<versão>-teste.apk.
set -euo pipefail
cd "$(dirname "$0")"

: "${ANDROID_HOME:?Defina ANDROID_HOME com o caminho do Android SDK}"
: "${VAIRO_KEY_PASSWORD:?Defina VAIRO_KEY_PASSWORD com a senha da chave}"
KEY="${VAIRO_KEY_PATH:-upload-key.jks}"
[ -f "$KEY" ] || { echo "Chave não encontrada: $KEY"; exit 1; }

BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
VERSION=$(grep -o 'versionName "[^"]*"' app/build.gradle | cut -d'"' -f2)
echo "sdk.dir=$ANDROID_HOME" > local.properties

./gradlew --no-daemon --max-workers=1 bundleRelease assembleRelease

AAB="vairo-$VERSION.aab"
cp app/build/outputs/bundle/release/app-release.aab "$AAB"
jarsigner -keystore "$KEY" -storepass "$VAIRO_KEY_PASSWORD" -keypass "$VAIRO_KEY_PASSWORD" \
  -sigalg SHA256withRSA -digestalg SHA-256 "$AAB" upload
jarsigner -verify "$AAB"

"$BT/zipalign" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk aligned.apk
"$BT/apksigner" sign --ks "$KEY" --ks-key-alias upload --ks-pass "pass:$VAIRO_KEY_PASSWORD" \
  --key-pass "pass:$VAIRO_KEY_PASSWORD" --out "vairo-$VERSION-teste.apk" aligned.apk
rm -f aligned.apk ./*.idsig

echo "Pronto: $AAB (enviar à Play Console) e vairo-$VERSION-teste.apk (instalar para testar)."
