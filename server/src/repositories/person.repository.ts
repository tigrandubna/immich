import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, Selectable, sql, Updateable } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { AssetFace } from 'src/database';
import { Chunked, ChunkedArray, DummyValue, GenerateSql } from 'src/decorators';
import { AssetFileType, AssetVisibility, SourceType } from 'src/enum';
import { DB } from 'src/schema';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table';
import { FaceSearchTable } from 'src/schema/tables/face-search.table';
import { PersonTable } from 'src/schema/tables/person.table';
import { dummy, removeUndefinedKeys, withFilePath } from 'src/utils/database';
import { paginationHelper, PaginationOptions } from 'src/utils/pagination';

export interface PersonSearchOptions {
  minimumFaceCount: number;
  withHidden: boolean;
  closestFaceAssetId?: string;
}

export interface PersonNameSearchOptions {
  withHidden?: boolean;
}

export interface PersonNameResponse {
  id: string;
  name: string;
}

export interface AssetFaceId {
  assetId: string;
  personId: string;
}

export interface UpdateFacesData {
  oldPersonId?: string;
  faceIds?: string[];
  // null clears the person assignment (face stays on the asset, no longer
  // linked to any person). Used by the "remove from photo" action.
  newPersonId: string | null;
}

export interface PersonStatistics {
  assets: number;
}

export interface DeleteFacesOptions {
  sourceType: SourceType;
}

export interface GetAllPeopleOptions {
  ownerId?: string;
  thumbnailPath?: string;
  faceAssetId?: string | null;
  isHidden?: boolean;
}

export interface GetAllFacesOptions {
  personId?: string | null;
  assetId?: string;
  sourceType?: SourceType;
}

export type UnassignFacesOptions = DeleteFacesOptions;

export type SelectFaceOptions = (keyof Selectable<AssetFaceTable>)[];

const withPerson = (eb: ExpressionBuilder<DB, 'asset_face'>) => {
  return jsonObjectFrom(
    eb.selectFrom('person').selectAll('person').whereRef('person.id', '=', 'asset_face.personId'),
  ).as('person');
};

const withExcludedPerson = (eb: ExpressionBuilder<DB, 'asset_face'>) => {
  return jsonObjectFrom(
    eb
      .selectFrom('person')
      .select(['person.id', 'person.name'])
      .whereRef('person.id', '=', 'asset_face.excludedPersonId'),
  ).as('excludedPerson');
};

const withFaceSearch = (eb: ExpressionBuilder<DB, 'asset_face'>) => {
  return jsonObjectFrom(
    eb.selectFrom('face_search').selectAll('face_search').whereRef('face_search.faceId', '=', 'asset_face.id'),
  ).as('faceSearch');
};

@Injectable()
export class PersonRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ oldPersonId: DummyValue.UUID, newPersonId: DummyValue.UUID }] })
  async reassignFaces({ oldPersonId, faceIds, newPersonId }: UpdateFacesData): Promise<number> {
    const result = await this.db
      .updateTable('asset_face')
      // Any reassignment to a non-null person clears the unassign-exclusion;
      // the user has explicitly attached this face to someone, so the prior
      // "do not auto-reattach" hint is dropped. For null reassignment (bulk
      // detach, currently only used by dedup) we don't track which person it
      // was — the per-face unassignFace path uses reassignFace() instead.
      .set({ personId: newPersonId, excludedPersonId: null })
      .$if(!!oldPersonId, (qb) => qb.where('asset_face.personId', '=', oldPersonId!))
      .$if(!!faceIds, (qb) => qb.where('asset_face.id', 'in', faceIds!))
      .executeTakeFirst();

    return Number(result.numChangedRows ?? 0);
  }

  async unassignFaces({ sourceType }: UnassignFacesOptions): Promise<void> {
    await this.db
      .updateTable('asset_face')
      .set({ personId: null })
      .where('asset_face.sourceType', '=', sourceType)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db.deleteFrom('person').where('person.id', 'in', ids).execute();
  }

  async deleteFaces({ sourceType }: DeleteFacesOptions): Promise<void> {
    await this.db.deleteFrom('asset_face').where('asset_face.sourceType', '=', sourceType).execute();
  }

  getAllFaces(options: GetAllFacesOptions = {}) {
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .$if(options.personId === null, (qb) => qb.where('asset_face.personId', 'is', null))
      .$if(!!options.personId, (qb) => qb.where('asset_face.personId', '=', options.personId!))
      .$if(!!options.sourceType, (qb) => qb.where('asset_face.sourceType', '=', options.sourceType!))
      .$if(!!options.assetId, (qb) => qb.where('asset_face.assetId', '=', options.assetId!))
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .stream();
  }

  getAll(options: GetAllPeopleOptions = {}) {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .$if(!!options.ownerId, (qb) => qb.where('person.ownerId', '=', options.ownerId!))
      .$if(options.thumbnailPath !== undefined, (qb) => qb.where('person.thumbnailPath', '=', options.thumbnailPath!))
      .$if(options.faceAssetId === null, (qb) => qb.where('person.faceAssetId', 'is', null))
      .$if(!!options.faceAssetId, (qb) => qb.where('person.faceAssetId', '=', options.faceAssetId!))
      .$if(options.isHidden !== undefined, (qb) => qb.where('person.isHidden', '=', options.isHidden!))
      .stream();
  }

  @GenerateSql()
  getFileSamples() {
    return this.db
      .selectFrom('person')
      .select(['id', 'thumbnailPath'])
      .where('thumbnailPath', '!=', sql.lit(''))
      .limit(sql.lit(3))
      .execute();
  }

  @GenerateSql({ params: [{ take: 1, skip: 0 }, DummyValue.UUID] })
  async getAllForUser(pagination: PaginationOptions, userId: string, options?: PersonSearchOptions) {
    const items = await this.db
      .selectFrom('person')
      .selectAll('person')
      .innerJoin('asset_face', 'asset_face.personId', 'person.id')
      .innerJoin('asset', (join) =>
        join
          .onRef('asset_face.assetId', '=', 'asset.id')
          .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
          .on('asset.deletedAt', 'is', null),
      )
      .where('person.ownerId', '=', userId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .orderBy('person.isHidden', 'asc')
      .orderBy('person.isFavorite', 'desc')
      .having((eb) =>
        eb.or([
          eb('person.name', '!=', ''),
          eb((innerEb) => innerEb.fn.count('asset_face.assetId'), '>=', options?.minimumFaceCount || 1),
        ]),
      )
      .groupBy('person.id')
      .$if(!!options?.closestFaceAssetId, (qb) =>
        qb.orderBy((eb) =>
          eb(
            (eb) =>
              eb
                .selectFrom('face_search')
                .select('face_search.embedding')
                .whereRef('face_search.faceId', '=', 'person.faceAssetId'),
            '<=>',
            (eb) =>
              eb
                .selectFrom('face_search')
                .select('face_search.embedding')
                .where('face_search.faceId', '=', options!.closestFaceAssetId!),
          ),
        ),
      )
      .$if(!options?.closestFaceAssetId, (qb) =>
        qb
          .orderBy(sql`NULLIF(person.name, '') is null`, 'asc')
          .orderBy((eb) => eb.fn.count('asset_face.assetId'), 'desc')
          .orderBy(sql`NULLIF(person.name, '')`, (om) => om.asc().nullsLast())
          .orderBy('person.createdAt'),
      )
      .$if(!options?.withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .offset(pagination.skip ?? 0)
      .limit(pagination.take + 1)
      .execute();

    return paginationHelper(items, pagination.take);
  }

  @GenerateSql()
  getAllWithoutFaces() {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .leftJoin('asset_face', 'asset_face.personId', 'person.id')
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .having((eb) => eb.fn.count('asset_face.assetId'), '=', 0)
      .groupBy('person.id')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFaces(assetId: string, options?: { isVisible?: boolean }) {
    const isVisible = options === undefined ? true : options.isVisible;

    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson)
      .select(withExcludedPerson)
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.deletedAt', 'is', null)
      .$if(isVisible !== undefined, (qb) => qb.where('asset_face.isVisible', '=', isVisible!))
      .orderBy('asset_face.boundingBoxX1', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFaceById(id: string) {
    // TODO return null instead of find or fail
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson)
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFaceForThumbnailJob(id: string) {
    return this.db
      .selectFrom('asset_face')
      .select([
        'asset_face.id',
        'asset_face.assetId',
        'asset_face.boundingBoxX1',
        'asset_face.boundingBoxY1',
        'asset_face.boundingBoxX2',
        'asset_face.boundingBoxY2',
        'asset_face.imageWidth',
        'asset_face.imageHeight',
        'asset_face.thumbnailPath',
      ])
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('asset')
            .select(['asset.ownerId'])
            .whereRef('asset.id', '=', 'asset_face.assetId'),
        ).as('asset'),
      )
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async updateThumbnailPath(faceId: string, thumbnailPath: string | null) {
    await this.db
      .updateTable('asset_face')
      .set({ thumbnailPath })
      .where('id', '=', faceId)
      .execute();
  }

  streamFacesNeedingThumbnail(force?: boolean) {
    return this.db
      .selectFrom('asset_face')
      .select(['asset_face.id'])
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .$if(!force, (qb) => qb.where('asset_face.thumbnailPath', 'is', null))
      .stream();
  }

  streamAssetIdsWithNamedFaces() {
    return this.db
      .selectFrom('asset_face')
      .innerJoin('person', 'person.id', 'asset_face.personId')
      .select('asset_face.assetId')
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .where('person.name', '!=', '')
      .distinct()
      .stream();
  }

  /**
   * Assets that have at least one face which is either:
   *   - attached to a named person (round-trip the name to XMP), or
   *   - manually detached with excludedPersonId set (round-trip the
   *     "do-not-reattach" marker to XMP).
   * Used by the "Rewrite face XMP sidecars" manual job so that previously
   * unassigned-with-exclusion faces also get persisted on disk.
   */
  streamAssetIdsWithFaceRegionsToWrite() {
    return this.db
      .selectFrom('asset_face as af')
      .leftJoin('person as p', 'p.id', 'af.personId')
      .leftJoin('person as ep', 'ep.id', 'af.excludedPersonId')
      .select('af.assetId')
      .where('af.deletedAt', 'is', null)
      .where('af.isVisible', 'is', true)
      .where((eb) =>
        eb.or([
          eb.and([eb('af.personId', 'is not', null), eb('p.name', '!=', '')]),
          eb.and([eb('af.excludedPersonId', 'is not', null), eb('ep.name', 'is not', null), eb('ep.name', '!=', '')]),
        ]),
      )
      .distinct()
      .stream();
  }

  streamAssetIdsWithMultipleFaces() {
    return this.db
      .selectFrom('asset_face')
      .select('asset_face.assetId')
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .groupBy('asset_face.assetId')
      .having((eb) => eb.fn.count('asset_face.id'), '>', 1)
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getFacesByAssetWithEmbeddings(assetId: string) {
    return this.db
      .selectFrom('asset_face')
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .leftJoin('person', 'person.id', 'asset_face.personId')
      .leftJoin('face_search', 'face_search.faceId', 'asset_face.id')
      .select([
        'asset_face.id',
        'asset_face.assetId',
        'asset_face.personId',
        'asset_face.boundingBoxX1',
        'asset_face.boundingBoxY1',
        'asset_face.boundingBoxX2',
        'asset_face.boundingBoxY2',
        'asset_face.imageWidth',
        'asset_face.imageHeight',
        'asset.ownerId as ownerId',
        'asset.fileCreatedAt as fileCreatedAt',
        'person.name as personName',
        'face_search.embedding as embedding',
      ])
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFaceForFacialRecognitionJob(id: string) {
    return this.db
      .selectFrom('asset_face')
      .select([
        'asset_face.id',
        'asset_face.personId',
        'asset_face.sourceType',
        'asset_face.assetId',
        'asset_face.excludedPersonId',
      ])
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('asset')
            .select(['asset.ownerId', 'asset.visibility', 'asset.fileCreatedAt'])
            .whereRef('asset.id', '=', 'asset_face.assetId'),
        ).as('asset'),
      )
      .select(withFaceSearch)
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getDataForThumbnailGenerationJob(id: string) {
    return this.db
      .selectFrom('person')
      .innerJoin('asset_face', 'asset_face.id', 'person.faceAssetId')
      .innerJoin('asset', 'asset_face.assetId', 'asset.id')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'person.ownerId',
        'asset_face.boundingBoxX1 as x1',
        'asset_face.boundingBoxY1 as y1',
        'asset_face.boundingBoxX2 as x2',
        'asset_face.boundingBoxY2 as y2',
        'asset_face.imageWidth as oldWidth',
        'asset_face.imageHeight as oldHeight',
        'asset.type',
        'asset.originalPath',
        'asset_exif.orientation as exifOrientation',
      ])
      .select((eb) => withFilePath(eb, AssetFileType.Preview).as('previewPath'))
      .where('person.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  /**
   * Update a face's person assignment.
   *
   * - When `newPersonId` is non-null (regular reassignment), `excludedPersonId`
   *   is also cleared so that any prior "do not auto-reattach to X" hint is
   *   dropped — the user is explicitly reassigning, so the exclusion no longer
   *   applies.
   * - When `newPersonId` is null AND `excludePersonId` is provided, the face
   *   is being detached and the previous person id is recorded as excluded so
   *   facial recognition won't immediately put the face back where it was.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async reassignFace(
    assetFaceId: string,
    newPersonId: string | null,
    excludePersonId: string | null = null,
  ): Promise<number> {
    const result = await this.db
      .updateTable('asset_face')
      .set({
        personId: newPersonId,
        excludedPersonId: newPersonId === null ? excludePersonId : null,
      })
      .where('asset_face.id', '=', assetFaceId)
      .executeTakeFirst();

    return Number(result.numChangedRows ?? 0);
  }

  getById(personId: string) {
    return this.db //
      .selectFrom('person')
      .selectAll('person')
      .where('person.id', '=', personId)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING, { withHidden: true }] })
  getByName(userId: string, personName: string, { withHidden }: PersonNameSearchOptions) {
    return this.db
      .with('similarity_threshold', (db) =>
        db.selectNoFrom(sql`set_config('pg_trgm.word_similarity_threshold', '0.5', true)`.as('thresh')),
      )
      .selectFrom(['similarity_threshold', 'person'])
      .selectAll('person')
      .where('person.ownerId', '=', userId)
      .where(() => sql`f_unaccent("person"."name") %> f_unaccent(${personName})`)
      .orderBy(sql`f_unaccent("person"."name") <->>> f_unaccent(${personName})`)
      .limit(100)
      .$if(!withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { withHidden: true }] })
  getDistinctNames(userId: string, { withHidden }: PersonNameSearchOptions): Promise<PersonNameResponse[]> {
    return this.db
      .selectFrom('person')
      .select(['person.id', 'person.name'])
      .distinctOn((eb) => eb.fn('lower', ['person.name']))
      .where((eb) => eb.and([eb('person.ownerId', '=', userId), eb('person.name', '!=', '')]))
      .$if(!withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getStatistics(personId: string): Promise<PersonStatistics> {
    const result = await this.db
      .selectFrom('asset_face')
      .leftJoin('asset', (join) =>
        join
          .onRef('asset.id', '=', 'asset_face.assetId')
          .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
          .on('asset.deletedAt', 'is', null),
      )
      .select((eb) => eb.fn.count(eb.fn('distinct', ['asset.id'])).as('count'))
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .where('asset_face.personId', '=', personId)
      .executeTakeFirst();

    return {
      assets: result ? Number(result.count) : 0,
    };
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getNumberOfPeople(userId: string) {
    const zero = sql.lit(0);
    return this.db
      .selectFrom('person')
      .where((eb) =>
        eb.exists((eb) =>
          eb
            .selectFrom('asset_face')
            .whereRef('asset_face.personId', '=', 'person.id')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', '=', true)
            .where((eb) =>
              eb.exists((eb) =>
                eb
                  .selectFrom('asset')
                  .whereRef('asset.id', '=', 'asset_face.assetId')
                  .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
                  .where('asset.deletedAt', 'is', null),
              ),
            ),
        ),
      )
      .where('person.ownerId', '=', userId)
      .select((eb) => eb.fn.coalesce(eb.fn.countAll<number>(), zero).as('total'))
      .select((eb) => eb.fn.coalesce(eb.fn.countAll<number>().filterWhere('isHidden', '=', true), zero).as('hidden'))
      .executeTakeFirstOrThrow();
  }

  create(person: Insertable<PersonTable>) {
    return this.db.insertInto('person').values(person).returningAll().executeTakeFirstOrThrow();
  }

  async createAll(people: Insertable<PersonTable>[]): Promise<string[]> {
    if (people.length === 0) {
      return [];
    }

    const results = await this.db.insertInto('person').values(people).returningAll().execute();
    return results.map(({ id }) => id);
  }

  @GenerateSql({ params: [[], [], [{ faceId: DummyValue.UUID, embedding: DummyValue.VECTOR }]] })
  async refreshFaces(
    facesToAdd: (Insertable<AssetFaceTable> & { assetId: string })[],
    faceIdsToRemove: string[],
    embeddingsToAdd?: Insertable<FaceSearchTable>[],
  ): Promise<void> {
    let query = this.db;
    if (facesToAdd.length > 0) {
      (query as any) = query.with('added', (db) => db.insertInto('asset_face').values(facesToAdd));
    }

    if (faceIdsToRemove.length > 0) {
      (query as any) = query.with('removed', (db) =>
        db.deleteFrom('asset_face').where('asset_face.id', '=', (eb) => eb.fn.any(eb.val(faceIdsToRemove))),
      );
    }

    if (embeddingsToAdd?.length) {
      (query as any) = query.with('added_embeddings', (db) => db.insertInto('face_search').values(embeddingsToAdd));
    }

    await query.selectFrom(dummy).execute();
  }

  async update(person: Updateable<PersonTable> & { id: string }) {
    return this.db
      .updateTable('person')
      .set(person)
      .where('person.id', '=', person.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateAll(people: Insertable<PersonTable>[]): Promise<void> {
    if (people.length === 0) {
      return;
    }

    await this.db
      .insertInto('person')
      .values(people)
      .onConflict((oc) =>
        oc.column('id').doUpdateSet((eb) =>
          removeUndefinedKeys(
            {
              name: eb.ref('excluded.name'),
              birthDate: eb.ref('excluded.birthDate'),
              thumbnailPath: eb.ref('excluded.thumbnailPath'),
              faceAssetId: eb.ref('excluded.faceAssetId'),
              isHidden: eb.ref('excluded.isHidden'),
              isFavorite: eb.ref('excluded.isFavorite'),
              color: eb.ref('excluded.color'),
            },
            people[0],
          ),
        ),
      )
      .execute();
  }

  @GenerateSql({ params: [[{ assetId: DummyValue.UUID, personId: DummyValue.UUID }]] })
  @ChunkedArray()
  getFacesByIds(ids: AssetFaceId[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    const assetIds: string[] = [];
    const personIds: string[] = [];
    for (const { assetId, personId } of ids) {
      assetIds.push(assetId);
      personIds.push(personId);
    }

    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson)
      .where('asset_face.assetId', 'in', assetIds)
      .where('asset_face.personId', 'in', personIds)
      .where('asset_face.deletedAt', 'is', null)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getRandomFace(personId: string) {
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .where('asset_face.personId', '=', personId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFacesByPersonId(personId: string) {
    return this.db
      .selectFrom('asset_face')
      .innerJoin('asset', (join) =>
        join
          .onRef('asset.id', '=', 'asset_face.assetId')
          .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
          .on('asset.deletedAt', 'is', null),
      )
      .select(['asset_face.id', 'asset_face.assetId', 'asset.fileCreatedAt'])
      .where('asset_face.personId', '=', personId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .orderBy('asset.fileCreatedAt', 'desc')
      .execute();
  }

  @GenerateSql()
  async getLatestFaceDate(): Promise<string | undefined> {
    const result = (await this.db
      .selectFrom('asset_job_status')
      .select((eb) => sql`${eb.fn.max('asset_job_status.facesRecognizedAt')}::text`.as('latestDate'))
      .executeTakeFirst()) as { latestDate: string } | undefined;

    return result?.latestDate;
  }

  async createAssetFace(face: Insertable<AssetFaceTable>): Promise<void> {
    await this.db.insertInto('asset_face').values(face).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAssetFace(id: string): Promise<void> {
    await this.db.deleteFrom('asset_face').where('asset_face.id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async softDeleteAssetFaces(id: string): Promise<void> {
    await this.db.updateTable('asset_face').set({ deletedAt: new Date() }).where('asset_face.id', '=', id).execute();
  }

  async vacuum({ reindexVectors }: { reindexVectors: boolean }): Promise<void> {
    await sql`VACUUM ANALYZE asset_face, face_search, person`.execute(this.db);
    await sql`REINDEX TABLE asset_face`.execute(this.db);
    await sql`REINDEX TABLE person`.execute(this.db);
    if (reindexVectors) {
      await sql`REINDEX TABLE face_search`.execute(this.db);
    }
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  getForPeopleDelete(ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.db.selectFrom('person').select(['id', 'thumbnailPath']).where('id', 'in', ids).execute();
  }

  @GenerateSql({ params: [[], []] })
  async updateVisibility(visible: AssetFace[], hidden: AssetFace[]): Promise<void> {
    if (visible.length === 0 && hidden.length === 0) {
      return;
    }

    await this.db.transaction().execute(async (trx) => {
      if (visible.length > 0) {
        await trx
          .updateTable('asset_face')
          .set({ isVisible: true })
          .where(
            'asset_face.id',
            'in',
            visible.map(({ id }) => id),
          )
          .execute();
      }

      if (hidden.length > 0) {
        await trx
          .updateTable('asset_face')
          .set({ isVisible: false })
          .where(
            'asset_face.id',
            'in',
            hidden.map(({ id }) => id),
          )
          .execute();
      }
    });
  }

  @GenerateSql({ params: [{ personId: DummyValue.UUID, assetId: DummyValue.UUID }] })
  getForFeatureFaceUpdate({ personId, assetId }: { personId: string; assetId: string }) {
    return this.db
      .selectFrom('asset_face')
      .select('asset_face.id')
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.personId', '=', personId)
      .innerJoin('asset', (join) => join.onRef('asset.id', '=', 'asset_face.assetId').on('asset.isOffline', '=', false))
      .executeTakeFirst();
  }
}
