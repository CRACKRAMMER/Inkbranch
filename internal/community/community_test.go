package community

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
)

func TestCommentSanitizationAndTree(t *testing.T) {
	htmlOut, err := RenderCommentMarkdown(`Hello **Inkbranch**! <script>alert(1)</script> [Site](https://blog.crackrammer.com)`)
	if err != nil {
		t.Fatalf("RenderCommentMarkdown: %v", err)
	}
	if strings.Contains(htmlOut, "<script") {
		t.Fatalf("expected script tag stripped, got: %s", htmlOut)
	}
	if !strings.Contains(htmlOut, "nofollow") || !strings.Contains(htmlOut, "noopener") {
		t.Fatalf("expected nofollow and noopener on link, got: %s", htmlOut)
	}

	rootID := uuid.New()
	childID := uuid.New()
	grandChildID := uuid.New()
	now := time.Now().UTC()
	tree := BuildCommentTree([]state.CommentRecord{
		{ID: rootID, AuthorName: "Alice", AuthorEmailHash: EmailHash("Alice@Example.com "), BodyHTML: "<p>Root</p>", Status: "approved", CreatedAt: now},
		{ID: childID, ParentID: &rootID, AuthorName: "Bob", IsAdmin: true, BodyHTML: "<p>Reply</p>", Status: "approved", CreatedAt: now.Add(time.Minute)},
		{ID: grandChildID, ParentID: &childID, AuthorName: "Carol", BodyHTML: "<p>Nested</p>", Status: "approved", CreatedAt: now.Add(2 * time.Minute)},
	})
	if len(tree) != 1 || len(tree[0].Replies) != 2 {
		t.Fatalf("expected 1 root with 2 flattened replies, got %+v", tree)
	}
	if !tree[0].Replies[0].IsAuthor {
		t.Fatalf("expected IsAuthor flag preserved on admin reply")
	}
}

func TestFriendFeedPollingRSSAndAtom(t *testing.T) {
	rssServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == `"etag-v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"etag-v1"`)
		w.Header().Set("Content-Type", "application/rss+xml")
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Friend</title>
<item><title>Go 1.26 Notes</title><link>https://friend.example/go</link><guid>g1</guid><description>&lt;p&gt;Fast&lt;/p&gt;</description><pubDate>Sat, 14 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`))
	}))
	defer rssServer.Close()

	st := state.NewMemoryStore()
	fl := state.FriendLinkRecord{
		ID:      uuid.New(),
		Name:    "Friend",
		URL:     "https://friend.example",
		FeedURL: rssServer.URL + "/feed.xml",
		Status:  "active",
	}
	if err := st.CreateFriendLink(context.Background(), fl); err != nil {
		t.Fatalf("CreateFriendLink: %v", err)
	}

	poller := NewFeedPoller()
	poller.AllowPrivateForTest = true
	checked, added := poller.PollAll(context.Background(), st)
	if checked != 1 || added != 1 {
		t.Fatalf("expected checked=1 added=1, got checked=%d added=%d", checked, added)
	}

	// Second poll sends ETag and expects 304 Not Modified (0 new items)
	checked2, added2 := poller.PollAll(context.Background(), st)
	if checked2 != 1 || added2 != 0 {
		t.Fatalf("expected conditional 304 checked=1 added=0, got checked=%d added=%d", checked2, added2)
	}

	feedItems, err := st.ListFriendFeedItems(context.Background(), 10)
	if err != nil || len(feedItems) != 1 || feedItems[0].Title != "Go 1.26 Notes" {
		t.Fatalf("unexpected feed items: %+v err=%v", feedItems, err)
	}
}
