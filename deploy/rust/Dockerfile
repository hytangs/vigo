# Build from the repository root:
# docker build -f deploy/rust/Dockerfile -t vigo-rust:local .
FROM rust:1.97.1-alpine AS build
RUN apk add --no-cache musl-dev build-base python3
WORKDIR /source
COPY native/vigo-routing-kernel/Cargo.toml native/vigo-routing-kernel/Cargo.lock ./native/vigo-routing-kernel/
COPY native/vigo-routing-kernel/vendor ./native/vigo-routing-kernel/vendor
COPY native/vigo-routing-kernel/src ./native/vigo-routing-kernel/src
COPY docs/standalone.html docs/standalone-openapi.json ./docs/
COPY scripts/package-standalone.py ./scripts/package-standalone.py
RUN cargo build --manifest-path native/vigo-routing-kernel/Cargo.toml --locked --release --no-default-features --features standalone --bin vigo
RUN python3 scripts/package-standalone.py --notices-only /THIRD-PARTY-NOTICES.txt

FROM scratch
COPY --from=build /source/native/vigo-routing-kernel/target/release/vigo /vigo
COPY --from=build /THIRD-PARTY-NOTICES.txt /THIRD-PARTY-NOTICES.txt
COPY LICENSE /LICENSE
COPY NOTICE /NOTICE
USER 65532:65532
ENV VIGO_CITY=/city PORT=8080
EXPOSE 8080
ENTRYPOINT ["/vigo"]
CMD ["serve", "--host", "0.0.0.0"]
