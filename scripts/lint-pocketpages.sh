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
# 8) xapi 엔드포인트에서 response.json(...) 사용
# 9) api 엔드포인트에서 redirect(...) 사용
# 10) redirect flash를 쓰면서 __flash 쿼리스트링을 수동 조립하는 패턴
# 11) 중첩 +config.js 사용
# 12) PocketPages가 알지 못하는 +special 파일명 사용
# 13) next 인자를 받는 middleware가 next()나 response.* 호출 없이 끝나는 패턴
# 14) 상위/하위 경로에 중첩 +load.js 배치
# 15) 허용 범위를 벗어난 raw EJS 출력(<%- ... %>)
# 16) DT(_private/table/*-dt.js) 내부에서 redirect/response/request/body/save/delete 같은 부작용 사용
# 17) auth helper 사용 시 pocketpages-plugin-auth 누락
# 18) pocketpages-plugin-auth 사용 시 pocketpages-plugin-js-sdk 누락 또는 순서 역전

errors=0

collect_service_dirs() {
  if [[ $# -gt 0 && -n "${1:-}" ]]; then
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
  local pages_root="$service_dir/pb_hooks/pages"
  local config_file="$pages_root/+config.js"

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

  if [[ -d "$pages_root/xapi" ]]; then
    mapfile -t xapi_json_matches < <(
      collect_matches '\bresponse\.json\s*\(' "$pages_root/xapi"
    )
    print_matches \
      "$service_name" \
      "xapi endpoints should return fragments/raw responses, not response.json(...). Move JSON endpoints under api/." \
      "${xapi_json_matches[@]}"
  fi

  if [[ -d "$pages_root/api" ]]; then
    mapfile -t api_redirect_matches < <(
      collect_matches '\bredirect\s*\(' "$pages_root/api"
    )
    print_matches \
      "$service_name" \
      "api endpoints should return programmatic responses, not redirect(...)." \
      "${api_redirect_matches[@]}"
  fi

  mapfile -t manual_flash_matches < <(
    collect_matches '__flash=' "$pages_root"
  )
  print_matches \
    "$service_name" \
    "Do not manually build ?__flash=... query strings. Use redirect(path, { message })." \
    "${manual_flash_matches[@]}"

  mapfile -t config_files < <(
    collect_named_files "$pages_root" '/\+config\.js$'
  )
  local config_path
  local nested_config_matches=()
  for config_path in "${config_files[@]}"; do
    [[ -f "$config_path" ]] || continue
    if [[ "$config_path" != "$config_file" ]]; then
      nested_config_matches+=("$config_path")
    fi
  done
  print_matches \
    "$service_name" \
    "+config.js must live only at pb_hooks/pages/+config.js, not nested route directories." \
    "${nested_config_matches[@]}"

  mapfile -t special_plus_files < <(
    collect_files "$pages_root" '/\+[^/]+\.(js|ejs)$'
  )
  local special_plus_file
  local invalid_special_plus_files=()
  for special_plus_file in "${special_plus_files[@]}"; do
    [[ -f "$special_plus_file" ]] || continue
    local special_basename
    special_basename="$(basename "$special_plus_file")"
    if [[ ! "$special_basename" =~ ^\+(config\.js|layout\.ejs|load\.js|middleware\.js|get\.js|post\.js|put\.js|patch\.js|delete\.js)$ ]]; then
      invalid_special_plus_files+=("$special_plus_file")
    fi
  done
  print_matches \
    "$service_name" \
    "Unknown +special file name detected. Only +config.js, +layout.ejs, +load.js, +middleware.js, +get.js, +post.js, +put.js, +patch.js, +delete.js are allowed." \
    "${invalid_special_plus_files[@]}"

  local middleware_flow_matches=()
  for middleware_file in "${middleware_files[@]}"; do
    [[ -f "$middleware_file" ]] || continue

    if grep -qE 'module\.exports\s*=\s*function\s*\([^)]*,\s*next\s*\)' "$middleware_file" &&
      ! grep -qE '\bnext\s*\(' "$middleware_file" &&
      ! grep -qE '\bresponse\.[A-Za-z_][A-Za-z0-9_]*\s*\(' "$middleware_file"; then
      middleware_flow_matches+=("$middleware_file")
    fi
  done
  print_matches \
    "$service_name" \
    "Middleware that declares next must either call next() or send a response via response.* before returning." \
    "${middleware_flow_matches[@]}"

  mapfile -t load_files < <(
    collect_named_files "$pages_root" '/\+load\.js$'
  )
  local load_file
  local nested_load_matches=()
  for load_file in "${load_files[@]}"; do
    [[ -f "$load_file" ]] || continue

    local load_dir
    load_dir="$(dirname "$load_file")"
    local search_dir
    search_dir="$(dirname "$load_dir")"

    while [[ "$search_dir" == "$pages_root"* ]]; do
      local ancestor_load
      ancestor_load="$search_dir/+load.js"
      if [[ -f "$ancestor_load" ]]; then
        nested_load_matches+=("$load_file (ancestor: $ancestor_load)")
        break
      fi

      [[ "$search_dir" == "$pages_root" ]] && break
      search_dir="$(dirname "$search_dir")"
    done
  done
  print_matches \
    "$service_name" \
    "Avoid stacking parent/child +load.js files. PocketPages executes only the leaf +load.js; shared loading belongs in middleware." \
    "${nested_load_matches[@]}"

  mapfile -t raw_ejs_output_matches < <(
    collect_matches '<%-' "$pages_root"
  )
  mapfile -t disallowed_raw_ejs_matches < <(
    filter_lines_excluding '<%-\s*(include\s*\(|slots?\b|content\b|resolve\s*\()' "${raw_ejs_output_matches[@]}"
  )
  print_matches \
    "$service_name" \
    "Raw EJS output (<%- ... %>) should be limited to include(), slot/slots, content, or resolve()-provided safe assets." \
    "${disallowed_raw_ejs_matches[@]}"

  local dt_root="$pages_root/_private/table"
  if [[ -d "$dt_root" ]]; then
    mapfile -t dt_files < <(
      collect_named_files "$dt_root" '/-dt\.js$'
    )
    mapfile -t dt_side_effect_matches < <(
      collect_matches '\bredirect\s*\(|\bresponse\.[A-Za-z_][A-Za-z0-9_]*\s*\(|\bbody\s*\(|\brequest\b|\$app\.(save|saveNoValidate|delete|deleteRecord|deleteRecords|dao)\b' "${dt_files[@]}"
    )
    print_matches \
      "$service_name" \
      "DT files must stay side-effect free. Keep redirect/response/request/body/save/delete logic in page/xapi/api call sites." \
      "${dt_side_effect_matches[@]}"
  fi

  local compact_config=""
  if [[ -f "$config_file" ]]; then
    compact_config="$(tr -d '[:space:]' < "$config_file")"
  fi

  mapfile -t auth_helper_matches < <(
    collect_matches '\b(signInWithPassword|signOut|requestOAuth2Login|requestOAuth2Link|registerWithPassword|signInWithOtp|signInWithOAuth2|signInAnonymously|signInWithToken)\s*\(' "$pages_root"
  )
  if [[ ${#auth_helper_matches[@]} -gt 0 ]] && [[ "$compact_config" != *"pocketpages-plugin-auth"* ]]; then
    print_matches \
      "$service_name" \
      "Auth helpers require pocketpages-plugin-auth in pb_hooks/pages/+config.js." \
      "${auth_helper_matches[@]}"
  fi

  local auth_plugin_config_matches=()
  if [[ "$compact_config" == *"pocketpages-plugin-auth"* ]]; then
    if [[ "$compact_config" != *"pocketpages-plugin-js-sdk"* ]]; then
      auth_plugin_config_matches+=("$config_file")
    else
      local auth_prefix
      local sdk_prefix
      auth_prefix="${compact_config%%pocketpages-plugin-auth*}"
      sdk_prefix="${compact_config%%pocketpages-plugin-js-sdk*}"
      if (( ${#sdk_prefix} > ${#auth_prefix} )); then
        auth_plugin_config_matches+=("$config_file")
      fi
    fi
  fi
  print_matches \
    "$service_name" \
    "pocketpages-plugin-auth requires pocketpages-plugin-js-sdk to be explicitly listed before it in +config.js." \
    "${auth_plugin_config_matches[@]}"
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
