-- Presentation identity only; unrelated to cold-graph age and scheduling.
CREATE TABLE IF NOT EXISTS planner_display_rounds (
  exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  number BIGINT NOT NULL CHECK (number > 0),
  title TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (exploration_id, turn_id),
  UNIQUE (exploration_id, number)
);
