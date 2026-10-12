#!/bin/bash
# WindFree installer for macOS (Apple Silicon and Intel).
#
#   curl -fsSL https://raw.githubusercontent.com/kevinnfsilva/samsung-windfree-menubar-app/main/install.sh | bash
#
# It downloads the right disk image from the latest GitHub release, checks that it really holds WindFree, copies the
# app into /Applications (or ~/Applications when /Applications is not writable for you) and opens it. It never uses
# sudo, never asks a question and never reads the terminal, so it works piped into bash.
#
# Why this avoids the Gatekeeper warning: WindFree is not notarized by Apple (that needs a paid developer account).
# macOS only blocks apps that carry the "quarantine" flag, which browsers put on downloads. curl does not, so an app
# installed this way opens normally. The script does not remove or change that flag on anything; it just never gets it.
#
# Optional environment variables (for tests and mirrors):
#   WINDFREE_DMG_URL      download this disk image instead of the latest release (any URL curl understands, file:// too)
#   WINDFREE_INSTALL_DIR  install into this folder instead of /Applications (it is created if missing)
#   WINDFREE_NO_OPEN=1    do not open the app when done
#
# The only things this script deletes are its own temporary folders and the previous WindFree.app at the destination.
# Messages are in Portuguese when LC_ALL, LC_MESSAGES or LANG (the first that is set) starts with "pt", else English.
#
# Everything lives in functions and runs from the last line, so a download cut short never executes half a script.

set -eu
set -o pipefail
# Keep the usual system tools reachable even from a stripped environment; anything earlier in PATH still wins.
PATH="$PATH:/usr/bin:/bin:/usr/sbin:/sbin"

REPO_URL="https://github.com/kevinnfsilva/samsung-windfree-menubar-app"
BUNDLE_ID="io.github.kevinnfsilva.windfree"
APP_NAME="WindFree.app"
MIN_MACOS=13
PLISTBUDDY="/usr/libexec/PlistBuddy"

LANG_UI=en
TMP=""          # our temp folder: the download and the mount point live here
MNT=""          # where the disk image is mounted (inside TMP)
DMG=""
DEST=""         # folder the app goes into
APP=""          # DEST/WindFree.app
APP_ALT=""      # the same path as the user spelled it, when that differs from the physical one
STAGE=""        # hidden folder inside DEST: holds the new copy until the swap, then the old copy until cleanup
OLD_BACKUP=""   # where the previous app is parked during the swap
CURL_PID=""
VERSION=""
INTERRUPTED=0

# ---------------------------------------------------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------------------------------------------------

detect_lang() {
  local l="${LC_ALL:-}"
  [ -n "$l" ] || l="${LC_MESSAGES:-}"
  [ -n "$l" ] || l="${LANG:-}"
  case "$l" in
    pt*) LANG_UI=pt ;;
    *) LANG_UI=en ;;
  esac
}

# m KEY [ARGS...]: prints the message for KEY in the chosen language; ARGS fill the %s places.
m() {
  local key="$1" fmt=""
  shift
  if [ "$LANG_UI" = pt ]; then
    case "$key" in
      err) fmt='Erro:' ;;
      warn) fmt='Aviso:' ;;
      only_mac) fmt='Este instalador só funciona no macOS. Para o Windows, veja as instruções em %s' ;;
      cant_detect_macos) fmt='Não consegui descobrir a versão do macOS.' ;;
      old_macos) fmt='O WindFree precisa do macOS 13 ou mais novo. Este Mac está com o macOS %s.' ;;
      is_root) fmt='Não rode este instalador como administrador (root ou sudo). Rode com o seu usuário normal.' ;;
      bad_arch) fmt='Processador não suportado: %s. O WindFree funciona em Macs Apple Silicon e Intel.' ;;
      no_tool) fmt='Falta uma ferramenta do sistema: %s.' ;;
      no_home) fmt='Não achei a sua pasta pessoal (HOME).' ;;
      dest_fail) fmt='Não consegui gravar em %s. Escolha outra pasta com WINDFREE_INSTALL_DIR.' ;;
      dest_fail_default) fmt='Não consegui gravar em /Applications nem em %s.' ;;
      fallback) fmt='A pasta /Applications não aceita gravação para este usuário. Instalando em %s.' ;;
      intro) fmt='Instalando o WindFree para %s.' ;;
      intro_url) fmt='Instalando o WindFree a partir de %s' ;;
      arch_arm64) fmt='Apple Silicon' ;;
      arch_x64) fmt='Intel' ;;
      downloading) fmt='Baixando o WindFree...' ;;
      download_failed) fmt='Não consegui baixar o WindFree (erro %s do curl) de:\n  %s\nConfira a conexão com a internet e tente de novo. Se continuar falhando, baixe o DMG à mão em:\n  %s/releases/latest' ;;
      download_empty) fmt='O download veio vazio. Tente de novo.' ;;
      checking) fmt='Conferindo o arquivo baixado...' ;;
      mount_failed) fmt='Não consegui abrir o arquivo baixado. O download pode estar incompleto ou corrompido. Tente de novo.' ;;
      not_windfree_noapp) fmt='O arquivo baixado não contém o WindFree.app. Nada foi instalado.' ;;
      not_windfree_id) fmt='O WindFree.app desse arquivo tem outro identificador (%s). Nada foi instalado.' ;;
      copying) fmt='Copiando para %s...' ;;
      copy_failed) fmt='Não consegui copiar o app para %s.' ;;
      bad_signature) fmt='O app copiado não passou na verificação da assinatura, então não foi instalado. O download pode estar corrompido. Tente de novo.' ;;
      stopping) fmt='Fechando o WindFree que está aberto...' ;;
      still_running) fmt='O WindFree continua aberto em %s. Feche-o pelo ícone na barra de menus (Sair) e rode o comando de novo.' ;;
      swap_failed) fmt='Não consegui substituir o WindFree em %s. A cópia anterior foi mantida.' ;;
      unmount_warn) fmt='Não consegui ejetar a imagem de disco em %s. Ejete pelo Finder ou rode: hdiutil detach "%s"' ;;
      leftover_warn) fmt='Não consegui apagar a cópia anterior do WindFree; ela ficou em %s.' ;;
      done_version) fmt='Pronto. O WindFree %s está instalado em %s.' ;;
      done) fmt='Pronto. O WindFree está instalado em %s.' ;;
      opening) fmt='Abrindo o WindFree. O ícone aparece na barra de menus, perto do relógio.' ;;
      no_open) fmt='Não abri o app (WINDFREE_NO_OPEN=1).' ;;
      open_failed) fmt='Não consegui abrir o app sozinho. Abra o WindFree pela pasta %s.' ;;
      interrupted) fmt='Interrompido. Os arquivos temporários foram removidos.' ;;
    esac
  else
    case "$key" in
      err) fmt='Error:' ;;
      warn) fmt='Warning:' ;;
      only_mac) fmt='This installer only works on macOS. For Windows, see the instructions at %s' ;;
      cant_detect_macos) fmt='Could not tell which macOS version this is.' ;;
      old_macos) fmt='WindFree needs macOS 13 or newer. This Mac is running macOS %s.' ;;
      is_root) fmt='Do not run this installer as an administrator (root or sudo). Run it as your normal user.' ;;
      bad_arch) fmt='Unsupported processor: %s. WindFree runs on Apple Silicon and Intel Macs.' ;;
      no_tool) fmt='A system tool is missing: %s.' ;;
      no_home) fmt='Could not find your home folder (HOME).' ;;
      dest_fail) fmt='Cannot write to %s. Pick another folder with WINDFREE_INSTALL_DIR.' ;;
      dest_fail_default) fmt='Cannot write to /Applications or to %s.' ;;
      fallback) fmt='/Applications is not writable for this user. Installing in %s instead.' ;;
      intro) fmt='Installing WindFree for %s.' ;;
      intro_url) fmt='Installing WindFree from %s' ;;
      arch_arm64) fmt='Apple Silicon' ;;
      arch_x64) fmt='Intel' ;;
      downloading) fmt='Downloading WindFree...' ;;
      download_failed) fmt='Could not download WindFree (curl error %s) from:\n  %s\nCheck your internet connection and try again. If it keeps failing, download the DMG by hand from:\n  %s/releases/latest' ;;
      download_empty) fmt='The download came back empty. Try again.' ;;
      checking) fmt='Checking the download...' ;;
      mount_failed) fmt='Could not open the downloaded file. The download may be incomplete or corrupted. Try again.' ;;
      not_windfree_noapp) fmt='The downloaded file does not contain WindFree.app. Nothing was installed.' ;;
      not_windfree_id) fmt='The WindFree.app in that file has a different identifier (%s). Nothing was installed.' ;;
      copying) fmt='Copying to %s...' ;;
      copy_failed) fmt='Could not copy the app to %s.' ;;
      bad_signature) fmt='The copied app failed the signature check, so it was not installed. The download may be corrupted. Try again.' ;;
      stopping) fmt='Quitting the WindFree that is running...' ;;
      still_running) fmt='WindFree is still running from %s. Quit it from its menu bar icon (Quit) and run this command again.' ;;
      swap_failed) fmt='Could not replace WindFree in %s. The previous copy was kept.' ;;
      unmount_warn) fmt='Could not eject the disk image at %s. Eject it in Finder or run: hdiutil detach "%s"' ;;
      leftover_warn) fmt='Could not delete the previous copy of WindFree; it was left in %s.' ;;
      done_version) fmt='Done. WindFree %s is installed in %s.' ;;
      done) fmt='Done. WindFree is installed in %s.' ;;
      opening) fmt='Opening WindFree. Its icon appears in the menu bar, near the clock.' ;;
      no_open) fmt='Did not open the app (WINDFREE_NO_OPEN=1).' ;;
      open_failed) fmt='Could not open the app by itself. Open WindFree from the folder %s.' ;;
      interrupted) fmt='Interrupted. The temporary files were removed.' ;;
    esac
  fi
  # shellcheck disable=SC2059  # the formats above are ours; only the arguments come from the outside
  printf "$fmt" "$@"
}

say() { printf '%s\n' "$(m "$@")"; }
warn() { printf '%s %s\n' "$(m warn)" "$(m "$@")" >&2; }
die() { printf '%s %s\n' "$(m err)" "$(m "$@")" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------------------------------
# Cleanup: runs on every way out (success, error, Ctrl-C, kill). It never deletes anything that is not ours.
# ---------------------------------------------------------------------------------------------------------------------

is_mounted() {
  local table
  [ -n "$MNT" ] || return 1
  table=$(mount 2>/dev/null) || return 1
  case "$table" in
    *" on $MNT ("*) return 0 ;;
  esac
  return 1
}

detach_image() {
  local i
  is_mounted || return 0
  for i in 1 2 3 4 5; do
    hdiutil detach "$MNT" -quiet >/dev/null 2>&1 </dev/null || true
    is_mounted || return 0
    sleep 1
  done
  hdiutil detach "$MNT" -force -quiet >/dev/null 2>&1 </dev/null || true
  is_mounted || return 0
  return 1
}

# Removes a folder this script made with mktemp, after checking its name.
remove_ours() {
  local dir="$1" prefix="$2"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  case "${dir##*/}" in
    "$prefix".*) ;;
    *) return 0 ;;
  esac
  rm -rf -- "$dir"
}

cleanup() {
  local rc=$? stuck=0
  trap - EXIT INT TERM HUP
  set +e
  if [ -n "$CURL_PID" ]; then
    kill "$CURL_PID" 2>/dev/null
    wait "$CURL_PID" 2>/dev/null
  fi
  # A swap cut in half: put the previous app back if the new one never arrived.
  if [ -n "$OLD_BACKUP" ] && [ -e "$OLD_BACKUP" ] && [ ! -e "$APP" ]; then
    mv "$OLD_BACKUP" "$APP"
  fi
  detach_image || stuck=1
  if [ "$stuck" -eq 1 ]; then
    # Never delete a folder that still has a volume mounted inside it.
    warn unmount_warn "$MNT" "$MNT"
  else
    remove_ours "$TMP" windfree-install
  fi
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then
    remove_ours "$STAGE" .windfree-install
    [ ! -d "$STAGE" ] || warn leftover_warn "$STAGE"
  fi
  if [ "$INTERRUPTED" -eq 1 ]; then
    say interrupted >&2
  fi
  exit "$rc"
}

# ---------------------------------------------------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------------------------------------------------

check_system() {
  local os ver major tool
  os=$(uname -s 2>/dev/null) || os=""
  [ "$os" = Darwin ] || die only_mac "$REPO_URL"

  ver=$(sw_vers -productVersion 2>/dev/null) || ver=""
  major=${ver%%.*}
  case "$major" in
    '' | *[!0-9]*) die cant_detect_macos ;;
  esac
  [ "$major" -ge "$MIN_MACOS" ] || die old_macos "$ver"

  [ "$(id -u 2>/dev/null || echo 1)" -ne 0 ] || die is_root

  for tool in curl hdiutil ditto codesign ps mktemp open mount; do
    command -v "$tool" >/dev/null 2>&1 || die no_tool "$tool"
  done
  [ -x "$PLISTBUDDY" ] || die no_tool PlistBuddy
  [ -n "${HOME:-}" ] || die no_home
}

# Prints arm64 or x64. A shell running under Rosetta reports x86_64 on an Apple Silicon Mac; the sysctl tells them apart.
detect_arch() {
  local machine
  machine=$(uname -m 2>/dev/null) || machine=""
  case "$machine" in
    arm64 | aarch64) printf 'arm64\n' ;;
    x86_64)
      if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
        printf 'arm64\n'
      else
        printf 'x64\n'
      fi
      ;;
    *) die bad_arch "$machine" ;;
  esac
}

# A real write test: a folder can look writable by its mode bits and still refuse.
can_write() {
  local probe
  probe=$(mktemp -d "$1/.windfree-probe.XXXXXX" 2>/dev/null) || return 1
  rmdir "$probe" 2>/dev/null || true
  return 0
}

choose_destination() {
  local dir
  if [ -n "${WINDFREE_INSTALL_DIR:-}" ]; then
    dir=${WINDFREE_INSTALL_DIR%/}
    [ -n "$dir" ] || dir=/
    mkdir -p "$dir" 2>/dev/null || die dest_fail "$dir"
    DEST=$(cd "$dir" 2>/dev/null && pwd -P) || die dest_fail "$dir"
    can_write "$DEST" || die dest_fail "$DEST"
    APP_ALT="$dir/$APP_NAME"
  elif can_write /Applications; then
    DEST=/Applications
  else
    dir="$HOME/Applications"
    mkdir -p "$dir" 2>/dev/null || die dest_fail_default "$dir"
    DEST=$(cd "$dir" 2>/dev/null && pwd -P) || die dest_fail_default "$dir"
    can_write "$DEST" || die dest_fail_default "$DEST"
    say fallback "$DEST"
  fi
  APP="$DEST/$APP_NAME"
}

make_temp() {
  local base="${TMPDIR:-/tmp}"
  base=${base%/}
  [ -d "$base" ] || base=/tmp
  TMP=$(mktemp -d "$base/windfree-install.XXXXXX") || die dest_fail "$base"
  TMP=$(cd "$TMP" && pwd -P)
  MNT="$TMP/mnt"
  DMG="$TMP/WindFree.dmg"
}

download() {
  local url="$1" rc=0 progress redirects
  if [ -t 2 ]; then progress=--progress-bar; else progress=-sS; fi
  # Redirects may not leave https once the download started on https (GitHub redirects to its own https storage).
  case "$url" in
    https://*) redirects=https ;;
    *) redirects=http,https ;;
  esac
  say downloading
  # In the background plus wait, so that a signal sent only to this script is handled at once and stops curl too.
  curl -fL "$progress" --retry 2 --connect-timeout 20 --speed-limit 1024 --speed-time 30 --proto-redir "=$redirects" \
    -o "$DMG" "$url" </dev/null &
  CURL_PID=$!
  wait "$CURL_PID" || rc=$?
  CURL_PID=""
  [ "$rc" -eq 0 ] || die download_failed "$rc" "$url" "$REPO_URL"
  [ -s "$DMG" ] || die download_empty
}

attach_image() {
  local line
  say checking
  mkdir "$MNT"
  if ! hdiutil attach -nobrowse -readonly -noautoopen -quiet -mountpoint "$MNT" "$DMG" \
    >"$TMP/hdiutil.log" 2>&1 </dev/null; then
    line=$(tail -n 1 "$TMP/hdiutil.log" 2>/dev/null || true)
    printf '%s %s\n' "$(m err)" "$(m mount_failed)" >&2
    [ -z "$line" ] || printf '  %s\n' "$line" >&2
    exit 1
  fi
}

plist_value() { "$PLISTBUDDY" -c "Print :$2" "$1" 2>/dev/null; }

verify_image() {
  local src="$MNT/$APP_NAME" id
  { [ -d "$src" ] && [ ! -L "$src" ]; } || die not_windfree_noapp
  id=$(plist_value "$src/Contents/Info.plist" CFBundleIdentifier) || id=""
  [ "$id" = "$BUNDLE_ID" ] || die not_windfree_id "${id:-?}"
  VERSION=$(plist_value "$src/Contents/Info.plist" CFBundleShortVersionString) || VERSION=""
}

stage_copy() {
  say copying "$DEST"
  STAGE=$(mktemp -d "$DEST/.windfree-install.XXXXXX") || die dest_fail "$DEST"
  OLD_BACKUP="$STAGE/$APP_NAME.previous"
  ditto "$MNT/$APP_NAME" "$STAGE/$APP_NAME" </dev/null || die copy_failed "$DEST"
  # The image is not needed any more; let go of it before the slower steps.
  detach_image || true
  # The ad-hoc signature covers every file of the app, so this also catches a damaged or truncated copy.
  codesign --verify --deep --strict "$STAGE/$APP_NAME" >"$TMP/codesign.log" 2>&1 </dev/null || die bad_signature
}

running_pids() {
  local pid comm
  ps -axo pid=,comm= 2>/dev/null | while read -r pid comm; do
    case "$comm" in
      "$APP/Contents/MacOS/"*) printf '%s\n' "$pid" ;;
      *)
        if [ -n "$APP_ALT" ]; then
          case "$comm" in
            "$APP_ALT/Contents/MacOS/"*) printf '%s\n' "$pid" ;;
          esac
        fi
        ;;
    esac
  done
}

# If a WindFree is running from the destination, asks it to quit and waits a few seconds. It is never killed.
stop_running_app() {
  local pids i
  pids=$(running_pids || true)
  [ -n "$pids" ] || return 0
  say stopping
  # Addressed by path, never by bundle id, so a copy running from somewhere else is left alone.
  osascript -e 'on run argv' -e 'with timeout of 8 seconds' -e 'tell application (item 1 of argv) to quit' \
    -e 'end timeout' -e 'end run' "$APP" >/dev/null 2>&1 </dev/null || true
  for i in $(seq 1 20); do
    pids=$(running_pids || true)
    [ -n "$pids" ] || return 0
    sleep 0.5
  done
  die still_running "$APP"
}

swap_in() {
  if [ -e "$APP" ] || [ -L "$APP" ]; then
    mv "$APP" "$OLD_BACKUP" || die swap_failed "$DEST"
  fi
  # If this fails or is interrupted, cleanup puts the previous copy back.
  mv "$STAGE/$APP_NAME" "$APP" || die swap_failed "$DEST"
}

open_app() {
  if [ "${WINDFREE_NO_OPEN:-}" = 1 ]; then
    say no_open
    return 0
  fi
  say opening
  open "$APP" >/dev/null 2>&1 </dev/null || warn open_failed "$DEST"
}

main() {
  local arch url arch_label
  # From here on nothing reads the terminal or the rest of a piped script.
  exec </dev/null
  detect_lang
  trap cleanup EXIT
  trap 'INTERRUPTED=1; exit 130' INT
  trap 'INTERRUPTED=1; exit 143' TERM
  trap 'INTERRUPTED=1; exit 129' HUP

  check_system

  if [ -n "${WINDFREE_DMG_URL:-}" ]; then
    url="$WINDFREE_DMG_URL"
    say intro_url "$url"
  else
    arch=$(detect_arch)
    url="$REPO_URL/releases/latest/download/WindFree-$arch.dmg"
    arch_label=$(m "arch_$arch")
    say intro "$arch_label"
  fi

  choose_destination
  make_temp
  download "$url"
  attach_image
  verify_image
  stage_copy
  stop_running_app
  swap_in
  # The old copy and the staging folder go in cleanup, with the temp folder.
  if [ -n "$VERSION" ]; then
    say done_version "$VERSION" "$APP"
  else
    say done "$APP"
  fi
  open_app
}

main "$@"
