#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_DIR="$ROOT_DIR/apps"
GITLEAKS_VERSION="8.30.1"

print_help() {
  cat <<'EOF'
Usage:
  ./task.sh start <service> [-- <extra args>]
  ./task.sh kill
  ./task.sh update <npm|pocketbase> [-- <extra args>]
  ./task.sh audit [-- <extra args>]
  ./task.sh install <npm> [-- <extra args>]
  ./task.sh deploy <service> [--skip-verify]
  ./task.sh rollback <service> <1|2|3>
  ./task.sh backup <service>
  ./task.sh archive <service>
  ./task.sh restore <archive-tag>
  ./task.sh archives [service]
  ./task.sh archives --delete <archive-tag>
  ./task.sh merge [service]
  ./task.sh test [service]
  ./task.sh lint [service]
  ./task.sh tsc [service]
  ./task.sh diag [file-or-service] [--profile] [--no-daemon]
  ./task.sh verify [service]
  ./task.sh preflight
  ./task.sh jj-main
  ./task.sh knip [-- <extra args>]
  ./task.sh gitleaks [--staged|--history|--range <git-log-range>|--latest|--ci] [-- <extra args>]
  ./task.sh index <service> [--section <name>] [--file <relative-path>] [--json|--pretty]
  ./task.sh new [service] [-- <extra args>]
  ./task.sh css [service]
  ./task.sh bundle
  ./task.sh generate [-- <extra args>]
  ./task.sh format [-- <extra args>]

Commands:
  start     Start service in foreground
  kill      Kill running pocketbase/pbw processes and free their ports
  update    `npm` runs npm up in root and app package.json dirs; `pocketbase` runs pocketbase update in app dirs
  audit     Run npm audit in root and app package.json dirs; continues across dirs and fails at the end if any dir reports vulnerabilities
  install   `npm` runs npm install in root and app package.json dirs
  deploy    Verify and upload one service deploy targets using .vscode/sftp.json
  rollback  Restore deploy history version 1, 2, or 3 for one service target set
  backup    Archive the remote pb_data directory over SSH and download it to ~/pocketpages-backups/<service>/
  archive   Tag current HEAD as archive/<service>/<YYYY-MM-DD>, push it, then remove apps/<service>
  restore   Restore apps/<service> from an archive tag
  archives  List archive tags, optionally filtered by service; use --delete to remove one archive tag locally and from origin
  merge     Merge main into local release/* branches, then push them to origin
  test      Run node:test files under __tests__ for one service or all services
  lint      Run PocketPages self-validation checks and ESLint for one service or all services
  tsc       Run checkJs TypeScript verification with jsconfig.json for one service or all services
  diag      Run PocketPages editor diagnostics for one file, one service, or all services when omitted
            `--profile` prints slow-file timings, `--no-daemon` disables the warm background cache
  verify    Run lint, tsc, and diag together for one service or all services
  preflight Run format, css, verify, staged Gitleaks, and Knip as a final local check
  jj-main   Move the main jj bookmark to current @ and push it after a safety preview
  knip      Run Knip unused files/dependencies check for the whole repository
  gitleaks  Run Gitleaks secret scan; defaults to staged changes
  index     Query AI-friendly PocketPages project index JSON for one service
  new       Interactively scaffold a new PocketPages service
  css       Build UnoCSS for one service or all services that reference it
  bundle    Interactively bundle one service dependency into pb_hooks/pages/_private/vendor
  generate  Interactively generate a PocketPages api/xapi route file
  format    Run npm run format

Examples:
  ./task.sh css booklog
  ./task.sh deploy booklog
  ./task.sh deploy booklog --skip-verify
  ./task.sh backup booklog
  ./task.sh archive portfolio
  ./task.sh restore archive/portfolio/2026-05-28
  ./task.sh archives portfolio
  ./task.sh archives --delete archive/portfolio/2026-05-28
  ./task.sh merge
  ./task.sh merge booklog
  ./task.sh new my-service
  ./task.sh update npm
  ./task.sh update npm -- --save
  ./task.sh install npm
  ./task.sh install npm -- --package-lock-only
  ./task.sh update pocketbase
  ./task.sh update pocketbase -- --backup
  ./task.sh audit
  ./task.sh audit -- --omit=dev
  ./task.sh preflight
  ./task.sh jj-main
  ./task.sh knip
  ./task.sh gitleaks --history
  ./task.sh generate
  ./task.sh generate -- --service booklog --kind xapi-redirect --path books/delete-note
EOF
}

list_services() {
  local d
  [[ -d "$APPS_DIR" ]] || return 0
  for d in "$APPS_DIR"/*; do
    [[ -d "$d" ]] || continue
    [[ -d "$d/pb_hooks" ]] || continue
    basename "$d"
  done | sort
}

resolve_service_dir() {
  local service="$1"
  if [[ -d "$service" ]]; then
    (cd "$service" && pwd)
    return 0
  fi

  if [[ -d "$APPS_DIR/$service" ]]; then
    (cd "$APPS_DIR/$service" && pwd)
    return 0
  fi

  if [[ -d "$ROOT_DIR/$service" ]]; then
    (cd "$ROOT_DIR/$service" && pwd)
    return 0
  fi

  return 1
}

RUNNER=()

resolve_pbw_cmd() {
  local service_dir="$1"
  RUNNER=()

  if [[ -f "$service_dir/pbw.exe" && -f "$service_dir/pocketbase.exe" ]]; then
    RUNNER=("$service_dir/pbw.exe" "$service_dir/pocketbase.exe")
    return 0
  fi

  if [[ -f "$service_dir/pbw" && -f "$service_dir/pocketbase" ]]; then
    RUNNER=("$service_dir/pbw" "$service_dir/pocketbase")
    return 0
  fi

  return 1
}

load_service_env() {
  local service_dir="$1"
  local env_file="$service_dir/.env"

  [[ -f "$env_file" ]] || return 0

  echo "Loading environment: $env_file"

  set -a
  # shellcheck disable=SC1090
  source <(sed -e 's/\r$//' "$env_file")
  set +a
}

start_service() {
  local service="$1"
  shift || true

  local service_dir
  if ! service_dir="$(resolve_service_dir "$service")"; then
    echo "Unknown service: $service" >&2
    echo "Available services:" >&2
    list_services >&2
    exit 1
  fi

  if [[ ! -d "$service_dir/pb_hooks" ]]; then
    echo "Missing pb_hooks in $service_dir" >&2
    exit 1
  fi

  if ! resolve_pbw_cmd "$service_dir"; then
    cat >&2 <<EOF
Missing pbw/pocketbase binaries in service directory:
  $service_dir
Expected one of:
  - pbw.exe + pocketbase.exe
  - pbw + pocketbase
EOF
    exit 1
  fi

  load_service_env "$service_dir"

  local cmd=(
    "${RUNNER[@]}"
    serve
    "--dev"
    "--dir=$service_dir/pb_data"
    "--hooksDir=$service_dir/pb_hooks"
  )

  [[ -d "$service_dir/pb_public" ]] && cmd+=("--publicDir=$service_dir/pb_public")
  [[ -d "$service_dir/pb_migrations" ]] && cmd+=("--migrationsDir=$service_dir/pb_migrations")

  if [[ $# -gt 0 ]]; then
    cmd+=("$@")
  fi

  echo "Running service: $service"
  echo "Command: ${cmd[*]}"

  exec "${cmd[@]}"
}

kill_pocketbase() {
  local ps_cmd=""
  if command -v powershell.exe >/dev/null 2>&1; then
    ps_cmd="powershell.exe"
  elif command -v pwsh >/dev/null 2>&1; then
    ps_cmd="pwsh"
  else
    echo "PowerShell not found. Cannot run kill command." >&2
    exit 1
  fi

  "$ps_cmd" -NoProfile -Command '
    $ErrorActionPreference = "SilentlyContinue"
    $targets = Get-CimInstance Win32_Process |
      Where-Object { $_.Name -match "^(pocketbase|pbw)(\.exe)?$" } |
      Select-Object -ExpandProperty ProcessId

    if (-not $targets) {
      Write-Output "No pocketbase/pbw process found."
      exit 0
    }

    $targets = $targets | Sort-Object -Unique
    $ports = Get-NetTCPConnection -State Listen |
      Where-Object { $targets -contains $_.OwningProcess } |
      Sort-Object LocalPort |
      Select-Object LocalAddress, LocalPort, OwningProcess

    Write-Output "[Before] Listening ports:"
    if ($ports) {
      $ports | Format-Table -AutoSize | Out-String | Write-Output
    } else {
      Write-Output "none"
    }

    foreach ($procId in $targets) {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Milliseconds 300

    $after = Get-CimInstance Win32_Process |
      Where-Object { $_.Name -match "^(pocketbase|pbw)(\.exe)?$" } |
      Select-Object -ExpandProperty ProcessId
    $afterPorts = @()
    if ($after) {
      $afterPorts = Get-NetTCPConnection -State Listen |
        Where-Object { $after -contains $_.OwningProcess } |
        Sort-Object LocalPort |
        Select-Object LocalAddress, LocalPort, OwningProcess
    }

    Write-Output "[After] Listening ports:"
    if ($afterPorts) {
      $afterPorts | Format-Table -AutoSize | Out-String | Write-Output
    } else {
      Write-Output "none"
    }
  '
}

run_npm_app_command() {
  local npm_command="$1"
  shift || true

  local update_script="$ROOT_DIR/scripts/up-apps.js"

  if [[ ! -f "$update_script" ]]; then
    echo "Missing npm script: $update_script" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run npm command." >&2
    exit 1
  fi

  node "$update_script" --npm-command "$npm_command" "$@"
}

run_update_npm() {
  run_npm_app_command up "$@"
}

run_install_npm() {
  run_npm_app_command install "$@"
}

run_audit() {
  run_npm_app_command audit "$@"
}

run_update_pocketbase() {
  local update_script="$ROOT_DIR/scripts/up-pocketbase.js"

  if [[ ! -f "$update_script" ]]; then
    echo "Missing update script: $update_script" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run PocketBase update." >&2
    exit 1
  fi

  node "$update_script" "$@"
}

run_update() {
  local target="${1:-}"
  shift || true

  case "$target" in
    npm)
      run_update_npm "$@"
      ;;
    pocketbase)
      run_update_pocketbase "$@"
      ;;
    *)
      echo "Unknown update target: $target" >&2
      echo "Usage: ./task.sh update <npm|pocketbase> [-- <extra args>]" >&2
      exit 1
      ;;
  esac
}

run_install() {
  local target="${1:-}"
  shift || true

  case "$target" in
    npm)
      run_install_npm "$@"
      ;;
    *)
      echo "Unknown install target: $target" >&2
      echo "Usage: ./task.sh install <npm> [-- <extra args>]" >&2
      exit 1
      ;;
  esac
}

run_lint() {
  local lint_script="$ROOT_DIR/scripts/lint-pocketpages.js"
  local eslint_bin="$ROOT_DIR/node_modules/eslint/bin/eslint.js"
  local service="${1:-}"
  local service_dir=""
  local eslint_target="."
  local eslint_cache_dir="$ROOT_DIR/.cache/eslint/"
  local failed=0

  if [[ ! -f "$lint_script" ]]; then
    echo "Missing lint script: $lint_script" >&2
    exit 1
  fi

  if [[ ! -f "$eslint_bin" ]]; then
    echo "Missing local ESLint install: $eslint_bin" >&2
    echo "Run npm install in the repository root first." >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run lint command." >&2
    exit 1
  fi

  if [[ -n "$service" ]]; then
    if ! service_dir="$(resolve_service_dir "$service")"; then
      echo "Unknown service: $service" >&2
      echo "Available services:" >&2
      list_services >&2
      exit 1
    fi

    if [[ "$service_dir" == "$ROOT_DIR"/* ]]; then
      eslint_target="${service_dir#$ROOT_DIR/}"
    else
      eslint_target="$service_dir"
    fi
  fi

  if [[ -n "$service_dir" ]]; then
    if ! node "$lint_script" "$service_dir"; then
      failed=1
    fi
  else
    if ! node "$lint_script"; then
      failed=1
    fi
  fi

  echo
  echo "Running ESLint..."
  if ! (
    cd "$ROOT_DIR"
    mkdir -p "$eslint_cache_dir"
    node "$eslint_bin" "$eslint_target" --cache --cache-location "$eslint_cache_dir"
  ); then
    failed=1
  fi

  if [[ "$failed" -ne 0 ]]; then
    exit 1
  fi
}

resolve_tsc_bin() {
  local candidate="$ROOT_DIR/node_modules/typescript/bin/tsc"
  [[ -f "$candidate" ]] || return 1
  printf '%s\n' "$candidate"
}

run_tsc_for_service() {
  local tsc_bin="$1"
  local service_dir="$2"
  local service_name
  local config_file
  local tsc_cache_file

  service_name="$(basename "$service_dir")"
  config_file="$service_dir/jsconfig.json"
  tsc_cache_file="$ROOT_DIR/.cache/tsc/${service_name}.tsbuildinfo"

  if [[ ! -f "$config_file" ]]; then
    echo "Skipping $service_name: missing jsconfig.json."
    return 0
  fi

  echo "Running TypeScript check for service: $service_name"
  mkdir -p "$(dirname "$tsc_cache_file")"
  node "$tsc_bin" -p "$config_file" --pretty false --incremental --tsBuildInfoFile "$tsc_cache_file"
}

run_test() {
  local service="${1:-}"

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run test command." >&2
    exit 1
  fi

  run_test_for_service() {
    local service_dir="$1"
    local service_name
    service_name="$(basename "$service_dir")"
    local test_dir="$service_dir/__tests__"
    local test_files=()

    if [[ ! -d "$test_dir" ]]; then
      echo "Skipping $service_name: missing __tests__ directory."
      return 0
    fi

    mapfile -t test_files < <(find "$test_dir" -type f \( -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' \) | sort)

    if [[ "${#test_files[@]}" -eq 0 ]]; then
      echo "Skipping $service_name: no node:test files found."
      return 0
    fi

    echo "Running tests for service: $service_name"
    (
      cd "$service_dir"
      node --test --test-concurrency=1 "${test_files[@]}"
    )
  }

  if [[ -n "$service" ]]; then
    local service_dir
    if ! service_dir="$(resolve_service_dir "$service")"; then
      echo "Unknown service: $service" >&2
      echo "Available services:" >&2
      list_services >&2
      exit 1
    fi

    run_test_for_service "$service_dir"
    return 0
  fi

  local service_name
  local service_dir
  local failed=0

  while IFS= read -r service_name; do
    service_dir="$APPS_DIR/$service_name"

    if ! run_test_for_service "$service_dir"; then
      failed=1
    fi
  done < <(list_services)

  if [[ "$failed" -ne 0 ]]; then
    exit 1
  fi
}

run_tsc() {
  local service="${1:-}"
  local tsc_bin=""

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run tsc command." >&2
    exit 1
  fi

  if ! tsc_bin="$(resolve_tsc_bin)"; then
    echo "Missing local TypeScript install." >&2
    echo "Run npm install in the repository root first." >&2
    echo "Expected:" >&2
    echo "  - $ROOT_DIR/node_modules/typescript/bin/tsc" >&2
    exit 1
  fi

  if [[ -n "$service" ]]; then
    local service_dir
    if ! service_dir="$(resolve_service_dir "$service")"; then
      echo "Unknown service: $service" >&2
      echo "Available services:" >&2
      list_services >&2
      exit 1
    fi

    run_tsc_for_service "$tsc_bin" "$service_dir"
    return 0
  fi

  local service_name=""
  local service_dir=""
  local failed=0

  while IFS= read -r service_name; do
    service_dir="$APPS_DIR/$service_name"

    if ! run_tsc_for_service "$tsc_bin" "$service_dir"; then
      failed=1
    fi
  done < <(list_services)

  if [[ "$failed" -ne 0 ]]; then
    exit 1
  fi
}

run_diag() {
  local diag_script="$ROOT_DIR/scripts/diag-pocketpages.js"
  local target="${1:-}"
  local extra_args=()

  if [[ -n "$target" && "$target" == --* ]]; then
    target=""
  elif [[ -n "$target" ]]; then
    shift || true
  fi

  extra_args=("$@")

  if [[ ! -f "$diag_script" ]]; then
    echo "Missing diag script: $diag_script" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run diag command." >&2
    exit 1
  fi

  if [[ -n "$target" ]]; then
    if [[ -f "$target" ]]; then
      node "$diag_script" "${extra_args[@]}" "$target"
      return 0
    fi

    local service_dir
    if ! service_dir="$(resolve_service_dir "$target")"; then
      echo "Unknown service or file: $target" >&2
      echo "Available services:" >&2
      list_services >&2
      exit 1
    fi
    node "$diag_script" "${extra_args[@]}" "$service_dir"
    return 0
  fi

  node "$diag_script" "${extra_args[@]}"
}

run_verify() {
  local service="${1:-}"

  run_lint "$service"
  run_tsc "$service"
  run_diag "$service"
}

run_knip() {
  if ! command -v npx >/dev/null 2>&1; then
    echo "npx not found. Cannot run Knip command." >&2
    exit 1
  fi

  (
    cd "$ROOT_DIR"
    npx --yes knip@6.27.0 --no-progress --no-config-hints "$@"
  )
}

download_gitleaks_release_asset() {
  local install_dir="$1"
  local bin_path="$2"
  local asset_name="$3"
  local release_url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
  local tmp_dir="$ROOT_DIR/.download/gitleaks/.tmp-${GITLEAKS_VERSION}-$$"
  local archive_path="$tmp_dir/$asset_name"
  local checksums_path="$tmp_dir/gitleaks_${GITLEAKS_VERSION}_checksums.txt"
  local expected_sha=""
  local extracted_bin=""

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found. Cannot download Gitleaks." >&2
    exit 1
  fi

  if ! command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum not found. Cannot verify Gitleaks download." >&2
    exit 1
  fi

  echo "Downloading Gitleaks v${GITLEAKS_VERSION}: $asset_name" >&2
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir" "$install_dir"

  curl -fsSL "$release_url/$asset_name" -o "$archive_path"
  curl -fsSL "$release_url/gitleaks_${GITLEAKS_VERSION}_checksums.txt" -o "$checksums_path"

  expected_sha="$(awk -v file="$asset_name" '$2 == file { print $1 }' "$checksums_path")"

  if [[ -z "$expected_sha" ]]; then
    echo "Checksum not found for $asset_name" >&2
    rm -rf "$tmp_dir"
    exit 1
  fi

  printf '%s  %s\n' "$expected_sha" "$archive_path" | sha256sum -c - >/dev/null

  case "$asset_name" in
    *.zip)
      if ! command -v powershell.exe >/dev/null 2>&1 || ! command -v cygpath >/dev/null 2>&1; then
        echo "PowerShell and cygpath are required to extract Gitleaks zip archives." >&2
        rm -rf "$tmp_dir"
        exit 1
      fi

      powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
        '& { param($archivePath, $outputDir) Expand-Archive -LiteralPath $archivePath -DestinationPath $outputDir -Force }' \
        "$(cygpath -w "$archive_path")" \
        "$(cygpath -w "$tmp_dir")"
      ;;
    *.tar.gz)
      if ! command -v tar >/dev/null 2>&1; then
        echo "tar not found. Cannot extract Gitleaks." >&2
        rm -rf "$tmp_dir"
        exit 1
      fi

      tar -xzf "$archive_path" -C "$tmp_dir"
      ;;
    *)
      echo "Unsupported Gitleaks archive type: $asset_name" >&2
      rm -rf "$tmp_dir"
      exit 1
      ;;
  esac

  extracted_bin="$(find "$tmp_dir" -type f \( -name gitleaks.exe -o -name gitleaks \) | head -n 1)"

  if [[ -z "$extracted_bin" ]]; then
    echo "Gitleaks executable not found in $asset_name." >&2
    rm -rf "$tmp_dir"
    exit 1
  fi

  cp "$extracted_bin" "$bin_path"
  chmod +x "$bin_path"
  rm -rf "$tmp_dir"
}

resolve_gitleaks_bin() {
  local os_name="$(uname -s)"
  local install_dir=""
  local bin_name="gitleaks"
  local asset_name=""

  case "$os_name" in
    MINGW*|MSYS*|CYGWIN*)
      install_dir="$ROOT_DIR/.download/gitleaks/$GITLEAKS_VERSION/windows-x64"
      bin_name="gitleaks.exe"
      asset_name="gitleaks_${GITLEAKS_VERSION}_windows_x64.zip"
      ;;
    Linux)
      install_dir="$ROOT_DIR/.download/gitleaks/$GITLEAKS_VERSION/linux-x64"
      asset_name="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
      ;;
    *)
      echo "Gitleaks auto-download supports Windows Git Bash and Linux x64 only. os=$os_name" >&2
      exit 1
      ;;
  esac

  local bin_path="$install_dir/$bin_name"

  if [[ ! -f "$bin_path" ]]; then
    download_gitleaks_release_asset "$install_dir" "$bin_path" "$asset_name"
  fi

  printf '%s\n' "$bin_path"
}

print_gitleaks_help() {
  cat <<'EOF'
Usage:
  ./task.sh gitleaks [--staged|--history|--range <git-log-range>|--latest|--ci] [-- <extra gitleaks args>]

Options:
  --staged   Scan staged changes for pre-commit use. Default.
  --history  Scan the git repository history.
  --range    Scan a git log range, for example OLD..NEW.
  --latest   Scan only the latest commit.
  --ci       Scan the current GitHub Actions push range, falling back to latest.
  --help     Show this help.

Examples:
  ./task.sh gitleaks
  ./task.sh gitleaks --history
  ./task.sh gitleaks --range HEAD~1..HEAD
  ./task.sh gitleaks --latest
  ./task.sh gitleaks --ci
  ./task.sh gitleaks --staged -- --log-level debug
EOF
}

resolve_gitleaks_ci_log_opts() {
  local before_sha="${BEFORE_SHA:-${GITHUB_EVENT_BEFORE:-}}"
  local current_sha="${GITHUB_SHA:-HEAD}"
  local zero_sha="0000000000000000000000000000000000000000"

  if [[ -z "$before_sha" || "$before_sha" == "$zero_sha" ]]; then
    printf '%s\n' "-1 $current_sha"
    return 0
  fi

  (
    cd "$ROOT_DIR"
    if ! git cat-file -e "${before_sha}^{commit}" 2>/dev/null; then
      if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
        git fetch --no-tags --deepen=200 origin "$GITHUB_REF_NAME" >/dev/null 2>&1 || true
      fi
    fi

    if ! git cat-file -e "${before_sha}^{commit}" 2>/dev/null; then
      echo "Pushed range base commit is not available: $before_sha" >&2
      exit 1
    fi
  )

  printf '%s\n' "${before_sha}..${current_sha}"
}

run_gitleaks() {
  local mode="staged"
  local extra_args=()
  local gitleaks_bin=""
  local gitleaks_args=()
  local log_opts=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --staged|--pre-commit)
        mode="staged"
        shift
        ;;
      --history)
        mode="history"
        shift
        ;;
      --range)
        shift
        if [[ $# -eq 0 || -z "$1" ]]; then
          echo "Missing git log range for --range." >&2
          print_gitleaks_help >&2
          exit 1
        fi
        mode="range"
        log_opts="$1"
        shift
        ;;
      --range=*)
        mode="range"
        log_opts="${1#--range=}"
        if [[ -z "$log_opts" ]]; then
          echo "Missing git log range for --range." >&2
          print_gitleaks_help >&2
          exit 1
        fi
        shift
        ;;
      --latest)
        mode="latest"
        shift
        ;;
      --ci)
        mode="ci"
        shift
        ;;
      -h|--help)
        print_gitleaks_help
        return 0
        ;;
      --)
        shift
        extra_args=("$@")
        break
        ;;
      *)
        echo "Unknown gitleaks option: $1" >&2
        print_gitleaks_help >&2
        exit 1
        ;;
    esac
  done

  gitleaks_bin="$(resolve_gitleaks_bin)"

  if [[ "$mode" == "history" ]]; then
    gitleaks_args=(git --redact --verbose --no-banner)
  elif [[ "$mode" == "range" ]]; then
    gitleaks_args=(git --redact --verbose --no-banner --log-opts "$log_opts")
  elif [[ "$mode" == "latest" ]]; then
    gitleaks_args=(git --redact --verbose --no-banner --log-opts "-1 HEAD")
  elif [[ "$mode" == "ci" ]]; then
    log_opts="$(resolve_gitleaks_ci_log_opts)"
    gitleaks_args=(git --redact --verbose --no-banner --log-opts "$log_opts")
  else
    gitleaks_args=(git --pre-commit --staged --redact --verbose --no-banner)
  fi

  (
    cd "$ROOT_DIR"
    "$gitleaks_bin" "${gitleaks_args[@]}" "${extra_args[@]}"
  )
}

run_index() {
  local index_script="$ROOT_DIR/scripts/index-pocketpages.js"
  local service="${1:-}"
  shift || true

  if [[ ! -f "$index_script" ]]; then
    echo "Missing index script: $index_script" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run index command." >&2
    exit 1
  fi

  if [[ -z "$service" ]]; then
    echo "Usage: ./task.sh index <service> [--section <name>] [--file <relative-path>] [--json|--pretty]" >&2
    exit 1
  fi

  local service_dir
  if ! service_dir="$(resolve_service_dir "$service")"; then
    echo "Unknown service: $service" >&2
    echo "Available services:" >&2
    list_services >&2
    exit 1
  fi

  node "$index_script" "$service_dir" "$@"
}

run_css() {
  local service="${1:-}"
  shift || true

  local unocss_bin="$ROOT_DIR/node_modules/@unocss/cli/bin/unocss.mjs"
  local config_file="$ROOT_DIR/unocss.config.js"

  if [[ $# -gt 0 ]]; then
    echo "Unknown css option: $1" >&2
    echo "Usage: ./task.sh css [service]" >&2
    exit 1
  fi

  if [[ ! -f "$unocss_bin" ]]; then
    echo "Missing local UnoCSS install: $unocss_bin" >&2
    echo "Run npm install in the repository root first." >&2
    exit 1
  fi

  if [[ ! -f "$config_file" ]]; then
    echo "Missing UnoCSS config: $config_file" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run css command." >&2
    exit 1
  fi

  if [[ -z "$service" ]]; then
    local service_name=""
    local failed=0
    local built=0

    while IFS= read -r service_name; do
      if ! service_needs_css_build "$service_name"; then
        echo "Skipping $service_name: no /assets/uno.min.css reference found."
        continue
      fi

      built=1
      if ! run_css "$service_name"; then
        failed=1
      fi
    done < <(list_services)

    if [[ "$built" -eq 0 ]]; then
      echo "No services need a UnoCSS build."
    fi

    if [[ "$failed" -ne 0 ]]; then
      exit 1
    fi

    return 0
  fi

  local service_dir
  if ! service_dir="$(resolve_service_dir "$service")"; then
    echo "Unknown service: $service" >&2
    echo "Available services:" >&2
    list_services >&2
    exit 1
  fi

  local pages_dir="$service_dir/pb_hooks/pages"
  local output_file="$pages_dir/assets/uno.min.css"
  local content_patterns=()
  local relative_output_file=""

  if [[ ! -d "$pages_dir" ]]; then
    echo "Missing PocketPages pages directory: $pages_dir" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$output_file")"

  if [[ "$service_dir" == "$ROOT_DIR"/* ]]; then
    local relative_service_dir="${service_dir#$ROOT_DIR/}"
    content_patterns=(
      "$relative_service_dir/pb_hooks/pages/**/*.ejs"
      "$relative_service_dir/pb_hooks/pages/_private/**/*.js"
      "!$relative_service_dir/pb_hooks/pages/_private/vendor/**"
      "$relative_service_dir/pb_hooks/pages/assets/**/*.js"
      "!$relative_service_dir/pb_hooks/pages/assets/vendor/**"
    )
    relative_output_file="$relative_service_dir/pb_hooks/pages/assets/uno.min.css"
  else
    content_patterns=(
      "$pages_dir/**/*.ejs"
      "$pages_dir/_private/**/*.js"
      "!$pages_dir/_private/vendor/**"
      "$pages_dir/assets/**/*.js"
      "!$pages_dir/assets/vendor/**"
    )
    relative_output_file="$output_file"
  fi

  local cmd=(
    node
    "$unocss_bin"
    "${content_patterns[@]}"
    -c
    "$config_file"
    -o
    "$relative_output_file"
    --minify
  )

  echo "Building UnoCSS for service: $(basename "$service_dir")"
  echo "Output: $output_file"
  (
    cd "$ROOT_DIR"
    "${cmd[@]}"
  )
}

service_needs_css_build() {
  local service="$1"
  local service_dir=""
  local pages_dir=""

  if ! service_dir="$(resolve_service_dir "$service")"; then
    echo "Unknown service: $service" >&2
    echo "Available services:" >&2
    list_services >&2
    exit 1
  fi

  pages_dir="$service_dir/pb_hooks/pages"
  [[ -d "$pages_dir" ]] || return 1

  local file=""
  while IFS= read -r file; do
    if grep -q "/assets/uno.min.css" "$file"; then
      return 0
    fi
  done < <(find "$pages_dir" -type f \( -name '*.ejs' -o -name '*.js' \))

  return 1
}

run_css_if_needed() {
  local service="$1"

  if service_needs_css_build "$service"; then
    echo "Running production CSS build: $service"
    run_css "$service"
  fi
}

run_format() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm not found. Cannot run format command." >&2
    exit 1
  fi

  npm run format -- "$@"
}

run_preflight() {
  echo "Running preflight step: format"
  run_format

  echo
  echo "Running preflight step: css"
  run_css

  echo
  echo "Running preflight step: verify"
  run_verify

  echo
  echo "Running preflight step: gitleaks"
  run_gitleaks

  echo
  echo "Running preflight step: knip"
  run_knip

  echo
  echo "Running preflight step: audit"
  run_audit
}

print_jj_main_help() {
  cat <<'EOF'
Usage:
  ./task.sh jj-main

Moves the main jj bookmark to current @ and pushes it.
EOF
}

run_jj_main() {
  local answer=""
  local current_description=""
  local current_is_empty=""

  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    print_jj_main_help
    return 0
  fi

  [[ $# -eq 0 ]] || { echo "Usage: ./task.sh jj-main" >&2; exit 1; }

  if ! command -v jj >/dev/null 2>&1; then
    echo "jj not found. Install Jujutsu or run this command in a shell where jj is available." >&2
    exit 1
  fi

  (
    cd "$ROOT_DIR"

    if ! jj root >/dev/null 2>&1; then
      echo "Not a jj repository: $ROOT_DIR" >&2
      exit 1
    fi

    echo "== jj status =="
    jj status

    echo
    echo "== recent log =="
    jj log -n 5

    current_is_empty="$(jj log -r @ --no-graph -T 'empty')"
    current_description="$(jj log -r @ --no-graph -T 'description')"

    if [[ "$current_is_empty" == "true" ]]; then
      cat >&2 <<'EOF'

Current @ is empty, so there is no work to move to main.
If main was moved here by mistake, move it back before trying again:
  jj bookmark set main -r @-
EOF
      exit 1
    fi

    if [[ -z "$current_description" ]]; then
      cat >&2 <<'EOF'

Current @ has no description. Describe it before pushing to main:
  jj describe -m "작업 설명"
EOF
      exit 1
    fi

    echo
    read -r -p "Move main bookmark to current @ and push? [y/N] " answer

    case "$answer" in
      y|Y|yes|YES)
        ;;
      *)
        echo "Cancelled."
        exit 1
        ;;
    esac

    echo
    echo "== fetch =="
    jj git fetch

    echo
    echo "== move main bookmark to current @ =="
    jj bookmark set main -r @

    echo
    echo "== push main =="
    jj git push --bookmark main
  )
}

list_release_services() {
  git -C "$ROOT_DIR" for-each-ref --format='%(refname:short)' refs/heads/release 2>/dev/null |
    sed -n 's#^release/##p' |
    sort
}

list_release_branches() {
  git -C "$ROOT_DIR" for-each-ref --format='%(refname:short)' refs/heads/release 2>/dev/null |
    sed -n '/^release\//p' |
    sort
}

require_merge_service_dirs() {
  local branch=""
  local service=""
  local missing=0

  for branch in "$@"; do
    service="${branch#release/}"

    if [[ ! -d "$APPS_DIR/$service" ]]; then
      echo "Merge cancelled: missing service directory on main: apps/$service" >&2
      missing=1
    fi
  done

  [[ "$missing" -eq 0 ]]
}

require_clean_git_worktree() {
  local action="${1:-operation}"

  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    echo "Working tree is not clean. Commit or stash local changes before $action." >&2
    exit 1
  fi
}

list_archive_services() {
  git -C "$ROOT_DIR" for-each-ref --format='%(refname:short)' refs/tags/archive 2>/dev/null |
    sed -n 's#^archive/\([^/][^/]*\)/.*#\1#p' |
    sort -u
}

list_archive_tags() {
  local service="${1:-}"
  local pattern="archive/*"

  if [[ -n "$service" ]]; then
    pattern="archive/$service/*"
  fi

  git -C "$ROOT_DIR" tag --list "$pattern" | sort
}

run_archives() {
  local service="${1:-}"

  if ! command -v git >/dev/null 2>&1; then
    echo "git not found. Cannot list archive tags." >&2
    exit 1
  fi

  list_archive_tags "$service"
}

run_delete_archive() {
  local tag_name="$1"
  local local_exists=0
  local remote_exists=0
  local remote_status=0

  if ! command -v git >/dev/null 2>&1; then
    echo "git not found. Cannot delete archive tag." >&2
    exit 1
  fi

  if [[ ! "$tag_name" =~ ^archive/[^/]+/[^/]+$ ]]; then
    echo "Archive delete only accepts tags like archive/<service>/<tag>: $tag_name" >&2
    exit 1
  fi

  if git -C "$ROOT_DIR" show-ref --verify --quiet "refs/tags/$tag_name"; then
    local_exists=1
  fi

  if git -C "$ROOT_DIR" remote get-url origin >/dev/null 2>&1; then
    if git -C "$ROOT_DIR" ls-remote --exit-code --tags origin "refs/tags/$tag_name" >/dev/null 2>&1; then
      remote_exists=1
    else
      remote_status=$?
      if [[ "$remote_status" -ne 2 ]]; then
        echo "Failed to check origin archive tag: $tag_name" >&2
        exit 1
      fi
    fi
  fi

  if [[ "$local_exists" -eq 0 && "$remote_exists" -eq 0 ]]; then
    echo "Unknown archive tag: $tag_name" >&2
    echo "Available archive tags:" >&2
    list_archive_tags >&2
    exit 1
  fi

  if [[ "$local_exists" -eq 1 ]]; then
    git -C "$ROOT_DIR" tag -d "$tag_name"
  fi

  if [[ "$remote_exists" -eq 1 ]]; then
    git -C "$ROOT_DIR" push origin ":refs/tags/$tag_name"
  fi

  echo "Deleted archive tag: $tag_name"
}

run_archive() {
  local service="$1"
  local service_dir=""
  local service_name=""
  local relative_path=""
  local tag_name=""

  if ! command -v git >/dev/null 2>&1; then
    echo "git not found. Cannot archive service." >&2
    exit 1
  fi

  require_clean_git_worktree archive

  if ! service_dir="$(resolve_service_dir "$service")"; then
    echo "Unknown service: $service" >&2
    echo "Available services:" >&2
    list_services >&2
    exit 1
  fi

  if [[ "$service_dir" != "$APPS_DIR/"* ]]; then
    echo "Archive only supports services under apps/: $service" >&2
    exit 1
  fi

  if [[ ! -d "$service_dir/pb_hooks" ]]; then
    echo "Missing pb_hooks in $service_dir" >&2
    exit 1
  fi

  service_name="$(basename "$service_dir")"
  relative_path="apps/$service_name"
  tag_name="archive/$service_name/$(date +%F)"

  if git -C "$ROOT_DIR" show-ref --verify --quiet "refs/tags/$tag_name"; then
    echo "Archive tag already exists: $tag_name" >&2
    exit 1
  fi

  git -C "$ROOT_DIR" tag "$tag_name" HEAD
  if ! git -C "$ROOT_DIR" push origin "refs/tags/$tag_name"; then
    git -C "$ROOT_DIR" tag -d "$tag_name" >/dev/null 2>&1 || true
    echo "Failed to push archive tag. Service was not removed." >&2
    exit 1
  fi

  git -C "$ROOT_DIR" rm -r "$relative_path"

  if [[ -d "$ROOT_DIR/$relative_path" ]]; then
    rm -rf -- "$ROOT_DIR/$relative_path"
  fi

  cat <<EOF
Archived service: $service_name
Tag: $tag_name (pushed to origin)
Removed directory: $relative_path

Review, then commit:
  git commit -m "Archive $service_name app"
EOF
}

run_restore() {
  local service="$1"
  local tag_name="$2"
  local relative_path="apps/$service"

  if ! command -v git >/dev/null 2>&1; then
    echo "git not found. Cannot restore service." >&2
    exit 1
  fi

  require_clean_git_worktree restore

  if ! git -C "$ROOT_DIR" show-ref --verify --quiet "refs/tags/$tag_name"; then
    echo "Unknown archive tag: $tag_name" >&2
    echo "Available archive tags:" >&2
    list_archive_tags "$service" >&2
    exit 1
  fi

  if [[ -e "$ROOT_DIR/$relative_path" ]]; then
    echo "Service already exists: $relative_path" >&2
    exit 1
  fi

  if ! git -C "$ROOT_DIR" cat-file -e "$tag_name:$relative_path" 2>/dev/null; then
    echo "Archive tag does not contain $relative_path: $tag_name" >&2
    exit 1
  fi

  git -C "$ROOT_DIR" restore --source "$tag_name" -- "$relative_path"

  cat <<EOF
Restored service: $service
Source tag: $tag_name
Restored path: $relative_path

Review, then commit:
  git add $relative_path
  git commit -m "Restore $service app"
EOF
}

run_merge() {
  local service="${1:-}"
  local branches=()
  local branch=""
  local failed=0

  if ! command -v git >/dev/null 2>&1; then
    echo "git not found. Cannot run merge command." >&2
    exit 1
  fi

  require_clean_git_worktree merge

  if [[ -n "$service" ]]; then
    branch="release/$service"
    if ! git -C "$ROOT_DIR" show-ref --verify --quiet "refs/heads/$branch"; then
      echo "Unknown local release branch: $branch" >&2
      echo "Available release services:" >&2
      list_release_services >&2
      exit 1
    fi
    branches=("$branch")
  else
    mapfile -t branches < <(list_release_branches)
    if [[ "${#branches[@]}" -eq 0 ]]; then
      echo "No local release/* branches found." >&2
      exit 1
    fi
  fi

  if ! git -C "$ROOT_DIR" show-ref --verify --quiet refs/heads/main; then
    echo "Missing local main branch." >&2
    exit 1
  fi

  echo "Updating main..."
  git -C "$ROOT_DIR" checkout main
  git -C "$ROOT_DIR" pull --ff-only origin main

  if ! require_merge_service_dirs "${branches[@]}"; then
    exit 1
  fi

  for branch in "${branches[@]}"; do
    echo "Merging main into $branch..."

    git -C "$ROOT_DIR" checkout "$branch"

    if ! git -C "$ROOT_DIR" pull --ff-only origin "$branch"; then
      echo "Failed to update $branch from origin. Skipping." >&2
      failed=1
      continue
    fi

    if git -C "$ROOT_DIR" merge --no-edit main; then
      echo "Merge complete. Pushing $branch..."
      if ! git -C "$ROOT_DIR" push origin "$branch"; then
        echo "Push failed: $branch" >&2
        failed=1
      fi
    else
      echo "Merge conflict: $branch" >&2
      git -C "$ROOT_DIR" merge --abort || true
      failed=1
    fi
  done

  git -C "$ROOT_DIR" checkout main

  if [[ "$failed" -ne 0 ]]; then
    exit 1
  fi
}

run_bundle() {
  local bundle_script="$ROOT_DIR/scripts/bundle-pocketpages-vendor.mjs"

  if [[ ! -f "$bundle_script" ]]; then
    echo "Missing bundle script: $bundle_script" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run bundle command." >&2
    exit 1
  fi

  node "$bundle_script" "$@"
}

run_generate() {
  local generate_script="$ROOT_DIR/scripts/generate-pocketpages.mjs"

  if [[ ! -f "$generate_script" ]]; then
    echo "Missing generate script: $generate_script" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run generate command." >&2
    exit 1
  fi

  node "$generate_script" "$@"
}

run_new() {
  local new_script="$ROOT_DIR/scripts/new-pocketpages-service.mjs"

  if [[ ! -f "$new_script" ]]; then
    echo "Missing new script: $new_script" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run new command." >&2
    exit 1
  fi

  node "$new_script" "$@"
}

normalize_bash_path() {
  local raw_path="$1"

  if [[ "$raw_path" == "~" ]]; then
    printf '%s\n' "$HOME"
    return 0
  fi

  if [[ "$raw_path" == "~/"* ]]; then
    printf '%s\n' "$HOME/${raw_path:2}"
    return 0
  fi

  if [[ "$raw_path" =~ ^[A-Za-z]:[\\/].* ]] && command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$raw_path"
    return 0
  fi

  printf '%s\n' "$raw_path"
}

resolve_config_dir() {
  local raw_path="$1"
  local normalized_path

  normalized_path="$(normalize_bash_path "$raw_path")"

  if [[ "$normalized_path" == /* ]]; then
    (cd "$normalized_path" && pwd)
    return 0
  fi

  (cd "$ROOT_DIR/$normalized_path" && pwd)
}

DEPLOY_HOST=""
DEPLOY_PORT=""
DEPLOY_USERNAME=""
DEPLOY_PRIVATE_KEY_PATH=""
DEPLOY_CONTEXT=""
DEPLOY_REMOTE_PATH=""
DEPLOY_PROTOCOL=""
DEPLOY_CONNECT_TIMEOUT_SECONDS=""
DEPLOY_DELETE_REMOTE=""

load_deploy_config() {
  local service="$1"
  local config_file="$ROOT_DIR/.vscode/sftp.json"
  local config_values=()

  [[ -f "$config_file" ]] || {
    echo "Missing deploy config: $config_file" >&2
    exit 1
  }

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot read deploy config." >&2
    exit 1
  fi

  if ! mapfile -t config_values < <(node - "$config_file" "$service" <<'NODE'
const fs = require('fs');

const configFile = process.argv[2];
const serviceName = process.argv[3];

const entries = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const entry = entries.find((item) => item && item.name === serviceName);

if (!entry) {
  console.error(`Unknown deploy service: ${serviceName}`);
  process.exit(1);
}

const timeoutMs = Number(entry.connectTimeout);
const timeoutSeconds = Number.isFinite(timeoutMs) && timeoutMs > 0
  ? Math.max(1, Math.ceil(timeoutMs / 1000))
  : 30;

const values = [
  entry.host || '',
  entry.port == null ? '' : String(entry.port),
  entry.username || '',
  entry.privateKeyPath || '',
  entry.context || '',
  entry.remotePath || '',
  entry.protocol || '',
  String(timeoutSeconds),
  entry.syncOption && entry.syncOption.delete === true ? 'true' : 'false',
];

process.stdout.write(values.join('\n'));
NODE
  ); then
    exit 1
  fi

  if [[ "${#config_values[@]}" -ne 9 ]]; then
    echo "Invalid deploy config for service: $service" >&2
    exit 1
  fi

  DEPLOY_HOST="${config_values[0]}"
  DEPLOY_PORT="${config_values[1]}"
  DEPLOY_USERNAME="${config_values[2]}"
  DEPLOY_PRIVATE_KEY_PATH="${config_values[3]}"
  DEPLOY_CONTEXT="${config_values[4]}"
  DEPLOY_REMOTE_PATH="${config_values[5]}"
  DEPLOY_PROTOCOL="${config_values[6]}"
  DEPLOY_CONNECT_TIMEOUT_SECONDS="${config_values[7]}"
  DEPLOY_DELETE_REMOTE="${config_values[8]}"
}

resolve_deploy_targets() {
  local service="$1"
  local config_file="$ROOT_DIR/.vscode/sftp.json"

  [[ -f "$config_file" ]] || {
    echo "Missing deploy config: $config_file" >&2
    exit 1
  }

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot read deploy config." >&2
    exit 1
  fi

  node - "$config_file" "$service" <<'NODE'
const fs = require('fs');

const configFile = process.argv[2];
const serviceName = process.argv[3];

const entries = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const exactMatches = entries.filter((item) => item && item.name === serviceName);

if (exactMatches.length > 0) {
  process.stdout.write(exactMatches.map((item) => item.name).join('\n'));
  process.exit(0);
}

const prefixMatches = entries.filter((item) => item && typeof item.name === 'string' && item.name.startsWith(`${serviceName}-`));

if (prefixMatches.length === 0) {
  console.error(`Unknown deploy service: ${serviceName}`);
  process.exit(1);
}

process.stdout.write(prefixMatches.map((item) => item.name).join('\n'));
NODE
}

check_remote_deploy_permissions() {
  local ssh_target="$1"
  local remote_path="$2"
  local create_history_dir="$3"
  shift 3

  local ssh_cmd=("$@")

  echo "Checking remote write permissions: $remote_path"
  "${ssh_cmd[@]}" "$ssh_target" bash -s -- "$remote_path" "$create_history_dir" <<'EOF'
set -euo pipefail

remote_path="$1"
create_history_dir="$2"
remote_parent_dir="$(dirname "$remote_path")"
remote_base_name="$(basename "$remote_path")"
history_root="${remote_parent_dir}/.deploy-history"
history_dir="${history_root}/${remote_base_name}"

check_writable_dir() {
  local path="$1"

  if [[ ! -d "$path" ]]; then
    echo "Remote path is not a directory: $path" >&2
    exit 1
  fi

  if [[ ! -w "$path" ]]; then
    echo "Remote deploy user cannot write to: $path" >&2
    echo "Grant write permissions to the deploy user or update remotePath ownership before deploying." >&2
    exit 1
  fi
}

if [[ -e "$remote_path" || -L "$remote_path" ]]; then
  check_writable_dir "$remote_path"
else
  check_writable_dir "$remote_parent_dir"
fi

if [[ "$create_history_dir" = "true" ]]; then
  if [[ -e "$history_dir" || -L "$history_dir" ]]; then
    check_writable_dir "$history_dir"
  elif [[ -e "$history_root" || -L "$history_root" ]]; then
    check_writable_dir "$history_root"
  else
    check_writable_dir "$remote_parent_dir"
  fi
fi
EOF
}

deploy_target() {
  local target_name="$1"
  local context_dir=""
  local private_key_path=""
  local temp_dir=""
  local archive_path=""
  local batch_file=""
  local remote_archive_path=""
  local ssh_target=""
  local timestamp=""
  local sftp_cmd=()
  local ssh_cmd=()

  load_deploy_config "$target_name"

  if [[ "$DEPLOY_PROTOCOL" != "sftp" ]]; then
    echo "Unsupported deploy protocol for $target_name: $DEPLOY_PROTOCOL" >&2
    exit 1
  fi

  if [[ -z "$DEPLOY_HOST" || -z "$DEPLOY_USERNAME" || -z "$DEPLOY_CONTEXT" || -z "$DEPLOY_REMOTE_PATH" ]]; then
    echo "Incomplete deploy config for service: $target_name" >&2
    exit 1
  fi

  if ! command -v ssh >/dev/null 2>&1 || ! command -v sftp >/dev/null 2>&1; then
    echo "ssh/sftp not found. Run this command in Windows Git Bash." >&2
    exit 1
  fi

  if ! command -v tar >/dev/null 2>&1 || ! command -v mktemp >/dev/null 2>&1; then
    echo "tar/mktemp not found. Run this command in Windows Git Bash." >&2
    exit 1
  fi

  if ! context_dir="$(resolve_config_dir "$DEPLOY_CONTEXT")"; then
    echo "Deploy context not found: $DEPLOY_CONTEXT" >&2
    exit 1
  fi

  private_key_path="$(normalize_bash_path "$DEPLOY_PRIVATE_KEY_PATH")"
  if [[ -n "$private_key_path" && ! -f "$private_key_path" ]]; then
    echo "Private key not found: $private_key_path" >&2
    exit 1
  fi

  temp_dir="$(mktemp -d)"
  archive_path="$temp_dir/${target_name}.tar.gz"
  batch_file="$temp_dir/upload.sftp"
  timestamp="$(date +%s)"
  remote_archive_path="/tmp/${target_name}-${timestamp}-$$.tar.gz"
  ssh_target="${DEPLOY_USERNAME}@${DEPLOY_HOST}"

  cleanup_deploy_temp() {
    [[ -n "${temp_dir:-}" ]] && rm -rf "$temp_dir"
  }
  trap cleanup_deploy_temp EXIT

  echo "Packaging target: $target_name ($context_dir)"
  (
    cd "$context_dir"
    tar -czf "$archive_path" .
  )

  printf 'put %s %s\n' "$archive_path" "$remote_archive_path" >"$batch_file"

  sftp_cmd=(
    sftp
    -q
    -b "$batch_file"
    -P "$DEPLOY_PORT"
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
    -o ConnectTimeout="$DEPLOY_CONNECT_TIMEOUT_SECONDS"
  )

  ssh_cmd=(
    ssh
    -p "$DEPLOY_PORT"
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
    -o ConnectTimeout="$DEPLOY_CONNECT_TIMEOUT_SECONDS"
  )

  if [[ -n "$private_key_path" ]]; then
    sftp_cmd+=(-i "$private_key_path")
    ssh_cmd+=(-i "$private_key_path")
  fi

  echo "Testing SSH connection: $ssh_target"
  if ! "${ssh_cmd[@]}" "$ssh_target" true; then
    echo "SSH connection test failed. Check network/VPN and try again." >&2
    exit 1
  fi

  check_remote_deploy_permissions "$ssh_target" "$DEPLOY_REMOTE_PATH" "true" "${ssh_cmd[@]}"

  echo "Uploading archive: $ssh_target:$remote_archive_path"
  "${sftp_cmd[@]}" "$ssh_target"

  echo "Replacing remote target: $DEPLOY_REMOTE_PATH"
"${ssh_cmd[@]}" "$ssh_target" bash -s -- "$remote_archive_path" "$DEPLOY_REMOTE_PATH" "$DEPLOY_DELETE_REMOTE" <<'EOF'
set -euo pipefail

archive_path="$1"
remote_path="$2"
delete_remote="$3"
stage_dir="$(mktemp -d /tmp/pb-hooks-deploy.XXXXXX)"
had_remote_path=0

create_history_snapshot() {
  local source_dir="$1"
  local snapshot_name=""

  [ -d "$source_dir" ] || return 0

  mkdir -p "$history_dir"
  snapshot_name="$(date +%Y%m%d-%H%M%S-%N)-$$"
  cp -a "$source_dir" "$history_dir/$snapshot_name"
}

list_history_snapshots() {
  [ -d "$history_dir" ] || return 0
  find "$history_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -nr | awk '{print $2}'
}

prune_history() {
  local snapshots=()
  local index=0

  mapfile -t snapshots < <(list_history_snapshots)

  for (( index=3; index<${#snapshots[@]}; index+=1 )); do
    rm -rf "$history_dir/${snapshots[$index]}"
  done
}

cleanup() {
  rm -rf "$stage_dir"
  rm -f "$archive_path"
}

trap cleanup EXIT

remote_parent_dir="$(dirname "$remote_path")"
remote_base_name="$(basename "$remote_path")"
history_dir="${remote_parent_dir}/.deploy-history/${remote_base_name}"

[ -d "$remote_path" ] && had_remote_path=1
mkdir -p "$remote_path"
tar -xzf "$archive_path" -C "$stage_dir"

remove_remote_only_entries() {
  local remote_root="$1"
  local stage_root="$2"
  local relative_path=""

  while IFS= read -r -d '' relative_path; do
    relative_path="${relative_path#./}"

    if [[ ! -e "$stage_root/$relative_path" && ! -L "$stage_root/$relative_path" ]]; then
      rm -rf "$remote_root/$relative_path"
    fi
  done < <(cd "$remote_root" && find . -mindepth 1 -print0)
}

remove_type_conflicts() {
  local remote_root="$1"
  local stage_root="$2"
  local relative_path=""
  local remote_item=""
  local stage_item=""
  local stage_is_dir=0
  local remote_is_dir=0

  while IFS= read -r -d '' relative_path; do
    relative_path="${relative_path#./}"
    remote_item="$remote_root/$relative_path"
    stage_item="$stage_root/$relative_path"
    stage_is_dir=0
    remote_is_dir=0

    if [[ ! -e "$remote_item" && ! -L "$remote_item" ]]; then
      continue
    fi

    [[ -d "$stage_item" && ! -L "$stage_item" ]] && stage_is_dir=1
    [[ -d "$remote_item" && ! -L "$remote_item" ]] && remote_is_dir=1

    if [[ "$stage_is_dir" -ne "$remote_is_dir" ]]; then
      rm -rf "$remote_item"
    fi
  done < <(cd "$stage_root" && find . -mindepth 1 -print0)
}

if [ "$delete_remote" = "true" ]; then
  remove_remote_only_entries "$remote_path" "$stage_dir"
fi

if [ "$had_remote_path" -eq 1 ]; then
  create_history_snapshot "$remote_path"
fi
remove_type_conflicts "$remote_path" "$stage_dir"
cp -a "$stage_dir"/. "$remote_path"/
prune_history
EOF

  trap - EXIT
  cleanup_deploy_temp

  echo "Deploy complete: $target_name"
}

run_deploy() {
  local service="$1"
  local skip_verify="${2:-false}"
  local deploy_targets=()
  local target_name=""

  if [[ "$skip_verify" != "true" ]]; then
    echo "Running pre-deploy verification: $service"
    run_verify "$service"
  else
    echo "Skipping pre-deploy verification: $service"
  fi

  run_css_if_needed "$service"

  if ! mapfile -t deploy_targets < <(resolve_deploy_targets "$service"); then
    exit 1
  fi

  for target_name in "${deploy_targets[@]}"; do
    deploy_target "$target_name"
  done
}

resolve_backup_source_target() {
  local service="$1"
  local config_file="$ROOT_DIR/.vscode/sftp.json"

  [[ -f "$config_file" ]] || {
    echo "Missing deploy config: $config_file" >&2
    exit 1
  }

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot read deploy config." >&2
    exit 1
  fi

  node - "$config_file" "$service" <<'NODE'
const fs = require('fs');

const configFile = process.argv[2];
const serviceName = process.argv[3];

const entries = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const hooksName = `${serviceName}-hooks`;
const entry = entries.find((item) => item && item.name === hooksName);

if (!entry) {
  console.error(`Missing deploy target for pb_data lookup: ${hooksName}`);
  console.error('backup derives the pb_data remote path from the "<service>-hooks" entry remotePath (.../hooks -> .../data).');
  process.exit(1);
}

if (typeof entry.remotePath !== 'string' || !entry.remotePath.endsWith('/hooks')) {
  console.error(`Cannot derive pb_data path from ${hooksName}.remotePath: ${entry.remotePath}`);
  console.error('Expected remotePath to end with "/hooks".');
  process.exit(1);
}

process.stdout.write(hooksName);
NODE
}

backup_target() {
  local service="$1"
  local hooks_target_name=""
  local remote_data_path=""
  local private_key_path=""
  local backup_dir=""
  local local_archive_path=""
  local remote_archive_path=""
  local ssh_target=""
  local timestamp=""
  local sftp_cmd=()
  local ssh_cmd=()

  if ! hooks_target_name="$(resolve_backup_source_target "$service")"; then
    exit 1
  fi

  load_deploy_config "$hooks_target_name"

  if [[ "$DEPLOY_PROTOCOL" != "sftp" ]]; then
    echo "Unsupported deploy protocol for $hooks_target_name: $DEPLOY_PROTOCOL" >&2
    exit 1
  fi

  if [[ -z "$DEPLOY_HOST" || -z "$DEPLOY_USERNAME" || -z "$DEPLOY_REMOTE_PATH" ]]; then
    echo "Incomplete deploy config for service: $hooks_target_name" >&2
    exit 1
  fi

  remote_data_path="${DEPLOY_REMOTE_PATH%/hooks}/data"

  if ! command -v ssh >/dev/null 2>&1 || ! command -v sftp >/dev/null 2>&1; then
    echo "ssh/sftp not found. Run this command in Windows Git Bash." >&2
    exit 1
  fi

  if ! command -v mktemp >/dev/null 2>&1; then
    echo "mktemp not found. Run this command in Windows Git Bash." >&2
    exit 1
  fi

  backup_dir="$HOME/pocketpages-backups/$service"
  mkdir -p "$backup_dir"

  private_key_path="$(normalize_bash_path "$DEPLOY_PRIVATE_KEY_PATH")"
  if [[ -n "$private_key_path" && ! -f "$private_key_path" ]]; then
    echo "Private key not found: $private_key_path" >&2
    exit 1
  fi

  timestamp="$(date +%Y%m%d-%H%M%S)"
  local_archive_path="$backup_dir/${service}-pbdata-${timestamp}.tar.gz"
  remote_archive_path="/tmp/${service}-pbdata-${timestamp}-$$.tar.gz"
  ssh_target="${DEPLOY_USERNAME}@${DEPLOY_HOST}"

  ssh_cmd=(
    ssh
    -p "$DEPLOY_PORT"
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
    -o ConnectTimeout="$DEPLOY_CONNECT_TIMEOUT_SECONDS"
  )

  local sftp_get_cmd=(
    sftp
    -q
    -P "$DEPLOY_PORT"
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
    -o ConnectTimeout="$DEPLOY_CONNECT_TIMEOUT_SECONDS"
  )

  if [[ -n "$private_key_path" ]]; then
    ssh_cmd+=(-i "$private_key_path")
    sftp_get_cmd+=(-i "$private_key_path")
  fi

  echo "Testing SSH connection: $ssh_target"
  if ! "${ssh_cmd[@]}" "$ssh_target" true; then
    echo "SSH connection test failed. Check network/VPN and try again." >&2
    exit 1
  fi

  echo "Archiving remote pb_data: $ssh_target:$remote_data_path"
  if ! "${ssh_cmd[@]}" "$ssh_target" bash -s -- "$remote_data_path" "$remote_archive_path" <<'EOF'
set -euo pipefail

remote_data_path="$1"
remote_archive_path="$2"

if [[ ! -d "$remote_data_path" ]]; then
  echo "Remote pb_data directory not found: $remote_data_path" >&2
  exit 1
fi

tar -czf "$remote_archive_path" -C "$(dirname "$remote_data_path")" "$(basename "$remote_data_path")"
EOF
  then
    echo "Failed to archive remote pb_data: $remote_data_path" >&2
    exit 1
  fi

  cleanup_remote_archive() {
    "${ssh_cmd[@]}" "$ssh_target" rm -f "$remote_archive_path" >/dev/null 2>&1 || true
  }
  trap cleanup_remote_archive EXIT

  echo "Downloading pb_data archive: $ssh_target:$remote_archive_path -> $local_archive_path"
  local batch_file
  batch_file="$(mktemp)"
  printf 'get %s %s\n' "$remote_archive_path" "$local_archive_path" >"$batch_file"
  sftp_get_cmd+=(-b "$batch_file")

  if ! "${sftp_get_cmd[@]}" "$ssh_target"; then
    rm -f "$batch_file"
    echo "Failed to download pb_data archive." >&2
    exit 1
  fi
  rm -f "$batch_file"

  trap - EXIT
  cleanup_remote_archive

  echo "Backup complete: $service"
  echo "Saved to: $local_archive_path"
}

run_backup() {
  local service="$1"

  backup_target "$service"
}

rollback_target() {
  local target_name="$1"
  local version_index="$2"
  local private_key_path=""
  local ssh_target=""
  local ssh_cmd=()

  load_deploy_config "$target_name"

  if [[ "$DEPLOY_PROTOCOL" != "sftp" ]]; then
    echo "Unsupported deploy protocol for $target_name: $DEPLOY_PROTOCOL" >&2
    exit 1
  fi

  if [[ -z "$DEPLOY_HOST" || -z "$DEPLOY_USERNAME" || -z "$DEPLOY_REMOTE_PATH" ]]; then
    echo "Incomplete deploy config for service: $target_name" >&2
    exit 1
  fi

  if [[ ! "$version_index" =~ ^[1-3]$ ]]; then
    echo "Rollback version must be 1, 2, or 3." >&2
    exit 1
  fi

  if ! command -v ssh >/dev/null 2>&1; then
    echo "ssh not found. Run this command in Windows Git Bash." >&2
    exit 1
  fi

  private_key_path="$(normalize_bash_path "$DEPLOY_PRIVATE_KEY_PATH")"
  if [[ -n "$private_key_path" && ! -f "$private_key_path" ]]; then
    echo "Private key not found: $private_key_path" >&2
    exit 1
  fi

  ssh_target="${DEPLOY_USERNAME}@${DEPLOY_HOST}"
  ssh_cmd=(
    ssh
    -p "$DEPLOY_PORT"
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
    -o ConnectTimeout="$DEPLOY_CONNECT_TIMEOUT_SECONDS"
  )

  if [[ -n "$private_key_path" ]]; then
    ssh_cmd+=(-i "$private_key_path")
  fi

  echo "Testing SSH connection: $ssh_target"
  if ! "${ssh_cmd[@]}" "$ssh_target" true; then
    echo "SSH connection test failed. Check network/VPN and try again." >&2
    exit 1
  fi

  check_remote_deploy_permissions "$ssh_target" "$DEPLOY_REMOTE_PATH" "false" "${ssh_cmd[@]}"

  echo "Rolling back remote target: $DEPLOY_REMOTE_PATH (version $version_index)"
"${ssh_cmd[@]}" "$ssh_target" bash -s -- "$DEPLOY_REMOTE_PATH" "$version_index" <<'EOF'
set -euo pipefail

remote_path="$1"
version_index="$2"
remote_parent_dir="$(dirname "$remote_path")"
remote_base_name="$(basename "$remote_path")"
history_dir="${remote_parent_dir}/.deploy-history/${remote_base_name}"
stage_dir="$(mktemp -d /tmp/pb-hooks-rollback.XXXXXX)"

create_history_snapshot() {
  local source_dir="$1"
  local snapshot_name=""

  [ -d "$source_dir" ] || return 0

  mkdir -p "$history_dir"
  snapshot_name="$(date +%Y%m%d-%H%M%S-%N)-$$"
  cp -a "$source_dir" "$history_dir/$snapshot_name"
}

list_history_snapshots() {
  [ -d "$history_dir" ] || return 0
  find "$history_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -nr | awk '{print $2}'
}

prune_history() {
  local snapshots=()
  local index=0

  mapfile -t snapshots < <(list_history_snapshots)

  for (( index=3; index<${#snapshots[@]}; index+=1 )); do
    rm -rf "$history_dir/${snapshots[$index]}"
  done
}

cleanup() {
  rm -rf "$stage_dir"
}

trap cleanup EXIT

if [ ! -d "$history_dir" ]; then
  echo "No deploy history found for $remote_path" >&2
  exit 1
fi

mapfile -t snapshots < <(list_history_snapshots)

if [ "${#snapshots[@]}" -lt "$version_index" ]; then
  echo "Rollback version $version_index is not available for $remote_path" >&2
  exit 1
fi

target_snapshot="${snapshots[$((version_index - 1))]}"
target_dir="$history_dir/$target_snapshot"

if [ ! -d "$target_dir" ]; then
  echo "Rollback target not found: $target_dir" >&2
  exit 1
fi

mkdir -p "$remote_path"
cp -a "$target_dir"/. "$stage_dir"/

remove_remote_only_entries() {
  local remote_root="$1"
  local stage_root="$2"
  local relative_path=""

  while IFS= read -r -d '' relative_path; do
    relative_path="${relative_path#./}"

    if [[ ! -e "$stage_root/$relative_path" && ! -L "$stage_root/$relative_path" ]]; then
      rm -rf "$remote_root/$relative_path"
    fi
  done < <(cd "$remote_root" && find . -mindepth 1 -print0)
}

remove_type_conflicts() {
  local remote_root="$1"
  local stage_root="$2"
  local relative_path=""
  local remote_item=""
  local stage_item=""
  local stage_is_dir=0
  local remote_is_dir=0

  while IFS= read -r -d '' relative_path; do
    relative_path="${relative_path#./}"
    remote_item="$remote_root/$relative_path"
    stage_item="$stage_root/$relative_path"
    stage_is_dir=0
    remote_is_dir=0

    if [[ ! -e "$remote_item" && ! -L "$remote_item" ]]; then
      continue
    fi

    [[ -d "$stage_item" && ! -L "$stage_item" ]] && stage_is_dir=1
    [[ -d "$remote_item" && ! -L "$remote_item" ]] && remote_is_dir=1

    if [[ "$stage_is_dir" -ne "$remote_is_dir" ]]; then
      rm -rf "$remote_item"
    fi
  done < <(cd "$stage_root" && find . -mindepth 1 -print0)
}

create_history_snapshot "$remote_path"
remove_remote_only_entries "$remote_path" "$stage_dir"
remove_type_conflicts "$remote_path" "$stage_dir"
cp -a "$stage_dir"/. "$remote_path"/
prune_history
EOF

  echo "Rollback complete: $target_name -> version $version_index"
}

run_rollback() {
  local service="$1"
  local version_index="$2"
  local deploy_targets=()
  local target_name=""

  if ! mapfile -t deploy_targets < <(resolve_deploy_targets "$service"); then
    exit 1
  fi

  for target_name in "${deploy_targets[@]}"; do
    rollback_target "$target_name" "$version_index"
  done
}

if [[ "${1:-}" == "__complete_services" ]]; then
  list_services
  exit 0
fi

if [[ "${1:-}" == "__complete_release_services" ]]; then
  list_release_services
  exit 0
fi

if [[ "${1:-}" == "__complete_archive_services" ]]; then
  list_archive_services
  exit 0
fi

if [[ "${1:-}" == "__complete_archive_tags" ]]; then
  list_archive_tags "${2:-}"
  exit 0
fi

if [[ "${1:-}" == "__complete_index_sections" ]]; then
  printf '%s\n' routes partials resolveGraph routeLinks schemaUsage impactByFile
  exit 0
fi

if [[ "${1:-}" == "__complete_update_targets" ]]; then
  printf '%s\n' npm pocketbase
  exit 0
fi

if [[ "${1:-}" == "__complete_install_targets" ]]; then
  printf '%s\n' npm
  exit 0
fi

if [[ "${1:-}" == "__complete_generate_kinds" ]]; then
  printf '%s\n' xapi-redirect api-json xapi-partial xapi-datastar
  exit 0
fi

case "${1:-help}" in
  start)
    shift
    [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh start <service> [-- <args>]" >&2; exit 1; }
    service="$1"
    shift
    [[ "${1:-}" == "--" ]] && shift
    start_service "$service" "$@"
    ;;
  kill)
    shift || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh kill" >&2; exit 1; }
    kill_pocketbase
    ;;
  update)
    shift || true
    [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh update <npm|pocketbase> [-- <extra args>]" >&2; exit 1; }
    target="$1"
    shift || true
    [[ "${1:-}" == "--" ]] && shift
    run_update "$target" "$@"
    ;;
  audit)
    shift || true
    [[ "${1:-}" == "--" ]] && shift
    run_audit "$@"
    ;;
  install)
    shift || true
    [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh install <npm> [-- <extra args>]" >&2; exit 1; }
    target="$1"
    shift || true
    [[ "${1:-}" == "--" ]] && shift
    run_install "$target" "$@"
    ;;
  deploy)
    shift
    [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh deploy <service> [--skip-verify]" >&2; exit 1; }
    service="$1"
    shift || true
    skip_verify="false"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --skip-verify)
          skip_verify="true"
          shift
          ;;
        *)
          echo "Unknown deploy option: $1" >&2
          echo "Usage: ./task.sh deploy <service> [--skip-verify]" >&2
          exit 1
          ;;
      esac
    done
    run_deploy "$service" "$skip_verify"
    ;;
  rollback)
    shift
    [[ -n "${1:-}" && -n "${2:-}" ]] || { echo "Usage: ./task.sh rollback <service> <version>" >&2; exit 1; }
    service="$1"
    version_index="$2"
    shift 2 || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh rollback <service> <version>" >&2; exit 1; }
    run_rollback "$service" "$version_index"
    ;;
  backup)
    shift
    [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh backup <service>" >&2; exit 1; }
    service="$1"
    shift || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh backup <service>" >&2; exit 1; }
    run_backup "$service"
    ;;
  archive)
    shift
    [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh archive <service>" >&2; exit 1; }
    service="$1"
    shift || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh archive <service>" >&2; exit 1; }
    run_archive "$service"
    ;;
  restore)
    shift
    [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh restore <archive-tag>" >&2; exit 1; }
    tag_name="$1"
    shift || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh restore <archive-tag>" >&2; exit 1; }
    service="${tag_name#archive/}"
    service="${service%%/*}"
    run_restore "$service" "$tag_name"
    ;;
  archives)
    shift || true
    if [[ "${1:-}" == "--delete" ]]; then
      shift
      [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh archives --delete <archive-tag>" >&2; exit 1; }
      tag_name="$1"
      shift || true
      [[ $# -eq 0 ]] || { echo "Usage: ./task.sh archives --delete <archive-tag>" >&2; exit 1; }
      run_delete_archive "$tag_name"
    else
      service="${1:-}"
      shift || true
      [[ $# -eq 0 ]] || { echo "Usage: ./task.sh archives [service]" >&2; exit 1; }
      run_archives "$service"
    fi
    ;;
  merge)
    shift || true
    service="${1:-}"
    shift || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh merge [service]" >&2; exit 1; }
    run_merge "$service"
    ;;
  test)
    shift || true
    service="${1:-}"
    [[ -n "$service" ]] && shift || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh test [service]" >&2; exit 1; }
    run_test "$service"
    ;;
  lint)
    shift || true
    service="${1:-}"
    [[ -n "$service" ]] && shift || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh lint [service]" >&2; exit 1; }
    run_lint "$service"
    ;;
  tsc)
    shift || true
    service="${1:-}"
    [[ -n "$service" ]] && shift || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh tsc [service]" >&2; exit 1; }
    run_tsc "$service"
    ;;
  diag)
    shift || true
    run_diag "$@"
    ;;
  verify)
    shift || true
    service="${1:-}"
    [[ -n "$service" ]] && shift || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh verify [service]" >&2; exit 1; }
    run_verify "$service"
    ;;
  preflight)
    shift || true
    [[ $# -eq 0 ]] || { echo "Usage: ./task.sh preflight" >&2; exit 1; }
    run_preflight
    ;;
  jj-main)
    shift || true
    run_jj_main "$@"
    ;;
  knip)
    shift || true
    [[ "${1:-}" == "--" ]] && shift
    run_knip "$@"
    ;;
  gitleaks)
    shift || true
    run_gitleaks "$@"
    ;;
  index)
    shift
    [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh index <service> [--section <name>] [--file <relative-path>] [--json|--pretty]" >&2; exit 1; }
    service="$1"
    shift || true
    run_index "$service" "$@"
    ;;
  new)
    shift || true
    [[ "${1:-}" == "--" ]] && shift
    run_new "$@"
    ;;
  css)
    shift || true
    service="${1:-}"
    shift || true
    run_css "$service" "$@"
    ;;
  bundle)
    shift || true
    run_bundle "$@"
    ;;
  generate)
    shift || true
    [[ "${1:-}" == "--" ]] && shift
    run_generate "$@"
    ;;
  format)
    shift || true
    [[ "${1:-}" == "--" ]] && shift
    run_format "$@"
    ;;
  help|-h|--help)
    print_help
    ;;
  *)
    echo "Unknown command: $1" >&2
    print_help >&2
    exit 1
    ;;
esac
