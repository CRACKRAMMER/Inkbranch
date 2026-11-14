package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ContentRecord represents the serializable index row persisted to content_index.
type ContentRecord struct {
	Type            string
	Slug            string
	Path            string
	Title           string
	Description     string
	Summary         string
	Status          string
	Category        *string
	PublishedAt     *time.Time
	ScheduledAt     *time.Time
	UpdatedAt       time.Time
	Cover           *string
	Featured        bool
	TOCEnabled      bool
	CommentsEnabled bool
	Lang            string
	TranslationKey  *string
	Series          *string
	SeriesOrder     *int
	ProjectStatus   *string
	ProjectStarted  *time.Time
	ProjectRepo     *string
	ProjectWebsite  *string
	ProjectStack    []string
	SEOJSON         []byte
	ExtraJSON       []byte
	WordCount       int
	ReadingMinutes  int
	Checksum        string
	FileSize        int64
	MtimeNs         int64
	RenderedHTML    string
	TOCJSON         []byte
	SearchTokens    string
	Tags            []TagRecord
	Links           []LinkRecord
}

type TagRecord struct {
	Name string
	Slug string
}

type LinkRecord struct {
	TargetType     *string
	TargetSlug     string
	LinkText       string
	ContextSnippet string
}

type IndexCounts struct {
	Total     int
	Published int
}

type RedirectTarget struct {
	TargetPath string
	StatusCode int
}

// Repo exposes strongly-typed PostgreSQL persistence methods backed by pgx/v5.
type Repo struct {
	pool *pgxpool.Pool
}

func NewRepo(pool *pgxpool.Pool) *Repo {
	if pool == nil {
		return nil
	}
	return &Repo{pool: pool}
}

func (r *Repo) CountIndexedContent(ctx context.Context) (IndexCounts, error) {
	if r == nil || r.pool == nil {
		return IndexCounts{}, nil
	}
	var c IndexCounts
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(*)::int AS total,
		       COUNT(*) FILTER (WHERE status = 'published')::int AS published
		FROM content_index
	`).Scan(&c.Total, &c.Published)
	return c, err
}

// UpsertContent atomically synchronizes a single parsed document, its tags, and outgoing links.
func (r *Repo) UpsertContent(ctx context.Context, rec ContentRecord) (uuid.UUID, error) {
	if r == nil || r.pool == nil {
		return uuid.Nil, fmt.Errorf("repository is nil")
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, fmt.Errorf("begin upsert tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	docID := uuid.NewSHA1(uuid.NameSpaceURL, []byte("inkbranch:path:"+rec.Path))
	if rec.ProjectStack == nil {
		rec.ProjectStack = []string{}
	}
	if len(rec.SEOJSON) == 0 {
		rec.SEOJSON = []byte("{}")
	}
	if len(rec.ExtraJSON) == 0 {
		rec.ExtraJSON = []byte("{}")
	}
	if len(rec.TOCJSON) == 0 {
		rec.TOCJSON = []byte("[]")
	}

	var id uuid.UUID
	err = tx.QueryRow(ctx, `
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
		RETURNING id
	`,
		docID, rec.Type, rec.Slug, rec.Path, rec.Title, rec.Description, rec.Summary, rec.Status, rec.Category,
		rec.PublishedAt, rec.ScheduledAt, rec.UpdatedAt, rec.Cover, rec.Featured, rec.TOCEnabled,
		rec.CommentsEnabled, rec.Lang, rec.TranslationKey, rec.Series, rec.SeriesOrder,
		rec.ProjectStatus, rec.ProjectStarted, rec.ProjectRepo, rec.ProjectWebsite, rec.ProjectStack,
		rec.SEOJSON, rec.ExtraJSON, rec.WordCount, rec.ReadingMinutes, rec.Checksum, rec.FileSize, rec.MtimeNs,
		rec.RenderedHTML, rec.TOCJSON, rec.SearchTokens,
	).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert content_index (%s): %w", rec.Path, err)
	}

	if _, err := tx.Exec(ctx, `DELETE FROM content_tags WHERE content_id = $1`, id); err != nil {
		return uuid.Nil, fmt.Errorf("clear content_tags: %w", err)
	}
	for _, t := range rec.Tags {
		tagID := uuid.NewSHA1(uuid.NameSpaceURL, []byte("inkbranch:tag:"+strings.ToLower(t.Slug)))
		var persistedTagID uuid.UUID
		err := tx.QueryRow(ctx, `
			INSERT INTO tags (id, name, slug) VALUES ($1, $2, $3)
			ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
			RETURNING id
		`, tagID, t.Name, t.Slug).Scan(&persistedTagID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("upsert tag %q: %w", t.Name, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO content_tags (content_id, tag_id) VALUES ($1, $2)
			ON CONFLICT DO NOTHING
		`, id, persistedTagID); err != nil {
			return uuid.Nil, fmt.Errorf("link tag %q: %w", t.Name, err)
		}
	}

	if _, err := tx.Exec(ctx, `DELETE FROM content_links WHERE source_id = $1`, id); err != nil {
		return uuid.Nil, fmt.Errorf("clear content_links: %w", err)
	}
	for _, link := range rec.Links {
		linkID := uuid.New()
		if _, err := tx.Exec(ctx, `
			INSERT INTO content_links (id, source_id, target_type, target_slug, target_id, link_text, context_snippet)
			VALUES (
				$1, $2, $3, $4,
				(SELECT id FROM content_index WHERE slug = $4 AND ($3::text IS NULL OR type = $3) LIMIT 1),
				$5, $6
			)
		`, linkID, id, link.TargetType, link.TargetSlug, link.LinkText, link.ContextSnippet); err != nil {
			return uuid.Nil, fmt.Errorf("insert link %q: %w", link.TargetSlug, err)
		}
	}

	// Reconcile any previously unresolved incoming links targeting this slug.
	if _, err := tx.Exec(ctx, `
		UPDATE content_links
		SET target_id = $1
		WHERE target_id IS NULL
		  AND target_slug = $2
		  AND (target_type IS NULL OR target_type = $3)
	`, id, rec.Slug, rec.Type); err != nil {
		return uuid.Nil, fmt.Errorf("reconcile incoming links: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, fmt.Errorf("commit upsert tx: %w", err)
	}
	return id, nil
}

func (r *Repo) DeleteMissingContentPaths(ctx context.Context, activePaths []string) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, nil
	}
	if len(activePaths) == 0 {
		tag, err := r.pool.Exec(ctx, `DELETE FROM content_index`)
		return tag.RowsAffected(), err
	}
	tag, err := r.pool.Exec(ctx, `DELETE FROM content_index WHERE NOT (path = ANY($1::text[]))`, activePaths)
	return tag.RowsAffected(), err
}

func (r *Repo) FindRedirect(ctx context.Context, sourcePath string) (*RedirectTarget, error) {
	if r == nil || r.pool == nil {
		return nil, nil
	}
	var out RedirectTarget
	err := r.pool.QueryRow(ctx, `SELECT target_path, status_code FROM redirects WHERE source_path = $1`, sourcePath).
		Scan(&out.TargetPath, &out.StatusCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (r *Repo) GetSiteSettings(ctx context.Context) (map[string]json.RawMessage, error) {
	if r == nil || r.pool == nil {
		return nil, nil
	}
	rows, err := r.pool.Query(ctx, `SELECT key, value_json FROM site_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	settings := make(map[string]json.RawMessage)
	for rows.Next() {
		var k string
		var v json.RawMessage
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		settings[k] = v
	}
	return settings, rows.Err()
}
