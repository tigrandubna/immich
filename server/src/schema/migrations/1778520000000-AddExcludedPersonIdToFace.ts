import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // When a user manually unassigns a face from a person via the info panel,
  // we record which person they detached it from. handleRecognizeFaces consults
  // this column to avoid immediately reattaching the face to that same person
  // via vector search (the cluster of other faces of that person is still in
  // the index and would otherwise win).
  await sql`
    ALTER TABLE asset_face
    ADD COLUMN "excludedPersonId" uuid NULL
      REFERENCES person(id) ON UPDATE CASCADE ON DELETE SET NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE asset_face DROP COLUMN IF EXISTS "excludedPersonId"`.execute(db);
}
