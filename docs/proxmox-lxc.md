# Proxmox LXC

Для Proxmox LXC в репозитории есть готовый установочный скрипт:

```sh
sudo ./scripts/proxmox-lxc-install.sh \
  --library-dir /mnt/books/flibusta \
  --inpx-file fb2.flibusta.lib.rus.ec.7z.inpx
```

Для нескольких библиотек используйте повторяемую опцию `--source`:

```sh
sudo ./scripts/proxmox-lxc-install.sh \
  --source 'lib-rus-ec-official|Lib.rus.ec официальная|/mnt/books/_Lib.rus.ec - Официальная|librusec_local_fb2.inpx' \
  --source 'flibusta-rus-ec|Flibusta lib.rus.ec|/mnt/books/fb2.flibusta.lib.rus.ec.7z|fb2.flibusta.lib.rus.ec.7z.inpx' \
  --source 'flibusta-net|Fb2.Flibusta.Net|/mnt/books/fb2.Flibusta.Net|flibusta_fb2_local.inpx' \
  --metrics
```

Что делает скрипт:

* устанавливает Docker Engine и Docker Compose plugin внутри Debian/Ubuntu LXC
* копирует текущий репозиторий в рабочий каталог контейнера
* создаёт `docker-compose.proxmox.yml` с постоянным каталогом данных, кэшем обложек и, при необходимости, несколькими источниками через `INPX_LIBRARY_SOURCES`
* собирает образ проекта и поднимает `inpx-shelf`

Перед запуском включите для LXC поддержку Docker:

```sh
pct set <CTID> -features nesting=1,keyctl=1
```

После этого контейнер нужно перезапустить.

Основные опции скрипта:

* `--app-root` — каталог, в который будет скопирован проект; по умолчанию `/opt/inpx-shelf`
* `--data-dir` — постоянный каталог данных; по умолчанию `/opt/inpx-shelf-data`
* `--port` — внешний HTTP-порт; по умолчанию `12380`
* `--source 'id|Название|/путь/к/библиотеке|file.inpx'` — добавить источник; можно указать несколько раз
* `--cover-cache-size-mb` — лимит кэша обложек; по умолчанию `512`
* `--metrics`, `--metrics-path`, `--metrics-token` — включить и настроить Prometheus-метрики
* `--lite` — собрать облегчённый образ `runtime-lite`
* `--skip-build` — не пересобирать образ, а только перезапустить compose-стек
* `--project-name` — имя docker compose проекта

Полный список параметров:

```sh
./scripts/proxmox-lxc-install.sh --help
```
