# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim
ARG RUNTIME_IMAGE=debian:bookworm-slim
ARG FB2CNG_VERSION=v1.9.1
ARG FB2CNG_ARCH=linux-amd64
# SHA-256 of fbc-${FB2CNG_ARCH}.zip: update with FB2CNG_VERSION/FB2CNG_ARCH, in release.yml and in scripts/bundle-windows-tools.ps1.
ARG FB2CNG_SHA256=51ae29f268994374fdbf9e7244f37510b46aa9a0439bd57eb89c7c0924359174

FROM ${NODE_IMAGE} AS build-deps

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts --no-audit --no-fund
# Let the locked packaging dependency select and verify its matching base binary.
RUN node -e "require('@yao-pkg/pkg-fetch').need({nodeRange:'node24',platform:'linux',arch:'x64'}).catch(error=>{console.error(error);process.exit(1)})"

FROM build-deps AS build

COPY . .
RUN npm run build:linux

FROM ${NODE_IMAGE} AS fb2cng-tools

ARG FB2CNG_VERSION
ARG FB2CNG_ARCH
ARG FB2CNG_SHA256

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates unzip wget \
    && wget -O /tmp/fbc.zip "https://github.com/rupor-github/fb2cng/releases/download/${FB2CNG_VERSION}/fbc-${FB2CNG_ARCH}.zip" \
    && echo "${FB2CNG_SHA256}  /tmp/fbc.zip" | sha256sum -c - \
    && unzip /tmp/fbc.zip -d /fb2cng-runtime \
    && chmod +x /fb2cng-runtime/fbc \
    && rm -rf /tmp/fbc.zip /var/lib/apt/lists/*

# The webp package pulls OpenGL, Mesa and LLVM (~200 MB) for its vwebp viewer; only dwebp is needed.
# Same base image as the runtime, so its libraries come from apt there (no copied libc).
FROM ${RUNTIME_IMAGE} AS webp-tools

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends webp \
    && rm -rf /var/lib/apt/lists/*

# Runtime stages are split into "*-tools" layers (OS packages, external
# converters) and thin final stages that only add the app binary on top.
# A JS/TS change then only rebuilds the last COPY instead of re-running the
# MuPDF apt installs that would otherwise sit above the binary.
FROM ${RUNTIME_IMAGE} AS base-tools

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libjxl-tools tini \
        libwebp7 libwebpdemux2 libpng16-16 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=webp-tools /usr/bin/dwebp /usr/bin/dwebp

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 12380
# The data path keeps its pre-rename name so existing volumes and compose files keep working.
VOLUME ["/usr/local/bin/.inpx-web", "/library"]

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["/usr/local/bin/docker-entrypoint.sh", "healthcheck"]

FROM base-tools AS conversion-tools

ARG FB2CNG_VERSION

LABEL org.opencontainers.image.title="inpx-shelf" \
      org.opencontainers.image.description="Dockerized inpx-shelf with fb2cng conversion" \
      org.opencontainers.image.source="https://github.com/vvorth/inpx-shelf"

ENV INPX_ENABLE_CONVERSION=true
ENV INPX_CONVERSION_FORMATS=epub,epub3,kepub,kfx,azw8
ENV INPX_FB2CNG_VERSION=${FB2CNG_VERSION}

COPY --from=fb2cng-tools /fb2cng-runtime/fbc /usr/local/bin/fbc

# Default image: fb2cng formats only. MuPDF (PDF output, ~100 MB) is in runtime-pdf.
FROM conversion-tools AS runtime

# --chmod avoids a follow-up chmod RUN that would duplicate the binary in a second layer.
COPY --from=build --chmod=755 /app/dist/linux/inpx-shelf /usr/local/bin/inpx-shelf

FROM conversion-tools AS pdf-tools

LABEL org.opencontainers.image.title="inpx-shelf-pdf" \
      org.opencontainers.image.description="Dockerized inpx-shelf with fb2cng and MuPDF (PDF) conversion"

ENV INPX_CONVERSION_FORMATS=epub,epub3,kepub,kfx,azw8,pdf

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends mupdf-tools fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

FROM pdf-tools AS runtime-pdf

COPY --from=build --chmod=755 /app/dist/linux/inpx-shelf /usr/local/bin/inpx-shelf

FROM base-tools AS runtime-lite

LABEL org.opencontainers.image.title="inpx-shelf-lite" \
      org.opencontainers.image.description="Lighter inpx-shelf image without conversion tools" \
      org.opencontainers.image.source="https://github.com/vvorth/inpx-shelf"

ENV INPX_ENABLE_CONVERSION=false
ENV INPX_CONVERSION_FORMATS=

COPY --from=build --chmod=755 /app/dist/linux/inpx-shelf /usr/local/bin/inpx-shelf

FROM runtime AS final
