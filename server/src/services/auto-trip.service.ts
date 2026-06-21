import { Injectable } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { AlbumUserRole, JobName, JobStatus, QueueName } from 'src/enum';
import { GpsAssetRow } from 'src/repositories/auto-trip.repository';
import { BaseService } from 'src/services/base.service';

// Prototype tuning knobs. Conservative defaults: prefer missing a trip over
// inventing a fake one. Tweak after looking at the first few albums.
const HOME_LOOKBACK_DAYS = 365;
const AWAY_THRESHOLD_KM = 100; // a single GPS sample at least this far from home counts as "away"
const MAX_TRIP_GAP_HOURS = 72; // two consecutive away assets more than this apart split into separate trips
const MIN_TRIP_ASSETS = 5; // ignore clusters smaller than this — usually one-off layovers
const MIN_TRIP_DURATION_HOURS = 18; // and clusters shorter than this in time — same reason
const TIME_PAD_HOURS = 24; // extend trip range by ±1 day to sweep up GPS-less photos at the edges
const MAX_TRIPS_PER_USER = 5; // prototype: only build albums for the N most recent trips per user

const MONTHS_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

@Injectable()
export class AutoTripService extends BaseService {
  /**
   * Prototype: cluster each user's GPS-tagged photos into "trips" (a contiguous
   * run of photos taken far from home) and turn the N most recent trips into
   * regular albums, named after the dominant city/country and the trip's
   * start month. The album sweeps the full time range so photos where GPS
   * wasn't recorded still end up in it.
   *
   * Knobs are inline constants for the first iteration — once we have a sense
   * of quality on a real library we can either expose them as user prefs or
   * commit to better defaults.
   */
  @OnJob({ name: JobName.AutoTripDetectRecent, queue: QueueName.BackgroundTask })
  async handleDetectRecentTrips(): Promise<JobStatus> {
    const ownerIds = await this.autoTripRepository.getDistinctOwnersWithGps();
    if (ownerIds.length === 0) {
      this.logger.log('No users with GPS-tagged assets found, skipping trip detection');
      return JobStatus.Skipped;
    }

    this.logger.log(`Running trip detection prototype across ${ownerIds.length} user(s)`);
    let totalAlbumsCreated = 0;
    for (const ownerId of ownerIds) {
      try {
        totalAlbumsCreated += await this.processUser(ownerId);
      } catch (error) {
        this.logger.error(`Trip detection failed for user ${ownerId}: ${error}`);
      }
    }
    this.logger.log(`Trip detection done. Created ${totalAlbumsCreated} album(s) total`);
    return JobStatus.Success;
  }

  private async processUser(userId: string): Promise<number> {
    const gpsAssets = await this.autoTripRepository.getGpsAssetsForUser(userId);
    if (gpsAssets.length === 0) {
      return 0;
    }

    const home = this.computeHomeCentroid(gpsAssets);
    if (!home) {
      this.logger.debug(`No home centroid for user ${userId} (no recent GPS assets), skipping`);
      return 0;
    }
    this.logger.debug(
      `User ${userId}: home centroid ≈ (${home.lat.toFixed(4)}, ${home.lon.toFixed(4)}), ${gpsAssets.length} GPS assets total`,
    );

    const clusters = this.findAwayClusters(gpsAssets, home);
    const trips = clusters
      .filter((cluster) => {
        if (cluster.length < MIN_TRIP_ASSETS) {
          return false;
        }
        // cluster is sorted desc (newest first), so [0] is end and last is start
        const endMs = cluster[0].fileCreatedAt.getTime();
        const startMs = cluster[cluster.length - 1].fileCreatedAt.getTime();
        const durationH = (endMs - startMs) / (1000 * 60 * 60);
        return durationH >= MIN_TRIP_DURATION_HOURS;
      })
      .slice(0, MAX_TRIPS_PER_USER);

    this.logger.log(`User ${userId}: ${clusters.length} raw clusters, ${trips.length} kept as trips`);

    let created = 0;
    for (const trip of trips) {
      const ok = await this.createTripAlbum(userId, trip);
      if (ok) {
        created++;
      }
    }
    return created;
  }

  private computeHomeCentroid(assets: GpsAssetRow[]): { lat: number; lon: number } | null {
    const cutoff = Date.now() - HOME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const recent = assets.filter((a) => a.fileCreatedAt.getTime() >= cutoff);
    if (recent.length === 0) {
      return null;
    }
    return {
      lat: median(recent.map((a) => a.latitude)),
      lon: median(recent.map((a) => a.longitude)),
    };
  }

  /**
   * Walk GPS assets newest → oldest, group consecutive "away from home" assets
   * into clusters. A gap of more than MAX_TRIP_GAP_HOURS between two adjacent
   * away assets splits the cluster; any "home" asset also splits. Walks until
   * we have enough clusters to fulfil MAX_TRIPS_PER_USER (keeps the prototype
   * fast on huge libraries).
   */
  private findAwayClusters(assets: GpsAssetRow[], home: { lat: number; lon: number }): GpsAssetRow[][] {
    const clusters: GpsAssetRow[][] = [];
    let current: GpsAssetRow[] = [];
    let lastAwayTime: number | null = null;

    for (const asset of assets) {
      const dist = haversineKm(asset.latitude, asset.longitude, home.lat, home.lon);
      const isAway = dist > AWAY_THRESHOLD_KM;

      if (!isAway) {
        if (current.length > 0) {
          clusters.push(current);
          current = [];
          if (clusters.length >= MAX_TRIPS_PER_USER * 3) {
            break;
          }
        }
        lastAwayTime = null;
        continue;
      }

      const time = asset.fileCreatedAt.getTime();
      if (current.length > 0 && lastAwayTime !== null) {
        const gapHours = (lastAwayTime - time) / (1000 * 60 * 60);
        if (gapHours > MAX_TRIP_GAP_HOURS) {
          clusters.push(current);
          current = [];
          if (clusters.length >= MAX_TRIPS_PER_USER * 3) {
            break;
          }
        }
      }
      current.push(asset);
      lastAwayTime = time;
    }
    if (current.length > 0) {
      clusters.push(current);
    }
    return clusters;
  }

  private async createTripAlbum(userId: string, trip: GpsAssetRow[]): Promise<boolean> {
    // trip is sorted desc; convert to chronological order for clearer logging
    const tripEnd = trip[0].fileCreatedAt;
    const tripStart = trip[trip.length - 1].fileCreatedAt;
    const from = new Date(tripStart.getTime() - TIME_PAD_HOURS * 60 * 60 * 1000);
    const to = new Date(tripEnd.getTime() + TIME_PAD_HOURS * 60 * 60 * 1000);

    const assetIds = await this.autoTripRepository.getAssetsInRangeForUser(userId, from, to);
    if (assetIds.length === 0) {
      this.logger.warn(
        `Skipping trip ${tripStart.toISOString()}..${tripEnd.toISOString()} for user ${userId}: time range query returned 0 assets`,
      );
      return false;
    }

    const albumName = this.titleForTrip(trip, tripStart);
    const description =
      `Auto-detected trip · ${tripStart.toISOString().slice(0, 10)} – ${tripEnd.toISOString().slice(0, 10)} · ` +
      `${trip.length} geo-tagged, ${assetIds.length} total in time range`;

    // Pick a thumbnail from somewhere in the middle of the GPS cluster — the
    // first asset by date is usually a transit shot ("at the airport"), and
    // the last is a transit shot back. The middle is more representative of
    // the actual destination.
    const middle = trip[Math.floor(trip.length / 2)];

    this.logger.log(
      `Creating trip album "${albumName}" for user ${userId} with ${assetIds.length} assets ` +
        `(${trip.length} GPS-tagged)`,
    );

    try {
      await this.albumRepository.create(
        {
          albumName,
          description,
          albumThumbnailAssetId: middle?.id ?? assetIds[0],
        },
        assetIds,
        [{ userId, role: AlbumUserRole.Owner }],
        userId,
      );
      return true;
    } catch (error) {
      this.logger.error(`Failed to create trip album "${albumName}" for user ${userId}: ${error}`);
      return false;
    }
  }

  private titleForTrip(trip: GpsAssetRow[], startDate: Date): string {
    const cityCounts = new Map<string, number>();
    const countryCounts = new Map<string, number>();
    for (const asset of trip) {
      if (asset.city) {
        cityCounts.set(asset.city, (cityCounts.get(asset.city) ?? 0) + 1);
      }
      if (asset.country) {
        countryCounts.set(asset.country, (countryCounts.get(asset.country) ?? 0) + 1);
      }
    }
    const dominantCity = topKey(cityCounts);
    const dominantCountry = topKey(countryCounts);
    const monthRu = MONTHS_RU[startDate.getMonth()];
    const year = startDate.getFullYear();
    if (dominantCity && dominantCountry) {
      return `${dominantCity}, ${dominantCountry} — ${monthRu} ${year}`;
    }
    if (dominantCountry) {
      return `${dominantCountry} — ${monthRu} ${year}`;
    }
    if (dominantCity) {
      return `${dominantCity} — ${monthRu} ${year}`;
    }
    return `Поездка — ${monthRu} ${year}`;
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function topKey<K>(counts: Map<K, number>): K | undefined {
  let bestKey: K | undefined;
  let bestVal = -Infinity;
  for (const [key, value] of counts) {
    if (value > bestVal) {
      bestVal = value;
      bestKey = key;
    }
  }
  return bestKey;
}
