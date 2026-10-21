#!/usr/bin/env bash
# Official PostgreSQL packages follow maintained 17.x patches; age and the
# Supabase public CA are immutable, checksum-pinned downloads. No source secrets.
set -euo pipefail

verify_pgdg_key_listing() {
  # Trust exactly one primary key. Taking only the first fingerprint would also
  # trust any additional key silently appended to the downloaded keyring.
  awk -F: '
    $1 == "pub" { if (pending) bad=1; keys++; pending=1; if ($2 == "r" || $2 == "e") bad=1; next }
    pending && $1 == "fpr" {
      fingerprints++; pending=0;
      if ($10 != "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8") bad=1
    }
    END { exit (bad || pending || keys != 1 || fingerprints != 1) }
  '
}

verify_install_context() {
  case $- in *x*) return 1 ;; esac
  test "${GITHUB_ACTIONS:-}" = true || return 1
  test "${RUNNER_ENVIRONMENT:-}" = github-hosted || return 1
  test "${RUNNER_OS:-}" = Linux || return 1
  test "${RUNNER_ARCH:-}" = X64 || return 1
  test -n "${RUNNER_TEMP:-}" || return 1
  case "$RUNNER_TEMP" in /*) ;; *) return 1 ;; esac
  # The workflow unsets OIDC request credentials before entering this process.
  # All permanent source/Drive credentials belong to the separate capture step.
  local variable
  for variable in ${!ECO_@}; do test -z "${!variable}" || return 1; done
  for variable in ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    PGPASSWORD PGPASSFILE SUPABASE_SERVICE_ROLE_KEY GOOGLE_APPLICATION_CREDENTIALS \
    AGE_SECRET_KEY AGE_IDENTITY_FILE BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH; do
    test -z "${!variable:-}" || return 1
  done
}

install_backup_tools() {
  verify_install_context || return 1
  umask 077
  test -d "$RUNNER_TEMP" && test ! -L "$RUNNER_TEMP" && test -O "$RUNNER_TEMP"
  test "$(uname -s)" = Linux && test "$(dpkg --print-architecture)" = amd64
  . /etc/os-release
  test "$ID" = ubuntu && test "$VERSION_ID" = 24.04 && test "$VERSION_CODENAME" = noble
  local backup_tools_dir="$RUNNER_TEMP/eco-backup-tools"
  mkdir -m 700 "$backup_tools_dir"
  mkdir -m 700 "$backup_tools_dir/gnupg"
  local curl_options=(--fail --silent --show-error --proto '=https' --proto-redir '=https'
    --connect-timeout 15 --max-time 180 --retry 2 --retry-max-time 360)
  curl "${curl_options[@]}" https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$backup_tools_dir/pgdg.asc"
  gpg --no-options --homedir "$backup_tools_dir/gnupg" --batch --show-keys --with-colons \
    "$backup_tools_dir/pgdg.asc" 2>/dev/null | verify_pgdg_key_listing
  sudo install -d /usr/share/postgresql-common/pgdg
  sudo install -m 644 "$backup_tools_dir/pgdg.asc" /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  cat > "$backup_tools_dir/pgdg.sources" <<'SOURCE'
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: noble-pgdg
Architectures: amd64
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
SOURCE
  sudo install -m 644 "$backup_tools_dir/pgdg.sources" /etc/apt/sources.list.d/pgdg.sources
  sudo apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update -qq
  sudo env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 \
    install --yes --no-install-recommends postgresql-17 postgresql-client-17
  # A major-specific package keeps security patches current without silently
  # changing archive format major. Reject an unexpectedly old package source.
  dpkg --compare-versions "$(dpkg-query -W -f='${Version}' postgresql-17)" ge 17.11
  local tool
  for tool in pg_dump pg_restore psql initdb pg_ctl postgres; do test -x "/usr/lib/postgresql/17/bin/$tool"; done
  /usr/lib/postgresql/17/bin/pg_dump --version | awk '$3 !~ /^17\./ {exit 1}'
  ldd /usr/lib/postgresql/17/bin/pg_dump | awk '/libssl\.so/ {found=1} END {exit !found}'
  test -f /usr/share/postgresql/17/extension/pgcrypto.control
  test -f /usr/share/postgresql/17/extension/uuid-ossp.control
  curl "${curl_options[@]}" --location \
    https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz \
    -o "$backup_tools_dir/age.tar.gz"
  printf '%s  %s\n' cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 "$backup_tools_dir/age.tar.gz" | sha256sum --check --status
  tar -xzf "$backup_tools_dir/age.tar.gz" -C "$backup_tools_dir" age/age age/age-keygen
  curl "${curl_options[@]}" \
    https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt \
    -o "$backup_tools_dir/source-ca.crt"
  printf '%s  %s\n' 700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7 "$backup_tools_dir/source-ca.crt" | sha256sum --check --status
  chmod 600 "$backup_tools_dir/source-ca.crt"
  test "$("$backup_tools_dir/age/age" --version)" = v1.3.2
  /usr/lib/postgresql/17/bin/pg_dump --version
  "$backup_tools_dir/age/age" --version
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then install_backup_tools; fi
