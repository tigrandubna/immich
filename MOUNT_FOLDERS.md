# Подключение локальных папок к Immich (External Library)

В этом форке dev-окружение Docker подготовлено к тому, чтобы подключать произвольные каталоги с хоста как **External Library** в Immich. Сами папки в репозитории не зашиты — вы дописываете строки маунтов под себя.

## Шаг 1. Прописать маунт в `docker/docker-compose.dev.yml`

Откройте [`docker/docker-compose.dev.yml`](docker/docker-compose.dev.yml) и в сервисе `immich-server` найдите блок:

```yaml
    volumes:
      - ${UPLOAD_LOCATION}/photos:/data
      - /etc/localtime:/etc/localtime:ro
      - pnpm_store_server:/buildcache/pnpm-store
      - ../plugins:/build/corePlugin
      # External photo libraries — uncomment and adjust paths to mount your own folders.
      # Mount as read-write so the server can write face regions to XMP sidecars.
      # See MOUNT_FOLDERS.md for details.
      # - /absolute/path/to/your/photos:/external/MyPhotos
      # - /another/absolute/path:/external/AnotherLibrary
```

Раскомментируйте/добавьте строки под себя:

```yaml
      - /absolute/path/to/your/photos:/external/MyPhotos
```

Правила:
- **Левая часть** (до `:`) — абсолютный путь к папке на хосте (macOS / Linux / Windows-WSL).
- **Правая часть** — путь внутри контейнера. Рекомендуется держать всё в `/external/`, чтобы внешние библиотеки лежали в одном месте.
- Без суффиксов после второго `:` — bind по умолчанию `rw`, и это нужно для записи регионов лиц в XMP. Если хотите read-only, добавьте `:ro` (тогда отключите тумблер «Write recognized faces to XMP» в админке).
- Папка на хосте должна существовать **до** запуска контейнера.

## Шаг 2. Перезапустить `immich-server`

После правки compose-файла:

```bash
docker compose -f ./docker/docker-compose.dev.yml up -d --force-recreate immich-server
```

Только этот сервис перечитает volume-mounts; БД, ML, веб и redis не нужно трогать.

Проверьте, что папка видна внутри контейнера:

```bash
docker exec immich_server ls /external/MyPhotos
```

## Шаг 3. Подключить папку как External Library в UI

1. Откройте http://localhost:3000 и войдите как admin.
2. **Administration → External Libraries → Create Library**.
3. Выберите пользователя-владельца библиотеки.
4. **Import paths** → Add path → введите путь, как он виден изнутри контейнера (например, `/external/MyPhotos`) → Save.
5. (Опционально) **Exclusion patterns** — например, `**/.DS_Store`, `**/xmp/**` если хотите игнорировать XMP-файлы как ассеты.
6. Запустите **Scan** для библиотеки.

После сканирования фотографии появятся в основной таймлайне.

## Права доступа

- В dev-режиме контейнеры запускаются под `root`, поэтому права на хосте обычно не мешают.
- Запись в смонтированную папку нужна для функции «Write recognized faces to XMP». Контейнер пишет от имени root: на macOS это создаст root-owned файлы, на Linux может потребоваться согласовать UID/GID через ключ `user:` в compose.

## Связанные настройки этого форка

В **Administration → System Settings → Metadata** доступны три тумблера, относящихся к XMP:

| Настройка | Что делает |
|---|---|
| Enable face import | Импортирует регионы лиц из EXIF/XMP при метаданных-скане. |
| Read XMP from `xmp/` subfolder | При поиске XMP рядом с фото также смотрит подпапку `xmp/`. Приоритет — у файла в той же папке, что и фото. |
| Write recognized faces to XMP | После распознавания / ручного переназначения / переименования персоны Immich пишет MWG-Region теги в XMP. Если sidecar отсутствует — создаёт `<dir>/xmp/<name>.xmp`. |

Чтобы Immich мог писать в XMP, монтируйте библиотеку без `:ro`.

## Структура библиотеки фотографий с XMP-подпапкой

Поддерживаемые расположения XMP:

```
MyPhotos/
├── 2024/
│   ├── IMG_0001.jpg
│   ├── IMG_0001.jpg.xmp        ← приоритет 1 (full-name рядом с фото)
│   ├── IMG_0001.xmp            ← приоритет 2 (basename рядом с фото)
│   └── xmp/
│       ├── IMG_0001.jpg.xmp    ← приоритет 3 (subfolder full-name)
│       └── IMG_0001.xmp        ← приоритет 4 (subfolder basename)
```

Immich пробует кандидатов сверху вниз и берёт первый существующий. Подпапка `xmp/` проверяется только если включена опция «Read XMP from xmp/ subfolder».

## Снять подключение папки

1. В UI: **External Libraries → … → Remove library** (ассеты будут помечены как отсутствующие).
2. Удалить (или закомментировать обратно) строку из `docker/docker-compose.dev.yml`.
3. Перезапустить сервис: `docker compose -f ./docker/docker-compose.dev.yml up -d --force-recreate immich-server`.

## Команды для повседневного управления стеком

Команды выполняются из корня репозитория.

```bash
# Старт всего стека (БД с русской локалью, server, web, ML, redis)
docker compose -f ./docker/docker-compose.dev.yml up -d

# Остановить
docker compose -f ./docker/docker-compose.dev.yml down

# Логи сервера
docker logs -f immich_server

# Перезапустить только сервер (после изменения compose-файла)
docker compose -f ./docker/docker-compose.dev.yml up -d --force-recreate immich-server

# Полностью пересобрать образы
docker compose -f ./docker/docker-compose.dev.yml build
```

## Куда какие папки смотрят

| Путь хоста | Путь в контейнере | Назначение |
|---|---|---|
| `./library/photos` | `/data` | Загрузки через UI/мобильное приложение (`UPLOAD_LOCATION` из `.env`) |
| `./library/postgres` | `/var/lib/postgresql/data` | Данные PostgreSQL (с локалью `ru_RU.UTF-8`) |
| (ваш путь) | `/external/<имя>` | Внешние библиотеки фотографий — добавляются вручную в `docker-compose.dev.yml` |
