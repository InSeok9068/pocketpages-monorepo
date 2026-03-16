#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_DIR="$ROOT_DIR/apps"

print_help() {
  cat <<'EOF'
Usage:
  ./task.sh start <service> [-- <extra args>]
  ./task.sh kill
  ./task.sh test [service]
  ./task.sh lint [service]
  ./task.sh diag <file-or-service>
  ./task.sh verify [service]
  ./task.sh format [-- <extra args>]

Commands:
  start     Start service in foreground
  kill      Kill running pocketbase/pbw processes and free their ports
  test      Run node:test files under __tests__ for one service or all services
  lint      Run lightweight PocketPages self-validation checks for one service or all services
  diag      Run PocketPages editor diagnostics for PocketPages code files (.ejs/.js/.cjs/.mjs).
  verify    Run lint and diag together for one service or all services
  format    Run npm run format
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

run_lint() {
  local lint_script="$ROOT_DIR/scripts/lint-pocketpages.js"
  local service="${1:-}"

  if [[ ! -f "$lint_script" ]]; then
    echo "Missing lint script: $lint_script" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Cannot run lint command." >&2
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
    node "$lint_script" "$service_dir"
    return 0
  fi

  node "$lint_script"
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
    node --test --test-concurrency=1 "${test_files[@]}"
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

run_diag() {
  local diag_script="$ROOT_DIR/scripts/diag-pocketpages.js"
  local target="${1:-}"

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
      node "$diag_script" "$target"
      return 0
    fi

    local service_dir
    if ! service_dir="$(resolve_service_dir "$target")"; then
      echo "Unknown service or file: $target" >&2
      echo "Available services:" >&2
      list_services >&2
      exit 1
    fi
    node "$diag_script" "$service_dir"
    return 0
  fi

  node "$diag_script"
}

run_verify() {
  local service="${1:-}"

  run_lint "$service"
  run_diag "$service"
}

run_format() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm not found. Cannot run format command." >&2
    exit 1
  fi

  npm run format -- "$@"
}

if [[ "${1:-}" == "__complete_services" ]]; then
  list_services
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
    kill_pocketbase
    ;;
  test)
    shift || true
    run_test "${1:-}"
    ;;
  lint)
    shift || true
    run_lint "${1:-}"
    ;;
  diag)
    shift || true
    run_diag "${1:-}"
    ;;
  verify)
    shift || true
    run_verify "${1:-}"
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
