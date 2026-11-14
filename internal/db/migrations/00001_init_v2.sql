-- +goose Up
-- Inkbranch v2 PostgreSQL 17 Schema Blueprint

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Content & Knowledge Graph Domain

CREATE TABLE content_index (
    id                uuid PRIMARY KEY,
    type              text NOT NULL CHECK (type IN ('post', 'note', 'project')),
    slug              text NOT NULL,
    path              text NOT NULL UNIQUE,
    title             text NOT NULL,
    description       text NOT NULL DEFAULT '',
    summary           text NOT NULL DEFAULT '',
    status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'published', 'archived', 'unlisted')),
    category          text,
    published_at      timestamptz,
    scheduled_at      timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    cover             text,
    featured          boolean NOT NULL DEFAULT false,
    toc_enabled       boolean NOT NULL DEFAULT true,
    comments_enabled  boolean NOT NULL DEFAULT true,
    lang              text NOT NULL DEFAULT 'en',
    translation_key   text,
    series            text,
    series_order      integer,
    project_status    text CHECK (project_status IS NULL OR project_status IN ('active', 'maintained', 'experiment', 'archived')),
    project_started   timestamptz,
    project_repo      text,
    project_website   text,
    project_stack     text[] NOT NULL DEFAULT '{}',
    seo_json          jsonb NOT NULL DEFAULT '{}'::jsonb,
    extra_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
    word_count        integer NOT NULL DEFAULT 0,
    reading_minutes   integer NOT NULL DEFAULT 1,
    checksum          text NOT NULL,
    file_size         bigint NOT NULL DEFAULT 0,
    mtime_ns          bigint NOT NULL DEFAULT 0,
    rendered_html     text NOT NULL DEFAULT '',
    toc_json          jsonb NOT NULL DEFAULT '[]'::jsonb,
    search_tokens     text NOT NULL DEFAULT '',
    search_vector     tsvector,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (type, slug)
);

CREATE INDEX content_index_status_pub_idx ON content_index (status, type, published_at DESC);
CREATE INDEX content_index_series_idx ON content_index (series, series_order, published_at ASC) WHERE series IS NOT NULL;
CREATE INDEX content_index_translation_idx ON content_index (translation_key) WHERE translation_key IS NOT NULL;
CREATE INDEX content_index_search_vec_idx ON content_index USING GIN (search_vector);
CREATE INDEX content_index_title_trgm_idx ON content_index USING GIN (title gin_trgm_ops);

CREATE TABLE content_revisions (
    id              uuid PRIMARY KEY,
    content_id      uuid NOT NULL REFERENCES content_index(id) ON DELETE CASCADE,
    revision_num    integer NOT NULL,
    checksum        text NOT NULL,
    compressed_body bytea NOT NULL,
    diff_text       text NOT NULL DEFAULT '',
    actor_id        uuid,
    note            text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (content_id, revision_num)
);

CREATE TABLE draft_previews (
    id            uuid PRIMARY KEY,
    token_hash    text NOT NULL UNIQUE,
    content_type  text NOT NULL,
    content_slug  text NOT NULL,
    label         text NOT NULL DEFAULT '',
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz,
    created_by    uuid,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX draft_previews_target_idx ON draft_previews (content_type, content_slug, expires_at DESC);

CREATE TABLE tags (
    id          uuid PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    slug        text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_tags (
    content_id  uuid NOT NULL REFERENCES content_index(id) ON DELETE CASCADE,
    tag_id      uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (content_id, tag_id)
);

CREATE TABLE content_links (
    id               uuid PRIMARY KEY,
    source_id        uuid NOT NULL REFERENCES content_index(id) ON DELETE CASCADE,
    target_type      text,
    target_slug      text NOT NULL,
    target_id        uuid REFERENCES content_index(id) ON DELETE SET NULL,
    link_text        text NOT NULL DEFAULT '',
    context_snippet  text NOT NULL DEFAULT ''
);

CREATE INDEX content_links_source_idx ON content_links (source_id);
CREATE INDEX content_links_target_idx ON content_links (target_id) WHERE target_id IS NOT NULL;

-- 2. Auth & Security Domain

CREATE TABLE users (
    id            uuid PRIMARY KEY,
    email         text NOT NULL UNIQUE,
    name          text NOT NULL,
    password_hash text NOT NULL,
    role          text NOT NULL DEFAULT 'admin',
    avatar_url    text,
    bio           text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id            uuid PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    text NOT NULL UNIQUE,
    csrf_secret   text NOT NULL,
    ip_hash       text NOT NULL DEFAULT '',
    user_agent    text NOT NULL DEFAULT '',
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at DESC);

CREATE TABLE passkey_credentials (
    id               uuid PRIMARY KEY,
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id    bytea NOT NULL UNIQUE,
    public_key       bytea NOT NULL,
    attestation_type text NOT NULL DEFAULT 'none',
    aaguid           bytea,
    sign_count       bigint NOT NULL DEFAULT 0,
    transports       text[] NOT NULL DEFAULT '{}',
    credential_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
    label            text NOT NULL DEFAULT 'Passkey',
    last_used_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE totp_secrets (
    user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_secret    bytea NOT NULL,
    recovery_code_hashes text[] NOT NULL DEFAULT '{}',
    enabled             boolean NOT NULL DEFAULT false,
    verified_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
    id            uuid PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          text NOT NULL,
    token_prefix  text NOT NULL,
    token_hash    text NOT NULL UNIQUE,
    scopes        text[] NOT NULL DEFAULT '{}',
    last_used_at  timestamptz,
    expires_at    timestamptz,
    revoked_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limits (
    key           text PRIMARY KEY,
    count         integer NOT NULL DEFAULT 0,
    window_start  timestamptz NOT NULL,
    expires_at    timestamptz NOT NULL
);

CREATE TABLE audit_logs (
    id          uuid PRIMARY KEY,
    actor_type  text NOT NULL,
    actor_id    uuid,
    action      text NOT NULL,
    target_type text,
    target_id   text,
    ip_hash     text NOT NULL DEFAULT '',
    meta_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

-- 3. Media & Ops Domain

CREATE TABLE assets (
    id             uuid PRIMARY KEY,
    storage_driver text NOT NULL DEFAULT 'local' CHECK (storage_driver IN ('local', 'r2')),
    storage_key    text NOT NULL UNIQUE,
    public_url     text NOT NULL,
    filename       text NOT NULL,
    mime_type      text NOT NULL,
    byte_size      bigint NOT NULL,
    width          integer,
    height         integer,
    thumbhash      text,
    exif_stripped  boolean NOT NULL DEFAULT true,
    alt_text       text NOT NULL DEFAULT '',
    variants_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by     uuid,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE backups (
    id             uuid PRIMARY KEY,
    filename       text NOT NULL,
    storage_driver text NOT NULL DEFAULT 'local' CHECK (storage_driver IN ('local', 'r2')),
    storage_key    text NOT NULL,
    byte_size      bigint NOT NULL DEFAULT 0,
    checksum       text NOT NULL DEFAULT '',
    status         text NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed')),
    error_message  text NOT NULL DEFAULT '',
    created_by     uuid,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhooks (
    id          uuid PRIMARY KEY,
    name        text NOT NULL,
    target_url  text NOT NULL,
    secret_enc  bytea NOT NULL,
    events      text[] NOT NULL DEFAULT '{}',
    enabled     boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
    id            uuid PRIMARY KEY,
    webhook_id    uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_name    text NOT NULL,
    payload_json  jsonb NOT NULL,
    attempt       integer NOT NULL DEFAULT 1,
    status_code   integer,
    response_body text NOT NULL DEFAULT '',
    error_message text NOT NULL DEFAULT '',
    delivered_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_jobs (
    id            uuid PRIMARY KEY,
    kind          text NOT NULL,
    payload_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    run_at        timestamptz NOT NULL DEFAULT now(),
    lease_owner   text,
    lease_until   timestamptz,
    attempts      integer NOT NULL DEFAULT 0,
    max_attempts  integer NOT NULL DEFAULT 5,
    last_error    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scheduled_jobs_poll_idx ON scheduled_jobs (status, run_at) WHERE status IN ('pending', 'running');

-- 4. Community, Subscriptions & Site Config Domain

CREATE TABLE comments (
    id            uuid PRIMARY KEY,
    content_type  text NOT NULL,
    content_slug  text NOT NULL,
    parent_id     uuid REFERENCES comments(id) ON DELETE CASCADE,
    author_name   text NOT NULL,
    author_email_hash text NOT NULL DEFAULT '',
    author_url    text NOT NULL DEFAULT '',
    is_admin      boolean NOT NULL DEFAULT false,
    body_markdown text NOT NULL,
    body_html     text NOT NULL,
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'spam', 'deleted')),
    pinned           boolean NOT NULL DEFAULT false,
    notify_reply     boolean NOT NULL DEFAULT false,
    notify_email_enc bytea,
    ip_hash          text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX comments_target_idx ON comments (content_type, content_slug, status, created_at ASC);

CREATE TABLE reactions (
    id           uuid PRIMARY KEY,
    content_type text NOT NULL,
    content_slug text NOT NULL,
    emoji        text NOT NULL,
    voter_hash   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (content_type, content_slug, emoji, voter_hash)
);

CREATE INDEX reactions_target_idx ON reactions (content_type, content_slug);

CREATE TABLE subscribers (
    id                uuid PRIMARY KEY,
    email             text NOT NULL UNIQUE,
    status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'unsubscribed')),
    confirm_token     text UNIQUE,
    unsubscribe_token text NOT NULL UNIQUE,
    confirmed_at      timestamptz,
    unsubscribed_at   timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE newsletters (
    id            uuid PRIMARY KEY,
    subject       text NOT NULL,
    body_markdown text NOT NULL,
    body_html     text NOT NULL,
    content_type  text,
    content_slug  text,
    status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed')),
    sent_count    integer NOT NULL DEFAULT 0,
    failed_count  integer NOT NULL DEFAULT 0,
    sent_at       timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE friend_links (
    id           uuid PRIMARY KEY,
    name         text NOT NULL,
    url          text NOT NULL UNIQUE,
    feed_url     text NOT NULL DEFAULT '',
    avatar_url   text NOT NULL DEFAULT '',
    description  text NOT NULL DEFAULT '',
    group_name   text NOT NULL DEFAULT 'Friends',
    status       text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'unreachable', 'hidden')),
    sort_order   integer NOT NULL DEFAULT 0,
    etag         text NOT NULL DEFAULT '',
    last_modified text NOT NULL DEFAULT '',
    last_checked_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE friend_feeds (
    id            uuid PRIMARY KEY,
    friend_id     uuid NOT NULL REFERENCES friend_links(id) ON DELETE CASCADE,
    item_guid     text NOT NULL,
    title         text NOT NULL,
    link          text NOT NULL,
    summary       text NOT NULL DEFAULT '',
    published_at  timestamptz NOT NULL,
    fetched_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (friend_id, item_guid)
);

CREATE INDEX friend_feeds_published_idx ON friend_feeds (published_at DESC);

CREATE TABLE site_settings (
    key        text PRIMARY KEY,
    value_json jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE navigation (
    id         uuid PRIMARY KEY,
    label      text NOT NULL,
    href       text NOT NULL,
    external   boolean NOT NULL DEFAULT false,
    sort_order integer NOT NULL DEFAULT 0,
    visible    boolean NOT NULL DEFAULT true
);

CREATE TABLE redirects (
    id          uuid PRIMARY KEY,
    source_path text NOT NULL UNIQUE,
    target_path text NOT NULL,
    status_code integer NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302, 307, 308)),
    hits        bigint NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_events (
    id          uuid PRIMARY KEY,
    path        text NOT NULL,
    content_type text,
    content_slug text,
    visitor_hash text NOT NULL,
    referrer_host text NOT NULL DEFAULT '',
    device_kind text NOT NULL DEFAULT 'desktop',
    dwell_ms    integer NOT NULL DEFAULT 0,
    scroll_pct  integer NOT NULL DEFAULT 0,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX analytics_events_occurred_idx ON analytics_events (occurred_at DESC);

CREATE TABLE analytics_daily (
    day           date NOT NULL,
    path          text NOT NULL,
    views         integer NOT NULL DEFAULT 0,
    unique_visitors integer NOT NULL DEFAULT 0,
    avg_dwell_ms  integer NOT NULL DEFAULT 0,
    avg_scroll_pct integer NOT NULL DEFAULT 0,
    PRIMARY KEY (day, path)
);

-- +goose Down
DROP TABLE IF EXISTS analytics_daily;
DROP TABLE IF EXISTS analytics_events;
DROP TABLE IF EXISTS redirects;
DROP TABLE IF EXISTS navigation;
DROP TABLE IF EXISTS site_settings;
DROP TABLE IF EXISTS friend_feeds;
DROP TABLE IF EXISTS friend_links;
DROP TABLE IF EXISTS newsletters;
DROP TABLE IF EXISTS subscribers;
DROP TABLE IF EXISTS reactions;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS scheduled_jobs;
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhooks;
DROP TABLE IF EXISTS backups;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS totp_secrets;
DROP TABLE IF EXISTS passkey_credentials;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS content_links;
DROP TABLE IF EXISTS content_tags;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS draft_previews;
DROP TABLE IF EXISTS content_revisions;
DROP TABLE IF EXISTS content_index;
