#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_DIR="$ROOT_DIR/apps"

print_help() {
  cat <<'EOF'
Usage:
  ./task.sh list
  ./task.sh start <service> [-- <extra args>]
  ./task.sh kill
  ./task.sh lint [service]

Commands:
  list      List services under apps/
  start     Start service in foreground
  kill      Kill running pocketbase/pbw processes and free their ports
  lint      Run lightweight PocketPages self-validation checks for one service or all services
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
  local lint_script="$ROOT_DIR/scripts/lint-pocketpages.sh"
  local service="${1:-}"

  if [[ ! -f "$lint_script" ]]; then
    echo "Missing lint script: $lint_script" >&2
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
    "$lint_script" "$service_dir"
    return 0
  fi

  "$lint_script"
}

if [[ "${1:-}" == "__complete_services" ]]; then
  list_services
  exit 0
fi

case "${1:-help}" in
  list)
    list_services
    ;;
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
  lint)
    shift || true
    run_lint "${1:-}"
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
