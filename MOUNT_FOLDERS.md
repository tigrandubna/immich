# Подключение локальных папок к Immich (External Library)

Этот форк настроен на dev-окружение Docker, в котором каталоги хоста монтируются в контейнер `immich_server` и затем подключаются как **External Library** через UI Immich.

## Текущие смонтированные папки

В файле [`docker/docker-compose.dev.yml`](docker/docker-compose.dev.yml), в сервисе `immich-server`, в секции `volumes`:

```yaml
volumes:
  - ${UPLOAD_LOCATION}/photos:/data
  - /etc/localtime:/etc/localtime:ro
  - pnpm_store_server:/buildcache/pnpm-store
  - ../plugins:/build/corePlugin
  - /Users/tigran/Desktop/PhotoBank:/external/PhotoBank   # ← примонтированная папка
```

В контейнере папка доступна по пути `/external/PhotoBank` с правами на чтение и запись (Docker монтирует bind-volumes как rw по умолчанию).

## Как добавить новую папку

### Шаг 1. Изменить `docker/docker-compose.dev.yml`

Добавьте новую строку в секцию `volumes` сервиса `immich-server`:

```yaml
    volumes:
      - ${UPLOAD_LOCATION}/photos:/data
      - /etc/localtime:/etc/localtime:ro
      - pnpm_store_server:/buildcache/pnpm-store
      - ../plugins:/build/corePlugin
      - /Users/tigran/Desktop/PhotoBank:/external/PhotoBank
      - /путь/на/хосте:/external/ИмяПапки           # ← новая папка
```

Правила:
- Левая часть (до `:`) — абсолютный путь на macOS-хосте.
- Правая часть — путь внутри контейнера. Рекомендуется использовать корень `/external/`, чтобы все внешние библиотеки лежали в одном месте.
- Никаких суффиксов после второго `:` — bind по умолчанию `rw`. Если нужен read-only, добавьте `:ro`.
- Папка на хосте должна существовать **до** запуска контейнера.

### Шаг 2. Перезапустить immich-server

```bash
cd /Users/tigran/Desktop/claude/immich-t
docker compose -f ./docker/docker-compose.dev.yml up -d --force-recreate immich-server
```

Только сервис `immich-server` перечитает volume-mounts; БД, ML, веб и redis не нужно трогать.

Проверить, что папка видна внутри контейнера:

```bash
docker exec immich_server ls /external/ИмяПапки
```

### Шаг 3. Подключить как External Library в UI

1. Откройте http://localhost:3000 → войти под admin.
2. **Administration → External Libraries → Create Library**.
3. Выбрать пользователя-владельца библиотеки.
4. **Import paths** → Add path → `/external/ИмяПапки` → Save.
5. (Опционально) **Exclusion patterns** — например, `**/.DS_Store`, `**/xmp/**` если хотите, чтобы XMP-файлы игнорировались как ассеты.
6. Запустить **Scan** для библиотеки.

После сканирования фотографии станут доступны в основной таймлайне.

## Права доступа

- В dev-режиме контейнеры запускаются с `root`, поэтому права на хосте обычно не мешают.
- Запись в смонтированную папку возможна, например, при сохранении распознанных лиц в XMP-файлы (см. ниже). Контейнер пишет от имени root — на macOS это вылезает в виде root-owned файлов в исходной папке. На Linux хосте может потребоваться согласование UID/GID через `user:` в compose.

## Связанные настройки этого форка

В **Administration → System Settings → Metadata** доступны три тумблера, относящихся к XMP:

| Настройка | Что делает |
|---|---|
| Enable face import | Импортирует регионы лиц из EXIF/XMP при метаданных-скане. |
| Read XMP from `xmp/` subfolder | При поиске XMP-файла рядом с фото также проверяет подпапку `xmp/`. Приоритет — у файла в той же папке, что и фото. |
| Write recognized faces to XMP | После распознавания / ручного переназначения / переименования персоны Immich пишет MWG-Region теги в XMP. Если XMP отсутствует, создаётся новый файл в подпапке `xmp/` рядом с фото. |

Чтобы Immich мог писать в XMP, монтируйте библиотеку без `:ro`.

## Структура библиотеки фотографий с XMP-подпапкой

Поддерживаемые варианты расположения XMP:

```
PhotoBank/
├── 2024/
│   ├── IMG_0001.jpg
│   ├── IMG_0001.jpg.xmp        ← приоритет 1 (full-name)
│   ├── IMG_0001.xmp            ← приоритет 2 (basename)
│   └── xmp/
│       ├── IMG_0001.jpg.xmp    ← приоритет 3 (subfolder full-name)
│       └── IMG_0001.xmp        ← приоритет 4 (subfolder basename)
```

Immich пробует кандидатов сверху вниз и берёт первый существующий. Подпапка `xmp/` проверяется только если включена опция «Read XMP from xmp/ subfolder».

## Снять подключение папки

1. В UI: **External Libraries → … → Remove library** (ассеты будут помечены как отсутствующие).
2. Удалить строку из `docker/docker-compose.dev.yml`.
3. Перезапустить сервис: `docker compose -f ./docker/docker-compose.dev.yml up -d --force-recreate immich-server`.

## Команды для повседневного управления стеком

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
| `./library/photos` | `/data` | Загрузки через UI/мобильное приложение (UPLOAD_LOCATION) |
| `./library/postgres` | `/var/lib/postgresql/data` | Данные PostgreSQL (с локалью ru_RU.UTF-8) |
| `/Users/tigran/Desktop/PhotoBank` | `/external/PhotoBank` | Внешняя библиотека фотографий |
| (новая папка) | `/external/<имя>` | Дополнительные внешние библиотеки |
