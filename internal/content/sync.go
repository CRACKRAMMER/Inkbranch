package content

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/CRACKRAMMER/Inkbranch/internal/db"
)

// TokenBuilder allows injecting CJK/Latin search token strings during PostgreSQL sync.
type TokenBuilder func(doc *Document) string

// SyncReport summarizes changes applied between disk Markdown files and PostgreSQL index.
type SyncReport struct {
	Scanned   int
	Published int
	Upserted  int
	Deleted   int64
	Errors    []ValidationError
}

// SyncToDatabase reloads disk content, upserts every valid document into PostgreSQL,
// and prunes stale paths only when scan completed cleanly.
func (s *Store) SyncToDatabase(ctx context.Context, repo *db.Repo, tokenBuilder TokenBuilder) (*SyncReport, error) {
	docs, valErrs, err := s.LoadAll()
	if err != nil {
		return nil, err
	}

	report := &SyncReport{
		Scanned: len(docs),
		Errors:  valErrs,
	}

	if repo == nil {
		_, report.Published = s.Stats()
		return report, nil
	}

	activePaths := make([]string, 0, len(docs))
	for _, doc := range docs {
		activePaths = append(activePaths, doc.RelativePath)

		seoBytes, _ := json.Marshal(doc.SEO)
		extraBytes, _ := json.Marshal(doc.Extra)
		tocBytes, _ := json.Marshal(doc.Headings)

		tags := make([]db.TagRecord, 0, len(doc.Tags))
		for _, t := range doc.Tags {
			tags = append(tags, db.TagRecord{Name: t, Slug: TagSlug(t)})
		}

		links := make([]db.LinkRecord, 0, len(doc.OutgoingLinks))
		for _, l := range doc.OutgoingLinks {
			var tType *string
			if l.TargetType != "" {
				v := l.TargetType
				tType = &v
			}
			links = append(links, db.LinkRecord{
				TargetType:     tType,
				TargetSlug:     l.TargetSlug,
				LinkText:       l.LinkText,
				ContextSnippet: l.ContextSnippet,
			})
		}

		var catPtr, covPtr, trPtr, serPtr, psPtr, repoPtr, webPtr *string
		if doc.Category != "" {
			v := doc.Category
			catPtr = &v
		}
		if doc.Cover != "" {
			v := doc.Cover
			covPtr = &v
		}
		if doc.TranslationKey != "" {
			v := doc.TranslationKey
			trPtr = &v
		}
		if doc.Series != "" {
			v := doc.Series
			serPtr = &v
		}
		if doc.ProjectStatus != "" {
			v := string(doc.ProjectStatus)
			psPtr = &v
		}
		if doc.RepoURL != "" {
			v := doc.RepoURL
			repoPtr = &v
		}
		if doc.WebsiteURL != "" {
			v := doc.WebsiteURL
			webPtr = &v
		}

		tokens := doc.PlainText
		if tokenBuilder != nil {
			tokens = tokenBuilder(doc)
		}

		rec := db.ContentRecord{
			Type:            string(doc.Type),
			Slug:            doc.Slug,
			Path:            doc.RelativePath,
			Title:           doc.Title,
			Description:     doc.Description,
			Summary:         doc.Summary,
			Status:          string(doc.Status),
			Category:        catPtr,
			PublishedAt:     doc.PublishedAt,
			ScheduledAt:     doc.ScheduledAt,
			UpdatedAt:       doc.UpdatedAt,
			Cover:           covPtr,
			Featured:        doc.Featured,
			TOCEnabled:      doc.TOCEnabled,
			CommentsEnabled: doc.Comments,
			Lang:            doc.Lang,
			TranslationKey:  trPtr,
			Series:          serPtr,
			SeriesOrder:     doc.SeriesOrder,
			ProjectStatus:   psPtr,
			ProjectStarted:  doc.StartedAt,
			ProjectRepo:     repoPtr,
			ProjectWebsite:  webPtr,
			ProjectStack:    doc.TechStack,
			SEOJSON:         seoBytes,
			ExtraJSON:       extraBytes,
			WordCount:       doc.WordCount,
			ReadingMinutes:  doc.ReadingMinutes,
			Checksum:        doc.Checksum,
			FileSize:        doc.ByteSize,
			MtimeNs:         doc.FileMtimeNs,
			RenderedHTML:    doc.RenderedHTML,
			TOCJSON:         tocBytes,
			SearchTokens:    strings.TrimSpace(tokens),
			Tags:            tags,
			Links:           links,
		}

		if _, err := repo.UpsertContent(ctx, rec); err != nil {
			return report, fmt.Errorf("sync %s: %w", doc.RelativePath, err)
		}
		report.Upserted++
		if isPublicDocument(doc) {
			report.Published++
		}
	}

	// Only delete paths absent from disk if there were zero validation errors on disk,
	// preventing temporary syntax errors from cascading into deleted index/revision rows.
	if len(valErrs) == 0 {
		deleted, err := repo.DeleteMissingContentPaths(ctx, activePaths)
		if err != nil {
			return report, fmt.Errorf("prune missing paths: %w", err)
		}
		report.Deleted = deleted
	}

	return report, nil
}
