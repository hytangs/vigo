FROM node:24.18.0-bookworm-slim AS node-runtime
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/vigo
COPY . .
RUN node -e 'const m=require("./manifest.json");if(m.platform!=="linux"||m.architecture!==process.arch)throw Error("A matching Linux Engine ZIP is required");require("./vigo-routing-kernel.node")'
USER 1000:1000
ENV VIGO_ENGINE_HOST=0.0.0.0 VIGO_ENGINE_PORT=8080 VIGO_CITY_DIR=/data/city
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:"+(process.env.VIGO_ENGINE_PORT||process.env.PORT||8080)+"/health",{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "engine-http.mjs"]
