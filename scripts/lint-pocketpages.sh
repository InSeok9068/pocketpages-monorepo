#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_DIR="$ROOT_DIR/apps"
HAS_RG=0
if command -v rg >/dev/null 2>&1; then
  HAS_RG=1
fi

# 이 스크립트는 PocketPages 구조에서 AI가 자주 내는 실수를 가볍게 검사한다.
# 현재 체크하는 항목:
# 1) resolve('/_private/...') 같이 _private 기준 규칙에 어긋나는 resolve 사용
# 2) include('/_private/...') 같이 _private 절대 경로 include 사용
# 3) EJS에서 record.fieldName 형태의 직접 필드 접근
# 4) +middleware.js 에서 인자로 받은 resolve 대신 전역 resolve() 직접 사용
# 5) api/xapi 아래에 +layout.ejs 를 두는 잘못된 레이아웃 구성
# 6) xapi 엔드포인트에서 <!DOCTYPE>, <html>, <body> 같은 전체 문서 응답 반환
# 7) _private 내부에 +layout, +load, +middleware 같은 특수 PocketPages 파일 배치

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

collect_named_files() {
  local root="$1"
  local name_pattern="$2"

  if (( HAS_RG )); then
    mapfile -t _matches < <(rg --files "$root" | rg --color never "$name_pattern" 2>/dev/null || true)
  else
    mapfile -t _matches < <(find "$root" -type f 2>/dev/null | tr '\\' '/' | grep -E "$name_pattern" || true)
  fi

  if [[ ${#_matches[@]} -gt 0 ]]; then
    printf '%s\n' "${_matches[@]}"
  fi
}

filter_lines_excluding() {
  local exclude_pattern="$1"
  shift
  local lines=("$@")
  local filtered=()
  local line

  for line in "${lines[@]}"; do
    [[ -z "$line" ]] && continue
    if [[ ! "$line" =~ $exclude_pattern ]]; then
      filtered+=("$line")
    fi
  done

  if [[ ${#filtered[@]} -gt 0 ]]; then
    printf '%s\n' "${filtered[@]}"
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

  mapfile -t include_private_matches < <(
    collect_matches 'include\(\s*["'\'']/?_private/' "$service_dir"
  )
  print_matches \
    "$service_name" \
    "Do not call include() with /_private paths. Keep include paths relative to the current PocketPages include rules." \
    "${include_private_matches[@]}"

  mapfile -t raw_record_field_matches < <(
    collect_matches '\brecord\.[A-Za-z_][A-Za-z0-9_]*' "$service_dir"/*.ejs "$service_dir"/pb_hooks "$service_dir"/pb_hooks/pages
  )
  mapfile -t record_field_matches < <(
    filter_lines_excluding 'record\.(get|set|email|verified|isSuperuser|collection|publicExport|original|fresh)\s*\(' "${raw_record_field_matches[@]}"
  )
  print_matches \
    "$service_name" \
    "Avoid record.fieldName direct access in EJS. Prefer record.get('fieldName')." \
    "${record_field_matches[@]}"

  mapfile -t middleware_files < <(
    collect_named_files "$service_dir/pb_hooks/pages" '/\+middleware\.js$'
  )
  local middleware_file
  local middleware_resolve_matches=()
  for middleware_file in "${middleware_files[@]}"; do
    [[ -f "$middleware_file" ]] || continue

    if grep -qE 'resolve\s*\(' "$middleware_file" && ! grep -qE 'module\.exports\s*=\s*function\s*\(\s*\{[^}]*\bresolve\b' "$middleware_file"; then
      middleware_resolve_matches+=("$middleware_file")
    fi
  done
  print_matches \
    "$service_name" \
    "Middleware must use resolve from function arguments, not a global resolve() call." \
    "${middleware_resolve_matches[@]}"

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
