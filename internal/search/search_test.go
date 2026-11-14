package search_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/search"
)

func TestBM25FMixedCJKAndEnglishSearch(t *testing.T) {
	dir, err := filepath.Abs(filepath.Join("..", "..", "content"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Skipf("content dir missing: %v", err)
	}

	store := content.NewStore(dir, nil)
	if _, valErrs, err := store.LoadAll(); err != nil || len(valErrs) > 0 {
		t.Fatalf("LoadAll failed: err=%v valErrs=%v", err, valErrs)
	}
	docs := store.ListPublished("")

	// English query matching atomic-writes.
	res := search.Search(docs, search.QueryOptions{Query: "atomic rename", Limit: 10})
	if res.Total == 0 || len(res.Hits) == 0 {
		t.Fatalf("expected hits for 'atomic rename'")
	}
	if res.Hits[0].Slug != "atomic-writes" {
		t.Fatalf("expected top hit 'atomic-writes', got %q", res.Hits[0].Slug)
	}
	if !strings.Contains(res.Hits[0].SnippetHTML, "<mark>") {
		t.Fatalf("expected highlighted <mark> in snippet: %s", res.Hits[0].SnippetHTML)
	}

	// Type filter narrows cleanly.
	noteRes := search.Search(docs, search.QueryOptions{Query: "strictNullChecks", Type: content.TypeNote})
	if noteRes.Total == 0 || noteRes.Hits[0].Type != content.TypeNote {
		t.Fatalf("expected note hit for strictNullChecks, got %+v", noteRes)
	}

	// Synthetic CJK + XSS snippet escaping check.
	cjkDoc := &content.Document{
		Type:      content.TypePost,
		Slug:      "cjk-bm25",
		Title:     "中文全文检索与架构设计",
		Tags:      []string{"搜索引擎", "Go"},
		PlainText: "这里包含 <script>bad()</script> 与中文全文检索索引分片细节。",
	}
	cjkRes := search.Search([]*content.Document{cjkDoc}, search.QueryOptions{Query: "中文检索"})
	if cjkRes.Total != 1 {
		t.Fatalf("expected CJK bigram/unigram match, got total=%d", cjkRes.Total)
	}
	if strings.Contains(cjkRes.Hits[0].SnippetHTML, "<script>") {
		t.Fatalf("expected HTML escaping inside search snippet, got: %s", cjkRes.Hits[0].SnippetHTML)
	}
}
