inpx-shelf
==========

[Русская версия](./README.ru.md)

> Based on [AceAsket/inpx-web](https://github.com/AceAsket/inpx-web) (a fork of [bookpauk/inpx-web](https://github.com/bookpauk/inpx-web)). See [NOTICE.md](./NOTICE.md).

inpx-shelf is a self-hosted web catalog for INPX e-book libraries (Flibusta, Lib.rus.ec and others): catalog search, book, author and series pages, personal shelves, reading lists, an online reader, OPDS and Kobo sync. The interface and OPDS are available in Russian and English.

## Key features

* runs in Docker and Proxmox LXC, handles large `.7z` / `.zip` / `fLibrary` collections
* personal shelves on the home page: continue reading, from your lists, unfinished series, similar to what you read
* built-in FB2 reader with a paged mode, mobile layout and font settings
* conversion to `epub`, `epub3`, `kepub`, `kfx`, `azw8` (fb2cng) and `pdf` (MuPDF), sending books via Telegram and email
* multi-user profiles, reading lists, OPDS, Kobo sync, Audiobookshelf metadata provider
* admin dashboard, event log, multiple INPX sources managed from the UI, backups, health checks and Prometheus metrics

## Quick start with Docker

```sh
docker run -d \
  --name=inpx-shelf \
  --restart unless-stopped \
  -p 12380:12380 \
  -e INPX=/library/my-library.inpx \
  -e LIBDIR=/library \
  -e CACHE_DIR=/usr/local/bin/.inpx-web/cache \
  -e INPX_BOOK_CACHE_SIZE_MB=2048 \
  -e INPX_COVER_CACHE_SIZE_MB=512 \
  -v /mnt/user/appdata/inpx-shelf:/usr/local/bin/.inpx-web \
  -v /mnt/user/books/my-library:/library:ro \
  vvorth/inpx-shelf:latest
```

* mount the `.inpx` file and the library archives into `/library`; `INPX` and `LIBDIR` are paths inside the container
* `/usr/local/bin/.inpx-web` holds the search database, caches, config and user data: keep it on a persistent volume
* the first start builds the search database and may take a while
* then open `http://<your-host>:12380`

For Docker Compose, edit the paths in [docker-compose.yml](./docker-compose.yml) and run `docker compose up -d`.

Image tags: `latest` (stable), `beta` (pre-releases), `dev` (for testing); each has a `-pdf` variant with MuPDF for `pdf` conversion. Standalone binaries for Linux, Windows and macOS are on [GitHub Releases](https://github.com/vvorth/inpx-shelf/releases).

## Documentation

The detailed documentation is in Russian: start from [README.ru.md](./README.ru.md#документация).

* [Docker: images, build, update](./docs/docker.md)
* [Configuration (`config.json`)](./docs/config.md)
* [Users, reading lists and OPDS](./docs/users-opds.md)
* [Kobo sync](./docs/kobo.md)
* [KOReader progress sync](./docs/koreader.md)

## Feedback

Issues: https://github.com/vvorth/inpx-shelf/issues

## License

[CC0 1.0](./LICENSE.md)
