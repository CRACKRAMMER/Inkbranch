package content

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watch starts a debounced filesystem watcher on content/{posts,notes,projects} and
// triggers onChange whenever Markdown files are created, modified, or removed.
func Watch(ctx context.Context, contentDir string, logger *slog.Logger, onChange func(ctx context.Context)) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer watcher.Close()

	for _, docType := range AllTypes {
		dir := filepath.Join(contentDir, docType.Dir())
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, wErr error) error {
				if wErr != nil || !d.IsDir() {
					return nil
				}
				name := d.Name()
				if strings.HasPrefix(name, ".") {
					return filepath.SkipDir
				}
				return watcher.Add(path)
			})
		}
	}

	var timer *time.Timer
	var timerCh <-chan time.Time

	for {
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return nil
		case ev, ok := <-watcher.Events:
			if !ok {
				return nil
			}
			base := filepath.Base(ev.Name)
			if strings.HasPrefix(base, ".") {
				continue
			}
			if ev.Has(fsnotify.Create) {
				if info, statErr := os.Stat(ev.Name); statErr == nil && info.IsDir() {
					_ = watcher.Add(ev.Name)
					continue
				}
			}
			lower := strings.ToLower(base)
			if !strings.HasSuffix(lower, ".md") && !strings.HasSuffix(lower, ".markdown") {
				continue
			}
			if timer == nil {
				timer = time.NewTimer(150 * time.Millisecond)
				timerCh = timer.C
			} else {
				timer.Reset(150 * time.Millisecond)
			}
		case err, ok := <-watcher.Errors:
			if !ok {
				return nil
			}
			if logger != nil {
				logger.Warn("content watcher error", "error", err)
			}
		case <-timerCh:
			timer = nil
			timerCh = nil
			if onChange != nil {
				onChange(ctx)
			}
		}
	}
}
