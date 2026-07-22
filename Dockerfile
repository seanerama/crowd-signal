# Crowd-Signal — single-container modular monolith (ADR 0001/0003).
# Official node image is multi-arch (arm64 for ec2-primary t4g). Node major
# pinned so the better-sqlite3 native build matches the runtime ABI.

FROM node:22.16.0-bookworm-slim AS build
WORKDIR /app
# Build toolchain for better-sqlite3 in case no prebuild matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

FROM node:22.16.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# /data is the mounted state volume (ADR 0002); make the mount point writable
# for the non-root user when running without a volume (e.g. local smoke).
RUN mkdir -p /data && chown node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
