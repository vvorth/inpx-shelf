#!/bin/sh
set -e

# Docker HEALTHCHECK: /health отвечает 200, как только сервер слушает порт (сборка индекса не мешает).
# В образе нет curl/wget: запрос через /dev/tcp в bash.
if [ "$1" = "healthcheck" ]; then
    HOST_VALUE="${HOST:-0.0.0.0}"
    case "$HOST_VALUE" in
        0.0.0.0|::|"[::]") HOST_VALUE=127.0.0.1 ;;
    esac
    exec bash -c 'exec 3<>"/dev/tcp/$1/$2" && printf "GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n" >&3 && head -n 1 <&3 | grep -q " 200 "' \
        healthcheck "$HOST_VALUE" "${PORT:-12380}"
fi

DATA_DIR_VALUE="${DATA_DIR:-${APP_DIR:-}}"
if [ -z "$DATA_DIR_VALUE" ] && [ -n "$CACHE_DIR" ]; then
    DATA_DIR_VALUE="$(dirname "$CACHE_DIR")"
fi
DATA_DIR_VALUE="${DATA_DIR_VALUE:-/usr/local/bin/.inpx-web}"

# Опции (первый аргумент с "-") передаются inpx-shelf, другая команда запускается как есть,
# но тоже после смены пользователя ниже.
if [ "$#" -gt 0 ]; then
    case "$1" in
        -*)
            set -- inpx-shelf "$@"
            ;;
    esac
else
    LIBDIR_VALUE="${LIBDIR:-${LIB_DIR:-/library}}"
    INPX_VALUE="${INPX:-}"
    HOST_VALUE="${HOST:-0.0.0.0}"
    PORT_VALUE="${PORT:-12380}"

    set -- inpx-shelf \
        "--host=$HOST_VALUE" \
        "--port=$PORT_VALUE" \
        "--data-dir=$DATA_DIR_VALUE" \
        "--lib-dir=$LIBDIR_VALUE"

    if [ -n "$INPX_VALUE" ]; then
        set -- "$@" "--inpx=$INPX_VALUE"
    fi
fi

# Приложение работает не от root: PUID/PGID (по умолчанию 1000), PUID=0 оставляет root.
# Каталоги данных и кэша, созданные прежними версиями от root, один раз передаются этому пользователю.
if [ "$(id -u)" = "0" ]; then
    PUID_VALUE="${PUID:-1000}"
    PGID_VALUE="${PGID:-1000}"
    if [ "$PUID_VALUE" != "0" ]; then
        for dir in "$DATA_DIR_VALUE" "${CACHE_DIR:-}"; do
            [ -n "$dir" ] || continue
            mkdir -p "$dir"
            if [ "$(stat -c %u:%g "$dir")" != "$PUID_VALUE:$PGID_VALUE" ]; then
                echo "inpx-shelf: changing owner of $dir to $PUID_VALUE:$PGID_VALUE"
                chown -R "$PUID_VALUE:$PGID_VALUE" "$dir"
            fi
        done
        export HOME="$DATA_DIR_VALUE"
        exec setpriv --reuid="$PUID_VALUE" --regid="$PGID_VALUE" --clear-groups -- "$@"
    fi
fi

exec "$@"
