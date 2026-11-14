package content_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
)

func repoContentDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "content"))
	if err != nil {
		t.Fatalf("resolve content dir: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Skipf("content dir unavailable at %s: %v", dir, err)
	}
	return dir
}

func TestRealCorpusLoadAndValidate(t *testing.T) {
	store := content.NewStore(repoContentDir(t), nil)
	docs, valErrs, err := store.LoadAll()
	if err != nil {
		t.Fatalf("LoadAll failed: %v", err)
	}
	if len(valErrs) > 0 {
		t.Fatalf("expected zero validation errors, got: %v", valErrs)
	}
	if len(docs) != 13 {
		t.Fatalf("expected 13 real documents, got %d", len(docs))
	}

	scanned, published := store.Stats()
	if scanned != 13 || published != 13 {
		t.Fatalf("unexpected stats scanned=%d published=%d", scanned, published)
	}

	// Verify derived title & slug on note without explicit title/slug in frontmatter.
	note, ok := store.GetPublished(content.TypeNote, "the-ones-that-find-bugs")
	if !ok {
		t.Fatalf("expected derived slug the-ones-that-find-bugs to resolve")
	}
	if note.Title != "The ones that find bugs" {
		t.Fatalf("unexpected derived title %q", note.Title)
	}
	if note.PublishedAt == nil || note.PublishedAt.Hour() != 12 || note.PublishedAt.Location() != time.UTC {
		t.Fatalf("expected bare date anchored to 12:00 UTC, got %v", note.PublishedAt)
	}
}

func TestFrontmatterAliasesAndExtraRoundTrip(t *testing.T) {
	raw := `---
summary: Short alias summary
pubDate: 2026-06-01
image: /uploads/cover.png
categories: [Systems, Go]
github: https://github.com/example/repo
homepage: https://example.com
techStack: [Go, Postgres]
translationKey: dual-post-1
series: Deep Dives
seriesOrder: 2
comments: false
customAuthorHandle: "@ink"
---
Title from body paragraph fallback

# Intro
Hello world.
`
	yamlPart, body, hasFM, err := content.SplitFrontmatter(raw)
	if err != nil || !hasFM {
		t.Fatalf("SplitFrontmatter failed: hasFM=%v err=%v", hasFM, err)
	}

	_, err = content.ParseFrontmatter(yamlPart, content.TypeProject)
	if err == nil {
		t.Fatalf("expected error for TypeProject without explicit title")
	}
	fm, err := content.ParseFrontmatter(yamlPart, content.TypeNote)
	if err != nil {
		t.Fatalf("ParseFrontmatter for TypeNote failed: %v", err)
	}
	if fm.Description != "Short alias summary" {
		t.Fatalf("expected summary alias -> Description, got %q", fm.Description)
	}
	if fm.Extra["customAuthorHandle"] != "@ink" {
		t.Fatalf("expected customAuthorHandle extra preserved, got %v", fm.Extra)
	}
	_ = body
}

func TestFrontmatterAliasNormalizationAndExtraPreservation(t *testing.T) {
	raw := `---
title: Compatibility Spec
summary: Legacy summary field
pubDate: 2026-07-15
image: /uploads/thumb.png
categories: [Engineering, Storage]
github: https://github.com/crackrammer/inkbranch
homepage: https://blog.crackrammer.com
techStack: [Go, React]
translationKey: compat-spec
series: Foundations
seriesOrder: 3
comments: false
legacyCustomFlag: keep-me
---

Body content here.
`
	yamlPart, body, hasFM, err := content.SplitFrontmatter(raw)
	if err != nil || !hasFM {
		t.Fatalf("SplitFrontmatter failed: hasFM=%v err=%v", hasFM, err)
	}

	fm, err := content.ParseFrontmatter(yamlPart, content.TypeProject)
	if err != nil {
		t.Fatalf("ParseFrontmatter failed: %v", err)
	}
	if fm.Description != "Legacy summary field" {
		t.Fatalf("expected summary alias -> Description, got %q", fm.Description)
	}
	if fm.Cover != "/uploads/thumb.png" {
		t.Fatalf("expected image alias -> Cover, got %q", fm.Cover)
	}
	if fm.Category != "Engineering" {
		t.Fatalf("expected categories[0] -> Category, got %q", fm.Category)
	}
	if fm.RepoURL != "https://github.com/crackrammer/inkbranch" || fm.WebsiteURL != "https://blog.crackrammer.com" {
		t.Fatalf("unexpected project URLs: repo=%q web=%q", fm.RepoURL, fm.WebsiteURL)
	}
	if len(fm.TechStack) != 2 || fm.TechStack[0] != "Go" {
		t.Fatalf("expected techStack alias -> TechStack, got %v", fm.TechStack)
	}
	if fm.SeriesOrder == nil || *fm.SeriesOrder != 3 || fm.TranslationKey != "compat-spec" || fm.Comments {
		t.Fatalf("unexpected v2 fields: seriesOrder=%v translationKey=%q comments=%v", fm.SeriesOrder, fm.TranslationKey, fm.Comments)
	}
	if fm.PublishedAt == nil || fm.PublishedAt.Hour() != 12 {
		t.Fatalf("expected pubDate anchored at noon UTC, got %v", fm.PublishedAt)
	}
	if fm.Extra["legacyCustomFlag"] != "keep-me" {
		t.Fatalf("expected unknown extra key preserved, got %v", fm.Extra)
	}

	rendered, err := content.RenderMarkdownFile(map[string]any{
		"title":  fm.Title,
		"status": string(fm.Status),
	}, fm.Extra, body)
	if err != nil {
		t.Fatalf("RenderMarkdownFile failed: %v", err)
	}
	if !strings.Contains(rendered, "legacyCustomFlag: keep-me") {
		t.Fatalf("rendered frontmatter dropped unknown extra field:\n%s", rendered)
	}
}

func TestWriteAtomicConflictRecoveryAndSecurity(t *testing.T) {
	tmpDir := t.TempDir()
	postsDir := filepath.Join(tmpDir, "posts")
	if err := os.MkdirAll(postsDir, 0o755); err != nil {
		t.Fatal(err)
	}

	first := []byte("---\ntitle: First Version\ndate: 2026-09-01\n---\n\nHello v1.\n")
	res1, err := content.WriteAtomic(content.WriteAtomicOptions{
		ContentDir:   tmpDir,
		RelativePath: "posts/hello.md",
		Data:         first,
	})
	if err != nil {
		t.Fatalf("initial WriteAtomic failed: %v", err)
	}
	if res1.SHA256 == "" || res1.RecoveryPath != "" {
		t.Fatalf("unexpected initial write result: %+v", res1)
	}

	// Optimistic concurrency failure when passing wrong checksum.
	_, err = content.WriteAtomic(content.WriteAtomicOptions{
		ContentDir:     tmpDir,
		RelativePath:   "posts/hello.md",
		Data:           []byte("overwrite"),
		ExpectedSHA256: "deadbeef",
	})
	if err != content.ErrConflict {
		t.Fatalf("expected ErrConflict, got %v", err)
	}

	// Valid overwrite with matching SHA-256 produces a .recovery backup of v1.
	second := []byte("---\ntitle: Second Version\ndate: 2026-09-02\n---\n\nHello v2.\n")
	res2, err := content.WriteAtomic(content.WriteAtomicOptions{
		ContentDir:     tmpDir,
		RelativePath:   "posts/hello.md",
		Data:           second,
		ExpectedSHA256: res1.SHA256,
	})
	if err != nil {
		t.Fatalf("overwrite WriteAtomic failed: %v", err)
	}
	if res2.RecoveryPath == "" {
		t.Fatalf("expected pre-write .recovery backup path on overwrite")
	}
	bakData, err := os.ReadFile(res2.RecoveryPath)
	if err != nil || string(bakData) != string(first) {
		t.Fatalf("recovery backup mismatch: err=%v data=%q", err, string(bakData))
	}

	// Path traversal must fail cleanly.
	if _, err := content.WriteAtomic(content.WriteAtomicOptions{
		ContentDir:   tmpDir,
		RelativePath: "../escape.md",
		Data:         first,
	}); err == nil {
		t.Fatalf("expected path traversal rejection")
	}

	// Symlink files must be rejected by ReadDocumentFile.
	targetOutside := filepath.Join(tmpDir, "secret.md")
	_ = os.WriteFile(targetOutside, first, 0o600)
	symPath := filepath.Join(postsDir, "symlink.md")
	if err := os.Symlink(targetOutside, symPath); err != nil {
		t.Fatalf("symlink setup failed: %v", err)
	}
	if _, err := content.ReadDocumentFile(tmpDir, "posts/symlink.md", content.TypePost); err == nil {
		t.Fatalf("expected symlink rejection")
	}
}
