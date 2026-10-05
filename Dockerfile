FROM rust:bookworm AS relay
RUN apt-get update && apt-get install -y --no-install-recommends libssl-dev pkg-config clang cmake protobuf-compiler && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY inference/tpu-relay/Cargo.toml inference/tpu-relay/Cargo.lock ./
COPY inference/tpu-relay/src ./src
ENV CARGO_PROFILE_RELEASE_OPT_LEVEL=1 CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 CARGO_PROFILE_RELEASE_LTO=false
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target cargo build --locked --release && cp target/release/sea-tpu-relay /sea-tpu-relay

FROM node:24-bookworm-slim AS web
WORKDIR /app/chat
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY chat/package.json chat/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY chat/ ./
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/chat
COPY --from=web /app/chat ./
COPY --from=relay /sea-tpu-relay /usr/local/bin/sea-tpu-relay
COPY inference/artifacts/qwen3-8b-q4g128/*.json /app/inference/artifacts/qwen3-8b-q4g128/
COPY inference/deployment/public.json /app/inference/deployment/public.json
COPY inference/reports/validation.json inference/reports/testnet-deployment-complete.json inference/reports/testnet-slice-batching-upgrade.json /app/inference/reports/
COPY inference/reports/testnet-independent-slices-upgrade.json inference/reports/testnet-independent-slices-smoke.json /app/inference/reports/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 SEA_TPU_RELAY_BIN=/usr/local/bin/sea-tpu-relay SEA_SESSION_DIRECTORY=/data/chat-sessions SEA_SPONSOR_KEYPAIR=/run/sponsor.json
EXPOSE 8787
CMD ["node", "--import", "tsx", "server.ts"]
