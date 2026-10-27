# =============================================================================
# ToM Bridge - production image
#
# Usage:
#   docker build -t tom-bridge .
#   docker run
#       -v /path/to/config.yaml:/data/config.yaml:ro
#       -v /path/to/registration.yaml:/data/registration.yaml:ro
#       --rm tom-bridge
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 - builder: compile the TypeScript, keep the production dependencies
# -----------------------------------------------------------------------------
FROM docker.io/node:24-trixie-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
# Optional peers too: the test database of drizzle-orm and the HTTP server of twake-node-server, which the bridge never loads
RUN npm run build && npm prune --omit=dev --omit=optional --omit=peer

# -----------------------------------------------------------------------------
# Stage 2 - runtime image: the compiled code and its dependencies only
# -----------------------------------------------------------------------------
FROM docker.io/node:24-trixie-slim AS runtime

WORKDIR /app
RUN mkdir -p /data && chown node:node /data

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY drizzle/ ./drizzle/

ENV NODE_ENV=production
ENV REGISTRATION_FILE=/data/registration.yaml

USER node

ENTRYPOINT ["node", "dist/index.js", "-c", "/data/config.yaml"]
