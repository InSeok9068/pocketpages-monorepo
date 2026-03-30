#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_DIR="$ROOT_DIR/apps"

print_help() {
  cat <<'EOF'
Usage:
  ./task.sh start <service> [-- <extra args>]
  ./task.sh kill
  ./task.sh deploy <service>
  ./task.sh rollback <service> <version>
  ./task.sh test [service]
  ./task.sh lint [service]
  ./task.sh diag <file-or-service>
  ./task.sh verify [service]
  ./task.sh index <service> [--section <name>] [--file <relative-path>] [--json|--pretty]
  ./task.sh bundle
  ./task.sh format [-- <extra args>]

Commands:
  start     Start service in foreground
  kill      Kill running pocketbase/pbw processes and free their ports
  deploy    Upload one service deploy targets using .vscode/sftp.json
  rollback  Restore one of the last 3 deployed target versions
  test      Run node:test files under __tests__ for one service or all services
  lint      Run lightweight PocketPages self-validation checks for one service or all services
  diag      Run PocketPages editor diagnostics for PocketPages code files (.ejs/.js/.cjs/.mjs).
  verify    Run lint and diag together for one service or all services
  index     Query AI-friendly PocketPages project index JSON for one service
  bundle    Interactively bundle one service dependency into pb_hooks/pages/_private/vendor
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

run_format() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm not found. Cannot run format command." >&2
    exit 1
  fi

  npm run format -- "$@"
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
    rm -rf "$temp_dir"
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
  local deploy_targets=()
  local target_name=""

  if ! mapfile -t deploy_targets < <(resolve_deploy_targets "$service"); then
    exit 1
  fi

  for target_name in "${deploy_targets[@]}"; do
    deploy_target "$target_name"
  done
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

if [[ "${1:-}" == "__complete_index_sections" ]]; then
  printf '%s\n' routes partials resolveGraph routeLinks schemaUsage impactByFile
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
  deploy)
    shift
    [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh deploy <service>" >&2; exit 1; }
    run_deploy "$1"
    ;;
  rollback)
    shift
    [[ -n "${1:-}" && -n "${2:-}" ]] || { echo "Usage: ./task.sh rollback <service> <version>" >&2; exit 1; }
    run_rollback "$1" "$2"
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
  index)
    shift
    [[ -n "${1:-}" ]] || { echo "Usage: ./task.sh index <service> [--section <name>] [--file <relative-path>] [--json|--pretty]" >&2; exit 1; }
    service="$1"
    shift || true
    run_index "$service" "$@"
    ;;
  bundle)
    shift || true
    run_bundle "$@"
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
