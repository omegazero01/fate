-- SERIES PostgreSQL schema (单一数据源)
-- 幂等：可重复执行（IF NOT EXISTS / OR REPLACE / DROP TRIGGER IF EXISTS）。

-- =====================================================================
-- 0. 通用：updated_at 触发器
-- =====================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- 安全的 text→inet 转换：非法值返回 NULL 而不是抛 22P02。assets.ip 是自由文本
-- (Agent / 资产 API 可能写进主机名)，裸转 a.ip::inet 会让单独一行脏数据把整条
-- 企业归属重算语句打挂。调用方用 try_inet(...) IS NULL 找出这些行并告警。
-- 不用 pg_input_is_valid 是因为那要 PG16+，这里要兼容更老的存量库。
CREATE OR REPLACE FUNCTION try_inet(value text) RETURNS inet AS $$
BEGIN
    -- Ordinary DNS names are not inet candidates. Avoid opening/rolling back a
    -- PL/pgSQL exception subtransaction for every domain in authorization scans.
    IF strpos(value, ':')=0 AND value !~ '^[[:space:]0-9./]+$' THEN
        RETURN NULL;
    END IF;
    BEGIN
        RETURN value::inet;
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- =====================================================================
-- A. 资产层：companies / assets / company_scope
-- =====================================================================

CREATE TABLE IF NOT EXISTS companies (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    nkey       TEXT NOT NULL UNIQUE,
    logo       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_companies_nkey ON companies(nkey);
DROP TRIGGER IF EXISTS trg_companies_upd ON companies;
CREATE TRIGGER trg_companies_upd BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS assets (
    id              BIGSERIAL PRIMARY KEY,
    type            TEXT NOT NULL CHECK (type IN (
                        'root_domain','ip','subdomain','app','service','endpoint'
                    )),
    company_id      BIGINT REFERENCES companies(id) ON DELETE SET NULL,
    -- explicit: caller/user selected the company; scope: derived from company_scope.
    -- Existing installations are conservatively migrated as explicit so a scope
    -- rebuild can never erase a historical manual association.
    company_source  TEXT NOT NULL DEFAULT 'explicit'
                    CHECK (company_source IN ('explicit','scope')),
    task_ids        BIGINT[] NOT NULL DEFAULT '{}',
    domain          TEXT,
    root_domain     TEXT,
    ip              TEXT,
    c_segment       CIDR,
    port            INTEGER CHECK (port BETWEEN 1 AND 65535),
    icp             TEXT,
    bound_domains   TEXT[]  NOT NULL DEFAULT '{}',
    open_ports      JSONB[] NOT NULL DEFAULT '{}',
    record_type     TEXT,
    record_value    TEXT[],
    bundle_id       TEXT,
    app_name        TEXT,
    category        TEXT,
    app_description TEXT,
    app_icp         TEXT,
    url             TEXT,
    service_type    TEXT CHECK (service_type IN ('http','other')),
    service_name    TEXT,
    favicon_mmh3    TEXT,
    status_code     INTEGER,
    content_length  BIGINT,
    page_title      TEXT,
    technologies    TEXT[]  NOT NULL DEFAULT '{}',
    auth            JSONB[] NOT NULL DEFAULT '{}',
    method          TEXT,
    params          JSONB[] NOT NULL DEFAULT '{}',
    extra           JSONB   NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_root_domain  ON assets(domain) WHERE type = 'root_domain';
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_ip           ON assets(ip)     WHERE type = 'ip';
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_subdomain    ON assets(domain, COALESCE(record_type,'')) WHERE type = 'subdomain';
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_app_bundle   ON assets(bundle_id) WHERE type = 'app' AND bundle_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_app_name     ON assets(app_name)  WHERE type = 'app' AND bundle_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_service_http ON assets(url) WHERE type = 'service' AND service_type = 'http';
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_service_other
    ON assets(COALESCE(domain,''), COALESCE(ip,''), port, service_name) WHERE type = 'service' AND service_type = 'other';
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_endpoint     ON assets(url, method) WHERE type = 'endpoint';
CREATE INDEX IF NOT EXISTS idx_av2_company      ON assets(company_id)       WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_av2_company_type ON assets(company_id, type) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_av2_task_ids     ON assets USING GIN(task_ids);
CREATE INDEX IF NOT EXISTS idx_av2_domain       ON assets(domain)      WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_av2_root_domain  ON assets(root_domain) WHERE root_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_av2_ip           ON assets(ip)          WHERE ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_av2_c_segment    ON assets USING GIST(c_segment inet_ops) WHERE c_segment IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_av2_technologies ON assets USING GIN(technologies) WHERE type = 'service';
CREATE INDEX IF NOT EXISTS idx_av2_bound_domains ON assets USING GIN(bound_domains) WHERE type = 'ip';
CREATE INDEX IF NOT EXISTS idx_av2_open_ports   ON assets USING GIN(open_ports)    WHERE type = 'ip';
CREATE INDEX IF NOT EXISTS idx_av2_last_seen    ON assets(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_av2_type_seen    ON assets(type, last_seen DESC);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS company_source TEXT;
UPDATE assets SET company_source = 'explicit' WHERE company_source IS NULL;
ALTER TABLE assets ALTER COLUMN company_source SET DEFAULT 'explicit';
ALTER TABLE assets ALTER COLUMN company_source SET NOT NULL;
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_company_source_check;
ALTER TABLE assets ADD CONSTRAINT assets_company_source_check
    CHECK (company_source IN ('explicit','scope'));
DROP TRIGGER IF EXISTS trg_av2_upd ON assets;
CREATE TRIGGER trg_av2_upd BEFORE UPDATE ON assets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS company_scope (
    id         BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('domain','ip','cidr','icp','keyword')),
    domain     TEXT,
    net        CIDR,
    value      TEXT,
    raw        TEXT NOT NULL,
    reason     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_sv2_domain UNIQUE (company_id, domain),
    CONSTRAINT uq_sv2_net    UNIQUE (company_id, net),
    CONSTRAINT ck_company_scope_payload CHECK (
        (kind = 'domain' AND domain IS NOT NULL AND net IS NULL AND value IS NULL)
        OR (kind IN ('ip','cidr') AND domain IS NULL AND net IS NOT NULL AND value IS NULL)
        OR (kind IN ('icp','keyword') AND domain IS NULL AND net IS NULL AND value IS NOT NULL)
    )
);
-- Existing installations need the new text payload and expanded kind check.
ALTER TABLE company_scope ADD COLUMN IF NOT EXISTS value TEXT;
ALTER TABLE company_scope DROP CONSTRAINT IF EXISTS company_scope_kind_check;
ALTER TABLE company_scope ADD CONSTRAINT company_scope_kind_check
    CHECK (kind IN ('domain','ip','cidr','icp','keyword'));
ALTER TABLE company_scope DROP CONSTRAINT IF EXISTS ck_company_scope_payload;
ALTER TABLE company_scope ADD CONSTRAINT ck_company_scope_payload CHECK (
    (kind = 'domain' AND domain IS NOT NULL AND net IS NULL AND value IS NULL)
    OR (kind IN ('ip','cidr') AND domain IS NULL AND net IS NOT NULL AND value IS NULL)
    OR (kind IN ('icp','keyword') AND domain IS NULL AND net IS NULL AND value IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sv2_domain  ON company_scope(domain)   WHERE kind = 'domain';
CREATE INDEX IF NOT EXISTS idx_sv2_net     ON company_scope USING GIST(net inet_ops) WHERE kind IN ('ip','cidr');
DROP INDEX IF EXISTS uq_sv2_value;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sv3_value ON company_scope(company_id, kind, md5(value)) WHERE kind IN ('icp','keyword');
DROP INDEX IF EXISTS idx_sv2_icp;
CREATE INDEX IF NOT EXISTS idx_sv3_icp ON company_scope(md5(value)) WHERE kind = 'icp';
CREATE INDEX IF NOT EXISTS idx_sv2_company ON company_scope(company_id);

-- =====================================================================
-- B. 推理探索层
-- =====================================================================
CREATE TABLE IF NOT EXISTS explorations (
    id          BIGSERIAL PRIMARY KEY,
    description TEXT,
    goal        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','achieved','failed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- cold-digest (§2.3): per-task planner round counter — bumped once each time the
-- planner wakes and processes a round. Drives the ≥R cold-node debounce (measured in
-- this exploration's own rounds, not global node ids or wall-clock).
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS round_no BIGINT NOT NULL DEFAULT 0;
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS planner_todos JSONB NOT NULL DEFAULT '[]'::jsonb;
DROP TRIGGER IF EXISTS trg_exp_upd ON explorations;
CREATE TRIGGER trg_exp_upd BEFORE UPDATE ON explorations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS exploration_nodes (
    id             BIGSERIAL PRIMARY KEY,
    exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    payload        JSONB NOT NULL DEFAULT '{}',
    priority       INT  NOT NULL DEFAULT 0,
    state          TEXT NOT NULL DEFAULT 'open',
    origin         TEXT,
    owner          TEXT,
    blocked_reason TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ,
    CONSTRAINT ck_node_kind CHECK (kind IN ('begin','goal','intent','fact','finding','hint','digest')),
    CONSTRAINT ck_node_state CHECK (
        (kind='begin'   AND state IN ('open')) OR
        (kind='intent'  AND state IN ('open','running','paused','done','blocked','exhausted','stopped')) OR
        (kind='goal'    AND state IN ('open','met','abandoned')) OR
        (kind='fact'    AND state IN ('confirmed','dismissed','origin')) OR
        (kind='finding' AND state IN ('confirmed','dismissed')) OR
        (kind='hint'    AND state IN ('active','consumed')) OR
        (kind='digest'  AND state IN ('active','superseded'))
    )
);
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
-- cold-digest (§2.3/§5.3): content_version bumps on any change that could alter a
-- digest body (summary/state/confidence); cold_since_round stamps the planner round
-- a node most recently went from "has a live downstream branch" to none (NULL = hot).
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS content_version  INT    NOT NULL DEFAULT 0;
-- Report-only revisions invalidate paged reads, but not the underlying execution basis.
-- Existing revisions are retained; no historical version or running contract is rewritten.
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS report_revision INT NOT NULL DEFAULT 0;
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS cold_since_round BIGINT;
-- ck_node_kind: existing installs predate the 'digest' kind — recreate to allow it.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='exploration_nodes'::regclass
          AND conname='ck_node_kind'
          AND pg_get_constraintdef(oid) NOT LIKE '%digest%'
    ) THEN
        ALTER TABLE exploration_nodes DROP CONSTRAINT ck_node_kind;
        ALTER TABLE exploration_nodes ADD CONSTRAINT ck_node_kind
            CHECK (kind IN ('begin','goal','intent','fact','finding','hint','digest'));
    END IF;
END $$;
-- ck_node_state: recreate when it lacks the 'paused' (older) or 'digest' (this rev) branches.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='exploration_nodes'::regclass
          AND conname='ck_node_state'
          AND (pg_get_constraintdef(oid) NOT LIKE '%paused%'
               OR pg_get_constraintdef(oid) NOT LIKE '%superseded%')
    ) THEN
        ALTER TABLE exploration_nodes DROP CONSTRAINT ck_node_state;
        ALTER TABLE exploration_nodes ADD CONSTRAINT ck_node_state CHECK (
            (kind='begin'   AND state IN ('open')) OR
            (kind='intent'  AND state IN ('open','running','paused','done','blocked','exhausted','stopped')) OR
            (kind='goal'    AND state IN ('open','met','abandoned')) OR
            (kind='fact'    AND state IN ('confirmed','dismissed','origin')) OR
            (kind='finding' AND state IN ('confirmed','dismissed')) OR
            (kind='hint'    AND state IN ('active','consumed')) OR
            (kind='digest'  AND state IN ('active','superseded'))
        );
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_expnodes_part     ON exploration_nodes(exploration_id, kind);
CREATE INDEX IF NOT EXISTS idx_expnodes_frontier ON exploration_nodes(exploration_id, priority DESC)
    WHERE kind='intent' AND state='open';
DROP TRIGGER IF EXISTS trg_expnodes_upd ON exploration_nodes;
CREATE TRIGGER trg_expnodes_upd BEFORE UPDATE ON exploration_nodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS exploration_edges (
    exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
    src_id         BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
    dst_id         BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
    rel            TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (exploration_id, src_id, rel, dst_id),
    CONSTRAINT ck_edge_noself CHECK (src_id <> dst_id),
    CONSTRAINT ck_edge_rel CHECK (rel IN ('spawns','derived_from','yields','proves','covers'))
);
CREATE INDEX IF NOT EXISTS idx_expedges_src ON exploration_edges(src_id, rel);
CREATE INDEX IF NOT EXISTS idx_expedges_dst ON exploration_edges(dst_id, rel);
-- Stable continuation cursor; preserve the existing composite primary key.
ALTER TABLE exploration_edges ADD COLUMN IF NOT EXISTS id BIGSERIAL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_expedges_cursor ON exploration_edges(id);
-- cold-digest (§1): the 'covers' relation (digest→member) postdates shipped installs,
-- whose rel CHECK is an inline auto-named constraint. Find and recreate it as ck_edge_rel.
DO $$
DECLARE cname text;
BEGIN
    SELECT conname INTO cname FROM pg_constraint
     WHERE conrelid='exploration_edges'::regclass AND contype='c'
       AND pg_get_constraintdef(oid) LIKE '%rel%'
       AND pg_get_constraintdef(oid) NOT LIKE '%covers%';
    IF cname IS NOT NULL THEN
        EXECUTE 'ALTER TABLE exploration_edges DROP CONSTRAINT '||quote_ident(cname);
        ALTER TABLE exploration_edges ADD CONSTRAINT ck_edge_rel
            CHECK (rel IN ('spawns','derived_from','yields','proves','covers'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS exploration_anchors (
    node_id   BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
    asset_id  BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    PRIMARY KEY (node_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_anchor_asset ON exploration_anchors(asset_id);

-- task_constraints: operator-authored operation constraints (allow/deny) for a task.
-- Extracted by the goals decomposer at round 0 (from goal/description), editable at
-- runtime by the main agent + 总览「约束管理」. Injected into the planner/worker system
-- prompt each round (config-gated) to keep exploration within the operator's boundary.
CREATE TABLE IF NOT EXISTS task_constraints (
    id             BIGSERIAL PRIMARY KEY,
    exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('allow','deny')),
    text           TEXT NOT NULL,
    origin         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_constraints_exp ON task_constraints(exploration_id);

CREATE TABLE IF NOT EXISTS activity (
    id                 BIGSERIAL PRIMARY KEY,
    exploration_id     BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
    node_id            BIGINT REFERENCES exploration_nodes(id) ON DELETE SET NULL,
    worker             TEXT,
    kind               TEXT,
    tool               TEXT,
    tool_use_id        TEXT,
    is_error           BOOLEAN NOT NULL DEFAULT false,
    summary            TEXT,
    detail             TEXT,
    metadata           JSONB NOT NULL DEFAULT '{}',
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE activity ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
-- main_seg segments the main-agent session into resettable conversations: a new
-- main session bumps the segment so its transcript + activity start clean while the
-- task's graph/assets/goal are untouched. NULL == legacy rows == segment 0 (the
-- original session). Only worker='mainagent' rows carry it.
ALTER TABLE activity ADD COLUMN IF NOT EXISTS main_seg INTEGER;
CREATE INDEX IF NOT EXISTS idx_act_node  ON activity(exploration_id, node_id, id);
CREATE INDEX IF NOT EXISTS idx_act_since ON activity(exploration_id, id);
CREATE INDEX IF NOT EXISTS idx_act_tool_call ON activity(exploration_id, tool_use_id, id)
  WHERE kind IN ('tool_use', 'tool_result');
-- Main/Plan history pages filter by worker (both carry NULL node_id, so idx_act_node
-- can't distinguish them); this covers reverse pagination of those sessions.
CREATE INDEX IF NOT EXISTS idx_act_worker ON activity(exploration_id, worker, id);
-- Main-session pages filter by segment on top of worker='mainagent'; this partial
-- index covers reverse pagination within one segment.
CREATE INDEX IF NOT EXISTS idx_act_main_seg ON activity(exploration_id, main_seg, id)
    WHERE worker='mainagent';
-- Task-list polls aggregate result usage and find the latest event repeatedly.
-- Cover the token columns for index-only aggregation and the timestamp order for
-- per-exploration latest-activity lookups.
CREATE INDEX IF NOT EXISTS idx_act_result_usage ON activity(exploration_id)
    INCLUDE (input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    WHERE kind='result';
CREATE INDEX IF NOT EXISTS idx_act_latest ON activity(exploration_id, created_at DESC);
-- Tool final-output lookup: result first, latest text as fallback, without a
-- prefix scan or sorting an entire long-running worker stream.
CREATE INDEX IF NOT EXISTS idx_act_worker_output ON activity
    (node_id, (CASE WHEN kind='result' THEN 0 ELSE 1 END), id DESC)
    WHERE kind IN ('result','text');

-- main_sessions records the resettable main-agent conversation segments of a task.
-- Segment 0 (the original session) is implicit and never stored; this table holds
-- only the extra segments created by "新建会话" (seq >= 1). The current segment is
-- MAX(seq) or 0. Each segment gets its own transcript file + activity slice; the
-- task's exploration graph/assets/goal are shared and never reset.
CREATE TABLE IF NOT EXISTS main_sessions (
    exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (exploration_id, seq)
);

-- =====================================================================
-- C. LLM profiles
-- =====================================================================
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS llm_profiles (
    id               BIGSERIAL PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    format           TEXT NOT NULL CHECK (format IN ('openai','anthropic','openai-responses')),
    base_url         TEXT,
    proxy            TEXT,
    model            TEXT NOT NULL,
    api_key          TEXT,
    api_key_hint     TEXT,
    rate_per_second  DOUBLE PRECISION NOT NULL DEFAULT 0,
    rate_per_minute  DOUBLE PRECISION NOT NULL DEFAULT 0,
    context_window_k INTEGER NOT NULL DEFAULT 0,
    -- 思考参数拆成两个独立字段：thinking_type=思考开关(''/disabled/enabled)，
    -- reasoning_effort=思考强度(''/low/medium/high/xhigh/max)，互不牵连。
    reasoning_effort TEXT NOT NULL DEFAULT '',
    thinking_type    TEXT NOT NULL DEFAULT '',
    is_default       BOOLEAN NOT NULL DEFAULT false,
    -- 轮询(故障转移)参数，见 docs/LLM轮询设计.md：
    --   priority     顺位，越大越先被选中；激活配置(is_default)永远排链首，与本值无关。
    --   pool_exclude true=不作为故障转移目标(仍可被 agent/任务显式绑定使用)。
    priority         INTEGER NOT NULL DEFAULT 0,
    pool_exclude     BOOLEAN NOT NULL DEFAULT false,
    -- streaming=true(默认)走流式 SSE；false 走真·非流式(stream:false，一次性 JSON)。
    streaming        BOOLEAN NOT NULL DEFAULT true,
    -- 单次回复的输出上限(token)。0=不发送该字段，由服务端默认值决定——保持既有行为。
    -- 与 context_window_k(模型总容量，仅本地用于压缩阈值)是两回事：本值会随请求发出。
    max_tokens       INTEGER NOT NULL DEFAULT 0,
    -- 输出上限用哪个请求字段名，仅对 format='openai' 生效：
    --   ''                      = max_tokens(默认，兼容绝大多数网关)
    --   'max_completion_tokens' = 新字段；OpenAI 推理模型(o 系列/GPT-5)只认它，
    --                             发 max_tokens 会被 unsupported_parameter 拒绝。
    -- anthropic(max_tokens 必填)与 openai-responses(max_output_tokens)自带字段名，不受此值影响。
    max_tokens_field TEXT NOT NULL DEFAULT '',
    -- 自定义会话头：非空时每次请求带一个该名字的 HTTP 头，头值=当前运行的 session id
    -- (chat 会话/worker 意图)。用于某些按 session-id 头做提示缓存/粘性路由的网关。''=不发送。
    session_header_key TEXT NOT NULL DEFAULT '',
    -- 重试覆盖：次数 0=用全局默认/-1=关闭/>0=该值；间隔 0=用默认指数退避/>0=固定毫秒。
    -- 三组分别对应建连重试、空响应重试、同 provider 安全窗口重试，详见下方 ALTER 处注释。
    retry_connect_attempts    INTEGER NOT NULL DEFAULT 0,
    retry_connect_interval_ms INTEGER NOT NULL DEFAULT 0,
    retry_empty_attempts      INTEGER NOT NULL DEFAULT 0,
    retry_empty_interval_ms   INTEGER NOT NULL DEFAULT 0,
    retry_stream_attempts     INTEGER NOT NULL DEFAULT 0,
    retry_stream_interval_ms  INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_one_default ON llm_profiles(is_default) WHERE is_default;
DROP TRIGGER IF EXISTS trg_llm_upd ON llm_profiles;
CREATE TRIGGER trg_llm_upd BEFORE UPDATE ON llm_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- 轮询顺位/排除标记；补旧库。默认 0 / false = 全部配置都参与轮询。
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS priority     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS pool_exclude BOOLEAN NOT NULL DEFAULT false;
-- 流式开关；补旧库。默认 true = 保持既有的流式行为，旧配置无感升级。
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS streaming    BOOLEAN NOT NULL DEFAULT true;
-- 放开 format 约束以容纳 openai-responses(OpenAI Responses API)；补旧库。
-- 每次启动执行,幂等:先删旧 CHECK 再建含三值的新 CHECK。
ALTER TABLE llm_profiles DROP CONSTRAINT IF EXISTS llm_profiles_format_check;
ALTER TABLE llm_profiles ADD  CONSTRAINT llm_profiles_format_check
    CHECK (format IN ('openai','anthropic','openai-responses'));

-- 输出上限及其字段名；补旧库。默认 0 / '' = 不发送上限、沿用 max_tokens 字段名，
-- 旧配置行为完全不变。
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS max_tokens       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS max_tokens_field TEXT    NOT NULL DEFAULT '';
-- 同 format：先删再建，保证每次启动幂等。
ALTER TABLE llm_profiles DROP CONSTRAINT IF EXISTS llm_profiles_max_tokens_field_check;
ALTER TABLE llm_profiles ADD  CONSTRAINT llm_profiles_max_tokens_field_check
    CHECK (max_tokens_field IN ('','max_completion_tokens'));
ALTER TABLE llm_profiles DROP CONSTRAINT IF EXISTS llm_profiles_max_tokens_check;
ALTER TABLE llm_profiles ADD  CONSTRAINT llm_profiles_max_tokens_check
    CHECK (max_tokens >= 0);
-- 自定义会话头名；补旧库。默认 '' = 不发送，旧配置行为不变。
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS session_header_key TEXT NOT NULL DEFAULT '';

-- 单配置的重试覆盖（见 docs/LLM重试设计.md）。三组各自一对「次数 + 固定间隔」，
-- 语义统一：次数 0=沿用全局默认、-1=关闭该层重试、>0=用该值；间隔 0=沿用该层的
-- 默认指数退避、>0=改用这个固定毫秒数。全部默认 0，所以旧库/旧配置行为不变。
--   connect = 建连重试（SDK doStream：连接重置/超时/429/5xx，流开始前）
--   empty   = 空响应重试（SDK：完成但没有任何 content block，仅 openai 格式）
--   stream  = 同 provider 安全窗口重试（本项目 task_llm：未交付输出前的断流重放）
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS retry_connect_attempts    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS retry_connect_interval_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS retry_empty_attempts      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS retry_empty_interval_ms   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS retry_stream_attempts     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS retry_stream_interval_ms  INTEGER NOT NULL DEFAULT 0;
-- 同 format：先删再建，保证每次启动幂等。次数下限 -1(关闭)，间隔不能为负。
ALTER TABLE llm_profiles DROP CONSTRAINT IF EXISTS llm_profiles_retry_check;
ALTER TABLE llm_profiles ADD  CONSTRAINT llm_profiles_retry_check CHECK (
    retry_connect_attempts >= -1 AND retry_empty_attempts >= -1 AND retry_stream_attempts >= -1
    AND retry_connect_interval_ms >= 0 AND retry_empty_interval_ms >= 0 AND retry_stream_interval_ms >= 0);

-- 思考开关字段 thinking_type，从旧的单一 reasoning_effort 语义一次性拆分而来。
-- schema.sql 每次启动都执行，故迁移必须只跑一次：仅当该列尚不存在时才回填，
-- 否则每次启动都会把用户后来手动设的组合覆盖回去。旧 reasoning_effort 语义：
--   'off'                    → 显式关闭  → thinking_type='disabled'，强度清空
--   'low/medium/high/max'    → 开启+强度 → thinking_type='enabled'，强度保留
--   ''                       → 不发送    → 两者皆空(默认)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'llm_profiles' AND column_name = 'thinking_type'
    ) THEN
        ALTER TABLE llm_profiles ADD COLUMN thinking_type TEXT NOT NULL DEFAULT '';
        UPDATE llm_profiles SET thinking_type = 'enabled'
            WHERE reasoning_effort IN ('low','medium','high','max');
        UPDATE llm_profiles SET thinking_type = 'disabled', reasoning_effort = ''
            WHERE reasoning_effort = 'off';
    END IF;
END $$;

-- LLM 轮询熔断状态：某个配置连续失败(余额不足/key 失效/限流)后进入冷却，冷却期内
-- 轮询直接跳过它。内存态为准，这里落库只为重启后不丢冷却窗口——加载时只取尚未
-- 到期的行(open_until > now)，已到期的自然回到"正常"，等下一次调用半开试探。
CREATE TABLE IF NOT EXISTS llm_profile_health (
    profile_id  BIGINT PRIMARY KEY REFERENCES llm_profiles(id) ON DELETE CASCADE,
    fails       INTEGER NOT NULL DEFAULT 0,  -- 当前连续失败次数(成功即清零)
    trips       INTEGER NOT NULL DEFAULT 0,  -- 累计熔断次数,用于冷却时间指数退避
    open_until  TIMESTAMPTZ,                 -- 冷却截止;NULL/过期 = 未熔断
    last_error  TEXT NOT NULL DEFAULT '',
    last_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- D. 任务层
-- =====================================================================
-- Global task categories are intentionally independent from task templates.
-- Deleting a category only moves its tasks back to the uncategorized bucket.
CREATE TABLE IF NOT EXISTS task_categories (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    nkey       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_categories_name ON task_categories(name, id);
DROP TRIGGER IF EXISTS trg_task_categories_upd ON task_categories;
CREATE TRIGGER trg_task_categories_upd BEFORE UPDATE ON task_categories
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS tasks (
    id             BIGSERIAL PRIMARY KEY,
    name           TEXT NOT NULL DEFAULT '',
    category_id    BIGINT REFERENCES task_categories(id) ON DELETE SET NULL,
    description    TEXT NOT NULL,
    goal           TEXT NOT NULL,
    exploration_id BIGINT NOT NULL UNIQUE
                     REFERENCES explorations(id) ON DELETE RESTRICT,
    status         TEXT NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created','running','paused','done','failed','timeout')),
    paused         BOOLEAN NOT NULL DEFAULT false,
    queued         BOOLEAN NOT NULL DEFAULT false,
    queued_at      TIMESTAMPTZ,
    queue_mode     TEXT NOT NULL DEFAULT '',
    llm_profile_id BIGINT REFERENCES llm_profiles(id) ON DELETE SET NULL,
    active_llm_profile_id BIGINT REFERENCES llm_profiles(id) ON DELETE SET NULL,
    llm_chain_revision BIGINT NOT NULL DEFAULT 0,
    company_id     BIGINT REFERENCES companies(id) ON DELETE SET NULL,
    parent_ref     TEXT,
    timeout_seconds INTEGER NOT NULL DEFAULT 0,
    plan_heartbeat_seconds INTEGER NOT NULL DEFAULT 300,
    coverage_enabled BOOLEAN NOT NULL DEFAULT true,
    pinned_at      TIMESTAMPTZ,
    first_run_at   TIMESTAMPTZ,
    deadline_at    TIMESTAMPTZ,
    archived_at    TIMESTAMPTZ,
    deleted_at     TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_alive  ON tasks(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)          WHERE deleted_at IS NULL;
DROP TRIGGER IF EXISTS trg_tasks_upd ON tasks;
CREATE TRIGGER trg_tasks_upd BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- planner 心跳触发间隔(秒);补旧库。默认 300s(5min)。见 docs/planner-trigger-impl-plan.md
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_heartbeat_seconds INTEGER NOT NULL DEFAULT 300;
-- 并发上限挂起态;补旧库。true=因并发上限排队、等待空位自动启动。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS queued BOOLEAN NOT NULL DEFAULT false;
-- 资产覆盖度功能开关;补旧库。true(默认)=计算/展示测试覆盖度、自动累积测试范围、
-- 给 agent 开放 add_task_scope/list_untested_assets;false=全部关闭(见 task_scope.go)。
-- 存量任务默认 true 保持原行为;company 关联(task_scope kind=company)不受此开关影响。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS coverage_enabled BOOLEAN NOT NULL DEFAULT true;
-- queued_at makes admission FIFO reflect the actual enqueue order rather than the
-- task creation order. queue_mode distinguishes first bootstrap from resuming an
-- exploration that already owns goals/history.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS queue_mode TEXT NOT NULL DEFAULT '';
-- 可选的任务名称;补旧库。空串=未命名,前端展示时回退到描述。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES task_categories(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS active_llm_profile_id BIGINT REFERENCES llm_profiles(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS llm_chain_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category_id, created_at DESC)
    WHERE deleted_at IS NULL AND category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_pinned ON tasks(pinned_at DESC)
    WHERE deleted_at IS NULL AND pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at DESC)
    WHERE archived_at IS NOT NULL;

-- Cold task archives retain only compact metadata in PostgreSQL. The complete
-- task payload lives in a versioned .tar.zst package under data/archives/tasks.
-- task_id stays unique so an operation can be retried safely after a restart.
CREATE TABLE IF NOT EXISTS task_archives (
    id                         BIGSERIAL PRIMARY KEY,
    task_id                    BIGINT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    state                      TEXT NOT NULL DEFAULT 'archive_queued' CHECK (state IN (
                                   'archive_queued','archiving','archive_failed','ready',
                                   'restore_queued','restoring','restore_failed',
                                   'delete_queued','deleting','delete_failed'
                               )),
    phase                      TEXT NOT NULL DEFAULT 'queued',
    progress                   INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    error                      TEXT NOT NULL DEFAULT '',
    warnings                   JSONB NOT NULL DEFAULT '[]',
    format_version             INTEGER NOT NULL DEFAULT 2,
    archive_path               TEXT NOT NULL DEFAULT '',
    sha256                     TEXT NOT NULL DEFAULT '',
    original_size              BIGINT NOT NULL DEFAULT 0,
    compressed_size            BIGINT NOT NULL DEFAULT 0,
    task_name                  TEXT NOT NULL DEFAULT '',
    task_description           TEXT NOT NULL DEFAULT '',
    task_goal                  TEXT NOT NULL DEFAULT '',
    original_status            TEXT NOT NULL DEFAULT '',
    category_id_snapshot       BIGINT,
    category_name_snapshot     TEXT NOT NULL DEFAULT '',
    source_task_ids            BIGINT[] NOT NULL DEFAULT '{}',
    remaining_timeout_seconds  BIGINT NOT NULL DEFAULT 0,
    data_counts                JSONB NOT NULL DEFAULT '{}',
    aggregate_stats            JSONB NOT NULL DEFAULT '{}',
    archived_at                TIMESTAMPTZ,
    requested_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE task_archives ALTER COLUMN format_version SET DEFAULT 2;
CREATE INDEX IF NOT EXISTS idx_task_archives_state ON task_archives(state, requested_at, id);
CREATE INDEX IF NOT EXISTS idx_task_archives_archived ON task_archives(archived_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_task_archives_sources ON task_archives USING GIN(source_task_ids);
DROP TRIGGER IF EXISTS trg_task_archives_upd ON task_archives;
CREATE TRIGGER trg_task_archives_upd BEFORE UPDATE ON task_archives
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Reusable task description/goal presets. nkey is the normalized, case-insensitive
-- identity used to reject visually equivalent duplicate names.
CREATE TABLE IF NOT EXISTS task_templates (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    nkey        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    goal        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_templates_updated ON task_templates(updated_at DESC, id DESC);
DROP TRIGGER IF EXISTS trg_task_templates_upd ON task_templates;
CREATE TRIGGER trg_task_templates_upd BEFORE UPDATE ON task_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Direct, read-only task context inheritance. Relations are intentionally not
-- recursive: a task sees only the source tasks explicitly chosen at creation.
CREATE TABLE IF NOT EXISTS task_relations (
    task_id        BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source_task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, source_task_id),
    CONSTRAINT ck_task_relation_not_self CHECK (task_id <> source_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_relations_source ON task_relations(source_task_id);

-- Task/asset provenance supplements the legacy assets.task_ids association. The
-- array remains the compatibility source for existing query and cleanup paths;
-- this relation records how each association was obtained for operator review.
CREATE TABLE IF NOT EXISTS task_asset_links (
    task_id        BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    asset_id       BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    source         TEXT NOT NULL DEFAULT 'system',
    source_summary TEXT NOT NULL DEFAULT '',
    source_node_id BIGINT REFERENCES exploration_nodes(id) ON DELETE SET NULL,
    tested         BOOLEAN NOT NULL DEFAULT false,
    tested_at      TIMESTAMPTZ,
    tested_by      TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, asset_id)
);
ALTER TABLE task_asset_links ADD COLUMN IF NOT EXISTS source_origin JSONB;
ALTER TABLE task_asset_links ADD COLUMN IF NOT EXISTS tested BOOLEAN;
UPDATE task_asset_links SET tested=false WHERE tested IS NULL;
ALTER TABLE task_asset_links ALTER COLUMN tested SET DEFAULT false;
ALTER TABLE task_asset_links ALTER COLUMN tested SET NOT NULL;
ALTER TABLE task_asset_links ADD COLUMN IF NOT EXISTS tested_at TIMESTAMPTZ;
ALTER TABLE task_asset_links ADD COLUMN IF NOT EXISTS tested_by TEXT;
CREATE INDEX IF NOT EXISTS idx_task_asset_links_asset ON task_asset_links(asset_id, task_id);
CREATE INDEX IF NOT EXISTS idx_task_asset_links_tested ON task_asset_links(task_id, tested, asset_id);
CREATE INDEX IF NOT EXISTS idx_task_asset_links_node ON task_asset_links(source_node_id)
    WHERE source_node_id IS NOT NULL;
DROP TRIGGER IF EXISTS trg_task_asset_links_upd ON task_asset_links;
CREATE TRIGGER trg_task_asset_links_upd BEFORE UPDATE ON task_asset_links
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keep provenance rows synchronized when existing asset upsert paths append or
-- remove task ids. Detailed callers overwrite the generic source after upsert.
CREATE OR REPLACE FUNCTION sync_task_asset_links() RETURNS trigger AS $$
DECLARE
    agent_discovery boolean := COALESCE(current_setting('series.agent_discovery', true), '') = 'on';
BEGIN
    INSERT INTO task_asset_links(
        task_id, asset_id, source, source_summary, source_origin
    )
    SELECT task.id,
           NEW.id,
           CASE WHEN agent_discovery THEN 'agent' ELSE 'system' END,
           CASE WHEN agent_discovery THEN 'Agent 通过 insert_assets 登记' ELSE '任务执行期间自动关联' END,
           CASE WHEN agent_discovery AND task.id::text = current_setting('series.origin_task',true)
                THEN NULLIF(current_setting('series.asset_origin',true),'')::jsonb ELSE NULL END
    FROM unnest(NEW.task_ids) AS requested(task_id)
    JOIN tasks task ON task.id=requested.task_id AND task.deleted_at IS NULL
    ON CONFLICT (task_id, asset_id) DO NOTHING;

    DELETE FROM task_asset_links link
    WHERE link.asset_id=NEW.id
      AND NOT (link.task_id=ANY(NEW.task_ids));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_assets_task_links ON assets;
CREATE TRIGGER trg_assets_task_links AFTER INSERT OR UPDATE OF task_ids ON assets
    FOR EACH ROW EXECUTE FUNCTION sync_task_asset_links();

-- Existing installations receive an auditable legacy source without rewriting
-- task_ids. Ignore stale array ids that no longer resolve to a live task.
INSERT INTO task_asset_links(task_id, asset_id, source, source_summary)
SELECT task.id, asset.id, 'legacy', '由历史任务资产关联迁移'
FROM assets asset
CROSS JOIN LATERAL unnest(asset.task_ids) AS requested(task_id)
JOIN tasks task ON task.id=requested.task_id AND task.deleted_at IS NULL
ON CONFLICT (task_id, asset_id) DO NOTHING;

-- Backfill the task-local tested flag for existing installations. Facts and
-- findings already anchored to an asset are durable evidence that an agent
-- tested it; later writes maintain the flag directly from the write tools.
WITH first_test AS (
    SELECT task.id AS task_id, anchor.asset_id,
           MIN(node.created_at) AS tested_at,
           (ARRAY_AGG(NULLIF(node.origin,'') ORDER BY node.created_at, node.id)
             FILTER (WHERE NULLIF(node.origin,'') IS NOT NULL))[1] AS tested_by
    FROM tasks task
    JOIN exploration_nodes node ON node.exploration_id=task.exploration_id
                               AND node.kind IN ('fact','finding')
                               AND node.state <> 'origin'
    JOIN exploration_anchors anchor ON anchor.node_id=node.id
    GROUP BY task.id, anchor.asset_id
)
UPDATE task_asset_links link
SET tested=true,
    tested_at=COALESCE(link.tested_at, first_test.tested_at),
    tested_by=COALESCE(NULLIF(link.tested_by,''), first_test.tested_by)
FROM first_test
WHERE link.task_id=first_test.task_id
  AND link.asset_id=first_test.asset_id
  AND NOT link.tested;

-- Ordered task-level LLM failover chain. A quota-exhausted entry is skipped
-- until the user saves/resets the chain, which clears all failure state.
CREATE TABLE IF NOT EXISTS task_llm_profiles (
    task_id          BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    profile_id       BIGINT NOT NULL REFERENCES llm_profiles(id) ON DELETE CASCADE,
    position         INTEGER NOT NULL CHECK (position >= 0),
    status           TEXT NOT NULL DEFAULT 'ready'
                       CHECK (status IN ('ready','quota_exhausted')),
    last_error       TEXT,
    exhausted_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, profile_id),
    UNIQUE (task_id, position)
);
CREATE INDEX IF NOT EXISTS idx_task_llm_profiles_order ON task_llm_profiles(task_id, position);
CREATE INDEX IF NOT EXISTS idx_task_llm_profiles_profile ON task_llm_profiles(profile_id, task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_llm_profile ON tasks(llm_profile_id) WHERE llm_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_active_llm_profile ON tasks(active_llm_profile_id) WHERE active_llm_profile_id IS NOT NULL;
DROP TRIGGER IF EXISTS trg_task_llm_profiles_upd ON task_llm_profiles;
CREATE TRIGGER trg_task_llm_profiles_upd BEFORE UPDATE ON task_llm_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One-time-compatible backfill: old pinned tasks become one-entry chains. A user
-- can still clear the chain later because the update path also clears the legacy
-- llm_profile_id column, preventing this block from re-adding it on restart.
INSERT INTO task_llm_profiles(task_id, profile_id, position)
SELECT t.id, t.llm_profile_id, 0
FROM tasks t
WHERE t.llm_profile_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM task_llm_profiles x WHERE x.task_id=t.id)
ON CONFLICT DO NOTHING;
UPDATE tasks t
SET active_llm_profile_id = t.llm_profile_id
WHERE t.active_llm_profile_id IS NULL
  AND t.llm_profile_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM task_llm_profiles x WHERE x.task_id=t.id AND x.profile_id=t.llm_profile_id);

-- 任务测试范围（资产分类与覆盖度的分母）。
--   自动填(source='auto')：insertAssets 顶层按 worker 显式插入的资产类型加保守范围
--     （root_domain→root_domain，subdomain/service/endpoint→subdomain(host)，ip→ip）；
--     side-effect 派生的资产不入范围（钩子在 handler 顶层，派生在 db 层内部）。
--   agent 填(source='agent')：add_task_scope 加 company/root_domain/subdomain/ip。
-- 覆盖度 = 匹配 active 行的 assets（分母）中，被 fact 节点锚定过的占比（分子）。
CREATE TABLE IF NOT EXISTS task_scope (
    id          BIGSERIAL PRIMARY KEY,
    task_id     BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('company','root_domain','subdomain','ip','cidr','icp','keyword')),
    company_id  BIGINT REFERENCES companies(id) ON DELETE CASCADE,  -- kind='company'
    domain      TEXT,          -- root_domain / subdomain
    net         CIDR,          -- ip / cidr
    value       TEXT,          -- icp / keyword
    source      TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','agent','manual')),
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 旧库升级：扩展任务范围，使其与企业范围的单文本框识别能力一致。
ALTER TABLE task_scope ADD COLUMN IF NOT EXISTS value TEXT;
ALTER TABLE task_scope DROP CONSTRAINT IF EXISTS task_scope_kind_check;
ALTER TABLE task_scope ADD CONSTRAINT task_scope_kind_check
    CHECK (kind IN ('company','root_domain','subdomain','ip','cidr','icp','keyword'));
-- 去重：同一 task 的同一条范围只存一次（自动填批量插入靠它幂等）。
DROP INDEX IF EXISTS uq_task_scope;
DROP INDEX IF EXISTS uq_task_scope_v2;
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_scope_v3 ON task_scope(
    task_id, kind, COALESCE(domain,''), COALESCE(net::text,''), COALESCE(company_id,0), md5(COALESCE(value,'')));
CREATE INDEX IF NOT EXISTS idx_ts_domain  ON task_scope(domain) WHERE kind IN ('root_domain','subdomain');
CREATE INDEX IF NOT EXISTS idx_ts_net     ON task_scope USING GIST(net inet_ops) WHERE kind IN ('ip','cidr');
CREATE INDEX IF NOT EXISTS idx_ts_company ON task_scope(company_id) WHERE kind = 'company';

-- =====================================================================
-- E. Agents / 提示词模板 / 变量目录
-- =====================================================================
CREATE TABLE IF NOT EXISTS agents (
    id                BIGSERIAL PRIMARY KEY,
    key               TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
    name              TEXT NOT NULL,
    description       TEXT,
    role              TEXT NOT NULL,
    builtin           BOOLEAN NOT NULL DEFAULT true,
    enabled           BOOLEAN NOT NULL DEFAULT true,
    llm_profile_id    BIGINT REFERENCES llm_profiles(id) ON DELETE SET NULL,
    current_prompt_id BIGINT,
    max_turns         INTEGER NOT NULL DEFAULT 0,
    run_seconds       INTEGER NOT NULL DEFAULT 1200,
    web_search        BOOLEAN NOT NULL DEFAULT false,
    interactive_shell BOOLEAN NOT NULL DEFAULT false,
    wrapup_prompt     TEXT NOT NULL DEFAULT '',
    wrapup_max_turns  INTEGER NOT NULL DEFAULT 0,
    task_timeout_wrapup_prompt    TEXT NOT NULL DEFAULT '',
    task_timeout_wrapup_max_turns INTEGER NOT NULL DEFAULT 0,
    trigger_run_mode     TEXT    NOT NULL DEFAULT 'serial'  CHECK (trigger_run_mode IN ('serial','parallel')),
    trigger_merge_mode   TEXT    NOT NULL DEFAULT 'all' CHECK (trigger_merge_mode IN ('by_task','all','none')),
    trigger_max_parallel INTEGER NOT NULL DEFAULT 5,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agents_role_ck CHECK (role IN ('goals','main','planner','worker','assistant'))
);
-- 加列迁移(已发版,旧库升级补列;新库 CREATE 已含。迁移不带 CHECK:旧库存量安全 + 后端写入白名单兜底)。
ALTER TABLE agents ADD COLUMN IF NOT EXISTS trigger_run_mode     TEXT    NOT NULL DEFAULT 'serial';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS trigger_merge_mode   TEXT    NOT NULL DEFAULT 'all';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS trigger_max_parallel INTEGER NOT NULL DEFAULT 5;
-- per-agent LLM 绑定(agent 级默认模型):列自初版即在上方 CREATE 中,此 ALTER 仅为极旧库兜底(幂等)。
ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_profile_id BIGINT REFERENCES llm_profiles(id) ON DELETE SET NULL;
-- run_seconds 单次 run 墙钟默认 600→1200:只改列默认(影响将来新插入的行),不动旧库存量行。
ALTER TABLE agents ALTER COLUMN run_seconds SET DEFAULT 1200;
CREATE INDEX IF NOT EXISTS idx_agents_llm_profile ON agents(llm_profile_id) WHERE llm_profile_id IS NOT NULL;
DROP TRIGGER IF EXISTS trg_agents_upd ON agents;
CREATE TRIGGER trg_agents_upd BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS agent_prompts (
    id            BIGSERIAL PRIMARY KEY,
    agent_id      BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    version       INT NOT NULL,
    template_text TEXT NOT NULL,
    note          TEXT,
    updated_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, version)
);
-- 循环外键：agents.current_prompt_id → agent_prompts.id（需在两表创建后加）
DO $$ BEGIN
    ALTER TABLE agents ADD CONSTRAINT fk_agents_curprompt
        FOREIGN KEY (current_prompt_id) REFERENCES agent_prompts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS agent_prompt_vars (
    id          BIGSERIAL PRIMARY KEY,
    agent_id    BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    var_name    TEXT NOT NULL,
    description TEXT,
    example     TEXT,
    source      TEXT NOT NULL CHECK (source IN ('exploration','runtime','distilled')),
    UNIQUE (agent_id, var_name)
);

-- =====================================================================
-- F. MCP 服务
-- =====================================================================
CREATE TABLE IF NOT EXISTS mcp_servers (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    transport   TEXT NOT NULL CHECK (transport IN ('stdio','http','sse')),
    command     TEXT,
    args        JSONB NOT NULL DEFAULT '[]',
    env         JSONB NOT NULL DEFAULT '{}',
    url         TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    insecure    BOOLEAN NOT NULL DEFAULT false,  -- http: 跳过 TLS 证书校验(自签证书场景, issue #108)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Allow legacy MCP SSE servers on databases created before SSE support.
ALTER TABLE mcp_servers DROP CONSTRAINT IF EXISTS mcp_servers_transport_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_transport_check
    CHECK (transport IN ('stdio','http','sse'));
-- 旧库补列(schema.sql 每次启动都会 Exec)。
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS insecure BOOLEAN NOT NULL DEFAULT false;
DROP TRIGGER IF EXISTS trg_mcp_upd ON mcp_servers;
CREATE TRIGGER trg_mcp_upd BEFORE UPDATE ON mcp_servers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 默认数据源占位：ScopeSentry 资产同步 MCP（地址与认证均留空、未启用）。
-- 供「资产同步」页检测数据源是否已配置；用户在页面填入 url 与 X-API-Key 后再启用。
-- 仅在缺失时插入，绝不覆盖用户已配置/已启用的服务器（schema.sql 每次启动都会 Exec）。
INSERT INTO mcp_servers (name, transport, url, env, enabled)
VALUES ('ScopeSentry', 'http', NULL, '{"X-API-Key":""}', false)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS mcp_tools_cache (
    id            BIGSERIAL PRIMARY KEY,
    server_id     BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    tool_name     TEXT NOT NULL,
    description   TEXT,
    schema        JSONB,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (server_id, tool_name)
);

-- =====================================================================
-- G. 可见性：agent × mcp / skill
-- =====================================================================
CREATE TABLE IF NOT EXISTS agent_visibility (
    agent_id      BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    resource_kind TEXT   NOT NULL CHECK (resource_kind IN ('mcp')),
    resource_id   BIGINT NOT NULL,
    mcp_tool_name TEXT   NOT NULL DEFAULT '',
    enabled       BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, resource_kind, resource_id, mcp_tool_name)
);
CREATE INDEX IF NOT EXISTS idx_vis_resource ON agent_visibility(resource_kind, resource_id);

CREATE TABLE IF NOT EXISTS agent_skill_visibility (
    agent_id   BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_name TEXT   NOT NULL,
    enabled    BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, skill_name)
);
CREATE INDEX IF NOT EXISTS idx_askv_skill ON agent_skill_visibility(skill_name);

-- Skill 调用账本（见 db/skill_usage.go）。一次 Skill() 调用一行，只记维度不记正文。
-- 刻意不设外键：任务/会话删除后统计仍要保留（与 llm_usage 同理），skill 本身也只是
-- 文件系统上的目录名，没有对应的表。
CREATE TABLE IF NOT EXISTS skill_usage (
    id             BIGSERIAL PRIMARY KEY,
    ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
    skill          TEXT NOT NULL,
    agent_key      TEXT,
    task_id        BIGINT,
    exploration_id BIGINT,
    intent_id      BIGINT,
    session_id     TEXT,
    args_len       INTEGER NOT NULL DEFAULT 0,
    -- false = 模型点名了一个不存在的 skill(未命中)。这类行同样保留：它反映"想用但没有"
    -- 的缺口，是补 skill 的依据。
    found          BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage(skill, ts DESC);
CREATE INDEX IF NOT EXISTS idx_skill_usage_task  ON skill_usage(task_id);

-- 工具调用账本（见 db/tool_usage.go）。一次实际 CoreTool.Call 一行，只记归属维度，
-- 不保存工具参数或返回内容。刻意不设外键，任务、会话或自定义工具删除后仍保留统计。
CREATE TABLE IF NOT EXISTS tool_usage (
    id             BIGSERIAL PRIMARY KEY,
    ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
    tool_key       TEXT NOT NULL,
    agent_key      TEXT,
    task_id        BIGINT,
    exploration_id BIGINT,
    intent_id      BIGINT,
    session_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool_key, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tool_usage_task ON tool_usage(task_id);

-- Startup backfills are transactional and must not run again after history is
-- cleared or archived. Kept independently of task/session lifetimes.
CREATE TABLE IF NOT EXISTS tool_usage_migrations (
    name TEXT PRIMARY KEY,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- MCP tool calls use a dedicated ledger instead of parsing the dynamic
-- mcp__server__tool runtime name. No foreign keys by design: task/session or MCP
-- deletion must not erase historical usage statistics.
CREATE TABLE IF NOT EXISTS mcp_usage (
    id             BIGSERIAL PRIMARY KEY,
    ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
    server_id      BIGINT,
    server_name    TEXT NOT NULL,
    tool_name      TEXT NOT NULL,
    agent_key      TEXT,
    task_id        BIGINT,
    exploration_id BIGINT,
    intent_id      BIGINT,
    session_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_usage_server ON mcp_usage(server_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_usage_tool ON mcp_usage(server_id, tool_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_usage_task ON mcp_usage(task_id);

-- =====================================================================
-- H. 内置工具目录
-- =====================================================================
CREATE TABLE IF NOT EXISTS tools (
    key         TEXT PRIMARY KEY,
    system      BOOLEAN NOT NULL DEFAULT true,
    description TEXT    NOT NULL DEFAULT '',
    schema      JSONB   NOT NULL DEFAULT '{}',
    agents      JSONB   NOT NULL DEFAULT '[]',
    enabled     BOOLEAN NOT NULL DEFAULT true,
    kind        TEXT    NOT NULL DEFAULT 'builtin',
    exec        JSONB   NOT NULL DEFAULT '{}',
    deferred    BOOLEAN NOT NULL DEFAULT false,
    directory   TEXT    NOT NULL DEFAULT '',
    usage_help  TEXT    NOT NULL DEFAULT '',
    when_to_use TEXT    NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tools ADD COLUMN IF NOT EXISTS directory   TEXT NOT NULL DEFAULT '';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS usage_help  TEXT NOT NULL DEFAULT '';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS when_to_use TEXT NOT NULL DEFAULT '';
DROP TRIGGER IF EXISTS trg_tools_upd ON tools;
CREATE TRIGGER trg_tools_upd BEFORE UPDATE ON tools
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- I. 会话（对话页）
-- =====================================================================
CREATE TABLE IF NOT EXISTS conversations (
    id             BIGSERIAL PRIMARY KEY,
    agent_key      TEXT NOT NULL,
    title          TEXT NOT NULL DEFAULT '',
    llm_profile_id BIGINT REFERENCES llm_profiles(id) ON DELETE SET NULL,
    pinned_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_conversations_llm_profile ON conversations(llm_profile_id) WHERE llm_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_pinned ON conversations(pinned_at DESC) WHERE pinned_at IS NOT NULL;
DROP TRIGGER IF EXISTS trg_conversations_upd ON conversations;
CREATE TRIGGER trg_conversations_upd BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS conversation_activities (
    id                 BIGSERIAL PRIMARY KEY,
    conversation_id    BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    worker             TEXT,
    kind               TEXT,
    tool               TEXT,
    tool_use_id        TEXT,
    is_error           BOOLEAN NOT NULL DEFAULT false,
    summary            TEXT,
    detail             TEXT,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_act ON conversation_activities(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_conv_act_tool_call ON conversation_activities(conversation_id, tool_use_id, id)
  WHERE kind IN ('tool_use', 'tool_result');

-- =====================================================================
-- J. Agent 触发器
-- =====================================================================
CREATE TABLE IF NOT EXISTS agent_triggers (
    id                          BIGSERIAL PRIMARY KEY,
    agent_key                   TEXT NOT NULL,
    enabled                     BOOLEAN NOT NULL DEFAULT true,
    interval_sec                INTEGER NOT NULL DEFAULT 0,
    on_finding                  BOOLEAN NOT NULL DEFAULT false,
    on_goal_met                 BOOLEAN NOT NULL DEFAULT false,
    on_task_timeout             BOOLEAN NOT NULL DEFAULT false,
    on_tool_call                BOOLEAN NOT NULL DEFAULT false,
    on_task_create              BOOLEAN NOT NULL DEFAULT false,
    interval_message            TEXT NOT NULL DEFAULT '',
    finding_message             TEXT NOT NULL DEFAULT '',
    goal_message                TEXT NOT NULL DEFAULT '',
    task_timeout_message        TEXT NOT NULL DEFAULT '',
    tool_call_message           TEXT NOT NULL DEFAULT '',
    task_create_message         TEXT NOT NULL DEFAULT '',
    tool_names                  TEXT NOT NULL DEFAULT '',
    last_fire                   TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_agent ON agent_triggers(agent_key);
-- 加列迁移(已发版,旧库升级补列;新库 CREATE 已含这些列,ALTER 为 no-op)。幂等,每次启动可重复执行。
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS on_tool_call        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS tool_call_message   TEXT    NOT NULL DEFAULT '';
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS tool_names          TEXT    NOT NULL DEFAULT '';
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS on_task_create      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS task_create_message TEXT    NOT NULL DEFAULT '';
DROP TRIGGER IF EXISTS trg_agent_triggers_upd ON agent_triggers;
CREATE TRIGGER trg_agent_triggers_upd BEFORE UPDATE ON agent_triggers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS scheduler_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

-- =====================================================================
-- =====================================================================

-- =====================================================================
-- L. 漏洞发现持久化
-- =====================================================================
CREATE TABLE IF NOT EXISTS findings (
    id          BIGSERIAL PRIMARY KEY,
    task_id     BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
    node_id     BIGINT REFERENCES exploration_nodes(id) ON DELETE SET NULL,
    vulnclass   TEXT NOT NULL DEFAULT '',
    -- 漏洞名称(可读标题)；为空时前端回退展示 vulnclass。severity 取值：
    -- critical 严重 / high 高 / medium 中 / low 低（不加 CHECK，与 status 一致由 server 白名单校验）。
    name        TEXT NOT NULL DEFAULT '',
    severity    TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL DEFAULT '',
    evidence    TEXT NOT NULL DEFAULT '',
    worker      TEXT NOT NULL DEFAULT '',
    asset_ids   JSONB NOT NULL DEFAULT '[]',
    -- 处置状态：pending 待处理 / in_progress 处理中 / confirmed 已确认 / resolved 已处理 / fixed 已修复 /
    -- false_positive 误报 / ignored 忽略 / duplicate 重复 / risk_accepted 风险接受。
    -- 取值不加 CHECK：旧库靠下面的 ALTER 补列,CHECK 无法回填,统一由 server 侧白名单校验。
    status      TEXT NOT NULL DEFAULT 'pending',
    -- 漏洞详细报告(Markdown)；默认空,仅详情页读取/展示,不进列表接口以免 payload 膨胀。
    report      TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE findings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS name   TEXT NOT NULL DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS report TEXT NOT NULL DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS triage_version BIGINT NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION bump_finding_triage_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN NEW.triage_version := OLD.triage_version + 1; END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_findings_triage_version ON findings;
CREATE TRIGGER trg_findings_triage_version BEFORE UPDATE OF status ON findings
    FOR EACH ROW EXECUTE FUNCTION bump_finding_triage_version();
CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id, created_at DESC);
-- Task selectors anti-join legacy graph nodes before pagination.
CREATE INDEX IF NOT EXISTS idx_findings_task_node ON findings(task_id, node_id) WHERE node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_findings_time ON findings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status, created_at DESC);
-- 「按资产」视图靠 asset_ids @> '[<id>]' 反查发现,没有这个 GIN 索引就是全表扫。
CREATE INDEX IF NOT EXISTS idx_findings_asset_ids ON findings USING GIN(asset_ids jsonb_path_ops);

-- 手动复测属于独立会话；结论与原漏洞处置状态分开保存。
CREATE TABLE IF NOT EXISTS finding_retests (
    id BIGSERIAL PRIMARY KEY,
    finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    conversation_id BIGINT UNIQUE REFERENCES conversations(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','stopped')),
    verdict TEXT NOT NULL DEFAULT '' CHECK (verdict IN ('','reproduced','fixed','inconclusive')),
    notes TEXT NOT NULL DEFAULT '',
    snapshot JSONB NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_finding_retests_history ON finding_retests(finding_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_retests_active ON finding_retests(finding_id)
    WHERE status IN ('pending','running');

-- 删除会话保留复测记录，同时解除尚未结束的复测占用。
CREATE OR REPLACE FUNCTION stop_deleted_conversation_retest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE finding_retests SET status='stopped', error='复测会话已删除', finished_at=now()
    WHERE conversation_id=OLD.id AND status IN ('pending','running');
    RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS trg_conversation_retest_delete ON conversations;
CREATE TRIGGER trg_conversation_retest_delete BEFORE DELETE ON conversations
    FOR EACH ROW EXECUTE FUNCTION stop_deleted_conversation_retest();

ALTER TABLE findings ADD COLUMN IF NOT EXISTS evidence_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS report_evidence_version BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS traffic_evidence_snapshots (
    id TEXT PRIMARY KEY,
    source_traffic_id TEXT NOT NULL,
    captured_at BIGINT NOT NULL,
    url TEXT NOT NULL,
    method TEXT NOT NULL,
    status INTEGER NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    req_head TEXT NOT NULL,
    resp_head TEXT NOT NULL,
    req_hash TEXT NOT NULL,
    resp_hash TEXT NOT NULL,
    req_len BIGINT NOT NULL,
    resp_len BIGINT NOT NULL,
    unreferenced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS finding_traffic_bindings (
    id BIGSERIAL PRIMARY KEY,
    finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL REFERENCES traffic_evidence_snapshots(id),
    role TEXT NOT NULL DEFAULT 'supporting',
    note TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(finding_id, snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_finding_traffic_order ON finding_traffic_bindings(finding_id, position, id);
CREATE INDEX IF NOT EXISTS idx_finding_traffic_snapshot ON finding_traffic_bindings(snapshot_id);

-- =====================================================================
-- M. 后端日志持久化
-- =====================================================================
CREATE TABLE IF NOT EXISTS server_logs (
    id         BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    level      TEXT NOT NULL DEFAULT 'info',
    tag        TEXT NOT NULL DEFAULT '',
    text       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_server_logs_id ON server_logs(id DESC);

-- Independent /btw history and the latest provider-ready main checkpoint.
CREATE TABLE IF NOT EXISTS side_question_sessions (
    session_key TEXT PRIMARY KEY,
    conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
    task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
    exploration_id BIGINT REFERENCES explorations(id) ON DELETE CASCADE,
    intent_id BIGINT REFERENCES exploration_nodes(id) ON DELETE CASCADE,
    run_id BIGINT NOT NULL,
    version BIGINT NOT NULL,
    snapshot JSONB NOT NULL,
    generation BIGINT NOT NULL DEFAULT 0,
    CHECK ((conversation_id IS NOT NULL AND task_id IS NULL AND exploration_id IS NULL AND intent_id IS NULL)
        OR (conversation_id IS NULL AND task_id IS NOT NULL AND exploration_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_side_sessions_conv ON side_question_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_side_sessions_task ON side_question_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_side_sessions_exp ON side_question_sessions(exploration_id);
CREATE INDEX IF NOT EXISTS idx_side_sessions_intent ON side_question_sessions(intent_id);

CREATE TABLE IF NOT EXISTS side_question_requests (
    id TEXT PRIMARY KEY,
    ordinal BIGSERIAL UNIQUE,
    session_key TEXT NOT NULL REFERENCES side_question_sessions(session_key) ON DELETE CASCADE,
    generation BIGINT NOT NULL,
    client_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
    error TEXT NOT NULL DEFAULT '',
    model JSONB NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sequence BIGINT NOT NULL DEFAULT 0,
    usage JSONB NOT NULL DEFAULT '{}',
    UNIQUE(session_key,generation,client_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_side_request_running ON side_question_requests(session_key) WHERE status='running';
CREATE INDEX IF NOT EXISTS idx_side_requests_history ON side_question_requests(session_key,ordinal DESC);

-- Additive v3 archive fields; old archives restore these as empty objects.
ALTER TABLE side_question_sessions ADD COLUMN IF NOT EXISTS memory JSONB NOT NULL DEFAULT '{}';
ALTER TABLE side_question_requests ADD COLUMN IF NOT EXISTS context_info JSONB NOT NULL DEFAULT '{}';

-- Immutable creation visibility for browser-local unread cursors. Add nullable
-- columns first: no volatile-default rewrite/backfill of historical business data.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS notification_xid xid8;
ALTER TABLE findings ALTER COLUMN notification_xid SET DEFAULT pg_current_xact_id();
ALTER TABLE task_asset_links ADD COLUMN IF NOT EXISTS notification_xid xid8;
ALTER TABLE task_asset_links ALTER COLUMN notification_xid SET DEFAULT pg_current_xact_id();

-- User-managed worker queue and deletion receipts belong to the task exploration.
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS worker_queue_manual BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS worker_queue_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS queue_position BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS deleted_workers (
    exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
    intent_id BIGINT NOT NULL,
    payload JSONB NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (exploration_id, intent_id)
);
CREATE OR REPLACE FUNCTION assign_worker_queue_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind='intent' AND NEW.state='open' AND NEW.payload->>'cancelled_by_user' IS DISTINCT FROM 'true' THEN
        IF TG_OP='INSERT' OR OLD.state IS DISTINCT FROM 'open' OR OLD.payload->>'cancelled_by_user'='true' THEN
            IF (SELECT worker_queue_manual FROM explorations WHERE id=NEW.exploration_id) AND NOT (TG_OP='INSERT' AND NEW.queue_position>0) THEN
                SELECT COALESCE(MAX(queue_position),0)+1 INTO NEW.queue_position
                  FROM exploration_nodes WHERE exploration_id=NEW.exploration_id AND kind='intent';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_worker_queue_position ON exploration_nodes;
CREATE TRIGGER trg_worker_queue_position BEFORE INSERT OR UPDATE ON exploration_nodes
FOR EACH ROW EXECUTE FUNCTION assign_worker_queue_position();
CREATE OR REPLACE FUNCTION bump_worker_queue_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        IF OLD.kind='intent' THEN
            UPDATE explorations SET worker_queue_version=worker_queue_version+1 WHERE id=OLD.exploration_id;
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.kind='intent' THEN
        IF TG_OP='INSERT' OR NEW.state IS DISTINCT FROM OLD.state OR NEW.priority IS DISTINCT FROM OLD.priority
           OR NEW.queue_position IS DISTINCT FROM OLD.queue_position
           OR (NEW.payload->>'cancelled_by_user') IS DISTINCT FROM (OLD.payload->>'cancelled_by_user') THEN
            UPDATE explorations SET worker_queue_version=worker_queue_version+1 WHERE id=NEW.exploration_id;
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_worker_queue_version ON exploration_nodes;
CREATE TRIGGER trg_worker_queue_version AFTER INSERT OR UPDATE OR DELETE ON exploration_nodes
FOR EACH ROW EXECUTE FUNCTION bump_worker_queue_version();
CREATE INDEX IF NOT EXISTS idx_worker_queue_position ON exploration_nodes(exploration_id,queue_position,id)
WHERE kind='intent' AND state='open';

-- Deletion feedback survives its finding and is private to the owning planner.
CREATE TABLE IF NOT EXISTS finding_deletion_feedback (
 id BIGSERIAL PRIMARY KEY,
 finding_id BIGINT NOT NULL,
 task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
 title TEXT NOT NULL DEFAULT '',
 vulnclass TEXT NOT NULL DEFAULT '',
 reason TEXT NOT NULL DEFAULT '' CHECK (char_length(reason)<=2000),
 deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finding_deletion_feedback_task ON finding_deletion_feedback(task_id,id DESC);

-- Execution selection is independent of queue ordering and task lifecycle.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'managed' CHECK (execution_mode IN ('managed','manual'));

ALTER TABLE tools ADD COLUMN IF NOT EXISTS executable TEXT NOT NULL DEFAULT '';

-- Main-agent dispatch receipts. Final delivery and node settlement share the
-- same transaction; SSE is only a notification, never the durable source.
CREATE TABLE IF NOT EXISTS worker_feedback (
    id BIGSERIAL PRIMARY KEY,
    exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
    task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    intent_id BIGINT NOT NULL,
    main_seg INTEGER NOT NULL CHECK (main_seg >= 0),
    after_activity BIGINT NOT NULL DEFAULT 0,
    terminal BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_feedback_active
    ON worker_feedback(exploration_id,intent_id,main_seg) WHERE NOT terminal;
CREATE INDEX IF NOT EXISTS worker_feedback_intent ON worker_feedback(exploration_id,intent_id,id);
CREATE TABLE IF NOT EXISTS worker_feedback_delivery (
    activity_id BIGINT PRIMARY KEY REFERENCES activity(id) ON DELETE CASCADE,
    task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    published BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS worker_feedback_unpublished ON worker_feedback_delivery(activity_id) WHERE NOT published;
CREATE INDEX IF NOT EXISTS worker_feedback_task_delivery ON worker_feedback_delivery(task_id,activity_id);
CREATE INDEX IF NOT EXISTS activity_worker_feedback_context ON activity(exploration_id,main_seg,id)
    WHERE worker='mainagent' AND metadata ? 'worker_feedback';

CREATE TABLE IF NOT EXISTS worker_feedback_run (
    intent_id BIGINT PRIMARY KEY REFERENCES exploration_nodes(id) ON DELETE CASCADE,
    after_activity BIGINT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION notify_worker_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f RECORD; result_id BIGINT; result_text TEXT; body TEXT; aid BIGINT; target_state TEXT; is_terminal BOOLEAN;
BEGIN
    IF OLD.kind <> 'intent' OR NOT EXISTS (SELECT 1 FROM tasks WHERE exploration_id=OLD.exploration_id AND deleted_at IS NULL) THEN RETURN NULL; END IF;
    IF TG_OP = 'DELETE' THEN target_state := 'deleted'; ELSE target_state := NEW.state; END IF;
    IF TG_OP = 'UPDATE' AND OLD.state IS NOT DISTINCT FROM NEW.state THEN RETURN NULL; END IF;
    -- An explicit rerun follows the original subscriber(s), but only when it is
    -- actually claimed. Failed admission/reopen rollback creates no new receipt.
    IF target_state = 'running' THEN
        INSERT INTO worker_feedback_run(intent_id,after_activity)
        VALUES(OLD.id,COALESCE((SELECT max(id) FROM activity WHERE exploration_id=OLD.exploration_id AND node_id=OLD.id),0))
        ON CONFLICT(intent_id) DO UPDATE SET after_activity=EXCLUDED.after_activity;
        UPDATE worker_feedback SET after_activity=(SELECT after_activity FROM worker_feedback_run WHERE intent_id=OLD.id)
        WHERE exploration_id=OLD.exploration_id AND intent_id=OLD.id AND NOT terminal;
        INSERT INTO worker_feedback(exploration_id,task_id,intent_id,main_seg,after_activity)
        SELECT DISTINCT ON (prev.main_seg) prev.exploration_id,prev.task_id,prev.intent_id,prev.main_seg,
            COALESCE((SELECT max(id) FROM activity WHERE exploration_id=OLD.exploration_id AND node_id=OLD.id),0)
        FROM worker_feedback prev WHERE prev.exploration_id=OLD.exploration_id AND prev.intent_id=OLD.id
        ORDER BY prev.main_seg,prev.id DESC
        ON CONFLICT (exploration_id,intent_id,main_seg) WHERE NOT terminal DO NOTHING;
        RETURN NULL;
    END IF;
    is_terminal := target_state IN ('done','blocked','exhausted','stopped','deleted');
    IF NOT is_terminal AND target_state NOT IN ('paused','open') THEN RETURN NULL; END IF;
    FOR f IN SELECT * FROM worker_feedback WHERE exploration_id=OLD.exploration_id AND intent_id=OLD.id AND NOT terminal FOR UPDATE LOOP
        result_id := NULL; result_text := NULL;
        IF is_terminal THEN
            SELECT id,COALESCE(NULLIF(detail,''),summary) INTO result_id,result_text FROM activity
            WHERE exploration_id=OLD.exploration_id AND node_id=OLD.id AND id>f.after_activity AND kind='result'
            ORDER BY id DESC LIMIT 1;
        END IF;
        body := format('### Worker %s · 意图 #%s', CASE WHEN is_terminal THEN '结果' ELSE '状态' END,OLD.id)
            || E'\n\n状态：' || CASE target_state WHEN 'done' THEN '已完成' WHEN 'blocked' THEN '执行失败'
            WHEN 'exhausted' THEN '预算或时间耗尽' WHEN 'stopped' THEN '已终止' WHEN 'deleted' THEN '已删除'
            WHEN 'paused' THEN '已暂停，恢复后继续跟踪' ELSE '等待执行，恢复后继续跟踪' END
            || CASE WHEN is_terminal THEN E'\n\n' || COALESCE(NULLIF(result_text,''),'本次未产生最终总结，请查看 Worker 会话中的已有记录。') ELSE '' END;
        IF result_id IS NULL THEN
            SELECT id INTO result_id FROM activity WHERE exploration_id=OLD.exploration_id AND node_id=OLD.id ORDER BY id DESC LIMIT 1;
        END IF;
        IF target_state <> 'deleted' AND result_id IS NOT NULL THEN
            body := body || format(E'\n\n[查看 Worker 原始会话](/function/tasks/detail?id=%s&session=intent:%s&activity=%s)',f.task_id,OLD.id,result_id);
        END IF;
        INSERT INTO activity(exploration_id,worker,kind,summary,detail,main_seg,is_error,metadata)
        VALUES(f.exploration_id,'mainagent','text',left(body,400),body,f.main_seg,
            target_state IN ('blocked','exhausted','stopped','deleted'),
            jsonb_build_object('worker_feedback',jsonb_build_object('id',f.id,'intent_id',OLD.id,'state',target_state,'source_activity_id',result_id))) RETURNING id INTO aid;
        INSERT INTO worker_feedback_delivery(activity_id,task_id) VALUES(aid,f.task_id);
        IF is_terminal THEN UPDATE worker_feedback SET terminal=true WHERE id=f.id; END IF;
    END LOOP;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS worker_feedback_state ON exploration_nodes;
CREATE TRIGGER worker_feedback_state AFTER UPDATE OF state OR DELETE ON exploration_nodes
FOR EACH ROW EXECUTE FUNCTION notify_worker_feedback();

-- Derived digests must never hide newly edited evidence or revived branches.
-- Conservative invalidation: any causal graph mutation invalidates this task's active view.
CREATE OR REPLACE FUNCTION invalidate_exploration_digests() RETURNS trigger AS $$
DECLARE eid BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'exploration_nodes' THEN
        IF TG_OP = 'DELETE' THEN
            IF OLD.kind = 'digest' THEN RETURN OLD; END IF;
            eid := OLD.exploration_id;
        ELSE
            IF NEW.kind = 'digest' THEN RETURN NEW; END IF;
            IF TG_OP = 'UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload AND NEW.state = OLD.state THEN RETURN NEW; END IF;
            eid := NEW.exploration_id;
        END IF;
    ELSIF TG_TABLE_NAME = 'exploration_anchors' THEN
        SELECT exploration_id INTO eid FROM exploration_nodes
          WHERE id=COALESCE(NEW.node_id,OLD.node_id) AND kind<>'digest';
        IF eid IS NULL THEN RETURN COALESCE(NEW,OLD); END IF;
    ELSE
        IF TG_OP = 'DELETE' THEN
            IF OLD.rel = 'covers' THEN RETURN OLD; END IF;
            eid := OLD.exploration_id;
        ELSE
            IF NEW.rel = 'covers' THEN RETURN NEW; END IF;
            eid := NEW.exploration_id;
        END IF;
    END IF;
    UPDATE exploration_nodes SET state='superseded' WHERE exploration_id=eid AND kind='digest' AND state='active';
    RETURN COALESCE(NEW,OLD);
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_nodes_invalidate_digests ON exploration_nodes;
CREATE TRIGGER trg_nodes_invalidate_digests AFTER INSERT OR UPDATE OF payload,state OR DELETE ON exploration_nodes
    FOR EACH ROW EXECUTE FUNCTION invalidate_exploration_digests();
DROP TRIGGER IF EXISTS trg_edges_invalidate_digests ON exploration_edges;
CREATE TRIGGER trg_edges_invalidate_digests AFTER INSERT OR DELETE ON exploration_edges
    FOR EACH ROW EXECUTE FUNCTION invalidate_exploration_digests();
DROP TRIGGER IF EXISTS trg_anchors_invalidate_digests ON exploration_anchors;
CREATE TRIGGER trg_anchors_invalidate_digests AFTER INSERT OR DELETE ON exploration_anchors
    FOR EACH ROW EXECUTE FUNCTION invalidate_exploration_digests();

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

-- pi request routing audit; API credentials are never persisted here.
CREATE TABLE IF NOT EXISTS llm_request_attempts (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL, profile_id BIGINT REFERENCES llm_profiles(id) ON DELETE SET NULL,
  model TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
  usage JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
);
-- Platform/Auto/Pentest conversations can call a model without a bound task.
ALTER TABLE llm_request_attempts ALTER COLUMN task_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_attempts_task ON llm_request_attempts(task_id,id DESC);
CREATE TABLE IF NOT EXISTS llm_request_limits (
  profile_id BIGINT PRIMARY KEY REFERENCES llm_profiles(id) ON DELETE CASCADE,
  next_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS engine_task_leases (
  task_id BIGINT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,token TEXT NOT NULL UNIQUE,expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS engine_worker_slots (
  id TEXT PRIMARY KEY,task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  token TEXT NOT NULL
);
-- Durable pause commands let the API instance wait for the instance that owns the task lease.
CREATE TABLE IF NOT EXISTS runtime_task_commands (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  command TEXT NOT NULL CHECK(command IN ('pause')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  executor_owner TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_task_commands_pending
  ON runtime_task_commands(task_id,command) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_runtime_task_commands_task
  ON runtime_task_commands(task_id,id DESC);

-- Immutable, content-addressed evidence survives deletion from the traffic inbox.
CREATE TABLE IF NOT EXISTS evidence_blobs(hash TEXT PRIMARY KEY,bytes BYTEA NOT NULL);
CREATE TABLE IF NOT EXISTS traffic_exchanges(
 id TEXT PRIMARY KEY REFERENCES traffic_evidence_snapshots(id),task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
 intent_id BIGINT REFERENCES exploration_nodes(id) ON DELETE SET NULL,host TEXT NOT NULL,truncated BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_traffic_task ON traffic_exchanges(task_id,id);
ALTER TABLE findings ADD COLUMN IF NOT EXISTS tool_call_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_idempotency ON findings(task_id,tool_call_id) WHERE tool_call_id IS NOT NULL;
ALTER TABLE llm_profiles ADD COLUMN IF NOT EXISTS supports_images BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS chat_artifacts (
 id TEXT PRIMARY KEY,task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
 conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
 name TEXT NOT NULL,path TEXT NOT NULL UNIQUE,mime TEXT NOT NULL,size BIGINT NOT NULL,
 sha256 TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE finding_retests ADD COLUMN IF NOT EXISTS lease_token TEXT;
ALTER TABLE finding_retests ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

ALTER TABLE evidence_blobs ALTER COLUMN bytes DROP NOT NULL;
ALTER TABLE evidence_blobs ADD COLUMN IF NOT EXISTS file_path TEXT;
ALTER TABLE evidence_blobs ADD COLUMN IF NOT EXISTS size BIGINT;

CREATE TABLE IF NOT EXISTS runtime_session_leases (
 key TEXT PRIMARY KEY,token TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,stop_requested BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_file TEXT;
CREATE TABLE IF NOT EXISTS conversation_runs (
 id BIGSERIAL PRIMARY KEY,conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'queued',message TEXT NOT NULL,attachments JSONB NOT NULL DEFAULT '[]',
 trigger_id BIGINT REFERENCES agent_triggers(id) ON DELETE SET NULL,event_keys TEXT[] NOT NULL DEFAULT '{}',
 token TEXT,started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,error TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_runs_queue ON conversation_runs(status,id);
CREATE TABLE IF NOT EXISTS agent_trigger_events (
 id BIGSERIAL PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
 payload JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_trigger_deliveries (
 trigger_id BIGINT NOT NULL REFERENCES agent_triggers(id) ON DELETE CASCADE,event_id BIGINT NOT NULL REFERENCES agent_trigger_events(id) ON DELETE CASCADE,
 run_id BIGINT REFERENCES conversation_runs(id) ON DELETE SET NULL,PRIMARY KEY(trigger_id,event_id)
);
ALTER TABLE llm_request_attempts ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE llm_request_attempts ADD COLUMN IF NOT EXISTS conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE;

-- Evidence ownership survives removal from the traffic inbox. Existing bound
-- snapshots can recover their owner from an unambiguous finding association.
ALTER TABLE traffic_evidence_snapshots ADD COLUMN IF NOT EXISTS task_id BIGINT;
ALTER TABLE traffic_evidence_snapshots ADD COLUMN IF NOT EXISTS intent_id BIGINT;
UPDATE traffic_evidence_snapshots s SET task_id=e.task_id,intent_id=e.intent_id
FROM traffic_exchanges e WHERE e.id=s.id AND s.task_id IS NULL;
UPDATE traffic_evidence_snapshots s SET task_id=owners.task_id
FROM (SELECT b.snapshot_id,min(f.task_id) AS task_id FROM finding_traffic_bindings b
 JOIN findings f ON f.id=b.finding_id WHERE f.task_id IS NOT NULL
 GROUP BY b.snapshot_id HAVING count(DISTINCT f.task_id)=1) owners
WHERE s.id=owners.snapshot_id AND s.task_id IS NULL;

-- Read projections use the same ancestor-anchor policy as the domain tools.
CREATE OR REPLACE FUNCTION task_asset_linked(tid BIGINT,aid BIGINT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM tasks t JOIN task_asset_links l ON l.task_id=t.id
 WHERE l.asset_id=aid AND t.deleted_at IS NULL AND
 (t.id=tid OR t.id IN(SELECT source_task_id FROM task_relations WHERE task_id=tid)))
 AND EXISTS(SELECT 1 FROM tasks WHERE id=tid AND deleted_at IS NULL)
$$;
CREATE OR REPLACE FUNCTION exploration_node_readable(eid BIGINT,nid BIGINT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id
 WHERE n.exploration_id=eid AND n.id=nid AND t.deleted_at IS NULL)
$$;
CREATE OR REPLACE FUNCTION exploration_activity_readable(eid BIGINT,nid BIGINT,meta JSONB)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT CASE WHEN nid IS NOT NULL THEN exploration_node_readable(eid,nid)
 WHEN (meta->'worker_feedback'->>'intent_id') ~ '^[0-9]+$'
 THEN exploration_node_readable(eid,(meta->'worker_feedback'->>'intent_id')::bigint)
 ELSE EXISTS(SELECT 1 FROM tasks WHERE exploration_id=eid AND deleted_at IS NULL) END
$$;
CREATE OR REPLACE FUNCTION finding_readable(fid BIGINT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT COALESCE((SELECT CASE WHEN f.node_id IS NOT NULL THEN exploration_node_readable(t.exploration_id,f.node_id)
 ELSE true END
 FROM findings f JOIN tasks t ON t.id=f.task_id AND t.deleted_at IS NULL WHERE f.id=fid),false)
$$;

CREATE TABLE IF NOT EXISTS tool_output_artifacts (
 id TEXT PRIMARY KEY,task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
 conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,node_id BIGINT REFERENCES exploration_nodes(id) ON DELETE CASCADE,
 tool TEXT NOT NULL,tool_call_id TEXT NOT NULL,body TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stop is a durable request; only executor completion confirms a running retest.
ALTER TABLE finding_retests ADD COLUMN IF NOT EXISTS stop_requested BOOLEAN NOT NULL DEFAULT false;
-- Keep delivery tombstones after a user deletes the generated conversation.
ALTER TABLE agent_trigger_deliveries ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
UPDATE agent_trigger_deliveries SET delivered_at=now() WHERE run_id IS NOT NULL AND delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS runtime_role_configs (
 id TEXT PRIMARY KEY,task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
 conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,role TEXT NOT NULL,
 configured JSONB NOT NULL,effective JSONB NOT NULL,started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_runtime_role_configs_task ON runtime_role_configs(task_id) WHERE finished_at IS NULL;
-- Every model attempt belongs to one runtime, rather than merely a task/role:
-- concurrent Workers must never close one another's requests after a crash.
ALTER TABLE llm_request_attempts ADD COLUMN IF NOT EXISTS runtime_id TEXT;
CREATE INDEX IF NOT EXISTS idx_llm_attempts_runtime_running ON llm_request_attempts(runtime_id) WHERE status='running';

ALTER TABLE tool_output_artifacts ADD COLUMN IF NOT EXISTS authorization_hash TEXT;

-- Sequence allocation order is not transaction commit order. A seen-set avoids
-- losing a late commit whose id is below a previously observed maximum.
CREATE TABLE IF NOT EXISTS scheduler_seen_sources (
 kind TEXT NOT NULL,source_id BIGINT NOT NULL,PRIMARY KEY(kind,source_id)
);

ALTER TABLE engine_worker_slots ADD COLUMN IF NOT EXISTS intent_id BIGINT;

-- Planner acknowledges individual events only after a successful planning round.
-- No max(id) cursor: a lower sequence value can commit after a higher value.
CREATE TABLE IF NOT EXISTS exploration_context_events (
 id BIGSERIAL PRIMARY KEY,
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 node_id BIGINT REFERENCES exploration_nodes(id) ON DELETE SET NULL,
 kind TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),acknowledged_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_context_events_pending ON exploration_context_events(exploration_id,id) WHERE acknowledged_at IS NULL;
CREATE TABLE IF NOT EXISTS planner_decisions (
 id BIGSERIAL PRIMARY KEY,exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 round_id TEXT NOT NULL UNIQUE,decision JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_planner_decisions_exp ON planner_decisions(exploration_id,id DESC);
CREATE OR REPLACE FUNCTION capture_exploration_context() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE eid BIGINT; nid BIGINT; event_kind TEXT;
BEGIN
 IF TG_OP='DELETE' THEN
  eid:=OLD.exploration_id; nid:=NULL; event_kind:='node_deleted';
 ELSIF TG_OP='INSERT' OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.state IS DISTINCT FROM OLD.state OR NEW.content_version IS DISTINCT FROM OLD.content_version THEN
  eid:=NEW.exploration_id; nid:=NEW.id; event_kind:=NEW.kind;
 ELSE RETURN NEW;
 END IF;
 -- During exploration cascade deletion the owning exploration no longer exists.
 IF EXISTS(SELECT 1 FROM explorations WHERE id=eid) THEN
  INSERT INTO exploration_context_events(exploration_id,node_id,kind) VALUES(eid,nid,event_kind);
  INSERT INTO exploration_context_events(exploration_id,node_id,kind)
   SELECT current.exploration_id,nid,event_kind FROM tasks source
   JOIN task_relations r ON r.source_task_id=source.id JOIN tasks current ON current.id=r.task_id
   WHERE source.exploration_id=eid AND current.deleted_at IS NULL;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS exploration_context_event ON exploration_nodes;
CREATE TRIGGER exploration_context_event AFTER INSERT OR UPDATE OR DELETE ON exploration_nodes FOR EACH ROW EXECUTE FUNCTION capture_exploration_context();

CREATE OR REPLACE FUNCTION version_exploration_content() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.state IS DISTINCT FROM OLD.state THEN
  NEW.content_version := OLD.content_version + 1;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS exploration_content_version ON exploration_nodes;
CREATE TRIGGER exploration_content_version BEFORE UPDATE ON exploration_nodes FOR EACH ROW EXECUTE FUNCTION version_exploration_content();

CREATE OR REPLACE FUNCTION capture_context_assets() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE tid BIGINT;
BEGIN
 IF TG_OP='DELETE' THEN tid:=OLD.task_id; ELSE tid:=NEW.task_id; END IF;
 INSERT INTO exploration_context_events(exploration_id,kind)
  SELECT exploration_id,'assets' FROM tasks WHERE deleted_at IS NULL AND (id=tid OR id IN (SELECT task_id FROM task_relations WHERE source_task_id=tid));
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS context_assets_event ON task_asset_links;
CREATE TRIGGER context_assets_event AFTER INSERT OR DELETE ON task_asset_links FOR EACH ROW EXECUTE FUNCTION capture_context_assets();

CREATE OR REPLACE FUNCTION version_finding_context() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 UPDATE exploration_nodes SET content_version=content_version+1,
   report_revision=report_revision+CASE WHEN NEW.evidence IS NOT DISTINCT FROM OLD.evidence
     AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.summary IS NOT DISTINCT FROM OLD.summary
     AND NEW.name IS NOT DISTINCT FROM OLD.name AND NEW.severity IS NOT DISTINCT FROM OLD.severity
     THEN 1 ELSE 0 END WHERE id=NEW.node_id;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finding_context_version ON findings;
CREATE TRIGGER finding_context_version AFTER UPDATE OF evidence,report,status,summary,name,severity ON findings
 FOR EACH ROW WHEN (NEW.evidence IS DISTINCT FROM OLD.evidence OR NEW.report IS DISTINCT FROM OLD.report
 OR NEW.status IS DISTINCT FROM OLD.status OR NEW.summary IS DISTINCT FROM OLD.summary
 OR NEW.name IS DISTINCT FROM OLD.name OR NEW.severity IS DISTINCT FROM OLD.severity)
 EXECUTE FUNCTION version_finding_context();

-- Native platform adaptation: additive audit purpose, preserving historical requests.
ALTER TABLE llm_request_attempts ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'conversation';

-- UI stream snapshots: shared across executors, with durable final activities as authority.
ALTER TABLE conversation_activities ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS agent_stream_snapshots (
 scope TEXT NOT NULL CHECK(scope IN ('task','conversation')),
 scope_id BIGINT NOT NULL, turn_id TEXT NOT NULL, stream_id TEXT NOT NULL,
 channel TEXT NOT NULL CHECK(channel IN ('text','thinking')),
 worker TEXT NOT NULL, node_id BIGINT, main_seg INTEGER,
 body TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(scope,scope_id,stream_id,channel)
);
CREATE INDEX IF NOT EXISTS idx_agent_stream_scope ON agent_stream_snapshots(scope,scope_id);
ALTER TABLE conversation_runs ADD COLUMN IF NOT EXISTS turn_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_request ON conversation_runs(conversation_id,turn_id) WHERE turn_id IS NOT NULL;

-- Blackboard collaboration v1: private work journals and durable release notifications.
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS published_revision BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS worker_observations (
 intent_id BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 node_id BIGINT PRIMARY KEY, finding_id BIGINT, kind TEXT NOT NULL CHECK(kind IN ('fact','finding')),
 payload JSONB NOT NULL, asset_ids JSONB NOT NULL DEFAULT '[]', traffic_refs JSONB NOT NULL DEFAULT '[]',
 dedup_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ,
 UNIQUE(intent_id,dedup_key)
);
ALTER TABLE worker_observations ADD COLUMN IF NOT EXISTS draft_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS worker_observation_revisions (
 node_id BIGINT NOT NULL REFERENCES worker_observations(node_id) ON DELETE CASCADE,
 version INTEGER NOT NULL, payload JSONB NOT NULL, asset_ids JSONB NOT NULL, traffic_refs JSONB NOT NULL,
 saved_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(node_id,version)
);
CREATE TABLE IF NOT EXISTS blackboard_wakeups (
 id BIGSERIAL PRIMARY KEY, exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 event_key TEXT NOT NULL, kind TEXT NOT NULL, node_id BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), acknowledged_at TIMESTAMPTZ,
 UNIQUE(exploration_id,event_key)
);
ALTER TABLE engine_worker_slots ADD COLUMN IF NOT EXISTS planning_round TEXT;
ALTER TABLE engine_worker_slots ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'running';
CREATE TABLE IF NOT EXISTS blackboard_planning_rounds (
 id TEXT PRIMARY KEY, task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 token TEXT NOT NULL, basis_revision BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'planning',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION advance_published_graph() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind IN ('fact','finding') AND (TG_OP='INSERT' OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.state IS DISTINCT FROM OLD.state) THEN
  UPDATE explorations SET published_revision=published_revision+1 WHERE id=NEW.exploration_id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS published_graph_revision ON exploration_nodes;
CREATE TRIGGER published_graph_revision AFTER INSERT OR UPDATE ON exploration_nodes FOR EACH ROW EXECUTE FUNCTION advance_published_graph();

CREATE TABLE IF NOT EXISTS worker_checkpoints (
 intent_id BIGINT PRIMARY KEY REFERENCES exploration_nodes(id) ON DELETE CASCADE,
 progress JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION wake_blackboard_control() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE eid BIGINT;
BEGIN
 -- Worker is still exploring. Persist asset links immediately, but do not
 -- treat that discovery as a user control event or start another planning round.
 IF TG_TABLE_NAME='task_asset_links' AND TG_OP<>'DELETE'
    AND current_setting('series.agent_discovery',true)='on'
    AND NULLIF(current_setting('series.asset_origin',true),'')::jsonb->>'node_id' IS NOT NULL THEN
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='task_constraints' THEN
  IF TG_OP='DELETE' THEN eid:=OLD.exploration_id; ELSE eid:=NEW.exploration_id; END IF;
 ELSE
  IF TG_OP='DELETE' THEN SELECT exploration_id INTO eid FROM tasks WHERE id=OLD.task_id;
  ELSE SELECT exploration_id INTO eid FROM tasks WHERE id=NEW.task_id; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM explorations WHERE id=eid) THEN
  UPDATE explorations SET published_revision=published_revision+1 WHERE id=eid;
  INSERT INTO blackboard_wakeups(exploration_id,event_key,kind) VALUES(eid,'control:'||txid_current()::text,'control_changed') ON CONFLICT DO NOTHING;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS blackboard_constraints ON task_constraints;
CREATE TRIGGER blackboard_constraints AFTER INSERT OR UPDATE OR DELETE ON task_constraints FOR EACH ROW EXECUTE FUNCTION wake_blackboard_control();
DROP TRIGGER IF EXISTS blackboard_assets ON task_asset_links;
CREATE TRIGGER blackboard_assets AFTER INSERT OR DELETE ON task_asset_links FOR EACH ROW EXECUTE FUNCTION wake_blackboard_control();

-- Durable publication hand-off: survives death after complete_intent commits.
CREATE TABLE IF NOT EXISTS worker_settlements (
 id uuid PRIMARY KEY, intent_id bigint NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
 exploration_id bigint NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, worker text NOT NULL,
 activity_id bigint, created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);
CREATE INDEX IF NOT EXISTS worker_settlements_pending ON worker_settlements(exploration_id) WHERE released_at IS NULL;
ALTER TABLE blackboard_planning_rounds ADD COLUMN IF NOT EXISTS source_versions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Direct Worker writeback: retries of one tool call return its original graph node.
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS tool_call_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_tool_call ON exploration_nodes(exploration_id,tool_call_id)
 WHERE kind='fact' AND tool_call_id IS NOT NULL;

-- Durable human continuation identity; native PI sessions carry the actual dialogue.
CREATE TABLE IF NOT EXISTS worker_interventions (
 id BIGSERIAL PRIMARY KEY,
 task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 intent_id BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,
 message TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 completed_at TIMESTAMPTZ,
 UNIQUE(task_id,intent_id,request_id)
);

ALTER TABLE engine_worker_slots ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT false;

-- Neo turn display projection; source activities remain the durable authority.
CREATE INDEX IF NOT EXISTS idx_activity_turn ON activity(exploration_id,(metadata->>'turn_id'),id);
CREATE INDEX IF NOT EXISTS idx_conversation_activity_turn ON conversation_activities(conversation_id,(metadata->>'turn_id'),id);

-- SERIES asset graph parity. Rows are written only after the item transaction succeeds.
CREATE TABLE IF NOT EXISTS asset_tool_writes (
 execution TEXT NOT NULL,call_id TEXT NOT NULL,item_index INTEGER NOT NULL,
 asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,result JSONB NOT NULL,
 PRIMARY KEY(execution,call_id,item_index)
);
CREATE TABLE IF NOT EXISTS asset_id_aliases (
 old_id BIGINT PRIMARY KEY,asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 original JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(old_id<>asset_id)
);
CREATE TABLE IF NOT EXISTS asset_graph_repairs (
 repair_key TEXT PRIMARY KEY,before_data JSONB NOT NULL,after_data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION capture_asset_graph_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE tids BIGINT[];tid BIGINT;eid BIGINT;
BEGIN
 IF current_setting('series.asset_repair',true)='on' THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='assets' THEN
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['last_seen','updated_at','task_ids']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['last_seen','updated_at','task_ids']) THEN RETURN NULL;END IF;
  SELECT array_agg(task_id) INTO tids FROM task_asset_links WHERE asset_id=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 ELSIF TG_TABLE_NAME='tasks' THEN
  IF (OLD.coverage_enabled,OLD.deleted_at) IS NOT DISTINCT FROM (NEW.coverage_enabled,NEW.deleted_at) THEN RETURN NULL;END IF;
  tids:=ARRAY[NEW.id];
 ELSE
  -- A fact updates coverage while it is still running. This is not asset
  -- discovery and must not turn each writeback into an immediate Planner wake.
  IF TG_TABLE_NAME='task_asset_links' AND TG_OP='UPDATE' AND
    (to_jsonb(OLD)-ARRAY['updated_at','notification_xid','tested','tested_at','tested_by']) IS NOT DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['updated_at','notification_xid','tested','tested_at','tested_by']) THEN RETURN NULL;END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['updated_at','notification_xid']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['updated_at','notification_xid']) THEN RETURN NULL;END IF;
  tids:=ARRAY[CASE WHEN TG_OP='DELETE' THEN OLD.task_id ELSE NEW.task_id END];
 END IF;
 FOR tid IN SELECT DISTINCT id FROM tasks WHERE deleted_at IS NULL AND
 (id=ANY(tids) OR id IN(SELECT task_id FROM task_relations WHERE source_task_id=ANY(tids))) LOOP
  SELECT exploration_id INTO eid FROM tasks WHERE id=tid;
  UPDATE explorations SET published_revision=published_revision+1 WHERE id=eid;
  INSERT INTO blackboard_wakeups(exploration_id,event_key,kind)
    VALUES(eid,'assets:'||pg_current_xact_id()::text,'assets_changed') ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM exploration_context_events WHERE exploration_id=eid AND kind='assets' AND acknowledged_at IS NULL) THEN
   INSERT INTO exploration_context_events(exploration_id,kind) VALUES(eid,'assets');
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS context_assets_event ON task_asset_links;
DROP TRIGGER IF EXISTS blackboard_assets ON task_asset_links;
DROP TRIGGER IF EXISTS asset_graph_content ON assets;
CREATE TRIGGER asset_graph_content AFTER INSERT OR UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION capture_asset_graph_change();
DROP TRIGGER IF EXISTS asset_graph_links ON task_asset_links;
CREATE TRIGGER asset_graph_links AFTER INSERT OR UPDATE OR DELETE ON task_asset_links FOR EACH ROW EXECUTE FUNCTION capture_asset_graph_change();
DROP TRIGGER IF EXISTS asset_graph_scope ON task_scope;
CREATE TRIGGER asset_graph_scope AFTER INSERT OR UPDATE OR DELETE ON task_scope FOR EACH ROW EXECUTE FUNCTION capture_asset_graph_change();
DROP TRIGGER IF EXISTS asset_graph_sources ON task_relations;
CREATE TRIGGER asset_graph_sources AFTER INSERT OR UPDATE OR DELETE ON task_relations FOR EACH ROW EXECUTE FUNCTION capture_asset_graph_change();

ALTER TABLE asset_tool_writes DROP CONSTRAINT IF EXISTS asset_tool_writes_asset_id_fkey;
ALTER TABLE asset_tool_writes ADD CONSTRAINT asset_tool_writes_asset_id_fkey FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE;
ALTER TABLE asset_id_aliases DROP CONSTRAINT IF EXISTS asset_id_aliases_asset_id_fkey;
ALTER TABLE asset_id_aliases ADD CONSTRAINT asset_id_aliases_asset_id_fkey FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE;

DROP TRIGGER IF EXISTS asset_graph_task_visibility ON tasks;
CREATE TRIGGER asset_graph_task_visibility AFTER UPDATE OF coverage_enabled,deleted_at ON tasks FOR EACH ROW EXECUTE FUNCTION capture_asset_graph_change();

-- Only new task creation opts into isolated Goals; never backfill historical tasks.
CREATE TABLE IF NOT EXISTS goals_bootstrap (
 task_id BIGINT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 policy TEXT NOT NULL DEFAULT 'goal-field-isolation-v1',
 goal TEXT NOT NULL, description TEXT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'constraints' CHECK(phase IN ('constraints','objectives','completed')),
 goal_ids BIGINT[] NOT NULL DEFAULT '{}', fallback BOOLEAN NOT NULL DEFAULT false,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Planning capacity is independent of Worker execution capacity.
CREATE TABLE IF NOT EXISTS engine_planner_slots (
 task_id BIGINT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 token TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
