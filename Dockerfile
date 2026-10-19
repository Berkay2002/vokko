# syntax=docker/dockerfile:1.7
# vokko-server: multi-stage build. Build: `docker build -t vokko-server .` (context = repo root).
#   docker run --rm -e DATABASE_URL=postgres://... -p 8710:8710 -v vokko-data:/data vokko-server            # serve (default)
#   docker run --rm -e DATABASE_URL=postgres://... vokko-server seed                                         # demo data, never in production

FROM rust:1.97-slim-bookworm AS build
WORKDIR /src
# The workspace lists the Tauri crate, the CLI and xtask, so their manifests have to resolve; only vokko-server is compiled.
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p vokko-server \
    && install -D target/release/vokko-server /out/vokko-server

FROM debian:bookworm-slim AS runtime
# ca-certificates: link-preview fetches (VOKKO_UNFURL) validate TLS against the system roots.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin vokko \
    && mkdir /data && chown vokko:vokko /data
COPY --from=build /out/vokko-server /usr/local/bin/vokko-server

ENV VOKKO_DATA_DIR=/data \
    VOKKO_BIND=0.0.0.0:8710 \
    RUST_LOG=vokko_server=info,warn
USER vokko
VOLUME /data
EXPOSE 8710
# /healthz does a DB round trip; 503 (DB down) marks the container unhealthy. Uses bash's /dev/tcp and read so the slim
# image needs no curl; matches ' 200 ' because hyper may answer the HTTP/1.0 request as HTTP/1.1.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
    CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${VOKKO_BIND##*:} && printf 'GET /healthz HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && read -r status <&3 && [[ $status == *' 200 '* ]]"]
ENTRYPOINT ["vokko-server"]
CMD ["serve"]
