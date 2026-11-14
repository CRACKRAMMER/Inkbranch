package markdown

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/microcosm-cc/bluemonday"
)

var allowedEmbedHosts = map[string]bool{
	"www.youtube.com":     true,
	"youtube.com":         true,
	"youtu.be":            true,
	"player.vimeo.com":    true,
	"www.bilibili.com":    true,
	"player.bilibili.com": true,
	"codesandbox.io":      true,
	"stackblitz.com":      true,
	"observablehq.com":    true,
	"www.desmos.com":      true,
}

func isAllowedEmbedOrigin(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	if u.Scheme != "https" {
		return false
	}
	return allowedEmbedHosts[strings.ToLower(u.Hostname())]
}

func newSanitizePolicy() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()

	// Semantic containers & structural elements
	p.AllowElements("figure", "figcaption", "aside", "details", "summary", "kbd", "mark", "button", "video", "audio", "source", "iframe", "div", "span")

	p.AllowAttrs("id").Globally()
	p.AllowAttrs("class").Matching(regexp.MustCompile(`^[a-zA-Z0-9_\s:-]+$`)).Globally()
	p.AllowAttrs("role").Matching(regexp.MustCompile(`^(region|tablist|tab|tabpanel)$`)).OnElements("pre", "div", "button")
	p.AllowAttrs("tabindex").Matching(regexp.MustCompile(`^-?[0-9]+$`)).OnElements("pre")
	p.AllowAttrs("aria-labelledby", "aria-label", "aria-selected", "hidden").OnElements("pre", "button", "div")
	p.AllowAttrs("aria-hidden").OnElements("span", "svg")

	p.AllowAttrs("data-lang", "data-terminal", "data-collapsible").OnElements("figure")
	p.AllowAttrs("data-line").OnElements("span")
	p.AllowAttrs("type", "data-copy-code", "data-tab-index").OnElements("button")
	p.AllowAttrs("data-mermaid", "data-tabs", "data-tab-panel", "data-math").OnElements("div")
	p.AllowAttrs("data-math").OnElements("span")
	p.AllowAttrs("data-wikilink-type", "data-wikilink-slug").OnElements("a")
	p.AllowAttrs("data-wikilink-target").OnElements("span")

	p.AllowAttrs("src", "poster", "controls", "preload").OnElements("video", "audio", "source")
	p.AllowAttrs("loading", "decoding", "width", "height").OnElements("img")
	p.AllowAttrs("open").OnElements("details")

	// Strict embed allowlist for iframes.
	p.AllowAttrs("title", "loading", "referrerpolicy", "allowfullscreen").OnElements("iframe")
	p.AllowAttrs("src").Matching(regexp.MustCompile(`^https://(www\.)?(youtube\.com|youtu\.be|player\.vimeo\.com|www\.bilibili\.com|player\.bilibili\.com|codesandbox\.io|stackblitz\.com|observablehq\.com|www\.desmos\.com)/`)).OnElements("iframe")

	p.RequireNoFollowOnLinks(false)
	return p
}
