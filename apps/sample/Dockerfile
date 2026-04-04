FROM node:20-alpine AS deps

WORKDIR /workspace/apps/sample
COPY apps/sample/package*.json ./
COPY packages /workspace/packages
RUN cd /workspace/packages/utils && npm ci --omit=dev
RUN npm ci --omit=dev

FROM alpine:3.20 AS pocketbase

ARG TARGETARCH

RUN apk add --no-cache ca-certificates curl unzip
RUN case "${TARGETARCH}" in \
    amd64|arm64) PB_ARCH="${TARGETARCH}" ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
  esac \
  && PB_VERSION="$(curl -fsSL https://api.github.com/repos/pocketbase/pocketbase/releases/latest | tr -d '\n' | sed -n 's/.*\"tag_name\"[[:space:]]*:[[:space:]]*\"v\([^\"]*\)\".*/\1/p')" \
  && curl -fsSL -o /tmp/pocketbase.zip \
  "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" \
  && unzip /tmp/pocketbase.zip -d /out \
  && chmod +x /out/pocketbase


FROM alpine:3.20

ENV CODE_ROOT=/workspace/apps/sample
ENV APP_ROOT=/app

WORKDIR /workspace/apps/sample

RUN apk add --no-cache ca-certificates

COPY apps/sample/. .
COPY --from=deps /workspace/packages /workspace/packages
COPY --from=deps /workspace/apps/sample/node_modules ./node_modules
COPY --from=pocketbase /out/pocketbase /usr/local/bin/pocketbase
RUN mkdir -p /opt/defaults/pb_hooks \
  && if [ -d "${CODE_ROOT}/pb_hooks" ]; then cp -R "${CODE_ROOT}/pb_hooks/." /opt/defaults/pb_hooks/; fi

RUN cat <<'EOF' > /usr/local/bin/start.sh
#!/bin/sh
set -eu

PB_DATA="${APP_ROOT}/pb_data"
PB_HOOKS="${APP_ROOT}/pb_hooks"
PB_PUBLIC="${APP_ROOT}/pb_public"
PB_MIGRATIONS="${APP_ROOT}/pb_migrations"
INIT_MARKER="${PB_DATA}/.superuser_initialized"

mkdir -p "${PB_DATA}"
mkdir -p "${PB_HOOKS}"

# If hooks volume is empty, seed it with baked defaults.
if [ -z "$(ls -A "${PB_HOOKS}" 2>/dev/null)" ] && [ -d /opt/defaults/pb_hooks ]; then
  cp -R /opt/defaults/pb_hooks/. "${PB_HOOKS}/"
fi

if [ -n "${PB_ADMIN_EMAIL:-}" ] && [ -n "${PB_ADMIN_PASSWORD:-}" ] && [ ! -f "${INIT_MARKER}" ]; then
  echo "Initializing PocketBase superuser..."
  pocketbase --dir="${PB_DATA}" superuser create "${PB_ADMIN_EMAIL}" "${PB_ADMIN_PASSWORD}" || true
  touch "${INIT_MARKER}"
fi

exec pocketbase serve \
  --dir="${PB_DATA}" \
  --hooksDir="${PB_HOOKS}" \
  --publicDir="${PB_PUBLIC}" \
  --migrationsDir="${PB_MIGRATIONS}" \
  --http=0.0.0.0:8090
EOF

RUN chmod +x /usr/local/bin/start.sh

EXPOSE 8090

CMD ["/usr/local/bin/start.sh"]
