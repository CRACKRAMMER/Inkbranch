package search

import (
	"strings"
	"unicode"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
)

// Tokenize produces normalized search tokens combining CJK overlapping bigrams + unigrams
// and lowercase Latin tokens + lightweight stems (never dropping written tokens so excerpts highlight).
func Tokenize(text string) []string {
	if strings.TrimSpace(text) == "" {
		return nil
	}

	var tokens []string
	var latin strings.Builder
	var cjkRun []rune

	flushLatin := func() {
		if latin.Len() == 0 {
			return
		}
		word := strings.ToLower(latin.String())
		latin.Reset()
		tokens = append(tokens, word)
		if stem := lightStem(word); stem != "" && stem != word {
			tokens = append(tokens, stem)
		}
	}

	flushCJK := func() {
		if len(cjkRun) == 0 {
			return
		}
		for i, r := range cjkRun {
			tokens = append(tokens, string(r))
			if i+1 < len(cjkRun) {
				tokens = append(tokens, string(cjkRun[i:i+2]))
			}
		}
		cjkRun = cjkRun[:0]
	}

	for _, r := range text {
		if isSearchCJK(r) {
			flushLatin()
			cjkRun = append(cjkRun, r)
		} else if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' {
			flushCJK()
			latin.WriteRune(r)
		} else {
			flushCJK()
			flushLatin()
		}
	}
	flushCJK()
	flushLatin()

	return tokens
}

// TokenizeQuery splits a search query into AND term groups where each group carries alternative forms.
func TokenizeQuery(query string) [][]string {
	var groups [][]string
	var cjkRun []rune
	var latin strings.Builder

	flushLatin := func() {
		if latin.Len() == 0 {
			return
		}
		word := strings.ToLower(latin.String())
		latin.Reset()
		grp := []string{word}
		if stem := lightStem(word); stem != "" && stem != word {
			grp = append(grp, stem)
		}
		groups = append(groups, grp)
	}

	flushCJK := func() {
		if len(cjkRun) == 0 {
			return
		}
		if len(cjkRun) == 1 {
			groups = append(groups, []string{string(cjkRun[0])})
		} else {
			for i := 0; i+1 < len(cjkRun); i++ {
				groups = append(groups, []string{string(cjkRun[i : i+2])})
			}
		}
		cjkRun = cjkRun[:0]
	}

	for _, r := range query {
		if isSearchCJK(r) {
			flushLatin()
			cjkRun = append(cjkRun, r)
		} else if unicode.IsLetter(r) || unicode.IsDigit(r) {
			flushCJK()
			latin.WriteRune(r)
		} else {
			flushCJK()
			flushLatin()
		}
	}
	flushCJK()
	flushLatin()
	return groups
}

// BuildSearchTokensString generates a PostgreSQL simple-tsvector friendly token string for indexing.
func BuildSearchTokensString(doc *content.Document) string {
	var all []string
	all = append(all, Tokenize(doc.Description)...)
	all = append(all, Tokenize(strings.Join(doc.Tags, " "))...)
	for _, h := range doc.Headings {
		all = append(all, Tokenize(h.Text)...)
	}
	all = append(all, Tokenize(doc.PlainText)...)
	return strings.Join(all, " ")
}

func isSearchCJK(r rune) bool {
	return content.IsCJK(r) || (r >= 0x3040 && r <= 0x30FF) || (r >= 0xAC00 && r <= 0xD7AF)
}

func lightStem(w string) string {
	if len(w) <= 4 {
		return w
	}
	for _, suf := range []string{"ments", "ment", "ings", "ing", "ations", "ation", "ies", "es", "ed", "ly"} {
		if strings.HasSuffix(w, suf) && len(w)-len(suf) >= 3 {
			base := strings.TrimSuffix(w, suf)
			if suf == "ies" {
				return base + "y"
			}
			return base
		}
	}
	if strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss") && len(w) > 4 {
		return strings.TrimSuffix(w, "s")
	}
	return w
}
