# syntax=docker/dockerfile:1
#
# SudokuCoop — small, hostable image. Multi-stage: the final image carries only
# production deps, the compiled server and the static client, no toolchain.
#
#   docker build -t sudoku-coop .
#   docker run --rm -p 8787:8787 sudoku-coop      # http://localhost:8787
#
# Raspberry Pi (see scripts/build-docker.sh for the shortcuts):
#   64-bit Pi OS: docker buildx build --platform linux/arm64 -t sudoku-coop .
#   32-bit Pi OS: docker buildx build --platform linux/arm/v7 -t sudoku-coop .
# Both build natively under QEMU emulation, so no Pi is needed to produce the image.

# ------------------------------------------------------------------ build ----
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Dependency layer, invalidated only when the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.base.json tsconfig.server.json tsconfig.client.json ./
COPY src ./src
# Static shell (index.html, style.css). public/dist is rebuilt below, and is
# dockerignored, so only the hand-written assets come from the context.
COPY public ./public

# Emits dist/ (server, CommonJS) and public/dist/ (browser client, ES modules).
RUN npm run build

# Strip dev deps so the runtime layer only carries express + ws.
RUN npm prune --omit=dev

# --------------------------------------------------------------- runtime ----
FROM node:22-bookworm-slim AS runtime

# tini reaps zombies and forwards SIGTERM so `docker stop` exits cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Keep the layout the server expects: dist/server/../../public resolves to /app/public.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./

# The image never needs root: static files are read-only, and 8787 is unprivileged.
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    RECONNECT_GRACE_MS=180000

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const p=process.env.PORT||8787;fetch('http://127.0.0.1:'+p+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server/index.js"]
