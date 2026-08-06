import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE shared_link
    ADD COLUMN "personId" uuid NULL
      REFERENCES person(id) ON DELETE CASCADE ON UPDATE CASCADE
  `.execute(db);
  await sql`CREATE INDEX "shared_link_personId_idx" ON shared_link("personId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS shared_link_personId_idx`.execute(db);
  await sql`ALTER TABLE shared_link DROP COLUMN IF EXISTS "personId"`.execute(db);
}
