package ops

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/community"
	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/db"
	"github.com/CRACKRAMMER/Inkbranch/internal/distribution"
	"github.com/CRACKRAMMER/Inkbranch/internal/media"
	"github.com/CRACKRAMMER/Inkbranch/internal/search"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
)

type SchedulerDeps struct {
	Config   *config.Config
	Logger   *slog.Logger
	Store    *content.Store
	Repo     *db.Repo
	State    state.Store
	Storage  media.StorageDriver
	Webhooks *distribution.WebhookDispatcher
	Poller   *community.FeedPoller
}

// StartScheduler launches background maintenance ticks (scheduled post publishing, friend RSS polling,
// analytics daily rollup, and periodic backup retention) until ctx is canceled.
func StartScheduler(ctx context.Context, deps SchedulerDeps) {
	if deps.Logger == nil {
		return
	}
	pubTicker := time.NewTicker(1 * time.Minute)
	rssTicker := time.NewTicker(30 * time.Minute)
	analyticsTicker := time.NewTicker(15 * time.Minute)
	defer pubTicker.Stop()
	defer rssTicker.Stop()
	defer analyticsTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-pubTicker.C:
			publishDueScheduledDocs(ctx, deps, now.UTC())
		case <-rssTicker.C:
			if deps.Poller != nil && deps.State != nil {
				checked, added := deps.Poller.PollAll(ctx, deps.State)
				deps.Logger.Debug("scheduled friends RSS poll finished", "checked", checked, "items", added)
			}
		case now := <-analyticsTicker.C:
			if deps.State != nil {
				_ = deps.State.RollupAnalyticsDaily(ctx, now.UTC())
			}
		}
	}
}

func publishDueScheduledDocs(ctx context.Context, deps SchedulerDeps, now time.Time) {
	if deps.Store == nil {
		return
	}
	docs := deps.Store.ListAll()
	changed := false
	for _, doc := range docs {
		if doc.Status != content.StatusScheduled || doc.ScheduledAt == nil {
			continue
		}
		if doc.ScheduledAt.After(now) {
			continue
		}
		rawBytes, err := os.ReadFile(doc.AbsolutePath)
		if err != nil {
			continue
		}
		updated := promoteScheduledFrontmatter(string(rawBytes), *doc.ScheduledAt)
		if _, err := content.WriteAtomic(content.WriteAtomicOptions{
			ContentDir:     deps.Config.ContentDir,
			RelativePath:   doc.RelativePath,
			Data:           []byte(updated),
			ExpectedSHA256: doc.Checksum,
		}); err != nil {
			deps.Logger.Warn("promote scheduled document failed", "path", doc.RelativePath, "error", err)
			continue
		}
		changed = true
		if deps.Webhooks != nil {
			deps.Webhooks.Dispatch(ctx, "content.published", map[string]any{
				"type":  doc.Type,
				"slug":  doc.Slug,
				"title": doc.Title,
				"url":   doc.CanonicalURL(),
			})
		}
	}
	if changed {
		_, _ = deps.Store.SyncToDatabase(ctx, deps.Repo, search.BuildSearchTokensString)
	}
}

func promoteScheduledFrontmatter(raw string, pubTime time.Time) string {
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != "---" {
		return raw
	}
	endIdx := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			endIdx = i
			break
		}
	}
	if endIdx < 0 {
		return raw
	}
	hasPubAt := false
	for i := 1; i < endIdx; i++ {
		trimmed := strings.TrimSpace(lines[i])
		if strings.HasPrefix(trimmed, "status:") {
			lines[i] = "status: published"
		} else if strings.HasPrefix(trimmed, "publishedAt:") {
			hasPubAt = true
		}
	}
	if !hasPubAt {
		pubLine := "publishedAt: " + pubTime.UTC().Format(time.RFC3339)
		newLines := make([]string, 0, len(lines)+1)
		newLines = append(newLines, lines[:endIdx]...)
		newLines = append(newLines, pubLine)
		newLines = append(newLines, lines[endIdx:]...)
		lines = newLines
	}
	return strings.Join(lines, "\n")
}
