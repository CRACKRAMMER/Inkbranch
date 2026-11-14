package community

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer/html"
)

type CommentNode struct {
	ID         string        `json:"id"`
	ParentID   string        `json:"parentId,omitempty"`
	AuthorName string        `json:"authorName"`
	AuthorURL  string        `json:"authorUrl,omitempty"`
	AvatarURL  string        `json:"avatarUrl,omitempty"`
	IsAuthor   bool          `json:"isAuthor,omitempty"`
	BodyHTML   string        `json:"bodyHtml"`
	CreatedAt  string        `json:"createdAt"`
	Replies    []CommentNode `json:"replies,omitempty"`
}

var (
	commentMarkdown = goldmark.New(
		goldmark.WithExtensions(
			extension.GFM,
			extension.Strikethrough,
			extension.Typographer,
		),
		goldmark.WithRendererOptions(
			html.WithHardWraps(),
		),
	)
	commentSanitizer = buildCommentSanitizer()
)

func buildCommentSanitizer() *bluemonday.Policy {
	p := bluemonday.NewPolicy()
	p.AllowStandardURLs()
	p.RequireNoFollowOnLinks(true)
	p.RequireNoReferrerOnLinks(true)
	p.AddTargetBlankToFullyQualifiedLinks(true)
	p.AllowElements("p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li")
	p.AllowAttrs("href").OnElements("a")
	p.AllowAttrs("class").OnElements("code")
	return p
}

// RenderCommentMarkdown converts bounded user Markdown into strictly sanitized UGC HTML.
func RenderCommentMarkdown(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("comment body cannot be empty")
	}
	if len([]rune(trimmed)) > 4000 {
		return "", fmt.Errorf("comment exceeds maximum 4000 character limit")
	}
	var buf bytes.Buffer
	if err := commentMarkdown.Convert([]byte(trimmed), &buf); err != nil {
		return "", fmt.Errorf("render comment markdown: %w", err)
	}
	sanitized := strings.TrimSpace(commentSanitizer.Sanitize(buf.String()))
	if sanitized == "" {
		return "", fmt.Errorf("comment body contains no displayable content")
	}
	return sanitized, nil
}

// EmailHash computes a privacy-preserving lowercase SHA-256 email hash for avatar lookup.
func EmailHash(email string) string {
	norm := strings.ToLower(strings.TrimSpace(email))
	if norm == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

// CravatarURL returns a domestic-friendly Cravatar identicon URL for the given SHA-256 email hash.
func CravatarURL(emailHash string) string {
	if emailHash == "" {
		return "https://cravatar.cn/avatar/00000000000000000000000000000000?d=identicon&s=80"
	}
	return "https://cravatar.cn/avatar/" + emailHash + "?d=identicon&s=80"
}

// ValidateOptionalURL validates an optional comment author homepage URL.
func ValidateOptionalURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	if len(trimmed) > 512 {
		return "", fmt.Errorf("URL exceeds 512 characters")
	}
	u, err := url.Parse(trimmed)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("authorUrl must be an http:// or https:// URL")
	}
	return u.String(), nil
}

// BuildCommentTree organizes flat approved comments into 2-level nested threads without exposing emails or IP hashes.
func BuildCommentTree(records []state.CommentRecord) []CommentNode {
	roots := make([]*CommentNode, 0)
	byID := make(map[string]*CommentNode, len(records))
	rootFor := make(map[string]string, len(records))

	for _, rec := range records {
		idStr := rec.ID.String()
		parentStr := ""
		if rec.ParentID != nil {
			parentStr = rec.ParentID.String()
		}
		node := CommentNode{
			ID:         idStr,
			ParentID:   parentStr,
			AuthorName: rec.AuthorName,
			AuthorURL:  rec.AuthorURL,
			AvatarURL:  CravatarURL(rec.AuthorEmailHash),
			IsAuthor:   rec.IsAdmin,
			BodyHTML:   rec.BodyHTML,
			CreatedAt:  rec.CreatedAt.UTC().Format(time.RFC3339),
		}
		if parentStr == "" {
			roots = append(roots, &node)
			byID[idStr] = &node
			rootFor[idStr] = idStr
		} else {
			byID[idStr] = &node
		}
	}

	// Flatten nested replies onto their top-level parent thread.
	for _, rec := range records {
		if rec.ParentID == nil {
			continue
		}
		idStr := rec.ID.String()
		pid := rec.ParentID.String()
		for hop := 0; hop < 8; hop++ {
			if r, ok := rootFor[pid]; ok {
				pid = r
				break
			}
			parentNode, exists := byID[pid]
			if !exists || parentNode.ParentID == "" {
				break
			}
			pid = parentNode.ParentID
		}
		rootNode, ok := byID[pid]
		if !ok || rootNode.ParentID != "" {
			continue
		}
		child := byID[idStr]
		if child != nil {
			rootFor[idStr] = pid
			rootNode.Replies = append(rootNode.Replies, *child)
		}
	}

	out := make([]CommentNode, 0, len(roots))
	for _, r := range roots {
		out = append(out, *r)
	}
	return out
}
