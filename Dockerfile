FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Octopus Energy Private MCP" \
      org.opencontainers.image.description="Privacy-first local MCP server for Octopus Energy" \
      org.opencontainers.image.source="https://github.com/soothill/octopus-energy-private-mcp" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    OCTOPUS_CACHE_DIR=/data/cache

RUN groupadd --gid 10001 mcp && \
    useradd --uid 10001 --gid mcp --create-home --shell /usr/sbin/nologin mcp && \
    mkdir -p /app /data/cache && \
    chown -R mcp:mcp /app /data

WORKDIR /app
COPY --from=build --chown=mcp:mcp /app/package.json /app/package-lock.json ./
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist

USER mcp
VOLUME ["/data/cache"]
ENTRYPOINT ["node", "dist/index.js"]
