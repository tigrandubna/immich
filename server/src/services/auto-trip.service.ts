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
const TIME_PAD_HOURS = 2; // small pre/post window around the trip's GPS range
const NONGPS_BRIDGE_HOURS = 4; // a GPS-less asset is included only if a GPS asset of the trip is within this much
const BURST_WINDOW_SECONDS = 15; // adjacent assets closer than this from the same camera count as a burst (covers both true iPhone bursts ~0.1s and manual "re-shoots" within ~15s)
const BURST_KEEP = 3; // keep up to this many sharpest shots per burst
const BURST_BLUR_CONCURRENCY = 8; // how many preview-blur measurements to run in parallel
const AESTHETIC_MODEL_NAME = 'cafe-aesthetic'; // hosted under /cache/aesthetic/<name>/scorer/model.onnx
const AESTHETIC_WEIGHT = 0.6; // final = AESTHETIC_WEIGHT * aesthetic + (1-AESTHETIC_WEIGHT) * normalised blur (per-burst max=1)
const MAX_TRIPS_PER_USER = 30; // prototype: only build albums for the N most recent trips per user
const AUTO_DESCRIPTION_PREFIX = 'Auto-detected trip ·';

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
    // Wipe out the previous prototype run's albums for this user so re-runs
    // replace rather than stack. Identified by the description prefix the
    // service stamps on every album it creates.
    const deleted = await this.autoTripRepository.deleteAutoCreatedAlbumsForUser(
      userId,
      AUTO_DESCRIPTION_PREFIX,
    );
    if (deleted.length > 0) {
      this.logger.log(`User ${userId}: removed ${deleted.length} previously auto-created trip album(s)`);
    }

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
    // Small pre/post window; the bridge filter below trims it tighter per-asset.
    const from = new Date(tripStart.getTime() - TIME_PAD_HOURS * 60 * 60 * 1000);
    const to = new Date(tripEnd.getTime() + TIME_PAD_HOURS * 60 * 60 * 1000);

    const candidates = await this.autoTripRepository.getAssetsInRangeForUser(userId, from, to);
    if (candidates.length === 0) {
      this.logger.warn(
        `Skipping trip ${tripStart.toISOString()}..${tripEnd.toISOString()} for user ${userId}: time range query returned 0 assets`,
      );
      return false;
    }

    // Sorted ascending GPS timestamps for the nearest-GPS bridge filter.
    const gpsTimes = trip.map((a) => a.fileCreatedAt.getTime()).sort((a, b) => a - b);

    // Step 1: drop edge / orphan assets. An asset with no GPS is included only
    // if a GPS asset of THIS trip is within ±NONGPS_BRIDGE_HOURS of it. This
    // kills the "midnight before the trip" / "midnight after the trip" photos
    // that the previous time-pad blindly swept in.
    const bridged = candidates.filter((asset) => {
      if (asset.hasGps) {
        return true;
      }
      const nearestDelta = nearestDeltaMs(asset.fileCreatedAt.getTime(), gpsTimes);
      return nearestDelta <= NONGPS_BRIDGE_HOURS * 60 * 60 * 1000;
    });
    const droppedByBridge = candidates.length - bridged.length;

    // Step 2: burst dedup. Walk chronologically, group consecutive assets
    // within BURST_WINDOW_SECONDS from the same camera model, then keep
    // the top BURST_KEEP sharpest of each group.
    //
    // Sharpness comes from a Laplacian-variance score computed on the
    // asset's preview thumbnail — same metric the fork already uses for
    // face crops, but applied per-asset so landscapes without faces get
    // ranked too. We only score assets that are actually in a burst (>1
    // member) to keep the work bounded.
    const groups = this.groupBursts(bridged);
    const burstAssetIds = groups
      .filter((g) => g.length > 1)
      .flatMap((g) => g)
      .map((a) => a.id);
    const previewPaths = await this.autoTripRepository.getPreviewPaths(burstAssetIds);
    const blurScores = new Map<string, number>();
    const aestheticScores = new Map<string, number>();
    const tasks: Array<() => Promise<void>> = [];
    let aestheticAttempts = 0;
    let aestheticHits = 0;
    for (const id of burstAssetIds) {
      const path = previewPaths.get(id);
      if (!path) {
        continue;
      }
      tasks.push(async () => {
        const [blur, aesthetic] = await Promise.all([
          this.mediaRepository.computeImageBlurScore(path),
          this.machineLearningRepository.aestheticScore(path, { modelName: AESTHETIC_MODEL_NAME }),
        ]);
        if (blur !== null) {
          blurScores.set(id, blur);
        }
        aestheticAttempts++;
        if (aesthetic !== null) {
          aestheticScores.set(id, aesthetic);
          aestheticHits++;
        }
      });
    }
    await runInBatches(tasks, BURST_BLUR_CONCURRENCY);

    // If the ML aesthetic model wasn't reachable for any frame (file missing,
    // server unhealthy), fall back to blur-only ranking instead of zeroing
    // every photo out. Mostly-hits is treated as success.
    const useAesthetic = aestheticAttempts > 0 && aestheticHits / aestheticAttempts > 0.5;
    this.logger.log(
      `User ${userId} burst ranking: ${aestheticHits}/${aestheticAttempts} aesthetic scores resolved; ` +
        `combining=${useAesthetic}`,
    );

    const kept: typeof bridged = [];
    for (const group of groups) {
      if (group.length === 1) {
        kept.push(group[0]);
        continue;
      }
      // Combined score:
      //   normalised blur per group (max within burst = 1) — keeps blur on
      //     the same 0..1 scale as the aesthetic prob so they can be weighted
      //   aesthetic prob from cafe_aesthetic (0..1 already)
      // Fall back to blur-only when aesthetic isn't available for the run.
      const groupMaxBlur = Math.max(
        ...group.map((a) => blurScores.get(a.id) ?? 0),
        1, // avoid divide-by-zero when no scores at all
      );
      const scoreOf = (id: string): number => {
        const blur = blurScores.get(id);
        const blurNorm = blur === undefined ? 0 : blur / groupMaxBlur;
        if (!useAesthetic) {
          return blurNorm;
        }
        const aesthetic = aestheticScores.get(id) ?? 0;
        return AESTHETIC_WEIGHT * aesthetic + (1 - AESTHETIC_WEIGHT) * blurNorm;
      };
      const ranked = [...group].sort((a, b) => {
        const sa = scoreOf(a.id);
        const sb = scoreOf(b.id);
        if (sb !== sa) {
          return sb - sa;
        }
        // tie: earliest first (usually the shot the user actually framed)
        return a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime();
      });
      const keepN = Math.min(group.length, BURST_KEEP);
      kept.push(...ranked.slice(0, keepN));
    }
    // Re-sort kept ascending (sort above scrambled within bursts)
    kept.sort((a, b) => a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime());
    const droppedByBurst = bridged.length - kept.length;

    if (kept.length === 0) {
      this.logger.warn(`Skipping trip ${tripStart.toISOString()}..${tripEnd.toISOString()} for user ${userId}: empty after filters`);
      return false;
    }

    const albumName = this.titleForTrip(trip, tripStart);
    const description =
      `${AUTO_DESCRIPTION_PREFIX} ${tripStart.toISOString().slice(0, 10)} – ${tripEnd.toISOString().slice(0, 10)} · ` +
      `${trip.length} geo-tagged · ${kept.length} kept (dropped ${droppedByBridge} off-trip + ${droppedByBurst} burst-duplicates)`;

    // Album cover: prefer the photo with the most NAMED people on it (i.e.
    // faces already linked to a person with a non-empty name). For trips,
    // shots of recognised friends/family are almost always better covers
    // than scenery alone. Tiebreaker: aesthetic score (or blur if the ML
    // model wasn't used). If nothing in the album has any named face at all,
    // fall back to the middle GPS asset, which has been the heuristic so far.
    const namedFaceCounts = await this.autoTripRepository.getNamedFaceCounts(kept.map((a) => a.id));
    const coverRanked = [...kept].sort((a, b) => {
      const na = namedFaceCounts.get(a.id) ?? 0;
      const nb = namedFaceCounts.get(b.id) ?? 0;
      if (nb !== na) {
        return nb - na;
      }
      // Tiebreaker — whichever quality signal we actually computed
      const qa = (useAesthetic ? aestheticScores.get(a.id) : blurScores.get(a.id)) ?? 0;
      const qb = (useAesthetic ? aestheticScores.get(b.id) : blurScores.get(b.id)) ?? 0;
      return qb - qa;
    });
    const bestNamedCover = coverRanked[0];
    const bestNamedCount = namedFaceCounts.get(bestNamedCover?.id ?? '') ?? 0;
    const middle = trip[Math.floor(trip.length / 2)];
    const coverAsset = bestNamedCount > 0 ? bestNamedCover : (middle ?? kept[0]);

    this.logger.log(
      `Creating trip album "${albumName}" for user ${userId} with ${kept.length} assets ` +
        `(GPS ${trip.length}, candidates ${candidates.length}, off-trip dropped ${droppedByBridge}, ` +
        `burst-dups dropped ${droppedByBurst}, cover has ${bestNamedCount} named face(s))`,
    );

    try {
      await this.albumRepository.create(
        {
          albumName,
          description,
          albumThumbnailAssetId: coverAsset?.id ?? kept[0].id,
        },
        kept.map((a) => a.id),
        [{ userId, role: AlbumUserRole.Owner }],
        userId,
      );
      return true;
    } catch (error) {
      this.logger.error(`Failed to create trip album "${albumName}" for user ${userId}: ${error}`);
      return false;
    }
  }



  /**
   * Group chronologically-sorted assets into bursts. Two adjacent assets
   * join the same burst when their timestamps differ by less than
   * BURST_WINDOW_SECONDS AND they come from the same camera model. Returns
   * each burst as its own sub-array; singletons stay as 1-element groups.
   */
  private groupBursts<T extends { fileCreatedAt: Date; model: string | null }>(assets: T[]): T[][] {
    const groups: T[][] = [];
    let current: T[] = [];
    for (const a of assets) {
      const last = current[current.length - 1];
      if (
        !last ||
        a.fileCreatedAt.getTime() - last.fileCreatedAt.getTime() > BURST_WINDOW_SECONDS * 1000 ||
        (last.model ?? '') !== (a.model ?? '')
      ) {
        if (current.length > 0) {
          groups.push(current);
        }
        current = [a];
      } else {
        current.push(a);
      }
    }
    if (current.length > 0) {
      groups.push(current);
    }
    return groups;
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

/**
 * Run an array of async thunks with bounded concurrency. Used to compute
 * preview-blur scores for burst members in parallel without hammering the
 * libuv pool / Sharp instance limit.
 */
async function runInBatches(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      await tasks[idx]();
    }
  });
  await Promise.all(workers);
}

/**
 * Smallest absolute time delta (ms) from `t` to any element of the SORTED
 * ascending array `sorted`. O(log n) per call. Used to decide whether a
 * GPS-less asset is close enough to a known trip moment to belong to it.
 */
function nearestDeltaMs(t: number, sorted: number[]): number {
  if (sorted.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < t) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // lo is the first index >= t (or last index if all < t).
  let best = Math.abs(sorted[lo] - t);
  if (lo > 0) {
    best = Math.min(best, Math.abs(sorted[lo - 1] - t));
  }
  return best;
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
