import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetType, AssetVisibility } from 'src/enum';
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
   * All timeline assets (image + video, with or without GPS) for a user inside
   * `[from, to]`. The detected trip cluster only uses GPS-tagged assets, but
   * the resulting album sweeps the full time range so photos where iPhone
   * forgot to record GPS still end up in the trip album.
   */
  async getAssetsInRangeForUser(userId: string, from: Date, to: Date): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.ownerId', '=', userId)
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.deletedAt', 'is', null)
      .where('asset.fileCreatedAt', '>=', from)
      .where('asset.fileCreatedAt', '<=', to)
      .orderBy('asset.fileCreatedAt', 'asc')
      .execute();
    return rows.map((r) => r.id);
  }
}
