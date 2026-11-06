ALTER TABLE findings ADD COLUMN IF NOT EXISTS reproduction JSONB;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS report_sections JSONB;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS report_revision BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS finding_report_versions (
 id BIGSERIAL PRIMARY KEY, finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL, evidence_version BIGINT NOT NULL, report TEXT NOT NULL DEFAULT '',
 sections JSONB, reproduction JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(finding_id,revision)
);
CREATE TABLE IF NOT EXISTS finding_step_images (
 id UUID PRIMARY KEY, finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
 step_id TEXT, blob_hash TEXT NOT NULL REFERENCES evidence_blobs(hash), mime TEXT NOT NULL,
 caption TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finding_step_images_owner ON finding_step_images(finding_id,position,id);
CREATE TABLE IF NOT EXISTS finding_report_jobs (
 id BIGSERIAL PRIMARY KEY, finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
 conversation_id BIGINT REFERENCES conversations(id), run_id BIGINT,
 evidence_version BIGINT NOT NULL, report_revision BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS finding_report_job_run ON finding_report_jobs(finding_id,run_id);
