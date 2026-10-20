<a id="https" />

# Настройка https с помощью nginx
Проще всего настроить https с помощью certbot и проксирования в nginx (пример для debian-based linux):

```sh
#ставим nginx
sudo apt install nginx
```
```
#правим конфиг nginx
server {
  listen 80;
  server_name <имя сервера>;
  set $inpx_web http://127.0.0.1:12380;

  client_max_body_size 512m;
  proxy_read_timeout 1h;

  location / {
    proxy_pass $inpx_web;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```
```sh
#загружаем новый конфиг
sudo service nginx reload
```
Далее следовать инструкции установки https://certbot.eff.org/instructions?ws=nginx&os=debianbuster
