FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY src ./src
# Lab experiment fingerprints include the verified test sources as well as src.
# Keep these identical to CI; never substitute a different hash in production.
COPY tests ./tests
COPY scripts ./scripts
COPY public ./public
COPY index.html vite.config.ts tsconfig.json ./
RUN pnpm build && chmod 755 scripts/docker-entrypoint.sh
ENV NODE_ENV=production
ENV DATA_DIR=/var/data/everlore
ENV PORT=10000
EXPOSE 10000
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["pnpm", "start"]
