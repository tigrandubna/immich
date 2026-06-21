import { Injectable } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { AlbumUserRole, DatabaseLock, JobName, JobStatus, QueueName } from 'src/enum';
import { GpsAssetRow } from 'src/repositories/auto-trip.repository';
import { BaseService } from 'src/services/base.service';

// Prototype tuning knobs. Conservative defaults: prefer missing a trip over
// inventing a fake one. Tweak after looking at the first few albums.
const HOME_LOOKBACK_DAYS = 365;
const AWAY_THRESHOLD_KM = 100; // a single GPS sample at least this far from home counts as "away"
const MAX_TRIP_GAP_HOURS = 72; // two consecutive away assets more than this apart split into separate trips
const MIN_TRIP_ASSETS = 5; // ignore multi-day GPS clusters smaller than this — usually one-off layovers
const MIN_TRIP_DURATION_HOURS = 18; // clusters spanning at least this long count as multi-day trips
const MIN_TRIP_TOTAL_ASSETS = 30; // final post-filter album size (after screenshot drop + burst dedup) — anything smaller doesn't feel like a real trip
const ONE_DAY_MIN_ASSETS = 15; // sub-multi-day clusters still qualify as "one-day trips" if they have at least this many shots…
const ONE_DAY_MIN_DISTINCT_CITIES = 2; // …AND visit at least this many distinct geocoded cities
const ONE_DAY_MIN_SPREAD_KM = 10; // …OR span at least this much geographic distance bounding-box-wise
const TIME_PAD_HOURS = 2; // small pre/post window around the trip's GPS range
const NONGPS_BRIDGE_HOURS = 4; // a GPS-less asset is included only if a GPS asset of the trip is within this much
const BURST_WINDOW_SECONDS = 15; // adjacent assets closer than this from the same camera count as a burst (covers both true iPhone bursts ~0.1s and manual "re-shoots" within ~15s)
const BURST_KEEP = 3; // keep up to this many sharpest shots per burst
const BURST_BLUR_CONCURRENCY = 8; // how many preview-blur measurements to run in parallel
const AESTHETIC_MODEL_NAME = 'cafe-aesthetic'; // hosted under /cache/aesthetic/<name>/scorer/model.onnx
const AESTHETIC_WEIGHT = 0.6; // final = AESTHETIC_WEIGHT * aesthetic + (1-AESTHETIC_WEIGHT) * normalised blur (per-burst max=1)
const MAX_TRIPS_PER_USER = 1000; // safety cap; in practice we run out of clusters first on any real library
const AUTO_DESCRIPTION_PREFIX = 'Auto-detected trip ·';
// Embedded watermark inside album descriptions so we can run the detector
// incrementally: assets uploaded BEFORE this timestamp are assumed to be
// already-considered (so a user-deleted asset doesn't get re-added on the
// next run). Format: "[scan:2026-06-21T03:00:00.000Z]" appended to the
// description.
const SCAN_WATERMARK_RE = /\[scan:([^\]]+)\]/;

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

// Genitive forms for "<day> <month> <year>" date strings (used for one-day trips).
const MONTHS_RU_GEN = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

type TripKind = 'multi-day' | 'one-day';

// Manual overrides for cities where the GeoNames-based heuristic still picks
// a non-Russian alternate (Tajik/Uzbek "<name> ош", Belarusian forms without
// uniquely-Belarusian letters, etc.). Adds entries lazily — only put a city
// here when its auto-derived title is wrong. Falls back to the GeoNames
// lookup for anything not listed.
const CITIES_RU_OVERRIDE: Record<string, string> = {
  'Yerevan': 'Ереван',
  'Saint Petersburg': 'Санкт-Петербург',
  'Gorodets': 'Городец',
  'Kostroma': 'Кострома',
};

// English country names (as immich's reverse geocoder stores them in
// asset_exif.country) → preferred Russian rendering. Common short forms; for
// countries not in the table the title falls back to the English original.
const COUNTRIES_RU: Record<string, string> = {
  'Armenia': 'Армения',
  'Azerbaijan': 'Азербайджан',
  'Belarus': 'Беларусь',
  'China': 'Китай',
  "People's Republic of China": 'Китай',
  'Czech Republic': 'Чехия',
  'Czechia': 'Чехия',
  'Egypt': 'Египет',
  'France': 'Франция',
  'Georgia': 'Грузия',
  'Germany': 'Германия',
  'Greece': 'Греция',
  'India': 'Индия',
  'Indonesia': 'Индонезия',
  'Iran': 'Иран',
  'Israel': 'Израиль',
  'Italy': 'Италия',
  'Japan': 'Япония',
  'Kazakhstan': 'Казахстан',
  'Kyrgyzstan': 'Киргизия',
  'Maldives': 'Мальдивы',
  'Mexico': 'Мексика',
  'Morocco': 'Марокко',
  'Netherlands': 'Нидерланды',
  'Norway': 'Норвегия',
  'Oman': 'Оман',
  'Poland': 'Польша',
  'Portugal': 'Португалия',
  'Russian Federation': 'Россия',
  'Russia': 'Россия',
  'Saudi Arabia': 'Саудовская Аравия',
  'Serbia': 'Сербия',
  'Spain': 'Испания',
  'Sri Lanka': 'Шри-Ланка',
  'Sweden': 'Швеция',
  'Switzerland': 'Швейцария',
  'Thailand': 'Таиланд',
  'Turkey': 'Турция',
  'Türkiye': 'Турция',
  'Ukraine': 'Украина',
  'United Arab Emirates': 'ОАЭ',
  'United Kingdom': 'Великобритания',
  'United States': 'США',
  'United States of America': 'США',
  'Uzbekistan': 'Узбекистан',
  'Vietnam': 'Вьетнам',
};

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
    // Detection is heavy and writes albums to the DB. The BackgroundTask
    // queue runs many workers in parallel, and BullMQ may also re-execute
    // stalled jobs after a worker restart (we hit this in the wild when a
    // hot-reload restart happened during a manual run + the manual job got
    // re-queued, both runs racing on the same library and producing
    // duplicate albums). pg_advisory_lock serialises detection — if a run
    // is in flight, the second worker waits, then re-enters as a no-op
    // steady-state pass (every cluster matches an album from the first
    // run, nothing new gets created).
    return this.databaseRepository.withLock(DatabaseLock.AutoTripDetect, async () => {
      const ownerIds = await this.autoTripRepository.getDistinctOwnersWithGps();
      if (ownerIds.length === 0) {
        this.logger.log('No users with GPS-tagged assets found, skipping trip detection');
        return JobStatus.Skipped;
      }

      this.logger.log(`Running trip detection across ${ownerIds.length} user(s)`);
      let totalAlbumsTouched = 0;
      for (const ownerId of ownerIds) {
        try {
          totalAlbumsTouched += await this.processUser(ownerId);
        } catch (error) {
          this.logger.error(`Trip detection failed for user ${ownerId}: ${error}`);
        }
      }
      this.logger.log(`Trip detection done. Created/updated ${totalAlbumsTouched} album(s) total`);
      return JobStatus.Success;
    });
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

    // Pre-load Russian alternates for every distinct city that appears in any
    // cluster so titleForTrip can just look them up. One DB hit per user.
    const distinctCities = new Set<string>();
    for (const cluster of clusters) {
      for (const a of cluster) {
        if (a.city) {
          distinctCities.add(a.city);
        }
      }
    }
    const cityRu = await this.autoTripRepository.getRussianCityNames([...distinctCities]);

    // Load every existing auto-trip album. Each cluster will be matched
    // against one of these by date-range overlap; if matched, we add only
    // newly-uploaded assets instead of recreating the album. If no match,
    // we fall through to creating a new album. Once an album has been
    // matched once in this run, it's removed from the pool so two
    // overlapping clusters can't both glom onto the same album.
    const existingAlbums = await this.autoTripRepository.getAutoTripAlbumsForUser(
      userId,
      AUTO_DESCRIPTION_PREFIX,
    );
    const albumPool = existingAlbums.map((album) => {
      const range = parseAlbumDateRange(album.description);
      const watermark = parseWatermark(album.description) ?? album.createdAt;
      return { ...album, range, watermark };
    });

    // Walk newest → oldest. classifyCluster gates on rough size; createTripAlbum
    // does the real work (screenshot drop + burst dedup) and can still bail at
    // the end if the post-filter album turns out too small for a memorable
    // trip.
    let created = 0;
    let mergedWithChanges = 0; // matched existing album, added at least one new asset
    let mergedUnchanged = 0; // matched existing album, nothing new to add (steady-state path)
    let assetsAddedTotal = 0;
    let multiKept = 0;
    let oneDayKept = 0;
    let classified = 0;
    let rejectedTooSmall = 0;
    for (const cluster of clusters) {
      if (created >= MAX_TRIPS_PER_USER) {
        break;
      }
      const kind = this.classifyCluster(cluster);
      if (kind === null) {
        continue;
      }
      classified++;

      // cluster is sorted desc; the album-range overlap check needs ascending
      // start/end.
      const clusterStart = cluster[cluster.length - 1].fileCreatedAt;
      const clusterEnd = cluster[0].fileCreatedAt;
      const matchIdx = findBestOverlappingAlbum(albumPool, clusterStart, clusterEnd);

      if (matchIdx >= 0) {
        const match = albumPool[matchIdx];
        const addedCount = await this.mergeClusterIntoAlbum(userId, cluster, kind, cityRu, match);
        if (addedCount > 0) {
          mergedWithChanges++;
          assetsAddedTotal += addedCount;
        } else {
          mergedUnchanged++;
        }
        // Either way, this album is now claimed for this run.
        albumPool.splice(matchIdx, 1);
        continue;
      }

      const ok = await this.createTripAlbum(userId, cluster, kind, cityRu);
      if (ok) {
        created++;
        if (kind === 'multi-day') {
          multiKept++;
        } else {
          oneDayKept++;
        }
      } else {
        rejectedTooSmall++;
      }
    }

    this.logger.log(
      `User ${userId}: ${clusters.length} raw clusters, ${classified} passed initial size gate. ` +
        `Created ${created} new album(s) (${multiKept} multi-day, ${oneDayKept} one-day); ` +
        `added ${assetsAddedTotal} asset(s) into ${mergedWithChanges} existing album(s); ` +
        `${mergedUnchanged} existing album(s) re-confirmed unchanged; ` +
        `${rejectedTooSmall} skipped because final album was too thin`,
    );
    return created + mergedWithChanges;
  }

  /**
   * Incremental merge: an existing auto-trip album already covers (most of)
   * this cluster's date range, so instead of recreating it we add any newly
   * uploaded assets that weren't there before. "Newly uploaded" is defined
   * by the album's scan watermark (asset.createdAt > watermark), which
   * means user-deleted assets stay deleted across runs. Returns the number
   * of assets actually added.
   */
  private async mergeClusterIntoAlbum(
    userId: string,
    cluster: GpsAssetRow[],
    kind: TripKind,
    cityRu: Map<string, string>,
    album: { id: string; albumName: string; description: string; assetIds: Set<string>; watermark: Date },
  ): Promise<number> {
    const tripEnd = cluster[0].fileCreatedAt;
    const tripStart = cluster[cluster.length - 1].fileCreatedAt;
    const from = new Date(tripStart.getTime() - TIME_PAD_HOURS * 60 * 60 * 1000);
    const to = new Date(tripEnd.getTime() + TIME_PAD_HOURS * 60 * 60 * 1000);

    // Run the same bridge filter we use for new albums (no burst dedup —
    // the album already has its dedup'd set, and we want to add new
    // uploads even if they form a burst with existing photos).
    const candidates = await this.autoTripRepository.getAssetsInRangeForUser(userId, from, to);
    const gpsTimes = cluster.map((a) => a.fileCreatedAt.getTime()).sort((a, b) => a - b);
    const bridged = candidates.filter((asset) => {
      if (asset.hasGps) {
        return true;
      }
      const nearestDelta = nearestDeltaMs(asset.fileCreatedAt.getTime(), gpsTimes);
      return nearestDelta <= NONGPS_BRIDGE_HOURS * 60 * 60 * 1000;
    });

    // Drop anything already in the album, then keep only assets uploaded
    // AFTER the album's last scan — that's the user-deletion guard.
    const candidateIds = bridged.filter((a) => !album.assetIds.has(a.id)).map((a) => a.id);
    if (candidateIds.length === 0) {
      // Still bump the watermark so we don't reconsider the same window forever.
      await this.autoTripRepository.updateAlbumDescription(
        album.id,
        replaceWatermark(album.description, new Date()),
      );
      return 0;
    }
    const createdAtMap = await this.autoTripRepository.getAssetCreatedAtMap(candidateIds);
    const toAdd: string[] = [];
    for (const id of candidateIds) {
      const createdAt = createdAtMap.get(id);
      if (createdAt && createdAt.getTime() > album.watermark.getTime()) {
        toAdd.push(id);
      }
    }

    if (toAdd.length > 0) {
      await this.albumRepository.addAssetIds(album.id, toAdd);
      this.logger.log(
        `Merged ${toAdd.length} new asset(s) into existing album "${album.albumName}" ` +
          `(user ${userId}, trip ${tripStart.toISOString().slice(0, 10)}..${tripEnd.toISOString().slice(0, 10)})`,
      );
    }

    // Re-title if our current naming scheme would produce something different
    // AND the existing title still looks auto-generated (i.e. user didn't
    // rename it manually). This lets us migrate old "<City> — <Month> <Year>"
    // titles to the new day-range form without trampling user edits.
    const newDescription = replaceWatermark(album.description, new Date());
    const newTitle = this.titleForTrip(cluster, tripStart, kind, cityRu);
    if (newTitle !== album.albumName && looksLikeAutoTitle(album.albumName)) {
      await this.autoTripRepository.updateAlbumNameAndDescription(album.id, newTitle, newDescription);
      this.logger.debug(
        `Renamed auto-trip album "${album.albumName}" → "${newTitle}" (user ${userId})`,
      );
    } else {
      await this.autoTripRepository.updateAlbumDescription(album.id, newDescription);
    }
    return toAdd.length;
  }

  /**
   * A cluster qualifies as a trip if either:
   *  - It spans at least MIN_TRIP_DURATION_HOURS (overnight) and has at least
   *    MIN_TRIP_ASSETS shots — your classic vacation / weekend away.
   *  - It's same-day but you took ONE_DAY_MIN_ASSETS+ photos AND moved between
   *    multiple geocoded cities or covered ONE_DAY_MIN_SPREAD_KM bounding-box
   *    distance — a deliberate day excursion to nearby places.
   *
   * Returns the trip kind or null if the cluster is too small / too local to
   * deserve its own album.
   */
  private classifyCluster(cluster: GpsAssetRow[]): TripKind | null {
    if (cluster.length === 0) {
      return null;
    }
    // cluster is sorted desc, so [0] is the end and last item is the start.
    const endMs = cluster[0].fileCreatedAt.getTime();
    const startMs = cluster[cluster.length - 1].fileCreatedAt.getTime();
    const durationH = (endMs - startMs) / (1000 * 60 * 60);

    if (durationH >= MIN_TRIP_DURATION_HOURS) {
      return cluster.length >= MIN_TRIP_ASSETS ? 'multi-day' : null;
    }

    if (cluster.length < ONE_DAY_MIN_ASSETS) {
      return null;
    }

    const distinctCities = new Set(
      cluster
        .map((a) => a.city?.toLowerCase().trim())
        .filter((c): c is string => !!c),
    );
    if (distinctCities.size >= ONE_DAY_MIN_DISTINCT_CITIES) {
      return 'one-day';
    }

    // Bounding-box spread (cheap O(n) proxy for max pairwise distance).
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    let minLon = Number.POSITIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
    for (const a of cluster) {
      if (a.latitude < minLat) minLat = a.latitude;
      if (a.latitude > maxLat) maxLat = a.latitude;
      if (a.longitude < minLon) minLon = a.longitude;
      if (a.longitude > maxLon) maxLon = a.longitude;
    }
    const spreadKm = haversineKm(minLat, minLon, maxLat, maxLon);
    return spreadKm >= ONE_DAY_MIN_SPREAD_KM ? 'one-day' : null;
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
          // No more early break: with the cap raised to 1000 we want to walk
          // the user's full GPS history once.
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
          // No more early break: with the cap raised to 1000 we want to walk
          // the user's full GPS history once.
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

  private async createTripAlbum(
    userId: string,
    trip: GpsAssetRow[],
    kind: TripKind,
    cityRu: Map<string, string>,
  ): Promise<boolean> {
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
    if (kept.length < MIN_TRIP_TOTAL_ASSETS) {
      this.logger.debug(
        `Skipping trip ${tripStart.toISOString()}..${tripEnd.toISOString()} for user ${userId}: ` +
          `only ${kept.length} assets after filters (need ≥ ${MIN_TRIP_TOTAL_ASSETS})`,
      );
      return false;
    }

    const albumName = this.titleForTrip(trip, tripStart, kind, cityRu);
    const description =
      `${AUTO_DESCRIPTION_PREFIX} ${kind} · ${tripStart.toISOString().slice(0, 10)} – ${tripEnd.toISOString().slice(0, 10)} · ` +
      `${trip.length} geo-tagged · ${kept.length} kept (dropped ${droppedByBridge} off-trip + ${droppedByBurst} burst-duplicates) ` +
      `[scan:${new Date().toISOString()}]`;

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

  private titleForTrip(
    trip: GpsAssetRow[],
    startDate: Date,
    kind: TripKind,
    cityRu: Map<string, string>,
  ): string {
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
    const dominantCityEn = topKey(cityCounts);
    const dominantCountryEn = topKey(countryCounts);
    // Translate to Russian when we have a hit; otherwise leave the original
    // (less ugly than dropping the field).
    const dominantCity = dominantCityEn
      ? (CITIES_RU_OVERRIDE[dominantCityEn] ?? cityRu.get(dominantCityEn) ?? dominantCityEn)
      : undefined;
    const dominantCountry = dominantCountryEn
      ? (COUNTRIES_RU[dominantCountryEn] ?? dominantCountryEn)
      : undefined;
    // trip is sorted desc by fileCreatedAt; [0] is the end day.
    const endDate = trip[0].fileCreatedAt;
    const datePart = formatDatePart(startDate, endDate, kind);
    if (dominantCity && dominantCountry) {
      return `${dominantCity}, ${dominantCountry} — ${datePart}`;
    }
    if (dominantCountry) {
      return `${dominantCountry} — ${datePart}`;
    }
    if (dominantCity) {
      return `${dominantCity} — ${datePart}`;
    }
    return `Поездка — ${datePart}`;
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

/**
 * Parse the "YYYY-MM-DD – YYYY-MM-DD" trip range out of the auto-generated
 * description. Returns null when the description doesn't follow the
 * expected format (e.g. user heavily edited it).
 */
function parseAlbumDateRange(description: string): { start: Date; end: Date } | null {
  const match = description.match(/(\d{4}-\d{2}-\d{2})\s+–\s+(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    return null;
  }
  const start = new Date(`${match[1]}T00:00:00Z`);
  const end = new Date(`${match[2]}T23:59:59Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }
  return { start, end };
}

function parseWatermark(description: string): Date | null {
  const match = description.match(SCAN_WATERMARK_RE);
  if (!match) {
    return null;
  }
  const d = new Date(match[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Replace or append the "[scan:<iso>]" watermark in an album description
 * without disturbing whatever else is there (user could have edited the
 * surrounding text). If there's no marker yet, append one separated by a
 * single space.
 */
function replaceWatermark(description: string, when: Date): string {
  const stamp = `[scan:${when.toISOString()}]`;
  if (SCAN_WATERMARK_RE.test(description)) {
    return description.replace(SCAN_WATERMARK_RE, stamp);
  }
  return description.length > 0 ? `${description} ${stamp}` : stamp;
}

/**
 * Pick the existing auto-trip album whose date range overlaps the given
 * cluster's range the most. Returns the index in `albums` or -1 if no
 * candidate overlaps at all. Used to decide between "merge into existing"
 * and "create new" for each detected cluster.
 */
function findBestOverlappingAlbum<A extends { range: { start: Date; end: Date } | null }>(
  albums: A[],
  clusterStart: Date,
  clusterEnd: Date,
): number {
  let bestIdx = -1;
  let bestOverlap = 0;
  const cs = clusterStart.getTime();
  const ce = clusterEnd.getTime();
  for (let i = 0; i < albums.length; i++) {
    const range = albums[i].range;
    if (!range) {
      continue;
    }
    const overlap = Math.min(ce, range.end.getTime()) - Math.max(cs, range.start.getTime());
    if (overlap > 0 && overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Build the date portion of a trip-album title.
 *  - One-day trips: "5 июня 2026" — single day, genitive month.
 *  - Multi-day in same month: "20–22 июля 2021" — day range, genitive month.
 *  - Multi-day spanning months: "29 декабря 2024 – 4 января 2025" — full
 *    range, each side with its own genitive month, so e.g. New Year's trips
 *    read naturally without dropping the second month.
 *
 * Always includes day info so two trips to the same city in the same month
 * get distinct titles (we hit this with two separate Dubrovnik stays in
 * July 2021 producing identical "Дубровник, Croatia — Июль 2021").
 */
function formatDatePart(startDate: Date, endDate: Date, kind: TripKind): string {
  const sDay = startDate.getDate();
  const sMon = startDate.getMonth();
  const sYear = startDate.getFullYear();
  const eDay = endDate.getDate();
  const eMon = endDate.getMonth();
  const eYear = endDate.getFullYear();
  if (kind === 'one-day' || (sDay === eDay && sMon === eMon && sYear === eYear)) {
    return `${sDay} ${MONTHS_RU_GEN[sMon]} ${sYear}`;
  }
  if (sMon === eMon && sYear === eYear) {
    return `${sDay}–${eDay} ${MONTHS_RU_GEN[sMon]} ${sYear}`;
  }
  if (sYear === eYear) {
    return `${sDay} ${MONTHS_RU_GEN[sMon]} – ${eDay} ${MONTHS_RU_GEN[eMon]} ${sYear}`;
  }
  return `${sDay} ${MONTHS_RU_GEN[sMon]} ${sYear} – ${eDay} ${MONTHS_RU_GEN[eMon]} ${eYear}`;
}

/**
 * Recognise an album title we generated automatically — used to decide
 * whether it's safe to re-title an existing album when we change the
 * format. If the user renamed an album manually, this returns false and
 * we leave their name alone.
 *
 * Old format: "<city|country>[, <country>] — <Month> <Year>" (capitalised
 * nominative month). New format always includes days. Anything not
 * matching either is presumed user-edited.
 */
function looksLikeAutoTitle(title: string): boolean {
  // Old format: ends with " — <Capital Month> YYYY"
  const oldMonth = MONTHS_RU.join('|');
  const oldRe = new RegExp(`\\s+—\\s+(?:${oldMonth})\\s+\\d{4}$`);
  if (oldRe.test(title)) {
    return true;
  }
  // New format: ends with " — <day stuff> <genitive-month> YYYY"
  const newMonth = MONTHS_RU_GEN.join('|');
  const newRe = new RegExp(`\\s+—\\s+.*(?:${newMonth}).*\\d{4}$`);
  return newRe.test(title);
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
