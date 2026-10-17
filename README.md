inpx-shelf
==========

[Русская версия](./README.ru.md)

> Based on [AceAsket/inpx-web](https://github.com/AceAsket/inpx-web) (a fork of [bookpauk/inpx-web](https://github.com/bookpauk/inpx-web)). See [NOTICE.md](./NOTICE.md).

Releases ship when ready and are numbered by date, `YY.M.N`: `26.10.0`, `26.10.1`, … (year, month and the number of the release in that month). Downloads and the latest version are on the [releases page](https://github.com/vvorth/inpx-shelf/releases); what changed is in the [changelog](./CHANGELOG.md), and changes that need action from you (config, data, OPDS, Kobo, environment variables) are marked **Action required**.

## What it is

inpx-shelf is a web catalog for self-hosted INPX libraries (Flibusta, Lib.rus.ec and others): catalog search, book, author and series pages, personal shelves, reading lists, an online reader, OPDS and Kobo sync. The interface and OPDS are available in Russian and English.

The catalog is built for self-hosted libraries, with a focus on large `.7z` / `.zip` / `fLibrary` collections, Docker deployment and the built-in FB2 reader. The documentation mainly covers the `Docker / server` setup, but also standalone binaries and running from source with Node.js.

Key features:

* runs in Docker and Proxmox LXC, handles large `.7z` / `.zip` / `fLibrary` collections, converts books with fb2cng and MuPDF
* personal shelves on the home page (`Continue reading`, `From your lists`, `Unfinished series`, `Similar to what you read`), new books and genres, and an external discovery tab
* catalog with book, series and author cards, covers, links between related books, authors and series, and an extended `fb2 info` section
* search can group editions of the same work (re-uploads, other formats) into one card; the book page lists the other editions
* a book opened from the catalog, shelves or lists appears in a window over the page: `Back` or `Esc` closes it and returns to the same place; a direct `/#/book/...` link opens the full book page
* author photos and short biographies from `fLibrary`, better handling of covers and images inside `fb2`
* restoring compressed EPUBs from FLibrary/Heimdall with covers and illustrations, extra reviews and ratings from library materials
* built-in FB2 reader with a paged mode, mobile layout, a debug panel and a separate `/#/reader-lab` route
* reader font settings, the Wake Lock API for reading on phones and a separate PWA manifest for a reader shortcut
* sending and converting books to `epub`, `epub3`, `kepub`, `kfx`, `azw8` and `pdf`, and sending them via Telegram and email
* multi-user profiles, personal reading lists and reading statistics, `Telegram chat id`, email and OPDS publishing
* Kobo sync and KOReader progress sync
* admin dashboard, event log, managing sources from the UI, health checks and Prometheus metrics

## Which setup to choose

1. `Docker / server`: the main and recommended option for a home server, NAS, unRAID, Proxmox LXC, VPS and permanent web access to the library.
2. `Standalone binary`: run locally without Docker when you want one ready `.exe` / executable.
3. `Running with Node.js`: for development, debugging and starting manually from source.

For a server catalog, start with the [quick start](#quick-start-with-docker-run) and the [Docker](./docs/docker.md) page. For a ready executable, use GitHub Releases. If you work with the source, see [running with Node.js](./docs/standalone.md#native_run).

## Quick start with docker run

Example for a Flibusta / `fLibrary` library:

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

Notes:

* mount the `.inpx` file and the library files named in `INPX` and `LIBDIR` into `/library`
* `/usr/local/bin/.inpx-web` holds the search database, caches, config and service data, so keep it on a persistent volume
* `INPX_BOOK_CACHE_SIZE_MB` and `INPX_COVER_CACHE_SIZE_MB` limit prepared books and covers; over the limit, the oldest files are removed down to the target size
* the library is mounted `:ro` so the container never changes the original archives
* the first start can take a while: the app builds the search database; conversion to `epub` / `epub3` / `kepub` / `kfx` / `azw8` needs fb2cng in the image, and `pdf` needs MuPDF (the `-pdf` image tag)
* how to update: [Updating the container](./docs/docker.md#обновление-контейнера)
* once started, the web interface is at `http://<your-host>:12380`

A ready YAML example for `docker compose` is [docker-compose.yml](./docker-compose.yml): set your paths in it and run `docker compose up -d`.

Image tags: `latest` (newest release), `<version>` (a specific release, such as `26.10.0`), `dev` (for testing); each has a `-pdf` variant with MuPDF. Standalone binaries for Linux, Windows and macOS are on [GitHub Releases](https://github.com/vvorth/inpx-shelf/releases).

## Documentation

The detailed documentation is in Russian.

* [Docker: images, build, update, AWS Fargate](./docs/docker.md)
* [Authentication and monitoring](./docs/auth-monitoring.md)
* [Multiple INPX sources, search, library in S3](./docs/sources.md)
* [Admin panel, backups, book and cover cache](./docs/admin.md)
* [Sending books via Telegram and email](./docs/sending.md)
* [Users, reading lists and OPDS](./docs/users-opds.md)
* [Kobo sync](./docs/kobo.md)
* [KOReader progress sync](./docs/koreader.md)
* [Reader and FB2 debugging](./docs/reader.md)
* [Discovery shelves and external sources](./docs/discovery.md)
* [Standalone, building, running with Node.js, command-line options](./docs/standalone.md)
* [Configuration (`config.json`), remote library, filter](./docs/config.md)
* [HTTPS with nginx](./docs/nginx-https.md)
* [Development, translations, release checks](./docs/development.md)
* [Proxmox LXC](./docs/proxmox-lxc.md)

## Not planned

* Book narration (Silero TTS): removed.
* Conversion via Calibre: removed; fb2cng converts, MuPDF does `pdf`.
* The old JembaDb database: replaced by SQLite, which needs several times less memory.
* The old catalog interface: replaced by SQLite search.
* The "New" and "Popular" pages: replaced by personal shelves on the home page.
* Feedback on recommendations ("Not interested", "More like this") and the hidden-books shelf.
* Parsing bookstore pages for the external discovery tab: replaced by literary award winners from Wikidata.

## Feedback

For questions about inpx-shelf, use Issues in the repository:
https://github.com/vvorth/inpx-shelf/issues

## License

[CC0 1.0](./LICENSE.md)
