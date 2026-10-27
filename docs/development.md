<a id="development" />

# Разработка

Для разработки получите ветку `main` и установите зависимости под Node.js 24.22.1 или новее (для Node.js 26 - 26.12.1 или новее; более ранние выпуски уязвимы) (на старой версии npm откажется их ставить: `engine-strict` в `.npmrc`):

```sh
git clone --branch main --single-branch https://github.com/vvorth/inpx-shelf.git
cd inpx-shelf
npm ci
npm run dev
```

`npm run dev` собирает dev-версию клиента (`npm run build:client-dev`) и запускает сервер через `nodemon`: он перезапускается при изменении серверного кода, клиент пересобирается на лету через webpack-hot-middleware.

Основная структура проекта:

- `client/components/App.vue` - корневой интерфейс, общая тема, переключение PWA-манифеста каталога и читалки.
- `client/components/Api/Api.vue` - запросы к HTTP API сервера (`client/components/Api/apiConnection.js`), сессии профилей, общие диалоги входа.
- `client/components/Shell/` - оболочка приложения: боковое меню, нижняя панель на телефоне, меню пользователя.
- `client/components/Library/` - главная, поиск, витрины, страницы книги, автора и серии, общие карточки книг.
- `client/components/Login/`, `Lists/`, `Me/`, `Admin/` - страницы входа, списков чтения, профиля и администрирования.
- `client/components/Library/` - главная, страницы книги, автора и серии, обложки и карточки книг.
- `client/components/Reader/Reader.vue` - читалка, стартовый экран чтения, темы, шрифты, Wake Lock и отдельный PWA-режим.
- `client/components/Reader/ReaderLab.vue` - локальная отладка поведения читалки без полного пользовательского сценария.
- `client/store/` - Vuex-хранилище и сохраняемые UI-настройки клиента.
- `client/assets/` - иконки, PWA-манифесты и статические ресурсы клиента.
- `server/index.js` и `server/static.js` - запуск HTTP-сервера и раздача статических файлов.
- `server/controllers/ApiController.js` - HTTP API (`<root>/api/`) между клиентом и серверным ядром; маршруты действий - в общей для сервера и клиента таблице `shared/apiRoutes.js`.
- `server/core/WebWorker.js` - основной серверный оркестратор: индекс, поиск, книги, обложки, конвертация, отправка, админские действия.
- `server/core/ReadingListStore.js` - профили, прогресс чтения, закладки, списки и отметки прочитанного.
- `server/core/LibrarySources.js` - нормализация одного или нескольких источников библиотек.
- `server/core/search/` - БД библиотеки на SQLite (`library.sqlite`): импорт из INPX (`CatalogSearch.js`, `LibraryImport.js`), запросы поиска, OPDS и витрин (`CatalogIndex.js`, `CatalogIndexQueries.js`); `server/core/StateStore.js` - служебное состояние (`state.sqlite`).
- `server/core/HealthRoutes.js` и `server/core/Security.js` - health/ready/index-status, Prometheus-метрики, авторизация и прокси-защита.
- `server/core/opds/`, `server/core/fb2/`, `server/core/xml/` - OPDS, разбор FB2 и XML-вспомогательная логика.
- `server/config/` - дефолтная конфигурация и runtime-настройки, сохраняемые в data-dir.
- `build/` - сборка клиента, pkg/Windows-артефактов и релизных архивов.
- `scripts/proxmox-lxc-install.sh` - установка и обновление сервиса в Proxmox LXC.

Полезные точки отладки:

- `npm run build:client` - быстрая проверка клиентской сборки после UI-правок.
- `npx eslint --quiet server shared scripts build client --ext .js,.vue` - ESLint, как в CI; настройки - `eslint.config.js` (без `--quiet` видны и предупреждения).
- `npm run test:release` - проверки перед релизом: авторизация, бэкапы, конвертация, EPUB, дополнительные материалы библиотеки, кэш, каталог и читалка.
- `node server --data-dir=.inpx-shelf --lib-dir=/path/to/library --inpx=/path/to/file.inpx` - локальный запуск сервера без Docker.
- `/#/reader` - отдельный старт читалки и PWA-режим INPX Reader.
- `/#/reader-lab` - отладочный экран читалки.
- `/health`, `/ready`, `/api/index-status` - проверки состояния контейнера и индекса.
- `/metrics` - Prometheus-метрики, если включено `INPX_METRICS_ENABLED=true`.
- В Docker/Proxmox все постоянные данные должны лежать в volume/data-dir: `config.json`, `reading-lists.json`, `secret.key`, `library.sqlite`, `state.sqlite`, `public-files/cover/`.

## Язык интерфейса и переводы

Интерфейс, сообщения сервера и OPDS-каталог доступны на русском и английском. Язык выбирается в настройках
(«Язык интерфейса»: автоматически по языку браузера, русский или английский). Язык по умолчанию для новых браузеров
задаётся в `uiDefaults.uiLang`, язык OPDS — в `opds.lang` (или переменной окружения `INPX_OPDS_LANG`), иначе
используется заголовок `Accept-Language` читалки.

Все тексты хранятся в `shared/locales/ru.json` и `shared/locales/en.json`, в коде используются только ключи:

```js
t('settings.darkTheme')               // строка
t('authors.foundCount', {n: 4})       // множественное число: {"one": ..., "few": ..., "many": ..., "other": ...}
msg('discovery.reason.series', {...}) // на сервере: описание сообщения, переводится в браузере (для кэшируемых данных)
```

Движок переводов — `shared/i18nEngine.js` (общий для браузера и сервера), обёртки — `client/share/i18n.js`
и `server/core/i18n.js`. Сервер загружает все словари сразу (`shared/i18n.js`), браузер — только словарь выбранного
языка, отдельным файлом сборки; новый язык добавляется в `supportedLangs` движка и в `shared/i18n.js`.
Сервер переводит ответы на язык клиента (заголовок `X-Ui-Lang` запроса API, cookie `inpx_lang`).
Проверка словарей: `npm run test:i18n` — ключи есть во всех языках, совпадают параметры, нет неиспользуемых ключей
и русского текста в коде (данные помечаются комментарием `i18n-ignore`).

## Релизы

Релизы выпускаются из ветки `main` по мере готовности: Actions → Release → Run workflow. Версия ставится по дате, `ГГ.М.N`: `26.10.0`, `26.10.1`, … (N — номер релиза в месяце, ведущих нулей нет). Workflow проверяет текущий коммит `main`, переименовывает раздел `Unreleased` в `CHANGELOG.md` в «версия / дата», записывает версию в `package.json`, коммитит это в `main`, переводит `release` на тот же коммит и ставит тег одним атомарным push. Затем публикует архивы и установщик в GitHub Releases и образы `<версия>` и `latest` в Docker Hub. Без раздела `Unreleased` релиз не запускается; если за время проверок в `main` появились новые коммиты или в `release` есть коммит, которого нет в `main`, ничего не публикуется. Образы `dev` сообщают версию с меткой коммита: `26.10.0+dev.b95beaa`.

Рядом с архивами публикуется `SHA256SUMS.txt`, у каждого файла есть [attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations) происхождения сборки. `npm audit` останавливает только релиз; в остальных проверках находки дают предупреждение, а еженедельный workflow Audit проверяет зависимости `main`. Обновления зависимостей и actions присылает Dependabot (`.github/dependabot.yml`) в ветку `main`; actions закреплены по SHA коммита.

В `release` пишет только этот workflow. Правило защиты `release` может требовать линейную историю и запрещать force push и удаление, но не должно требовать проверок статуса: релизный коммит новый, проверок на нём ещё нет, и push из GitHub Actions остановится до публикации.

Workflow CI (`.github/workflows/ci.yml`) запускается на pull request и на push в `main` и `release`. Проверки, уже пройденные на этом же коммите (pull request, влитый в `main`; `main`, переведённый в `release`), не повторяются: первая задача ищет успешные check runs по SHA коммита и пропускает их; образы Docker при этом собираются как обычно.

## Релизные проверки

Перед релизом запустите:

```sh
npm run test:release
npm run build:client
```

`test:release` запускает `scripts/release-smoke-tests.js`: авторизация HTTP API/OPDS и SSO, пароли и секреты, бэкапы и их восстановление, БД библиотеки и поиск, OPDS, ограничения ресурсов и очереди конвертации, EPUB с изображениями и кодировки FB2, кэш книг, Kobo, синхронизация KOReader, читалка и витрины. Проверки используют тестовые библиотеки и не требуют реальной коллекции. GitHub Actions запускает их перед сборкой релизных архивов для Linux x64, Linux ARM64, Windows x64, macOS Intel и macOS Apple Silicon; Windows-релиз также включает установщик.
