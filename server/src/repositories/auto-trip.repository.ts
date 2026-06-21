import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AlbumUserRole, AssetFileType, AssetType, AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';

export interface GpsAssetRow {
  id: string;
  ownerId: string;
  fileCreatedAt: Date;
  latitude: number;
  longitude: number;
  city: string | null;
  country: string | null;
}

@Injectable()
export class AutoTripRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Distinct user ids that own at least one timeline image with GPS — input for
   * the prototype trip-detection job, so we only iterate users where there's
   * actually something to cluster.
   */
  async getDistinctOwnersWithGps(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select('asset.ownerId')
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.deletedAt', 'is', null)
      .where('asset.type', '=', AssetType.Image)
      .where('asset_exif.latitude', 'is not', null)
      .where('asset_exif.longitude', 'is not', null)
      .distinct()
      .execute();
    return rows.map((r) => r.ownerId);
  }

  /**
   * GPS-tagged timeline images for a user, newest first. We need lat/lon to
   * cluster, and city/country to title the resulting album.
   */
  async getGpsAssetsForUser(userId: string): Promise<GpsAssetRow[]> {
    const rows = await this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.fileCreatedAt',
        'asset_exif.latitude',
        'asset_exif.longitude',
        'asset_exif.city',
        'asset_exif.country',
      ])
      .where('asset.ownerId', '=', userId)
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.deletedAt', 'is', null)
      .where('asset.type', '=', AssetType.Image)
      .where('asset_exif.latitude', 'is not', null)
      .where('asset_exif.longitude', 'is not', null)
      .orderBy('asset.fileCreatedAt', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      ownerId: r.ownerId,
      fileCreatedAt: r.fileCreatedAt,
      latitude: r.latitude!,
      longitude: r.longitude!,
      city: r.city,
      country: r.country,
    }));
  }

  /**
   * Timeline assets (image + video, with or without GPS) for a user inside
   * `[from, to]`, with the metadata needed by post-fetch filtering: timestamp,
   * presence of GPS, and camera model for burst-grouping.
   *
   * Filters out "technical" assets — anything that has no camera metadata at
   * all (no model AND no aperture AND no focal length). On iPhone libraries
   * this catches screenshots, downloaded images, scanned documents, and other
   * non-photographic content that shouldn't end up in a trip album.
   *
   * Returned in chronological ascending order so the caller can do
   * adjacent-pair operations (burst dedup, nearest-GPS bridging) in one pass.
   */
  async getAssetsInRangeForUser(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{ id: string; fileCreatedAt: Date; hasGps: boolean; model: string | null }>> {
    const rows = await this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.fileCreatedAt',
        'asset_exif.latitude',
        'asset_exif.model',
      ])
      .where('asset.ownerId', '=', userId)
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.deletedAt', 'is', null)
      .where('asset.fileCreatedAt', '>=', from)
      .where('asset.fileCreatedAt', '<=', to)
      // Skip technical / screenshot-like assets: anything with no real camera
      // metadata at all. A genuine photo always has at least ONE of {model,
      // fNumber, focalLength}; screenshots and scanned docs have none.
      .where((eb) =>
        eb.or([
          eb('asset_exif.model', 'is not', null).and(eb.fn('trim', ['asset_exif.model']), '!=', ''),
          eb('asset_exif.fNumber', 'is not', null),
          eb('asset_exif.focalLength', 'is not', null),
        ]),
      )
      .orderBy('asset.fileCreatedAt', 'asc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      fileCreatedAt: r.fileCreatedAt,
      hasGps: r.latitude !== null,
      model: r.model,
    }));
  }

  /**
   * Best blur score across all faces on the given assets (one row per assetId
   * that has at least one face with a non-null blurScore). Higher = sharper.
   * Used by the burst-dedup step to pick the keeper from a group of
   * near-identical shots.
   */
  async getMaxBlurScores(assetIds: string[]): Promise<Map<string, number>> {
    if (assetIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('asset_face')
      .select((eb) => ['asset_face.assetId', eb.fn.max('asset_face.blurScore').as('blur')])
      .where('asset_face.assetId', 'in', assetIds)
      .where('asset_face.blurScore', 'is not', null)
      .groupBy('asset_face.assetId')
      .execute();
    const out = new Map<string, number>();
    for (const r of rows) {
      if (r.blur !== null) {
        out.set(r.assetId, Number(r.blur));
      }
    }
    return out;
  }

  /**
   * Number of faces with a named, non-deleted person on each given asset.
   * Used by the trip-album cover selector — photos with more recognised
   * people (named, not just unidentified faces) usually make better
   * thumbnails than scenery shots from the middle of the cluster.
   */
  async getNamedFaceCounts(assetIds: string[]): Promise<Map<string, number>> {
    if (assetIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('asset_face')
      .innerJoin('person', 'person.id', 'asset_face.personId')
      .select((eb) => ['asset_face.assetId', eb.fn.countAll<number>().as('named')])
      .where('asset_face.assetId', 'in', assetIds)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .where('person.name', '!=', '')
      .groupBy('asset_face.assetId')
      .execute();
    const out = new Map<string, number>();
    for (const r of rows) {
      out.set(r.assetId, Number(r.named));
    }
    return out;
  }

  /**
   * Preview-file path per assetId (only assets that have one). The burst
   * dedup step ranks shots by computing a Laplacian-variance sharpness
   * score on these previews.
   */
  async getPreviewPaths(assetIds: string[]): Promise<Map<string, string>> {
    if (assetIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('asset_file')
      .select(['asset_file.assetId', 'asset_file.path'])
      .where('asset_file.assetId', 'in', assetIds)
      .where('asset_file.type', '=', AssetFileType.Preview)
      .execute();
    const out = new Map<string, string>();
    for (const r of rows) {
      out.set(r.assetId, r.path);
    }
    return out;
  }

  /**
   * For each given English city name, find a Russian / Cyrillic-script
   * alternate from GeoNames `alternateNames`. Returns a Map keyed by the
   * exact English name; cities with no Cyrillic alternate are simply absent
   * from the result and the caller can fall back to the English form.
   *
   * Match is by name only (no country filter) — same-name collisions are
   * unlikely for the cities a user actually photographs, and the first
   * Cyrillic alternate is usually the canonical Russian name across rows.
   */
  async getRussianCityNames(englishNames: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (englishNames.length === 0) {
      return out;
    }
    const rows = await this.db
      .selectFrom('geodata_places')
      .select(['name', 'alternateNames'])
      .where('name', 'in', englishNames)
      .where('alternateNames', 'is not', null)
      .execute();

    // Letters that exist in other Cyrillic alphabets but NOT modern Russian.
    //   ї є і ґ – Ukrainian
    //   ў        – Belarusian
    //   ѓ ѕ љ њ ћ ђ џ – various South Slavic / Macedonian / Serbian
    //   ѣ ѳ ѵ    – pre-1918 Russian (still want to skip — gives "Бетъырбухъ" style)
    // Any alternate containing one of these is dropped, which usually pushes
    // us toward the modern Russian rendering.
    const NON_RUSSIAN_CYRILLIC = /[іїєґўѓѕљњћђџѣѳѵ]/i;
    const ANY_CYRILLIC = /[Ѐ-ӿ]/;

    for (const row of rows) {
      if (out.has(row.name)) {
        continue;
      }
      const alternates = (row.alternateNames ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => ANY_CYRILLIC.test(s) && !NON_RUSSIAN_CYRILLIC.test(s));
      if (alternates.length === 0) {
        continue;
      }
      // Pick the longest remaining (usually the full canonical name —
      // "Нижний Новгород" beats the short "Горький"; "Санкт-Петербург"
      // beats "Питер"). Stable tiebreaker: ASCII order so reruns are
      // deterministic.
      alternates.sort((a, b) => b.length - a.length || a.localeCompare(b, 'ru'));
      out.set(row.name, alternates[0]);
    }
    return out;
  }

  /**
   * Soft-delete every album whose description starts with the auto-created
   * marker. Called at the top of the job so prototype re-runs cleanly
   * replace the previous batch instead of stacking duplicates.
   */
  async deleteAutoCreatedAlbumsForUser(userId: string, descriptionPrefix: string): Promise<string[]> {
    // Find albums owned by this user with the prefix marker.
    const ids = await this.db
      .selectFrom('album')
      .innerJoin('album_user', 'album_user.albumId', 'album.id')
      .select('album.id')
      .where('album_user.userId', '=', userId)
      .where('album_user.role', '=', AlbumUserRole.Owner)
      .where('album.description', 'like', `${descriptionPrefix}%`)
      .where('album.deletedAt', 'is', null)
      .execute();
    if (ids.length === 0) {
      return [];
    }
    const idList = ids.map((r) => r.id);
    // Hard-delete; this is prototype iteration data, no need to send to trash.
    await this.db.deleteFrom('album').where('album.id', 'in', idList).execute();
    return idList;
  }
}
