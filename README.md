# Изменения в этом форке

Этот форк отличается от upstream `immich-app/immich` следующими доработками. Все они находятся в ветке [`feature/local-customizations`](../../tree/feature/local-customizations).

## База данных и UI

1. **Кириллическая база данных.** Кастомный образ Postgres ([`docker/Dockerfile.postgres-ru`](docker/Dockerfile.postgres-ru)) с локалью `ru_RU.UTF-8`. `initdb` инициализирует кластер с `--lc-collate=ru_RU.UTF-8 --lc-ctype=ru_RU.UTF-8`, поэтому `ORDER BY` по тексту автоматически использует русскую раскладку без правки запросов.

2. **Сортировка папок по русскому алфавиту, папки выше файлов.** В дереве папок `TreeNode.children` сортируется через `Intl.Collator('ru')`. Папки рендерятся выше галереи, ассеты внутри папки сортируются по имени (Russian-aware за счёт локали БД).

## XMP-сайдкары

3. **Чтение XMP из подпапки `.xmp/`.** Тумблер «Read XMP from .xmp/ subfolder» в Administration → System Settings → Metadata. Приоритет поиска: `<dir>/<name>.<ext>.xmp` → `<dir>/<name>.xmp` → `<dir>/.xmp/<name>.<ext>.xmp` → `<dir>/.xmp/<name>.xmp`.

4. **Запись распознанных лиц в XMP.** Тумблер «Write recognized faces to XMP» включает job `SidecarWriteFaces`. Триггерится после ML-распознавания, ручного переназначения лица, переименования персоны и дедупликации. Пишет MWG-Region теги через exiftool в существующий XMP (та же логика приоритета, что при чтении); если sidecar отсутствует — создаёт `<dir>/.xmp/<name>.xmp`.

5. **Ручная перезапись XMP с лицами для всех фотографий.** Manual job `RewriteFaceSidecars` (Administration → Job Status → **+ Create job** → «Rewrite face XMP sidecars»). Стримит все ассеты, у которых есть хотя бы одно лицо с привязанным именем (`asset_face JOIN person WHERE name != ''`), и для каждого ставит `SidecarWriteFaces`. Полезно после массового переназначения или включения тумблера записи задним числом.

## Лица и персоны

6. **Грид «только лица» на странице персоны.** Кнопка-переключатель в шапке (`mdiFaceMan` ↔ `mdiImageMultiple`) переключает таймлайн на грид кропов лиц — удобно для быстрого поиска ошибочных распознаваний. Клик по миниатюре открывает соответствующий ассет.

7. **Кэшируемые миниатюры лиц.** Колонка `asset_face.thumbnailPath` + новая очередь `QueueName.FaceThumbnail` с двумя джобами:
   - `FaceGenerateThumbnail` — sharp-кроп `<dir>/.../face_<faceId>.jpeg` с padding 1.4×, путь сохраняется в БД.
   - `FaceThumbnailQueueAll` — батч на все лица, опция «Missing» / «All» в Job Status.
   - Авто-триггер после ML-детекта и XMP-импорта. Endpoint `GET /api/faces/:id/thumbnail` сначала отдаёт готовый файл через sendFile, иначе генерирует on-the-fly и кэширует. Эндпоинт `GET /api/people/:id/faces` отдаёт список `{faceId, assetId}` для построения сетки.

8. **Дедупликация перекрывающихся лиц.** Очень часто одно и то же лицо попадает в БД дважды: один раз через ML, второй — через импорт XMP-региона. Их bbox практически совпадают, но хранятся в разных системах координат (preview vs original). Новый job `AssetFaceDedup` нормализует bbox в `[0,1]` через `imageWidth/imageHeight` каждого лица, кластеризует по IoU ≥ 0.7 и для каждого кластера применяет правила:
   - все без имени → оставить первое, остальные удалить;
   - одно с именем (или все с одним и тем же `personId`) → оставить именованное;
   - конфликт имён → обнулить `personId` у оставшегося, удалить остальные, и через `searchRepository.searchFaces` с `hasPerson=true` подобрать ближайшего человека по embedding.
   
   Триггерится автоматически после ML-детекта и XMP-импорта; вручную — `Administration → Job Status → + Create job → «Deduplicate overlapping faces» / «Объединить дубликаты лиц»`. Если в результате что-то изменилось и включена запись XMP — следом ставится `SidecarWriteFaces`.

9. **Настройки concurrency для новых очередей.** В `Administration → System Settings → Job Settings` появилось поле для `Face thumbnail` (по умолчанию 3). Дедупликация ходит через `BackgroundTask` queue.

## Шеринг

10. **Секретная ссылка на персону.** Новый `SharedLinkType.Person` + миграция, добавляющая `shared_link.personId`. В контекстном меню страницы персоны команда «Создать ссылку для шаринга»: генерирует URL `/share/<key>`, по которому без авторизации видны все фотографии с этим человеком (включая добавленные позже — резолв ассетов динамический по `asset_face.personId`).

11. **Список шеринговых ссылок с именами.** На странице `/shared-links` для Person-ссылок отображается имя человека (DTO дополнен полем `personName`). Каждая карточка имеет стандартные кнопки **Edit / Copy / Delete** — Delete отзывает ссылку.

## Стабильность очередей

12. **Дедуп лиц синхронно в `handleDetectFaces`.** Раньше дедуп ставился отдельным `AssetFaceDedup` job в `BackgroundTask` и работал параллельно с `FacialRecognition`. На каждой загруженной фотографии возникала race: ML-распознавание подбирало `faceId`, который дедуп удалял в ту же секунду, и в логах сыпалось `Face X not found` + `PostgresError: person_faceAssetId_fkey`. Теперь в `handleDetectFaces` после `refreshFaces` дедуп вызывается синхронно и в `FacialRecognition` / `FaceGenerateThumbnail` уходят только выжившие id. Ручной job `AssetFaceDedup` остался для batch-прогона по существующим ассетам.

13. **PSD больше не обрабатываются.** Sharp/libvips зависает на больших `.psd` (например, 647 MB), забивает `UV_THREADPOOL`, OOM-kill убивает дочерний процесс — но основной Node не получает SIGCHLD и держит worker-слот вечно. Десять параллельных слотов `thumbnailGeneration` залипают целиком, очереди встают. `.psd` убран из `mimeTypes.raw` (новые импорты блокируются library scanner и upload endpoint), а `handleGenerateThumbnails` дополнительно делает early-skip для `AssetType.Image` ассетов с расширением вне `mimeTypes.image` — это покрывает уже импортированные PSD без необходимости их удалять. Если в будущем подобное проявится на другом формате — добавлять расширение туда же.

14. **Auto-restart упавшего worker'а в `Workers` manager.** Раньше при OOM в worker_thread (microservices) `onExit` валил весь main process через `process.exit`. В production это нормально — Docker рестартит контейнер. В dev `nest --watch` не рестартит crashed user code (только при изменении файлов), и api-fork оставался жить как сирота, microservices больше не было, BullMQ active-locks не освобождались (некому stalled-check делать) — очереди стояли до `docker restart`. Теперь `onExit` авто-рестартит crashed worker, ограничивая до 3 крэшей за 60 секунд (после — fallback на старое поведение, чтобы не зацикливаться на действительно фатальном баге).

15. **Sharp `concurrency(1)` + полное отключение cache.** `concurrency(0)` (дефолт upstream) означает «использовать все CPU cores **на каждую** sharp-instance». При 10 параллельных thumbnail jobs + faceThumbnail + smartSearch получался thread storm, native память libvips вырастала до OOM-killer'а Docker VM. С `concurrency(1)` libvips тратит один поток на pipeline → общее число потоков растёт линейно с queue-concurrency, память bounded. `cache({ memory: 0, items: 0, files: 0 })` дополнительно убирает leaked Buffer'ы между ассетами. С этими двумя настройками `thumbnailGeneration concurrency = 10` стабильно держится без OOM.

## Запуск

Внешние папки с фотографиями подключаются как bind-volumes сервиса `immich-server` в [`docker/docker-compose.dev.yml`](docker/docker-compose.dev.yml) — в файле уже есть закомментированный шаблон. Подробная инструкция по подключению папок и созданию External Library в UI: **[MOUNT_FOLDERS.md](MOUNT_FOLDERS.md)**.

```bash
docker compose -f ./docker/docker-compose.dev.yml up -d
# UI: http://localhost:3000, API: http://localhost:2283
```

---

<p align="center"> 
  <br/>
  <a href="https://opensource.org/license/agpl-v3"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg?color=3F51B5&style=for-the-badge&label=License&logoColor=000000&labelColor=ececec" alt="License: AGPLv3"></a>
  <a href="https://discord.immich.app">
    <img src="https://img.shields.io/discord/979116623879368755.svg?label=Discord&logo=Discord&style=for-the-badge&logoColor=000000&labelColor=ececec" alt="Discord"/>
  </a>
  <br/>
  <br/>
</p>

<p align="center">
<img src="design/immich-logo-stacked-light.svg" width="300" title="Login With Custom URL">
</p>
<h3 align="center">High performance self-hosted photo and video management solution</h3>
<br/>
<a href="https://immich.app">
<img src="design/immich-screenshots.png" title="Main Screenshot">
</a>
<br/>

<p align="center">
  <a href="readme_i18n/README_ca_ES.md">Català</a>
  <a href="readme_i18n/README_es_ES.md">Español</a>
  <a href="readme_i18n/README_fr_FR.md">Français</a>
  <a href="readme_i18n/README_it_IT.md">Italiano</a>
  <a href="readme_i18n/README_ja_JP.md">日本語</a>
  <a href="readme_i18n/README_ko_KR.md">한국어</a>
  <a href="readme_i18n/README_de_DE.md">Deutsch</a>
  <a href="readme_i18n/README_nl_NL.md">Nederlands</a>
  <a href="readme_i18n/README_tr_TR.md">Türkçe</a>
  <a href="readme_i18n/README_zh_CN.md">简体中文</a>
  <a href="readme_i18n/README_zh_TW.md">正體中文</a>
  <a href="readme_i18n/README_uk_UA.md">Українська</a>
  <a href="readme_i18n/README_ru_RU.md">Русский</a>
  <a href="readme_i18n/README_pt_BR.md">Português Brasileiro</a>
  <a href="readme_i18n/README_sv_SE.md">Svenska</a>
  <a href="readme_i18n/README_ar_JO.md">العربية</a>
  <a href="readme_i18n/README_vi_VN.md">Tiếng Việt</a>
  <a href="readme_i18n/README_th_TH.md">ภาษาไทย</a>
</p>


> [!WARNING]
> ⚠️ Always follow [3-2-1](https://www.backblaze.com/blog/the-3-2-1-backup-strategy/) backup plan for your precious photos and videos!
> 
 

> [!NOTE]
> You can find the main documentation, including installation guides, at https://immich.app/.

## Links

- [Documentation](https://docs.immich.app/)
- [About](https://docs.immich.app/overview/introduction)
- [Installation](https://docs.immich.app/install/requirements)
- [Roadmap](https://immich.app/roadmap)
- [Demo](#demo)
- [Features](#features)
- [Translations](https://docs.immich.app/developer/translations)
- [Contributing](https://docs.immich.app/overview/support-the-project)

## Demo

Access the demo [here](https://demo.immich.app). For the mobile app, you can use `https://demo.immich.app` for the `Server Endpoint URL`.

### Login credentials

| Email           | Password |
| --------------- | -------- |
| demo@immich.app | demo     |

## Features

| Features                                     | Mobile | Web |
| :------------------------------------------- | ------ | --- |
| Upload and view videos and photos            | Yes    | Yes |
| Auto backup when the app is opened           | Yes    | N/A |
| Prevent duplication of assets                | Yes    | Yes |
| Selective album(s) for backup                | Yes    | N/A |
| Download photos and videos to local device   | Yes    | Yes |
| Multi-user support                           | Yes    | Yes |
| Album and Shared albums                      | Yes    | Yes |
| Scrubbable/draggable scrollbar               | Yes    | Yes |
| Support raw formats                          | Yes    | Yes |
| Metadata view (EXIF, map)                    | Yes    | Yes |
| Search by metadata, objects, faces, and CLIP | Yes    | Yes |
| Administrative functions (user management)   | No     | Yes |
| Background backup                            | Yes    | N/A |
| Virtual scroll                               | Yes    | Yes |
| OAuth support                                | Yes    | Yes |
| API Keys                                     | N/A    | Yes |
| LivePhoto/MotionPhoto backup and playback    | Yes    | Yes |
| Support 360 degree image display             | No     | Yes |
| User-defined storage structure               | Yes    | Yes |
| Public Sharing                               | Yes    | Yes |
| Archive and Favorites                        | Yes    | Yes |
| Global Map                                   | Yes    | Yes |
| Partner Sharing                              | Yes    | Yes |
| Facial recognition and clustering            | Yes    | Yes |
| Memories (x years ago)                       | Yes    | Yes |
| Offline support                              | Yes    | No  |
| Read-only gallery                            | Yes    | Yes |
| Stacked Photos                               | Yes    | Yes |
| Tags                                         | No     | Yes |
| Folder View                                  | Yes    | Yes |

## Translations

Read more about translations [here](https://docs.immich.app/developer/translations).

<a href="https://hosted.weblate.org/engage/immich/">
<img src="https://hosted.weblate.org/widget/immich/immich/multi-auto.svg" alt="Translation status" />
</a>

## Repository activity

![Activities](https://repobeats.axiom.co/api/embed/9e86d9dc3ddd137161f2f6d2e758d7863b1789cb.svg "Repobeats analytics image")

## Star history

<a href="https://star-history.com/#immich-app/immich&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=immich-app/immich&type=date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=immich-app/immich&type=date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=immich-app/immich&type=date" width="100%" />
 </picture>
</a>

## Contributors

<a href="https://github.com/immich-app/immich/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=immich-app/immich" width="100%"/>
</a>
