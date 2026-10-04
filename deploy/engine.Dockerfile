FROM node:24.18.0-bookworm-slim AS node-runtime

FROM ubuntu:24.04 AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/ /usr/local/
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain none
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/build/native/vigo-routing-kernel/target \
    npm run build:engine
RUN --mount=type=cache,target=/root/.cargo/registry \
    node scripts/package-engine.mjs

FROM build AS verify
RUN node test/check-engine-package.mjs

FROM ubuntu:24.04 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/vigo
COPY --from=build /build/release/engine/runtime-linux-*/ ./
USER 1000:1000
ENV VIGO_ENGINE_HOST=0.0.0.0 VIGO_ENGINE_PORT=8080 VIGO_CITY_DIR=/data/city
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:"+(process.env.VIGO_ENGINE_PORT||process.env.PORT||8080)+"/health",{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "engine-http.mjs"]
