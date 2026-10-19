# Установка Zvonitel.ru на VPS с FastPanel

Отдельная инструкция для сервера, где уже стоит панель FastPanel. Предполагается Debian или Ubuntu, доступ по SSH и домен, направленный на этот сервер.

Общая инструкция (без панели, чистый VPS, Docker) — в [INSTALL.md](INSTALL.md).

---

## 0. Что важно знать до начала

**Про лицензию.** В FastPanel тип бэкенда «Node.js» доступен только на платной лицензии **Extended**. На бесплатной Standard его в списке не будет — это не ошибка, просто ограничение панели.

Инструкция ниже построена так, что **лицензия не имеет значения**: мы ставим Node.js в систему, запускаем приложение через systemd, а в панели используем тип бэкенда **Reverse proxy**, который есть на любой лицензии. Если у вас Extended, можете вместо этого выбрать бэкенд Node.js и отдать панели управление процессом — но вариант с systemd надёжнее и одинаков на всех лицензиях.

**Про порты.** Панель уже занимает 80 и 443 своим nginx, а сама отвечает на 8888. Наше приложение повесим на `127.0.0.1:3000` — **только на локальный интерфейс**, наружу его не открываем. Весь внешний трафик идёт через nginx панели.

**Про HTTPS и TURN.** Камера в браузере работает только по HTTPS — сертификат выпустим в панели, это одна кнопка. А вот TURN-сервер для WebRTC панель не умеет: ставим coturn рядом вручную. Без него часть пользователей не сможет соединиться.

---

## 1. Подготовка

### 1.1 Что нужно

- VPS на Debian 11/12 или Ubuntu 22.04/24.04, от 1 ГБ памяти (комфортно — 2 ГБ)
- Установленная FastPanel, доступ `https://IP_СЕРВЕРА:8888`
- SSH-доступ под root или с sudo
- Домен с A-записью на IP сервера

### 1.2 Проверяем, что домен смотрит на сервер

На своей машине:

```bash
dig +short ваш-домен.ru
```

Должен вернуться IP вашего VPS. Если нет — идите в панель регистратора и правьте A-запись. DNS расходится до суток, обычно хватает 10–15 минут.

### 1.3 Подключаемся по SSH

```bash
ssh root@IP_СЕРВЕРА
```

---

## 2. Устанавливаем Node.js в систему

Ставим из NodeSource — панельный Node.js привязан к лицензии и версиям, а нам нужен обычный системный.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

Проверяем:

```bash
node -v    # v20.x
npm -v     # 10.x
```

Инструменты для сборки `better-sqlite3` (нужны, если для вашей платформы нет готового бинарника):

```bash
apt-get install -y python3 make g++ git
```

---

## 3. Создаём сайт в FastPanel

1. Заходим в панель: `https://IP_СЕРВЕРА:8888`
2. Слева — **«Сайты»** → **«Создать сайт»**
3. Выбираем **«Создать сайт вручную»**
4. Домен: `ваш-домен.ru` (без `http://` и без `www`)
5. **Пользователь** — обязательно **«Создать нового»**. Не используйте `fastuser` для боевого сайта: при взломе приложения злоумышленник получит права того пользователя, под которым оно работает. Допустим, создали пользователя `zvuser`
6. На шаге бэкенда пока оставьте **PHP** — так надёжнее выпустить SSL (см. ниже). Переключим на прокси после
7. MySQL создавать не нужно — у нас SQLite
8. **«Создать сайт»**

Панель создаст каталог:

```
/var/www/zvuser/data/www/ваш-домен.ru
```

и системного пользователя `zvuser`. Запомните это имя — дальше оно встречается в путях и в systemd-юните.

---

## 4. Разворачиваем приложение

### 4.1 Кладём код

```bash
cd /var/www/zvuser/data/www/ваш-домен.ru
rm -rf * .[!.]* 2>/dev/null      # убираем заглушку панели

git clone https://github.com/ВАШ-АККАУНТ/zvonitel.git .
# или загрузите архив через файловый менеджер панели («Файлы» → «Загрузить») и распакуйте
```

### 4.2 Ставим зависимости

```bash
cd /var/www/zvuser/data/www/ваш-домен.ru
npm ci --omit=dev
```

`--omit=dev` — на сервере не нужны Playwright и socket.io-client. Если собираетесь запускать тесты прямо на сервере, выполните `npm install` без флага.

### 4.3 Права

Приложение работает под пользователем сайта, поэтому файлы должны принадлежать ему:

```bash
chown -R zvuser:zvuser /var/www/zvuser/data/www/ваш-домен.ru
chmod 750 /var/www/zvuser/data/www/ваш-домен.ru
```

### 4.4 Папка для базы

Базу лучше держать **вне** каталога сайта — чтобы резервные копии панели и обновления кода её не задели:

```bash
mkdir -p /var/www/zvuser/data/zvonitel-db
chown zvuser:zvuser /var/www/zvuser/data/zvonitel-db
```

---

## 5. systemd-юнит

Панель не управляет нашим процессом, поэтому автозапуск и перезапуск при падении делаем через systemd.

```bash
nano /etc/systemd/system/zvonitel.service
```

```ini
[Unit]
Description=Zvonitel.ru
After=network.target

[Service]
Type=simple
User=zvuser
Group=zvuser
WorkingDirectory=/var/www/zvuser/data/www/ваш-домен.ru
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=DATA_DIR=/var/www/zvuser/data/zvonitel-db
Environment=PUBLIC_URL=https://ваш-домен.ru
Environment=ADMIN_NICK=admin
Environment=ADMIN_PASS=ПРИДУМАЙТЕ-ДЛИННЫЙ-ПАРОЛЬ
Environment=ICE_SERVERS=[{"urls":"stun:turn.ваш-домен.ru:3478"},{"urls":["turn:turn.ваш-домен.ru:3478?transport=udp","turn:turn.ваш-домен.ru:3478?transport=tcp"],"username":"zvonitel","credential":"ПРИДУМАЙТЕ-СЕКРЕТ"}]
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Обязательно замените: `zvuser`, `ваш-домен.ru`, оба пароля и секрет TURN.

Запускаем:

```bash
systemctl daemon-reload
systemctl enable --now zvonitel
systemctl status zvonitel
```

Первый запуск создаст базу и администратора. Смотрим лог:

```bash
journalctl -u zvonitel -f
```

Должны появиться строки:

```
[boot] создан админ: admin / ваш-пароль
Zvonitel.ru готов → http://127.0.0.1:3000
```

Проверяем, что приложение отвечает локально:

```bash
curl http://127.0.0.1:3000/api/health
# {"ok":true,...}
```

`ICE_SERVERS` пока можно оставить как есть — TURN поднимем в разделе 8, до этого звонки будут работать через STUN (не для всех пар пользователей).

---

## 6. SSL-сертификат

Выпускаем **до** переключения в режим прокси, пока сайт ещё на PHP: так панель без проблем пройдёт проверку Let's Encrypt.

1. Карточка сайта → **«SSL-сертификаты»** → **«New Certificate»**
2. Вводим домен, при желании включаем `www`
3. Ждём выпуска

Панель сама получит сертификат и пропишет пути в конфиг nginx.

Включите **«Редирект на HTTPS»** в настройках сайта.

> Если сертификат не выпускается, проверьте, что порты 80 и 443 открыты и домен уже смотрит на сервер. Let's Encrypt проверяет владение доменом, обращаясь к нему по HTTP.

---

## 7. Настраиваем nginx: прокси и WebSocket

### 7.1 Переключаем бэкенд в Reverse proxy

Карточка сайта → **«Настройки»** → блок **«Backend (PHP, Reverse proxy, etc.)»** → тип **«Reverse proxy»**.

Адрес бэкенда:

```
http://127.0.0.1:3000
```

Сохраняем.

### 7.2 Добавляем поддержку WebSocket

Это **критично**. Socket.IO (очередь, сигналинг, чат) работает поверх WebSocket. Штатный конфиг прокси в панели может не содержать нужных заголовков — тогда сайт откроется, но звонки не будут соединяться, а в консоли браузера будет `WebSocket connection failed`.

Откройте карточку сайта → **«Manual settings»** (Ручные настройки) → раздел nginx, и добавьте:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_buffering off;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
```

Для этого нужна переменная `$connection_upgrade`. Если её в конфиге панели нет, создайте отдельный файл — он лежит вне конфигов сайтов, поэтому не перезатирается панелью при перегенерации:

```bash
nano /etc/nginx/conf.d/ws-upgrade.conf
```

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Если `nginx -t` после этого ругается на **дублирование** `map` — значит, такая переменная уже определена; удалите свой файл и оставьте как есть.

Нет желания возиться с `map` — замените строку на литерал, это работает не хуже:

```nginx
proxy_set_header Connection "upgrade";
```

Три вещи, которые чаще всего забывают:

- `proxy_http_version 1.1` — без него WebSocket не поднимется;
- `proxy_set_header Upgrade` и `Connection` — собственно апгрейд соединения;
- `proxy_read_timeout 86400s` — долгие WebSocket-сессии, иначе разговор обрывается на 60-й секунде.

Если панель не даёт сохранить конфиг (бывает из-за уже существующего `location /`), положите тот же блок в файл инклюда сайта:

```bash
nano /etc/nginx/fastpanel2-sites/zvuser/ваш-домен.ru.includes
```

### 7.3 Проверяем и применяем

```bash
nginx -t && systemctl reload nginx
```

Если `nginx -t` ругается на дублирование `location /` — значит, панель уже сгенерировала свой, и правки нужно вносить в него, а не добавлять второй.

Откройте `https://ваш-домен.ru` — должна загрузиться главная.

Проверьте, что WebSocket живёт: откройте консоль браузера (F12) — не должно быть ошибок `WebSocket` — и посмотрите счётчик «человек онлайн» на главной: он должен показать `1`, а не `0`.

---

## 8. TURN-сервер (coturn)

Без него пользователи за симметричным NAT и часть мобильных операторов не смогут соединиться: матч будет, а видео не пойдёт.

### 8.1 Устанавливаем

```bash
apt-get install -y coturn
```

### 8.2 Поддомен для TURN

Заведите A-запись `turn.ваш-домен.ru` на IP сервера. Один и тот же хост обслуживает и STUN, и TURN — так проще, чем держать два поддомена.

Проверьте:

```bash
dig +short turn.ваш-домен.ru
```

### 8.3 Узнаём свой публичный IP

```bash
curl -s ifconfig.me; echo
```

Запомните его — он понадобится в конфиге.

### 8.4 Настраиваем

```bash
nano /etc/turnserver.conf
```

```conf
listening-port=3478
listening-ip=ВАШ_ПУБЛИЧНЫЙ_IP
external-ip=ВАШ_ПУБЛИЧНЫЙ_IP

fingerprint
lt-cred-mech
realm=ваш-домен.ru
server-name=ваш-домен.ru

user=zvonitel:СЕКРЕТ-ИЗ-ICE_SERVERS

min-port=49160
max-port=49200

no-tls
no-dtls
no-cli
no-multicast-peers

denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
```

Почему именно так — каждая строка проверена на реальном запуске:

- **`listening-ip` обязателен.** Без него coturn часто не может сам определить адрес и падает сразу: `ERROR: main: Cannot configure any meaningful IP listener address`. Проверено в A/B-тесте: без этой строки — немедленный выход, с ней — нормальный старт.
- **`external-ip`** нужен, если сервер за NAT (у части провайдеров именно так). Если IP прямой, просто продублируйте тот же адрес — хуже не будет.
- **`no-cli`** убирает ошибку `Empty cli-password, and so telnet cli interface is disabled!` — telnet-интерфейс нам не нужен.
- **`no-tls` / `no-dtls`** отключают TLS-слушатели: TLS нам не нужен (браузер подключается к TURN по plain), а без сертификатов coturn будет сыпать предупреждениями.
- Секрет в `user=` должен **совпадать** с тем, что в `ICE_SERVERS` в systemd-юните.

Включаем автозапуск — в Debian/Ubuntu coturn после установки стартует только после правки:

```bash
nano /etc/default/coturn
# TURNSERVER_ENABLED=1
```

```bash
systemctl enable --now coturn
systemctl status coturn
```

Диагностика:

```bash
journalctl -u coturn -n 50 --no-pager
```

Если в journalctl пусто (у coturn есть своя привычка писать лог в файл), смотрите его напрямую:

```bash
ls -t /var/tmp/turn_*.log | head -1 | xargs tail -50
```

Что в логе нормально, а что нет:

```
Relay ports initialization done          ← всё хорошо, TURN работает
I cannot support STUN CHANGE_REQUEST     ← нормально, это не ошибка:
                                           серверу передали один IP
Cannot configure any meaningful IP       ← ошибка: не задан listening-ip
Cannot open SQLite DB connection         ← нет доступа к /var/lib/turn; проверьте владельца
```

Если видите проблему с БД — она не мешает работе со статическими учётными данными, но лучше поправить:

```bash
ls -ld /var/lib/turn                      # должно быть turnserver:turnserver
chown -R turnserver:turnserver /var/lib/turn
```

### 8.5 Открываем порты

Здесь **два** брандмауэра, и забывают обычно второй:

1. **В FastPanel:** «Настройки» → **«Firewall»** → «New rule»:

   | Name | Port | Protocol | Type |
   |---|---|---|---|
   | TURN | 3478 | TCP | INPUT |
   | TURN-UDP | 3478 | UDP | INPUT |
   | TURN-relay | 49160-49200 | UDP | INPUT |

2. **У хостинг-провайдера** — в панели управления VPS тоже часто есть свой файрвол. Откройте там те же порты, иначе правила сервера просто не помогут.

### 8.6 Проверяем

Откройте <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>, впишите:

```
turn:ваш-домен.ru:3478    zvonitel    ваш-секрет
```

Нажмите **Add Server** → **Gather candidates**. Если появились candidates типа `relay` — TURN работает.

После этого перезапустите приложение, чтобы оно подхватило настройки:

```bash
systemctl restart zvonitel
```

Проще вынести TURN на поддомен `turn.ваш-домен.ru` с отдельной A-записью — тогда при переезде сервера не придётся менять конфиг приложения.

---

## 9. Проверка всей связки

```bash
# приложение отвечает
curl http://127.0.0.1:3000/api/health

# наружу отдаётся через nginx по HTTPS
curl -I https://ваш-домен.ru/api/health

# WebSocket-эндпоинт доступен
curl -I "https://ваш-домен.ru/socket.io/?EIO=4&transport=polling"
# ожидаемо 200, а не 404/502

# TURN слушает
ss -lntup | grep -E '3478|turnserver'
```

Затем откройте сайт в двух браузерах (второй — приватный режим) и сделайте звонок: «Начать» → «Случайный звонок». Если камера не включается — почти всегда это проблема HTTPS (см. раздел 11).

Админка: `https://ваш-домен.ru/admin`.

---

## 10. Обслуживание

### Обновление

```bash
cd /var/www/zvuser/data/www/ваш-домен.ru
systemctl stop zvonitel
cp -r /var/www/zvuser/data/zvonitel-db/ /root/zv-db-backup-$(date +%F)/
git pull
npm ci --omit=dev
chown -R zvuser:zvuser .
systemctl start zvonitel
journalctl -u zvonitel -f
```

### Бэкап базы

```bash
# консистентный бэкап SQLite на работающем сервере
cd /var/www/zvuser/data/www/ваш-домен.ru
NODE_PATH=$(pwd)/node_modules node -e \
  "require('better-sqlite3')('/var/www/zvuser/data/zvonitel-db/zvonitel.db').backup('/root/zv-$(date +%F).db')"
```

Плюс настройте резервное копирование в самой панели («Резервные копии») — оно пригодится для файлов сайта.

### Логи

```bash
journalctl -u zvonitel -f                                                  # приложение
journalctl -u coturn -f                                                    # TURN
tail -f /var/www/zvuser/data/logs/ваш-домен.ru-frontend.error.log          # nginx панели
tail -f /var/www/zvuser/data/logs/ваш-домен.ru-frontend.access.log
```

### Полезные команды

```bash
systemctl restart zvonitel      # перезапуск приложения
systemctl status zvonitel       # состояние
nginx -t                        # проверка конфига перед reload
systemctl reload nginx          # применить конфиг без разрыва соединений
```

---

## 11. Частые проблемы

**502 Bad Gateway**
Приложение не отвечает на `127.0.0.1:3000`. Проверьте по порядку:

```bash
systemctl status zvonitel
curl http://127.0.0.1:3000/api/health
journalctl -u zvonitel -n 50
```

Частые причины: приложение упало (смотрите лог), неверный порт в настройках прокси, `HOST` в юните не `127.0.0.1`.

**Сайт открывается, но «0 человек онлайн» и звонок не соединяется**
Не работает WebSocket. Проверьте консоль браузера: ошибки `WebSocket connection failed` означают, что в nginx не добавлены заголовки `Upgrade` и `proxy_http_version 1.1` (раздел 7.2).

**Камера и микрофон не включаются**
Три причины по частоте: открыли по `http://` вместо `https://`; браузер не получил разрешение; камера занята другим приложением. `getUserMedia` работает только в безопасном контексте — с HTTPS у вас всё в порядке, ищите разрешения в настройках сайта браузера.

**Собеседник не соединяется: матч есть, видео нет**
Нет или не настроен TURN. Проверьте coturn (раздел 8.6) и что секрет в `turnserver.conf` совпадает с `ICE_SERVERS`.

**Сертификат Let's Encrypt не выпускается после переключения в Reverse proxy**
Панель не может пройти проверку, потому что запрос уходит на бэкенд. Решение: временно переключите бэкенд сайта на **PHP** или **Static content**, выпустите сертификат, затем верните **Reverse proxy**.

**Приложение не пишет базу: `SQLITE_CANTOPEN` или `EACCES`**
Неверные права на `DATA_DIR`. Проверьте, что папка существует и принадлежит пользователю из юнита:

```bash
ls -ld /var/www/zvuser/data/zvonitel-db
chown zvuser:zvuser /var/www/zvuser/data/zvonitel-db
```

**`EADDRINUSE: address already in use :::3000`**
Порт 3000 уже занят — возможно, приложение запущено и из systemd, и вручную. Остановите лишнее: `pkill -f "node server/index.js" && systemctl start zvonitel`.

**При обновлении панели слетела настройка прокси**
Правки, внесённые через «Manual settings», иногда затираются. Держите резервную копию блока конфига и после обновления панели проверяйте `nginx -t` и работу WebSocket.

**Реферальные ссылки ведут на `localhost:3000`**
Не задан `PUBLIC_URL` в systemd-юните. После правки: `systemctl daemon-reload && systemctl restart zvonitel`.

---

## 12. Кратко: порядок действий

1. Установить Node.js 20 в систему
2. Создать сайт в FastPanel с отдельным пользователем (бэкенд пока PHP)
3. Положить код в `/var/www/USER/data/www/DOMAIN`, выполнить `npm ci --omit=dev`, назначить права
4. Создать systemd-юнит с `HOST=127.0.0.1` и `DATA_DIR` вне каталога сайта
5. Выпустить SSL в панели, включить редирект на HTTPS
6. Переключить бэкенд в Reverse proxy на `http://127.0.0.1:3000`
7. Добавить в nginx заголовки WebSocket и длинные таймауты
8. Установить coturn, открыть порты 3478 и 49160–49200 в двух брандмауэрах
9. Проверить health, WebSocket, TURN и сделать тестовый звонок

**Не забудьте:** сменить `ADMIN_PASS`, задать `PUBLIC_URL`, совместить секрет TURN в systemd-юните и в `turnserver.conf`.
