# Отправка книг в Telegram и на email

Форк умеет не только скачивать книгу, но и отправлять её:

* в Telegram через Bot API
* на email через SMTP

Кнопки `Telegram` и `Email` появляются в карточке книги только если интеграции включены и настроены. Настраивать их можно двумя способами:

* в интерфейсе: `Настройки` -> `Отправка книг`, доступно только администратору профилей
* через переменные окружения при запуске контейнера

В админ-панели можно сохранить параметры Telegram/SMTP и сразу проверить подключение: Telegram проверяется через Bot API `getMe`, SMTP — через подключение к серверу и `verify`.

Пример `docker run` с включённой отправкой:

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
  -e TELEGRAM_BOT_TOKEN=<telegram_bot_token> \
  -e TELEGRAM_CAPTION_TEMPLATE='${AUTHOR} - ${TITLE}' \
  -e SMTP_HOST=smtp.example.com \
  -e SMTP_PORT=587 \
  -e SMTP_SECURE=false \
  -e SMTP_USER=user@example.com \
  -e SMTP_PASS=<smtp_password> \
  -e EMAIL_FROM=user@example.com \
  -v /mnt/user/appdata/inpx-shelf:/usr/local/bin/.inpx-web \
  -v /mnt/user/books/my-library:/library:ro \
  vvorth/inpx-shelf:latest
```

Переменные для Telegram:

* `TELEGRAM_BOT_TOKEN` — токен бота от `@BotFather`
* `TELEGRAM_CAPTION_TEMPLATE` — подпись к книге, по умолчанию `${AUTHOR} - ${TITLE}`

Переменные для email:

* `SMTP_HOST` — SMTP-сервер
* `SMTP_PORT` — порт SMTP, например `587`
* `SMTP_SECURE` — `true` для SMTPS, иначе `false`
* `SMTP_USER` — логин SMTP
* `SMTP_PASS` — пароль SMTP
* `EMAIL_FROM` — адрес отправителя

Важно:

* если Telegram не настроен, кнопка `Telegram` в интерфейсе скрыта
* книги в Telegram отправляются только в личный `Telegram chat id` текущего профиля; общий `TELEGRAM_CHAT_ID` как fallback не используется
* обычный клик по `Telegram` отправляет исходный файл книги, а через выпадающее меню можно выбрать `epub`, `epub3`, `kepub`, `kfx`, `azw8` или `pdf`
* если SMTP не настроен, кнопка `Email` в интерфейсе скрыта
* книги на email отправляются только на личный email текущего профиля; общий `EMAIL_TO` как fallback не используется
* обычный клик по `Email` отправляет исходный файл книги, а через выпадающее меню можно выбрать `epub`, `epub3`, `kepub`, `kfx`, `azw8` или `pdf`
* отправлять книги и задавать свои `email` и `Telegram chat id` может только профиль с паролем (или вошедший через SSO): профиль без пароля открыт любому, кто его выберет. Администратор может задать адреса любому профилю в `Администрирование → Пользователи`
* `email` профиля — ровно один адрес, без списков через запятую или точку с запятой
* с одного профиля уходит не больше `deliveryRateLimit` книг в час (email и Telegram вместе, по умолчанию 20, не больше 1000); сверх лимита отправка отклоняется с сообщением
* после изменения переменных окружения контейнер нужно пересоздать; изменения из админ-панели сохраняются в `config.json`
