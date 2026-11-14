package search

import (
	stdhtml "html"
	"math"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
)

// QueryOptions configures multi-field search and filtering.
type QueryOptions struct {
	Query    string
	Type     content.ContentType
	Tag      string
	Category string
	Lang     string
	Limit    int
	Offset   int
}

// Hit represents one ranked search match with HTML-escaped `<mark>` snippet highlighting.
type Hit struct {
	Type           content.ContentType `json:"type"`
	Slug           string              `json:"slug"`
	Title          string              `json:"title"`
	Description    string              `json:"description"`
	Category       string              `json:"category,omitempty"`
	Tags           []string            `json:"tags"`
	Lang           string              `json:"lang"`
	URL            string              `json:"url"`
	SnippetHTML    string              `json:"snippetHtml"`
	PublishedAt    string              `json:"publishedAt,omitempty"`
	ReadingMinutes int                 `json:"readingMinutes"`
	Score          float64             `json:"score"`
}

// Response summarizes ranked search hits.
type Response struct {
	Query string `json:"query"`
	Total int    `json:"total"`
	Hits  []Hit  `json:"hits"`
}

const (
	bm25K1 = 1.2
	bm25B  = 0.75
)

var fieldWeights = struct {
	Title       float64
	Tags        float64
	Description float64
	Headings    float64
	Body        float64
}{
	Title:       8.0,
	Tags:        6.0,
	Description: 4.0,
	Headings:    3.0,
	Body:        1.0,
}

type indexedDoc struct {
	doc        *content.Document
	titleTF    map[string]int
	tagsTF     map[string]int
	descTF     map[string]int
	headingsTF map[string]int
	bodyTF     map[string]int
	totalLen   float64
}

// Search executes BM25F weighted search over published documents with safe <mark> context snippets.
func Search(docs []*content.Document, opts QueryOptions) Response {
	if opts.Limit <= 0 || opts.Limit > 100 {
		opts.Limit = 20
	}
	if opts.Offset < 0 {
		opts.Offset = 0
	}

	trimmedQ := strings.TrimSpace(opts.Query)
	groups := TokenizeQuery(trimmedQ)

	var filtered []*content.Document
	for _, doc := range docs {
		if opts.Type != "" && doc.Type != opts.Type {
			continue
		}
		if opts.Category != "" && !strings.EqualFold(doc.Category, opts.Category) {
			continue
		}
		if opts.Lang != "" && !strings.EqualFold(doc.Lang, opts.Lang) {
			continue
		}
		if opts.Tag != "" && !hasTag(doc.Tags, opts.Tag) {
			continue
		}
		filtered = append(filtered, doc)
	}

	if len(groups) == 0 {
		total := len(filtered)
		slice := paginateDocs(filtered, opts.Offset, opts.Limit)
		hits := make([]Hit, 0, len(slice))
		for _, doc := range slice {
			hits = append(hits, makeHit(doc, 0, nil))
		}
		return Response{Query: trimmedQ, Total: total, Hits: hits}
	}

	indexed := make([]indexedDoc, 0, len(filtered))
	docFreq := make(map[string]int)
	var sumLen float64

	for _, doc := range filtered {
		id := buildIndexedDoc(doc)
		indexed = append(indexed, id)
		sumLen += id.totalLen

		seenTerms := make(map[string]struct{})
		for _, tf := range []map[string]int{id.titleTF, id.tagsTF, id.descTF, id.headingsTF, id.bodyTF} {
			for k := range tf {
				seenTerms[k] = struct{}{}
			}
		}
		for k := range seenTerms {
			docFreq[k]++
		}
	}

	avgDL := 1.0
	if len(indexed) > 0 && sumLen > 0 {
		avgDL = sumLen / float64(len(indexed))
	}
	N := float64(len(indexed))

	var allTerms []string
	for _, g := range groups {
		allTerms = append(allTerms, g...)
	}

	var matched []Hit
	for _, item := range indexed {
		score := 0.0
		allGroupsHit := true

		for _, grp := range groups {
			bestGrpScore := 0.0
			grpMatched := false
			for _, term := range grp {
				df := float64(docFreq[term])
				if df == 0 {
					continue
				}
				idf := math.Log((N-df+0.5)/(df+0.5) + 1.0)
				weightedTF := float64(item.titleTF[term])*fieldWeights.Title +
					float64(item.tagsTF[term])*fieldWeights.Tags +
					float64(item.descTF[term])*fieldWeights.Description +
					float64(item.headingsTF[term])*fieldWeights.Headings +
					float64(item.bodyTF[term])*fieldWeights.Body

				if weightedTF <= 0 {
					continue
				}
				grpMatched = true
				normTF := (weightedTF * (bm25K1 + 1.0)) / (weightedTF + bm25K1*(1.0-bm25B+bm25B*(item.totalLen/avgDL)))
				if s := idf * normTF; s > bestGrpScore {
					bestGrpScore = s
				}
			}
			if !grpMatched {
				allGroupsHit = false
				break
			}
			score += bestGrpScore
		}

		// Boost exact substring match in title or body for multi-character CJK phrases.
		if !allGroupsHit {
			lowerQ := strings.ToLower(trimmedQ)
			if strings.Contains(strings.ToLower(item.doc.Title), lowerQ) {
				allGroupsHit = true
				score = 5.0
			} else if strings.Contains(strings.ToLower(item.doc.PlainText), lowerQ) {
				allGroupsHit = true
				score = 1.5
			}
		}

		if allGroupsHit && score > 0 {
			if item.doc.Featured {
				score *= 1.1
			}
			matched = append(matched, makeHit(item.doc, score, append(allTerms, trimmedQ)))
		}
	}

	sort.Slice(matched, func(i, j int) bool {
		if matched[i].Score != matched[j].Score {
			return matched[i].Score > matched[j].Score
		}
		return matched[i].PublishedAt > matched[j].PublishedAt
	})

	total := len(matched)
	end := opts.Offset + opts.Limit
	if opts.Offset > total {
		return Response{Query: trimmedQ, Total: total, Hits: []Hit{}}
	}
	if end > total {
		end = total
	}

	return Response{
		Query: trimmedQ,
		Total: total,
		Hits:  matched[opts.Offset:end],
	}
}

func buildIndexedDoc(doc *content.Document) indexedDoc {
	titleToks := Tokenize(doc.Title)
	tagText := strings.Join(doc.Tags, " ") + " " + doc.Category + " " + doc.Series + " " + strings.Join(doc.TechStack, " ")
	tagToks := Tokenize(tagText)
	descToks := Tokenize(doc.Description)
	var headingParts []string
	for _, h := range doc.Headings {
		headingParts = append(headingParts, h.Text)
	}
	headingToks := Tokenize(strings.Join(headingParts, " "))
	bodyToks := Tokenize(doc.PlainText)

	return indexedDoc{
		doc:        doc,
		titleTF:    termFreq(titleToks),
		tagsTF:     termFreq(tagToks),
		descTF:     termFreq(descToks),
		headingsTF: termFreq(headingToks),
		bodyTF:     termFreq(bodyToks),
		totalLen:   float64(len(titleToks) + len(tagToks) + len(descToks) + len(headingToks) + len(bodyToks)),
	}
}

func termFreq(tokens []string) map[string]int {
	m := make(map[string]int, len(tokens))
	for _, t := range tokens {
		m[t]++
	}
	return m
}

func hasTag(tags []string, want string) bool {
	wantSlug := content.TagSlug(want)
	for _, t := range tags {
		if strings.EqualFold(t, want) || content.TagSlug(t) == wantSlug {
			return true
		}
	}
	return false
}

func paginateDocs(docs []*content.Document, offset, limit int) []*content.Document {
	if offset >= len(docs) {
		return nil
	}
	end := offset + limit
	if end > len(docs) {
		end = len(docs)
	}
	return docs[offset:end]
}

func makeHit(doc *content.Document, score float64, highlightTerms []string) Hit {
	pub := ""
	if doc.PublishedAt != nil {
		pub = doc.PublishedAt.Format("2006-01-02")
	}
	return Hit{
		Type:           doc.Type,
		Slug:           doc.Slug,
		Title:          doc.Title,
		Description:    doc.Description,
		Category:       doc.Category,
		Tags:           doc.Tags,
		Lang:           doc.Lang,
		URL:            doc.CanonicalURL(),
		SnippetHTML:    buildHighlightedSnippet(doc.PlainText, doc.Description, highlightTerms),
		PublishedAt:    pub,
		ReadingMinutes: doc.ReadingMinutes,
		Score:          math.Round(score*1000) / 1000,
	}
}

func buildHighlightedSnippet(plainText, fallbackDesc string, terms []string) string {
	source := strings.TrimSpace(plainText)
	if source == "" {
		source = strings.TrimSpace(fallbackDesc)
	}
	if source == "" {
		return ""
	}

	lower := strings.ToLower(source)
	bestByteIdx := -1
	for _, t := range terms {
		t = strings.TrimSpace(strings.ToLower(t))
		if t == "" {
			continue
		}
		if idx := strings.Index(lower, t); idx >= 0 {
			if bestByteIdx < 0 || idx < bestByteIdx {
				bestByteIdx = idx
			}
		}
	}

	runes := []rune(source)
	startRune := 0
	if bestByteIdx > 0 {
		prefixRunes := utf8.RuneCountInString(source[:bestByteIdx])
		if prefixRunes > 40 {
			startRune = prefixRunes - 40
		}
	}
	endRune := startRune + 140
	if endRune > len(runes) {
		endRune = len(runes)
	}

	excerpt := string(runes[startRune:endRune])
	if startRune > 0 {
		excerpt = "…" + strings.TrimSpace(excerpt)
	}
	if endRune < len(runes) {
		excerpt = strings.TrimSpace(excerpt) + "…"
	}

	return highlightTermsInEscapedText(excerpt, terms)
}

func highlightTermsInEscapedText(plain string, terms []string) string {
	if len(terms) == 0 {
		return stdhtml.EscapeString(plain)
	}

	// Deduplicate longer terms first so multi-character matches win over 1-char fallbacks.
	var unique []string
	seen := make(map[string]struct{}, len(terms))
	for _, t := range terms {
		clean := strings.TrimSpace(t)
		if clean == "" {
			continue
		}
		key := strings.ToLower(clean)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, clean)
	}
	sort.Slice(unique, func(i, j int) bool {
		return len([]rune(unique[i])) > len([]rune(unique[j]))
	})

	// Scan case-insensitively across runes to avoid matching HTML entities.
	lower := strings.ToLower(plain)
	var b strings.Builder
	pos := 0
	for pos < len(plain) {
		matchedLen := 0
		for _, term := range unique {
			lt := strings.ToLower(term)
			if strings.HasPrefix(lower[pos:], lt) {
				matchedLen = len(term)
				break
			}
		}
		if matchedLen > 0 && pos+matchedLen <= len(plain) {
			b.WriteString("<mark>")
			b.WriteString(stdhtml.EscapeString(plain[pos : pos+matchedLen]))
			b.WriteString("</mark>")
			pos += matchedLen
			continue
		}
		_, size := utf8.DecodeRuneInString(plain[pos:])
		b.WriteString(stdhtml.EscapeString(plain[pos : pos+size]))
		pos += size
	}
	return b.String()
}
