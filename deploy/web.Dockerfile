# syntax=docker/dockerfile:1.7
# Web client + Caddy. Build context is the repo root: docker build -f deploy/web.Dockerfile --build-arg VITE_VOKKO_API=https://chat.example.com .

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY apps/desktop apps/desktop
# The logo is imported from the repo-level brand folder.
COPY assets/brand assets/brand
# Without this the bundle runs on the in-memory mock backend.
ARG VITE_VOKKO_API
RUN test -n "$VITE_VOKKO_API" || (echo "VITE_VOKKO_API is required" && exit 1)
ENV VITE_VOKKO_API=$VITE_VOKKO_API
RUN npm run build --workspace @vokko/desktop

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/desktop/dist /srv
