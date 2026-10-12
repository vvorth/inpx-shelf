# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim
ARG RUNTIME_IMAGE=debian:bookworm-slim
ARG FB2CNG_VERSION=v1.2.3
ARG FB2CNG_ARCH=linux-amd64

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

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates unzip wget \
    && wget -O /tmp/fbc.zip "https://github.com/rupor-github/fb2cng/releases/download/${FB2CNG_VERSION}/fbc-${FB2CNG_ARCH}.zip" \
    && unzip /tmp/fbc.zip -d /fb2cng-runtime \
    && chmod +x /fb2cng-runtime/fbc \
    && rm -rf /tmp/fbc.zip /var/lib/apt/lists/*

# Runtime stages are split into "*-tools" layers (OS packages, external
# converters) and thin final stages that only add the app binary on top.
# A JS/TS change then only rebuilds the last COPY instead of re-running the
# MuPDF apt installs that would otherwise sit above the binary.
FROM ${RUNTIME_IMAGE} AS base-tools

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates p7zip-full libjxl-tools webp tini \
    && rm -rf /var/lib/apt/lists/*

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 12380
# The data path keeps its pre-rename name so existing volumes and compose files keep working.
VOLUME ["/usr/local/bin/.inpx-web", "/library"]

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

FROM base-tools AS conversion-tools

ARG FB2CNG_VERSION

LABEL org.opencontainers.image.title="inpx-shelf" \
      org.opencontainers.image.description="Dockerized inpx-shelf with fb2cng and MuPDF conversion" \
      org.opencontainers.image.source="https://github.com/vvorth/inpx-shelf"

ENV INPX_ENABLE_CONVERSION=true
ENV INPX_CONVERSION_FORMATS=epub,epub3,kepub,kfx,azw8,pdf
ENV INPX_FB2CNG_VERSION=${FB2CNG_VERSION}

COPY --from=fb2cng-tools /fb2cng-runtime/fbc /usr/local/bin/fbc

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends mupdf-tools fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

FROM conversion-tools AS runtime

# --chmod avoids a follow-up chmod RUN that would duplicate the binary in a second layer.
COPY --from=build --chmod=755 /app/dist/linux/inpx-shelf /usr/local/bin/inpx-shelf

FROM base-tools AS runtime-lite

LABEL org.opencontainers.image.title="inpx-shelf-lite" \
      org.opencontainers.image.description="Lighter inpx-shelf image without conversion tools" \
      org.opencontainers.image.source="https://github.com/vvorth/inpx-shelf"

ENV INPX_ENABLE_CONVERSION=false
ENV INPX_CONVERSION_FORMATS=

COPY --from=build --chmod=755 /app/dist/linux/inpx-shelf /usr/local/bin/inpx-shelf

FROM runtime AS final
