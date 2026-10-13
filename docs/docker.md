# Сборка Docker-контейнера

Основной способ запуска рассчитан на Docker. Готовый образ публикуется в [Docker Hub](https://hub.docker.com/r/vvorth/inpx-shelf) под тегами версий и тегом `latest`, например `vvorth/inpx-shelf:latest`. Тег `latest` указывает на последний стабильный релиз, `beta` — на последний предварительный (`-alpha`, `-beta`, `-rc`), `dev` — на сборку из ветки `dev` (собирается при каждом изменении ветки, только для тестирования). У каждого тега есть вариант с суффиксом `-pdf` (`latest-pdf`, `beta-pdf`, `dev-pdf`, `<версия>-pdf`): тот же образ плюс MuPDF для конвертации в `pdf`, примерно на 100 МБ больше. Образ рассчитан на `linux/amd64`; для Linux ARM64 есть отдельный standalone-архив в GitHub Releases.

Образ можно запустить на данных inpx-web: путь данных в контейнере остался `/usr/local/bin/.inpx-web`, поэтому существующий volume подключается без изменений.

Готовый YAML-пример — [docker-compose.yml](../docker-compose.yml): основной образ с конвертацией через fb2cng (для `pdf` возьмите тег с `-pdf`), закомментированные настройки отправки книг в Telegram и на email.

Важно: путь в `INPX` и каталог в `LIBDIR` должны совпадать с путём внутри контейнера из правой части `volume`.
Например, если библиотека смонтирована как `...:/library:ro`, то и `INPX` должен быть вида `/library/имя.inpx`, а `LIBDIR` — `/library`.

Для самостоятельной сборки сначала получите исходники:

```sh
git clone https://github.com/vvorth/inpx-shelf.git
cd inpx-shelf
```

Собрать основной образ с конвертацией через fb2cng можно так:

```sh
docker build -t inpx-shelf:latest .
```

Вариант с MuPDF для конвертации в `pdf`:

```sh
docker build --target runtime-pdf -t inpx-shelf:latest-pdf .
```

Облегчённый вариант без конвертации в `epub` / `epub3` / `kepub` / `kfx` / `azw8` / `pdf`:

```sh
docker build --target runtime-lite -t inpx-shelf:lite .
```

Если нужно пересобрать все слои заново без кэша:

```sh
docker build --no-cache -t inpx-shelf:latest .
```

Важно:

* основной образ умеет `fb2 -> epub`, `epub3`, `kepub`, `kfx`, `azw8` через fb2cng; `runtime-pdf` (теги `-pdf`) добавляет `fb2` / `epub -> pdf` через MuPDF
* `runtime-lite` заметно легче и быстрее собирается, не умеет конвертацию книг и автоматически скрывает кнопки `EPUB` / `EPUB3` / `KEPUB` / `KFX` / `AZW8` / `PDF` в интерфейсе
* Dockerfile использует multi-stage сборку: приложение упаковывается в `pkg`-бинарник, а runtime-слой не тянет Node.js, `node_modules` и dev/UI-зависимости
* при включённом BuildKit повторные сборки идут быстрее за счёт кэша `apt` и `npm`

Чтобы собрать и запустить образ через `docker compose`, замените в [docker-compose.yml](../docker-compose.yml) строку `image: ...` на `build: .` и выполните:

```sh
docker compose up -d --build
```

## Пользовательский конфиг fb2cng

Свой YAML-конфиг fb2cng можно передать через `INPX_FB2CNG_CONFIG`. Переменная `FB2CNG_CONFIG` поддерживается как совместимый alias, но `INPX_FB2CNG_CONFIG` имеет приоритет. Путь берётся только из окружения и не сохраняется в `config.json`, поэтому его можно менять или удалять при пересоздании контейнера.

Встроенный `fbc` собран из форка [vvorth/fb2cng](https://github.com/vvorth/fb2cng): это fb2cng с дополнительной настройкой `document.images.force_jpeg`. Образец конфига с описанием всех полей выдаёт `fbc dumpconfig --default`.

Монтируйте read-only весь каталог конфига, а не только YAML: конфиг fb2cng может ссылаться на CSS, шрифты и другие файлы рядом с ним.

```sh
docker run -d \
  --name=inpx-shelf \
  -p 12380:12380 \
  -e INPX_FB2CNG_CONFIG=/config/fb2cng/config.yaml \
  -v /path/on/host/fb2cng:/config/fb2cng:ro \
  -v /path/on/host/library:/library:ro \
  -v /path/on/host/data:/usr/local/bin/.inpx-web \
  vvorth/inpx-shelf:latest
```

При первом обращении к конвертации приложение проверяет, что файл существует, читается и принимается командой `fbc --config PATH dumpconfig`. Ошибочный путь или YAML возвращает явную ошибку вместо незаметного запуска с настройками по умолчанию. Кэш учитывает логический формат (`epub` и `epub3` раздельно), содержимое и расположение YAML, версию встроенного fb2cng и настроенные пути конвертеров.

Конвертации выполняются в общей очереди. По умолчанию одновременно работают два задания, ещё 16 могут ожидать; ожидание и выполнение ограничены двумя минутами каждое. При таймауте завершается дерево процессов конвертера. Незавершённый результат не попадает в кэш.

| Параметр config.json | Переменная Docker | По умолчанию |
| --- | --- | --- |
| `conversionConcurrency` | `INPX_CONVERSION_CONCURRENCY` | `2` |
| `conversionQueueLimit` | `INPX_CONVERSION_QUEUE_LIMIT` | `16` |
| `conversionTimeoutMs` | `INPX_CONVERSION_TIMEOUT_MS` | `120000` |
| `conversionQueueTimeoutMs` | `INPX_CONVERSION_QUEUE_TIMEOUT_MS` | `120000` |

Переменные окружения имеют приоритет; изменения применяются после перезапуска. Для тяжёлых книг можно увеличить таймаут. При заполнении очереди приложение возвращает ошибку с предложением повторить запрос позже.

Для запуска готового образа используйте [пример docker run](../README.ru.md#быстрый-старт-через-docker-run).

## Обновление контейнера

Для обновления сначала скачайте новый образ, затем пересоздайте контейнер. Повторите свою исходную команду `docker run`, заменив только тег образа: сохраните все переменные окружения, порты и тома, включая `INPX_LIBRARY_SOURCES`, настройки авторизации и отправки книг. Ниже пример для одной библиотеки; замените пути на свои. Команды соединены через `&&`, чтобы не удалять работающий контейнер при ошибке скачивания образа.

```sh
docker pull vvorth/inpx-shelf:latest &&
docker rm -f inpx-shelf &&
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

При локальной сборке используйте имя своего образа. Если сервис запущен через Compose, сохраните настройки в YAML, укажите нужный тег в `image` и выполните `docker compose pull && docker compose up -d`.
