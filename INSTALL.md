# Установка Zvonitel.ru

Подробная инструкция: от «просто запустить локально» до продакшена с HTTPS и TURN.

Краткая версия есть в [README.md](README.md#быстрый старт) — здесь всё то же, но с объяснениями и диагностикой.

Если сервер уже с **FastPanel** — есть отдельная инструкция: [INSTALL-FASTPANEL.md](INSTALL-FASTPANEL.md).

---

## 1. Что понадобится

| | Минимум | Рекомендуется | Зачем |
|---|---|---|---|
| **Node.js** | 18 | 20 LTS | сервер; в 20-ке стабильнее WebSocket и быстрее старт |
| **npm** | 9 | идёт с Node | установка зависимостей |
| **Сборщик для нативной сборки** | — | `python3`, `make`, `g++` | `better-sqlite3`; обычно ставится из готового бинарника, но без сборщика на нестандартной платформе упадёт |
| **Браузер + камера** | — | Chrome/Edge/Safari | проверка звонка; Safari не умеет распознавание речи (субтитры) |
| **Playwright + Chromium** | — | для тестов | E2E-тесты и демо-боты |
| **Docker** | — | для продакшена | готовый стек: приложение + nginx + coturn |

Внешние сервисы для старта **не нужны** — ни база, ни Redis, ни очереди. Всё в одном процессе, данные в SQLite-файле.

Проверить версию:

```bash
node -v    # должно быть >= 18
npm -v
```

Если Node старше 18 — обновите ([nvm](https://github.com/nvm-sh/nvm) удобнее всего):

```bash
nvm install 20 && nvm use 20
```

### Если ставите на чистый Debian/Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y python3 make g++ curl git
```

На macOS достаточно Xcode Command Line Tools: `xcode-select --install`.

---

## 2. Локальный запуск (три минуты)

```bash
git clone <ваш-репозиторий> zvonitel
cd zvonitel
npm install
npm start
```

Откройте **http://localhost:3000**.

Что вы увидите: гейт 18+ (подтвердите возраст — запоминается в localStorage), затем главную. Кнопка «Начать» ведёт на проверку камеры, оттуда — в очередь или к фильтрам.

Остановка: `Ctrl+C`. Сервер корректно закрывает соединения и SQLite (`SIGINT`/`SIGTERM` обрабатываются).

<details>
<summary><b>Что именно делает npm install</b></summary>

Три рабочие зависимости:

- `express` — REST API и раздача статики;
- `socket.io` — сигналинг, очередь, матчинг, чат, модерация;
- `better-sqlite3` — база (синхронный драйвер, очень быстрый на таком объёме).

И две dev-зависимости: `playwright` и `socket.io-client` — они нужны только для тестов и демо-ботов.

Если ставите на сервер и тесты там не нужны: `npm ci --omit=dev`. Это вдвое меньше места, но демо-боты перестанут работать (они поднимают headless-браузер через Playwright). Сам сервис при этом работает полностью.
</details>

### Режим разработки

```bash
npm run dev          # node --watch: перезапуск при изменении файлов в server/
```

Фронтенд (`public/`) отдаётся с диска, поэтому правки CSS/JS видны после обычного обновления страницы — перезапуск не нужен.

---

## 3. Что происходит при первом запуске

При старте сервер сам создаёт всё необходимое:

1. **Папку данных** — `./data/` (или `$DATA_DIR`), в ней `zvonitel.db`. Таблицы создаются автоматически при первом обращении, миграции накатываются сами.
2. **Администратора** — логин/пароль из `ADMIN_NICK` / `ADMIN_PASS`, по умолчанию `admin` / `zvonitel`. В консоль выводится строка `[boot] создан админ: admin / zvonitel`.
3. **Стартовый счётчик звонков** — на главной написано «Уже 12 847 звонков». Это «соцдоказательство» для первого посетителя: пустой сервис с честным нулём выглядит мёртвым.

> **Обязательно в продакшене:** смените пароль администратора через `ADMIN_PASS` и сбросьте seeded-счётчик (см. раздел 8).

Админка: **http://localhost:3000/admin**.

---

## 4. Как проверить, что всё работает

### 4.1 Быстрая проверка сервера

```bash
curl http://localhost:3000/api/health
```

Ответ `{"ok":true,...}` — сервер жив. Ещё полезно:

```bash
curl http://localhost:3000/api/config      # продуктовые словари и тарифы
curl http://localhost:3000/api/metrics     # счётчики
curl "http://localhost:3000/api/users/search?q=ad"   # поиск по логину
```

### 4.2 Первый звонок

Самый надёжный способ — **два окна браузера** (второе — приватное/`Ctrl+Shift+N`, чтобы получить отдельного гостя или другого пользователя):

1. В обоих откройте http://localhost:3000
2. Подтвердите 18+ и разрешите доступ к камере
3. В обоих нажмите «Начать» → «Случайный звонок»
4. Через 1–3 секунды вы увидите друг друга

Если камеры нет或以 доступ не дан — приложение не падает, а включает демо-поток (анимированный canvas) и пишет об этом: «Камера недоступна — включён демо-поток (звонок всё равно работает)». Звонок при этом работает по-настоящему.

### 4.3 Проверка звонка по логину

1. Зарегистрируйтесь в первом окне («Войти» → «Регистрация»)
2. Во втором окне зарегистрируйтесь под другим ником
3. В первом окне: «Начать» → введите логин второго в поле «Позвоните напрямую» → «Позвонить»
4. Во втором окне появится экран входящего вызова с ником звонящего → «Принять»

### 4.4 Если хочется поговорить, а второго человека нет

Включите демо-ботов — они поднимаются как настоящие участники с canvas-видео (нужен установленный Playwright):

```bash
curl -X POST http://localhost:3000/api/admin/bots \
  -H "Authorization: Bearer <токен админа>" \
  -H "Content-Type: application/json" \
  -d '{"on":true,"count":1}'
```

Токен проще всего взять так:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"nick":"admin","password":"zvonitel"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)
```

То же самое есть кнопками в админке (`/admin` → «Демо-боты»). Остановка: `{"on":false}`.

Боты **честно подписаны** — «Демо-бот Алиса», в профиле роль `bot`. Обмана нет: собеседник видит, что это бот.

---

## 5. Переменные окружения

Все необязательны — без них сервер стартует с разумными значениями по умолчанию.

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `PORT` | `3000` | Порт |
| `HOST` | `0.0.0.0` | Интерфейс; `127.0.0.1` — если перед ним стоит nginx на той же машине |
| `PUBLIC_URL` | *(пусто)* | **Важно за прокси.** Внешний адрес вида `https://zvonitel.ru` — из него строятся реферальные ссылки и ссылки приватных комнат. Если не задан, адрес выводится из фактического хоста запроса (`X-Forwarded-Host`/`Host` + `X-Forwarded-Proto`), но при раздаче на несколько доменов задайте явно |
| `DATA_DIR` | `./data` | Где лежит SQLite. В продакшене вынесите на постоянный диск/volume |
| `ADMIN_NICK` | `admin` | Логин администратора, создаётся при первом старте |
| `ADMIN_PASS` | `zvonitel` | **Смените.** Пароль администратора |
| `ICE_SERVERS` | публичные STUN Google | Массив STUN/TURN в JSON. Принимает и строки, и объекты — сервер сам приведёт к формату `RTCIceServer`. **В продакшене обязателен свой TURN** |
| `TRANSLATE_URL` | *(пусто)* | LibreTranslate-совместимый API для перевода субтитров. Без него перевод честно отдаёт 503, а клиент пишет «перевод не настроен» |
| `TRANSLATE_KEY` | *(пусто)* | Ключ к нему. Живёт на сервере, в браузер не уходит |
| `BOT_DEBUG` | *(пусто)* | Любое значение — выводить консоль демо-ботов в логи |

### Файл `.env` — нет, не поддерживается напрямую

Приложение читает переменные напрямую из окружения и не подхватывает `.env` само. Есть три нормальных способа:

```bash
# 1) прямо в командной строке
PORT=8080 PUBLIC_URL=https://zvonitel.ru npm start

# 2) через export в текущей сессии
export ADMIN_PASS='длинный-случайный-пароль'
export PUBLIC_URL='https://zvonitel.ru'
npm start

# 3) через Docker Compose (он читает .env сам)
cp .env.example .env && $EDITOR .env
docker compose up -d
```

`.env.example` в репозитории — шаблон для Docker-варианта. Сам `.env` в `.gitignore`, в git он не попадёт.

---

## 6. Тесты

```bash
npm test              # unit + integration — быстро, без браузера
npm run test:all      # всё, включая браузерные сценарии
```

Раздельно:

```bash
npm run test:unit         # 12  — алгоритм матчинга
npm run test:integration  # 18  — продуктовые сценарии через Socket.IO
npm run test:quota        # 15  — квоты и адресный звонок
npm run test:e2e          # 21  — два реальных браузера, настоящий WebRTC
npm run test:e2e-bot      # 12  — пользователь + демо-бот
npm run test:v2           # 24  — субтитры и запись по взаимному согласию
npm run test:direct       # 29  — звонок по логину через браузер
npm run test:mobile       # 40  — 4 телефона: раскладка, тач-цели, скролл
npm run test:preview      # 12  — приложение внутри iframe (как в предпросмотре)
```

### Подготовка к браузерным тестам

`npm test` работает сразу. Для остальных нужен Chromium:

```bash
npx playwright install chromium
```

Если Playwright ругается на отсутствующие системные библиотеки:

```bash
sudo npx playwright install-deps chromium
```

или вручную на Debian/Ubuntu:

```bash
sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libxdamage1 libxkbcommon0 libasound2 libatspi2.0-0
```

Тесты поднимают **свой** сервер на отдельных портах (3111, 3112, 3777, 3779, 3888) и свою временную базу в `/tmp`, так что ваш рабочий сервер на 3000 они не трогают и не требуют его запуска. Скриншоты складываются в `shots/`.

---

## 7. Продакшен

### 7.1 Два условия, без которых ничего не работает

1. **HTTPS обязателен.** `getUserMedia` (камера и микрофон) работает только в безопасном контексте — на `https://` или на `localhost`. По http на боевом домене камера просто не включится.
2. **Нужен свой TURN.** STUN хватает примерно для 70–80 % пар. Остальные — за симметричным NAT, корпоративными и части мобильных операторов — соединиться не смогут: видео не пойдёт, и вы получите жалобы «сервис не работает». Публичные TURN использовать нельзя: они перегружены, ненадёжны и небезопасны.

   Поднимите coturn (в `docker-compose.yml` он уже есть) и отдайте его адрес в `ICE_SERVERS`. Открытые порты: `3478` (UDP+TCP) и `49160–49200` (UDP, диапазон ретрансляции).

   Проверить, что TURN живой: <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>

### 7.2 Docker Compose (рекомендуемый путь)

В комплекте: приложение, nginx с HTTPS, coturn.

```bash
cp .env.example .env
$EDITOR .env            # минимум: ADMIN_PASS, TURN_SECRET, ICE_SERVERS

mkdir -p deploy/certs
# положите туда fullchain.pem и privkey.pem для вашего домена
# (например, из Let's Encrypt: certbot certonly --standalone -d zvonitel.ru)

docker compose up -d
docker compose logs -f app
```

Данные живут в Docker-томе `zv-data` — переживают пересборку контейнеров.

`docker-compose.yml` по умолчанию настроен на `zvonitel.ru`. Для другого домена поправьте три места: `PUBLIC_URL` в compose, `server_name` в `deploy/nginx.conf`, `--realm` у coturn.

### 7.3 Без Docker: systemd + nginx

**systemd-юнит** `/etc/systemd/system/zvonitel.service`:

```ini
[Unit]
Description=Zvonitel.ru
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/zvonitel
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=PUBLIC_URL=https://zvonitel.ru
Environment=DATA_DIR=/srv/zvonitel/data
Environment=ADMIN_PASS=ваш-длинный-пароль
EnvironmentFile=-/srv/zvonitel/.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zvonitel
sudo journalctl -u zvonitel -f
```

**nginx** — готовый конфиг лежит в `deploy/nginx.conf`. Два момента, которые там уже учтены и которые чаще всего забывают:

- `location /socket.io/` с `proxy_http_version 1.1` и заголовками `Upgrade`/`Connection` — без этого Socket.IO откатится на long-polling и звонки начнут подтормаживать;
- `proxy_read_timeout 86400s` — долгие WebSocket-сессии, иначе соединение рвётся на 60-й секунде разговора.

`client_max_body_size 2m` — больше и не нужно: загрузок файлов нет, видео на сервер не ходит.

### 7.4 Чек-лист перед запуском в бой

- [ ] `ADMIN_PASS` сменён (не `zvonitel`)
- [ ] `PUBLIC_URL` = реальный https-адрес
- [ ] HTTPS поднят, сертификат не истёк (поставьте автообновление certbot)
- [ ] Свой TURN поднят, порты 3478 и 49160–49200 открыты
- [ ] `ICE_SERVERS` содержит ваш TURN
- [ ] `DATA_DIR` на постоянном диске, а не в временном контейнере
- [ ] Бэкап базы настроен (раздел 8)
- [ ] Seeded-счётчик звонков сброшен или осознанно оставлен
- [ ] Логи куда-то пишутся (`journalctl` или `docker logs`)

---

## 8. Обслуживание

### Бэкап базы

SQLite работает в режиме WAL, поэтому скопировать один файл `.db` недостаточно — рядом лежат `-wal` и `-shm`. Два пути:

```bash
# 1) Консистентный бэкап средствами SQLite (на работающем сервере)
NODE_PATH=$(pwd)/node_modules node -e \
  "require('better-sqlite3')('data/zvonitel.db').backup('/tmp/zv-backup-$(date +%F).db')"

# 2) Или целиком папку — проще и надёжнее
systemctl stop zvonitel && tar czf zv-backup-$(date +%F).tgz data/ && systemctl start zvonitel
```

> `NODE_PATH=$(pwd)/node_modules` нужен, потому что скрипт из `node -e` не всегда находит модули проекта — так мы явно указываем, где их искать. Внутри `npm`-скриптов и обычных файлов этого делать не нужно.

Восстановление: остановить сервер, заменить `data/`, запустить.

### Сброс seeded-счётчика

```bash
NODE_PATH=$(pwd)/node_modules node -e "const db=require('better-sqlite3')('data/zvonitel.db');
  db.prepare(\"UPDATE stats SET value='0' WHERE key='totalCalls'\").run();
  console.log('сброшено')"
```

### Обновление

```bash
git pull
npm ci --omit=dev          # или npm install, если нужны тесты
sudo systemctl restart zvonitel
```

Схема базы мигрируется сама при старте — ничего запускать не нужно. Только сделайте бэкап `data/` перед обновлением.

### Логи

Сервер пишет в stdout: стартовую шапку, ошибки обработчиков сокета (префикс `[socket:<событие>]`), предупреждения демо-ботов (`[bot]`). Отдельного лог-файла нет — этим занимается systemd или Docker.

### Метрики

```bash
curl http://localhost:3000/api/metrics        # публичные: онлайн, в очереди, всего звонков
curl -H "Authorization: Bearer <токен админа>" http://localhost:3000/api/admin/metrics
```

Полные метрики (DAU, skip-rate, среднее ожидание, жалобы на 1000 звонков, виральный коэффициент) — в админке `/admin`.

---

## 9. Частые проблемы

**`Error: listen EADDRINUSE: address already in use :::3000`**
Порт занят — скорее всего, старый процесс. Найти и остановить:
```bash
lsof -ti:3000 | xargs kill      # или
pkill -f "node server/index.js"
```
Либо запустите на другом порту: `PORT=8080 npm start`.

**`Cannot find module 'express'` / `'better-sqlite3'`**
Зависимости не установлены или папка `node_modules` пропала (например, её исключили из бэкапа — она не должна попадать в git). Лечится `npm install`.

**Ошибка сборки `better-sqlite3` (`node-gyp`, `prebuild-install`)**
Нет инструментов сборки или нет готового бинарника под вашу платформу:
```bash
sudo apt-get install -y python3 make g++       # Debian/Ubuntu
xcode-select --install                          # macOS
npm rebuild better-sqlite3
```

**Камера не включается, «Камера недоступна — включён демо-поток»**
Три причины по частоте:
1. Сайт открыт по `http://` на внешнем домене — нужен HTTPS (или `localhost`);
2. Доступ к камере не выдан в браузере или запрещён в настройках сайта;
3. Камера занята другим приложением (Zoom, Meet).

Приложение во всех случаях продолжает работать на демо-потоке — это не авария.

**Собеседник не соединяется: видео не идёт, хотя «матч» был**
Классический симптом отсутствия TURN. Проверьте `ICE_SERVERS` и доступность TURN с клиента. На localhost всё работает и без него, поэтому локально проблему не увидеть.

**Реферальные ссылки и ссылки комнат ведут на `localhost:3000`**
Не задан `PUBLIC_URL`, либо nginx не передаёт `X-Forwarded-Host` / `X-Forwarded-Proto`. Задайте `PUBLIC_URL` явно — надёжнее всего.

**Демо-боты не запускаются (`playwright не установлен`)**
Playwright — dev-зависимость. Если ставили с `--omit=dev`, ботов не будет (сервис работает полностью, эта функция просто отключается). Для ботов и тестов: `npm install && npx playwright install chromium`.

**Тесты падают на `browserType.launch: Executable doesn't exist`**
Не скачан Chromium: `npx playwright install chromium` (и системные библиотеки — см. раздел 6).

**«Перевод не настроен на сервере. Задайте TRANSLATE_URL»**
Это не ошибка, а честное сообщение: перевод субтитров требует внешнего LibreTranslate-совместимого API. Без него субтитры работают, а перевода нет. Задайте `TRANSLATE_URL` (и `TRANSLATE_KEY`, если нужен).

**Счётчик «Уже 12 847 звонков» не соответствует реальности**
Так и задумано: это стартовое значение для соцдоказательства. Как сбросить — в разделе 8.

---

## 10. Структура проекта

```
zvonitel/
├── server/
│   ├── index.js           REST API, раздача статики, безопасность
│   ├── socket-server.js   сигналинг, очередь, матчинг, модерация, квоты, адресные звонки
│   ├── matching.js        алгоритм подбора пар
│   ├── db.js              SQLite: схема, миграции, запросы
│   ├── config.js          продуктовые константы (веса, тарифы, квоты, словари)
│   ├── gamify.js          уровни, достижения, ежедневные задания, темы вечера
│   ├── automod.js         автомодерация чата и кадра, страйки
│   ├── rooms.js           приватные комнаты и реестр активных звонков
│   └── bots.js            пул демо-ботов
├── public/
│   ├── index.html
│   ├── bot.html           страница демо-бота
│   ├── css/app.css
│   └── js/
│       ├── util.js        DOM-хелперы, тосты, звуки, аватары
│       ├── media.js      getUserMedia, устройства, демо-поток
│       ├── webrtc.js      PeerConnection, сигналинг
│       ├── v2.js          субтитры и запись
│       ├── direct.js      звонок по логину и квоты
│       └── app.js         экраны, навигация, состояние
├── test/                  тесты (см. раздел 6)
├── deploy/nginx.conf      готовый конфиг nginx
├── Dockerfile
├── docker-compose.yml     приложение + nginx + coturn
└── data/                  SQLite (создаётся сама, в .gitignore)
```
