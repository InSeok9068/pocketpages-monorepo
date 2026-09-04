# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps

WORKDIR /app/apps/dulkong

COPY apps/dulkong/package*.json ./
COPY packages /app/packages
COPY scripts/run-patch-package.js /app/scripts/run-patch-package.js
COPY scripts/patches /app/scripts/patches

RUN cd /app/packages/utils \
    && npm ci --omit=dev --no-audit --no-fund

RUN npm ci --no-audit --no-fund \
    && npm prune --omit=dev --no-audit --no-fund


FROM node:24-bookworm-slim AS css

WORKDIR /app

COPY package*.json ./
COPY packages /app/packages

RUN npm ci --no-audit --no-fund

COPY task.sh ./
COPY unocss.config.js ./
COPY apps/dulkong/pb_hooks ./apps/dulkong/pb_hooks

RUN bash ./task.sh css dulkong


FROM alpine:3.24 AS pocketbase

ARG TARGETARCH
ARG PB_VERSION

RUN apk add --no-cache ca-certificates curl unzip
RUN set -eu; \
  if [ -z "${PB_VERSION}" ]; then echo "PB_VERSION build argument is required"; exit 1; fi; \
  case "${TARGETARCH}" in \
    amd64|arm64) PB_ARCH="${TARGETARCH}" ;; \
    *) echo "Unsupported TARGETARCH: $TARGETARCH"; exit 1 ;; \
  esac; \
  CURL_RETRY="--retry 5 --retry-delay 5 --retry-max-time 120 --retry-all-errors --retry-connrefused"; \
  curl -fsSL ${CURL_RETRY} -o /tmp/pocketbase.zip \
    "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip"; \
  unzip /tmp/pocketbase.zip -d /out; \
  chmod +x /out/pocketbase


FROM alpine:3.24

ENV CODE_ROOT=/app/apps/dulkong
ENV APP_ROOT=/app/apps/dulkong

WORKDIR /app/apps/dulkong

RUN apk add --no-cache ca-certificates

COPY apps/dulkong/. .
COPY --from=deps /app/packages /app/packages
COPY --from=deps /app/apps/dulkong/node_modules ./node_modules
COPY --from=css /app/apps/dulkong/pb_hooks/pages/assets/uno.min.css ./pb_hooks/pages/assets/uno.min.css
COPY --from=pocketbase /out/pocketbase /usr/local/bin/pocketbase

RUN mkdir -p /opt/defaults/pb_hooks \
  && if [ -d "${CODE_ROOT}/pb_hooks" ]; then cp -R "${CODE_ROOT}/pb_hooks/." /opt/defaults/pb_hooks/; fi \
  && if [ -d "${CODE_ROOT}/pb_public" ]; then mkdir -p /opt/defaults/pb_public && cp -R "${CODE_ROOT}/pb_public/." /opt/defaults/pb_public/; fi

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
mkdir -p "${PB_PUBLIC}"

if [ -z "$(ls -A "${PB_HOOKS}" 2>/dev/null)" ] && [ -d /opt/defaults/pb_hooks ]; then
  cp -R /opt/defaults/pb_hooks/. "${PB_HOOKS}/"
fi

if [ -z "$(ls -A "${PB_PUBLIC}" 2>/dev/null)" ] && [ -d /opt/defaults/pb_public ]; then
  cp -R /opt/defaults/pb_public/. "${PB_PUBLIC}/"
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
