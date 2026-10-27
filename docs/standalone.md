<a id="standalone" />
<a id="техническая-документация-и-ручная-настройка" />

# Standalone и ручная настройка

Этот раздел нужен для локального запуска без Docker и ручной настройки: готовый standalone-бинарник, запуск из исходников через Node.js и параметры командной строки. Конфиг, режим удалённой библиотеки и фильтрация `.inpx` описаны в [config.md](config.md), reverse proxy — в [nginx-https.md](nginx-https.md), dev-режим — в [development.md](development.md).

Для серверного сценария удобнее использовать [Docker](docker.md).

Что важно для standalone-запуска:

* рабочие данные приложения хранятся в каталоге `.inpx-shelf` рядом с исполняемым файлом; если его нет, а есть `.inpx-web` от inpx-web, используется он
* Windows-бинарник по умолчанию хранит данные в `%LOCALAPPDATA%\inpx-shelf`, там же, где ярлыки установщика; уже существующий каталог `.inpx-shelf` (или `.inpx-web`) рядом с `.exe` продолжает использоваться, а если запись в него недоступна, приложение переключается на `%LOCALAPPDATA%\inpx-shelf`
* standalone-архивы включают `fbc` из fb2cng для конвертации `fb2` в `epub`, `epub3`, `kepub`, `kfx` и `azw8`; Windows-архив также включает утилиты для обложек (`djxl`, `dwebp`)
* если библиотека лежит на сетевом или внешнем диске, а запись туда ограничена, лучше сразу указать `--data-dir`

Быстрые переходы:

* [Сборка standalone-бинарников](#build)
* [Локальный запуск через Node.js без Docker](#native_run)
* [Параметры командной строки](#cli)
* [Конфигурация](config.md#config)

<a id="build" />

## Сборка standalone-бинарников

Этот раздел нужен только для ручной сборки standalone-бинарников. Если нужен готовый локальный запуск без сборки, проще взять assets из GitHub Releases. Контрольные суммы всех файлов релиза лежат в `SHA256SUMS.txt` рядом с ними (`sha256sum -c --ignore-missing SHA256SUMS.txt` в каталоге со скачанными файлами), происхождение сборки проверяет `gh attestation verify <файл> --repo vvorth/inpx-shelf`. Для сборки и запуска текущей ветки из исходников требуется Node.js 24.22.1 или новее (для Node.js 26 - 26.12.1 или новее; более ранние выпуски уязвимы). Бинарники собираются через `@yao-pkg/pkg` со встроенным Node 24.

Сборка на машине с архитектурой целевой платформы предпочтительна; CI собирает ARM64-архивы на ARM64 runner'ах. Для кросс-сборки linux-arm64 на x64 потребуется [QEMU](https://wiki.debian.org/QemuUserEmulation). Linux-бинарники используют glibc; для Alpine используйте Docker-образ на Debian.

```sh
git clone https://github.com/vvorth/inpx-shelf.git
cd inpx-shelf
npm ci
npm run release:linux
```

Это пример сборки Linux x64; для упаковки архива нужна утилита `zip`. Для Linux ARM64 используйте `npm run build:linux-arm64 && node build/release.js linux-arm64`, для Windows — `npm run release:win`, для macOS Intel — `npm run release:macos`, для macOS Apple Silicon — `npm run release:macos-arm64` (бинарник подписывается ad-hoc только при сборке на macOS). Команда `npm run release` собирает все пять платформ. Результат сборки будет доступен в каталоге `dist/release`.

Для Windows дополнительно можно собрать полноценный установщик `.exe`. Он устанавливает приложение в профиль пользователя, добавляет ярлыки в меню «Пуск», опциональный ярлык на рабочий стол, отдельный ярлык `Open web interface` на `http://127.0.0.1:12380` и стандартный uninstaller. Инсталлятор не регистрирует Windows-службу: `inpx-shelf` запускается как обычный локальный сервер. Ярлыки запускают приложение с рабочими данными в `%LOCALAPPDATA%\inpx-shelf`.

Требуется Inno Setup 6: `ISCC.exe` должен быть доступен в `PATH`, либо путь к нему можно задать через `INNO_SETUP_COMPILER`.

```bat
npm run build:win
npm run build:win-tools
npm run build:win-installer
```

Готовый файл будет создан как `dist\release\inpx-shelf-<version>-win-setup.exe`.

`npm run build:win-tools` кладёт в `dist\win\bin` утилиты `djxl.exe`, `dwebp.exe` и `fbc.exe`. Их версии и SHA-256 архивов закреплены в `scripts/bundle-windows-tools.ps1`; скачанные архивы хранятся в `dist\tools-cache` и повторно не скачиваются.

<a id="native_run" />

## Локальный запуск через Node.js без Docker

Этот режим подходит для локальной отладки и ручного запуска из исходников без Docker.

Если вы используете уже готовый standalone-бинарник из GitHub Releases:

* распакуйте архив в отдельную папку
* положите рядом с ним `.inpx` и файлы библиотеки или укажите их через параметры
* при необходимости задайте отдельный каталог данных через `--data-dir`
* для готовых архивов дополнительные fb2cng-инструменты для `epub` / `epub3` / `kepub` / `kfx` / `azw8` вручную ставить не нужно: `fbc` лежит в каталоге `bin` рядом с приложением

Примеры для готового Windows-бинарника:

```bat
inpx-shelf.exe
```

Если `.inpx` и библиотека лежат не рядом с `.exe`:

```bat
inpx-shelf.exe --lib-dir="Z:\Books" --inpx="Z:\Books\library.inpx"
```

Если рабочие данные нужно хранить не в `%LOCALAPPDATA%\inpx-shelf`:

```bat
inpx-shelf.exe --data-dir="D:\inpx-shelf-data" --lib-dir="Z:\Books" --inpx="Z:\Books\library.inpx"
```

Ниже пример для Ubuntu с Node.js 24 из [репозитория NodeSource](https://github.com/nodesource/distributions/blob/master/DEV_README.md). Для других Linux-систем установите Node.js 24.22.1 или новее подходящим для системы способом.

```sh
# установка Node.js 24 и утилит для исходников
sudo apt update
sudo apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/inpx-nodesource-setup.sh
sudo -E bash /tmp/inpx-nodesource-setup.sh
sudo apt install -y nodejs
node --version

# подготовка
git clone https://github.com/vvorth/inpx-shelf.git
cd inpx-shelf
npm ci
npm run build:client
node build/prepkg.js linux

# удалим файл development-среды, чтобы запускался в production-режиме
rm -f ./server/config/application_env

# запуск inpx-shelf, тут же будет создан каталог .inpx-shelf
node server --data-dir=.inpx-shelf --lib-dir=/path/to/library --inpx=/path/to/library/library.inpx
```

Замените `/path/to/library` на свой каталог. Для конвертации при запуске из исходников нужны установленные fb2cng (`fbc`) и MuPDF (`mutool`); для JPEG XL/WebP — `djxl` и `dwebp`. Готовый Docker-образ включает эти инструменты, MuPDF — только образ с тегом `-pdf`.

<a id="cli" />

## Параметры командной строки
Запустите `inpx-shelf --help`, чтобы увидеть список опций:
```console
Usage: inpx-shelf [options]

Options:
  --help               Показать опции командной строки
  --host=<ip>          Задать имя хоста для веб сервера, по умолчанию: 0.0.0.0
  --port=<port>        Задать порт для веб сервера, по умолчанию: 12380
  --config=<filepath>  Задать файл конфигурации, по умолчанию: <dataDir>/config.json
  --data-dir=<dirpath> (или --app-dir) Задать рабочую директорию, по умолчанию: <execDir>/.inpx-shelf (Windows-бинарник: %LOCALAPPDATA%\inpx-shelf)
  --lib-dir=<dirpath>  Задать директорию библиотеки (с zip- или 7z-архивами), по умолчанию: там же, где лежит файл приложения
  --inpx=<filepath>    Задать путь к файлу .inpx, по умолчанию: тот, что найдется в директории библиотеки
  --library-sources=<json> Задать несколько INPX-источников, JSON-массив или строка "name|inpx|libDir;..."
  --recreate           Принудительно пересоздать поисковую БД при запуске приложения
  --unsafe-filter      Использовать небезопасный фильтр на свой страх и риск
```
