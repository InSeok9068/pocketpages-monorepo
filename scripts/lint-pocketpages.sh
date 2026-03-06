#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_DIR="$ROOT_DIR/apps"
HAS_RG=0
if command -v rg >/dev/null 2>&1; then
  HAS_RG=1
fi

errors=0

collect_service_dirs() {
  if [[ $# -gt 0 ]]; then
    printf '%s\n' "$1"
    return 0
  fi

  local d
  [[ -d "$APPS_DIR" ]] || return 0
  for d in "$APPS_DIR"/*; do
    [[ -d "$d" ]] || continue
    [[ -d "$d/pb_hooks" ]] || continue
    printf '%s\n' "$d"
  done | sort
}

print_matches() {
  local service_name="$1"
  local title="$2"
  shift 2
  local matches=("$@")

  [[ ${#matches[@]} -eq 0 ]] && return 0

  errors=$((errors + ${#matches[@]}))
  echo
  echo "[FAIL][$service_name] $title"
  printf '  %s\n' "${matches[@]}"
}

collect_matches() {
  local pattern="$1"
  shift
  if [[ $# -eq 0 ]]; then
    return 0
  fi

  if (( HAS_RG )); then
    mapfile -t _matches < <(rg -n --color never --pcre2 "$pattern" "$@" 2>/dev/null || true)
  else
    mapfile -t _matches < <(grep -RInE "$pattern" "$@" 2>/dev/null || true)
  fi

  if [[ ${#_matches[@]} -gt 0 ]]; then
    printf '%s\n' "${_matches[@]}"
  fi
}

collect_files() {
  local root="$1"
  local pattern="$2"

  if (( HAS_RG )); then
    mapfile -t _matches < <(rg --files "$root" | rg --color never "$pattern" 2>/dev/null || true)
  else
    mapfile -t _matches < <(find "$root" -type f 2>/dev/null | tr '\\' '/' | grep -E "$pattern" || true)
  fi

  if [[ ${#_matches[@]} -gt 0 ]]; then
    printf '%s\n' "${_matches[@]}"
  fi
}

lint_service() {
  local service_dir="$1"
  local service_name
  service_name="$(basename "$service_dir")"

  echo "Checking service: $service_name"

  mapfile -t resolve_private_matches < <(
    collect_matches 'resolve\(\s*["'\'']/?_private/' "$service_dir"
  )
  print_matches \
    "$service_name" \
    "Do not call resolve() with /_private paths. Use names relative to _private, e.g. resolve('board-service')." \
    "${resolve_private_matches[@]}"

  mapfile -t api_layout_matches < <(
    collect_files "$service_dir" '/pb_hooks/pages/(api|xapi)(/.*)?/\+layout\.ejs$'
  )
  print_matches \
    "$service_name" \
    "api/xapi routes must not define +layout.ejs files." \
    "${api_layout_matches[@]}"

  if [[ -d "$service_dir/pb_hooks/pages/xapi" ]]; then
    mapfile -t xapi_full_html_matches < <(
      collect_matches '<!DOCTYPE|<html\b|<body\b' "$service_dir/pb_hooks/pages/xapi"
    )
    print_matches \
      "$service_name" \
      "xapi endpoints should return fragments or raw responses, not full HTML documents." \
      "${xapi_full_html_matches[@]}"
  fi

  mapfile -t private_special_file_matches < <(
    collect_files "$service_dir" '/pb_hooks/pages/.*/_private/.*/\+(layout|config|load|middleware|get|post|put|patch|delete)\.(ejs|js)$'
  )
  print_matches \
    "$service_name" \
    "_private must not contain PocketPages special route/config files." \
    "${private_special_file_matches[@]}"
}

echo "Running PocketPages self-validation checks..."

mapfile -t service_dirs < <(collect_service_dirs "${1:-}")

if [[ ${#service_dirs[@]} -eq 0 ]]; then
  echo "No services found."
  exit 0
fi

for service_dir in "${service_dirs[@]}"; do
  lint_service "$service_dir"
done

if (( errors > 0 )); then
  echo
  echo "PocketPages lint failed with $errors issue(s)."
  exit 1
fi

echo "PocketPages lint passed."
