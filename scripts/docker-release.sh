#!/bin/sh
set -eu

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

valid_sha() {
  [ "${#1}" -eq 40 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

[ "$#" -le 4 ] || fail 'Usage: docker-release.sh [mode service image selection]'
mode=${1:-${PP_DEPLOY_MODE:-deploy}}
service=${2:-${PP_DEPLOY_SERVICE:-}}
image=${3:-${PP_DEPLOY_IMAGE:-}}
selection=${4:-${PP_DEPLOY_SHA:-}}
case "$service" in ''|[!a-z0-9]*|*[!a-z0-9-]*) fail 'Invalid service: use lowercase letters, digits and hyphens, starting with an alphanumeric character.' ;; esac
case "$image" in ''|-*|*[!a-zA-Z0-9._/:-]*) fail 'Invalid image repository.' ;; esac
case "$mode" in
  deploy) valid_sha "$selection" || fail 'Deploy selection must be a full lowercase SHA (40 characters).' ;;
  rollback) case "$selection" in 1|2|3) ;; *) fail 'Rollback selection must be 1, 2, or 3.' ;; esac ;;
  *) fail 'Mode must be deploy or rollback.' ;;
esac
lock_retries=${PP_DEPLOY_LOCK_RETRIES-60}
case "$lock_retries" in ''|*[!0-9]*) fail 'PP_DEPLOY_LOCK_RETRIES must be a number from 0 to 120.' ;; esac
lock_retries=$(printf '%s\n' "$lock_retries" | sed 's/^0*//')
lock_retries=${lock_retries:-0}
[ "${#lock_retries}" -le 3 ] && [ "$lock_retries" -le 120 ] || fail 'PP_DEPLOY_LOCK_RETRIES must be a number from 0 to 120.'

cd ./Docker-Compose
compose_service="${service}-pocketpages"
history_root=.deploy-history
history_dir="$history_root/$service"
history_file="$history_dir/successful-shas"
lock_dir="$history_root/.lock"
mkdir -p "$history_root"
lock_attempt=0
while ! mkdir "$lock_dir" 2>/dev/null; do
  if [ "$lock_attempt" -ge "$lock_retries" ]; then
    fail "Cannot acquire global deployment lock: $(pwd)/$lock_dir after $lock_attempt retries. Check active deployments manually; remove the lock directory only after confirming no deployment is running."
  fi
  lock_attempt=$((lock_attempt + 1))
  printf 'Waiting for global deployment lock: %s/%s; retrying in 5 seconds: %s/%s\n' "$(pwd)" "$lock_dir" "$lock_attempt" "$lock_retries" >&2
  sleep 5
done

# Only the process that created the lock installs cleanup traps.
history_temp=''
cleanup() {
  if [ -n "$history_temp" ]; then
    rm -f "$history_temp" || printf 'WARNING: Cannot remove history temporary file: %s\n' "$history_temp" >&2
  fi
  rmdir "$lock_dir" || printf 'WARNING: Cannot remove deployment lock: %s\n' "$lock_dir" >&2
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -e "$history_file" ]; then
  [ -f "$history_file" ] && [ -r "$history_file" ] || fail "Cannot read success history: $history_file"
  if ! awk '
    length($0) != 40 || $0 ~ /[^0-9a-f]/ || seen[$0]++ { bad = 1 }
    END { if (bad || NR == 0 || NR > 4) exit 1 }
  ' "$history_file"; then
    fail "Corrupt success history: $history_file. Inspect it manually before retrying."
  fi
elif [ "$mode" = rollback ]; then
  fail "No success history: $history_file. Rollback cannot bootstrap from Git history."
fi

# Query stopped containers too; an unknown or ambiguous state must never be guessed.
inspect_container() {
  container_ids=$(docker compose ps -aq "$compose_service") || fail 'Cannot query current container.'
  container_id=$(printf '%s\n' "$container_ids" | awk 'NF { count++; id=$0 } END { if (count != 1) exit 1; print id }') || fail 'Expected exactly one service container.'
  container_revision=$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container_id") || fail 'Cannot inspect container revision.'
  valid_sha "$container_revision" || fail 'Missing or invalid container revision.'
  container_running=$(docker inspect --format '{{ .State.Running }}' "$container_id") || fail 'Cannot inspect container running state.'
  case "$container_running" in true|false) ;; *) fail 'Unknown container running state.' ;; esac
}

if [ "$mode" = rollback ]; then
  inspect_container
  first_sha=$(sed -n '1p' "$history_file")
  target_index=$selection
  if [ "$first_sha" = "$container_revision" ] && [ "$container_running" = true ]; then
    target_index=$((selection + 1))
  fi
  target_sha=$(sed -n "${target_index}p" "$history_file")
  valid_sha "$target_sha" || fail "Rollback version $selection is not available in successful deployments."
else
  target_sha=$selection
  git pull --ff-only
fi

printf 'Deploying %s: %s:%s (%s)\n' "$service" "$image" "$target_sha" "$mode"
docker pull "${image}:${target_sha}"
image_revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image}:${target_sha}") || fail 'Cannot inspect target image revision.'
[ "$image_revision" = "$target_sha" ] || fail 'Target image revision does not match the selected SHA; service was not stopped.'
docker tag "${image}:${target_sha}" "${image}:release"
docker compose stop "$compose_service"

deploy_owner="$(id -u):$(id -g)"
docker compose run --rm --no-deps --pull never --entrypoint sh "$compose_service" -c '
  set -eu
  service="$1"
  deploy_owner="$2"
  hooks_dir="/app/apps/${service}/pb_hooks"
  public_dir="/app/apps/${service}/pb_public"

  if [ ! -d /opt/defaults/pb_hooks ]; then
    echo "Baked hooks directory not found: /opt/defaults/pb_hooks" >&2
    exit 1
  fi

  mkdir -p "$hooks_dir"
  find "$hooks_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a /opt/defaults/pb_hooks/. "$hooks_dir"/
  chown -R "$deploy_owner" "$hooks_dir"

  if [ -d /opt/defaults/pb_public ]; then
    mkdir -p "$public_dir"
    find "$public_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a /opt/defaults/pb_public/. "$public_dir"/
    chown -R "$deploy_owner" "$public_dir"
  fi
' -- "$service" "$deploy_owner"

docker compose up -d --no-deps --force-recreate --pull never --wait "$compose_service"
inspect_container
[ "$container_revision" = "$target_sha" ] && [ "$container_running" = true ] || fail 'Started container does not match the target revision or is not running; success history was not advanced.'
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile

# The global lock serializes writers; publish with a same-directory atomic rename.
record_history() {
  mkdir -p "$history_dir" || return 1
  candidate="$history_dir/.successful-shas.$$"
  (set -C; : > "$candidate") || return 1
  history_temp=$candidate
  history_source=/dev/null
  if [ -f "$history_file" ]; then history_source=$history_file; fi
  # 현재 버전과 롤백 대상 1~3번을 합친 4개만 기록합니다.
  awk -v target="$target_sha" '
    BEGIN { print target; seen[target] = 1; count = 1 }
    !seen[$0]++ { if (++count <= 4) print }
  ' "$history_source" > "$history_temp" || return 1
  mv -f "$history_temp" "$history_file"
}
if ! record_history; then
  fail "Service has changed successfully, but recording success history failed: $history_file. Inspect the running service and repair history manually."
fi
history_temp=''

valid_image_id() {
  case "$1" in sha256:*) ;; *) return 1 ;; esac
  cleanup_hash=${1#sha256:}
  [ "${#cleanup_hash}" -eq 64 ] || return 1
  case "$cleanup_hash" in *[!0-9a-f]*) return 1 ;; esac
}

cleanup_old_sha_images() {
  cleanup_images=$(docker image ls --no-trunc --format '{{.Repository}} {{.Tag}} {{.ID}}' "$image") || return 1
  [ -n "$cleanup_images" ] || return 0
  # 서버에는 현재·직전 성공 버전만 두고, 더 오래된 버전은 롤백 시 레지스트리에서 pull합니다.
  cleanup_keep=$(sed -n '1,2p' "$history_file") || return 1
  cleanup_containers=$(docker ps -aq) || return 1
  cleanup_used_ids=''
  # 중지된 컨테이너도 포함하며, 참조 조회가 불완전하면 어떤 태그도 제거하지 않습니다.
  for cleanup_container in $cleanup_containers; do
    cleanup_used_id=$(docker inspect --format '{{.Image}}' "$cleanup_container") || return 1
    valid_image_id "$cleanup_used_id" || return 1
    cleanup_used_ids="$cleanup_used_ids $cleanup_used_id"
  done

  cleanup_status=0
  while read -r cleanup_repo cleanup_tag cleanup_image_id cleanup_extra; do
    [ "$cleanup_repo" = "$image" ] && [ -z "$cleanup_extra" ] || continue
    valid_sha "$cleanup_tag" && valid_image_id "$cleanup_image_id" || continue
    [ "$cleanup_tag" != "$target_sha" ] || continue
    cleanup_protected=false
    for cleanup_kept_sha in $cleanup_keep; do
      if [ "$cleanup_tag" = "$cleanup_kept_sha" ]; then cleanup_protected=true; break; fi
    done
    for cleanup_used_id in $cleanup_used_ids; do
      if [ "$cleanup_image_id" = "$cleanup_used_id" ]; then cleanup_protected=true; break; fi
    done
    [ "$cleanup_protected" = false ] || continue

    printf 'Removing old local SHA tag: %s:%s\n' "$cleanup_repo" "$cleanup_tag"
    if ! docker image rm "$cleanup_repo:$cleanup_tag"; then
      printf 'WARNING: Could not remove local SHA tag: %s:%s\n' "$cleanup_repo" "$cleanup_tag" >&2
      cleanup_status=1
    fi
  done <<EOF
$cleanup_images
EOF
  return "$cleanup_status"
}

if ! cleanup_old_sha_images; then
  printf 'WARNING: Old SHA image cleanup failed; deployment and success history are already committed.\n' >&2
fi
printf 'Docker %s complete: %s -> %s\n' "$mode" "$service" "$target_sha"
