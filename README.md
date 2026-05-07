# Изменения в этом форке

Этот форк отличается от upstream `immich-app/immich` следующими доработками. Все они находятся в ветке [`feature/local-customizations`](../../tree/feature/local-customizations).

1. **Кириллическая база данных.** Кастомный образ Postgres ([`docker/Dockerfile.postgres-ru`](docker/Dockerfile.postgres-ru)) с локалью `ru_RU.UTF-8`. `initdb` инициализирует кластер с `--lc-collate=ru_RU.UTF-8 --lc-ctype=ru_RU.UTF-8`, поэтому `ORDER BY` по тексту автоматически использует русскую раскладку без правки запросов.

2. **Чтение XMP из подпапки `xmp/`.** Опционально (тумблер «Read XMP from xmp/ subfolder» в Administration → System Settings → Metadata) Immich ищет XMP-файл не только рядом с фото, но и в подпапке `xmp/`. Приоритет: `<dir>/<name>.<ext>.xmp` → `<dir>/<name>.xmp` → `<dir>/xmp/<name>.<ext>.xmp` → `<dir>/xmp/<name>.xmp`. Реализовано в [`server/src/services/metadata.service.ts`](server/src/services/metadata.service.ts).

3. **Запись распознанных лиц в XMP.** Опциональный тумблер «Write recognized faces to XMP» включает новый job `SidecarWriteFaces`. Триггерится после ML-распознавания, ручного переназначения лица и переименования персоны. Пишет MWG-Region теги через exiftool в существующий XMP по той же логике приоритета, что и при чтении; если sidecar отсутствует — создаёт `<dir>/xmp/<name>.xmp`.

4. **Секретная ссылка на персону.** Новый `SharedLinkType.Person` с миграцией, добавляющей `shared_link.personId`. В контекстном меню страницы персоны появилась команда «Создать ссылку для шаринга»: создаёт shareable URL вида `/share/<key>`, по которому видны все фотографии с этим человеком (включая будущие — резолв ассетов динамический). Отзыв через стандартную страницу управления Shared Links.

5. **Тумблер «миниатюры лиц» в просмотре персоны.** Кнопка в шапке страницы персоны переключает таймлайн на грид кропов лиц — удобно для быстрого поиска ошибочных распознаваний. Бэкенд: `GET /api/faces/:id/thumbnail` возвращает JPEG, обрезанный по bounding box (sharp, padding 1.4×); `GET /api/people/:id/faces` отдаёт список faceId+assetId.

6. **Сортировка папок по русскому алфавиту, папки выше файлов.** В дереве папок `TreeNode.children` сортируется через `Intl.Collator('ru')`. Папки и сейчас рендерятся выше галереи, ассеты внутри папки уже сортировались по имени (теперь Russian-aware за счёт локали БД).

Внешние папки с фотографиями подключаются как bind-volumes сервиса `immich-server` в [`docker/docker-compose.dev.yml`](docker/docker-compose.dev.yml) — в файле уже есть закомментированный шаблон. Подробная инструкция по подключению папок и созданию External Library в UI: **[MOUNT_FOLDERS.md](MOUNT_FOLDERS.md)**.

Запуск:

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
