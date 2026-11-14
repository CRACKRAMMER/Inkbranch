-- name: UpsertContentIndex :one
INSERT INTO content_index (
    id, type, slug, path, title, description, summary, status, category,
    published_at, scheduled_at, updated_at, cover, featured, toc_enabled,
    comments_enabled, lang, translation_key, series, series_order,
    project_status, project_started, project_repo, project_website, project_stack,
    seo_json, extra_json, word_count, reading_minutes, checksum, file_size, mtime_ns,
    rendered_html, toc_json, search_tokens, search_vector
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9,
    $10, $11, $12, $13, $14, $15,
    $16, $17, $18, $19, $20,
    $21, $22, $23, $24, $25,
    $26, $27, $28, $29, $30, $31, $32,
    $33, $34, $35,
    setweight(to_tsvector('simple', coalesce($5, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce($35, '')), 'B')
)
ON CONFLICT (path) DO UPDATE SET
    type = EXCLUDED.type,
    slug = EXCLUDED.slug,
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    summary = EXCLUDED.summary,
    status = EXCLUDED.status,
    category = EXCLUDED.category,
    published_at = EXCLUDED.published_at,
    scheduled_at = EXCLUDED.scheduled_at,
    updated_at = EXCLUDED.updated_at,
    cover = EXCLUDED.cover,
    featured = EXCLUDED.featured,
    toc_enabled = EXCLUDED.toc_enabled,
    comments_enabled = EXCLUDED.comments_enabled,
    lang = EXCLUDED.lang,
    translation_key = EXCLUDED.translation_key,
    series = EXCLUDED.series,
    series_order = EXCLUDED.series_order,
    project_status = EXCLUDED.project_status,
    project_started = EXCLUDED.project_started,
    project_repo = EXCLUDED.project_repo,
    project_website = EXCLUDED.project_website,
    project_stack = EXCLUDED.project_stack,
    seo_json = EXCLUDED.seo_json,
    extra_json = EXCLUDED.extra_json,
    word_count = EXCLUDED.word_count,
    reading_minutes = EXCLUDED.reading_minutes,
    checksum = EXCLUDED.checksum,
    file_size = EXCLUDED.file_size,
    mtime_ns = EXCLUDED.mtime_ns,
    rendered_html = EXCLUDED.rendered_html,
    toc_json = EXCLUDED.toc_json,
    search_tokens = EXCLUDED.search_tokens,
    search_vector = EXCLUDED.search_vector
RETURNING id;

-- name: DeleteMissingContentPaths :execrows
DELETE FROM content_index WHERE NOT (path = ANY($1::text[]));

-- name: ListPublishedContent :many
SELECT id, type, slug, path, title, description, status, category, published_at,
       updated_at, cover, featured, toc_enabled, comments_enabled, lang,
       translation_key, series, series_order, project_status, word_count,
       reading_minutes, checksum
FROM content_index
WHERE status = 'published'
ORDER BY published_at DESC NULLS LAST, updated_at DESC;

-- name: CountIndexedContent :one
SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE status = 'published')::int AS published
FROM content_index;

-- name: FindActiveRedirect :one
SELECT target_path, status_code FROM redirects WHERE source_path = $1;

-- name: ListSiteSettings :many
SELECT key, value_json FROM site_settings;
