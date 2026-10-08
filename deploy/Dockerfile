# syntax=docker/dockerfile:1
# Keep this compiler pin equal to rust-toolchain.toml; check:deployment verifies it.
FROM rust:1.97.1-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY rust-toolchain.toml ./
COPY native/vigo-routing-kernel/Cargo.toml native/vigo-routing-kernel/Cargo.lock ./native/vigo-routing-kernel/
COPY native/vigo-routing-kernel/vendor ./native/vigo-routing-kernel/vendor
COPY native/vigo-routing-kernel/src ./native/vigo-routing-kernel/src
COPY docs/standalone.html docs/standalone-openapi.json ./docs/
COPY scripts/package-standalone.py ./scripts/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/source/native/vigo-routing-kernel/target \
    cargo build --manifest-path native/vigo-routing-kernel/Cargo.toml --locked --release --no-default-features --features standalone --bin vigo \
    && cp native/vigo-routing-kernel/target/release/vigo /vigo \
    && python3 scripts/package-standalone.py --notices-only /THIRD-PARTY-NOTICES.txt

# glibc supports returning freed query/preparation memory to the operating system.
FROM debian:bookworm-slim
COPY --from=build /vigo /vigo
COPY --from=build /THIRD-PARTY-NOTICES.txt /THIRD-PARTY-NOTICES.txt
COPY LICENSE NOTICE /
USER 65532:65532
ENV VIGO_CITY=/city PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=65s --retries=3 CMD ["/vigo", "health"]
ENTRYPOINT ["/vigo"]
CMD ["serve", "--host", "0.0.0.0"]
