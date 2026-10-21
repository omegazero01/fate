import type {Database} from './index.js';

/** Additive migration. Legacy rows remain effective until explicitly reviewed. */
export async function migrateConstraintProvenance(db:Database) {
  await db.query(`ALTER TABLE task_constraints ADD COLUMN IF NOT EXISTS source JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await db.query(`CREATE TABLE IF NOT EXISTS constraint_correction_audit (
    key TEXT PRIMARY KEY, task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    before_snapshot JSONB NOT NULL, correction JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}
