package graph

import (
	"sort"
	"strings"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
)

// GraphNode represents a published document inside the knowledge graph.
type GraphNode struct {
	ID       string              `json:"id"`
	Type     content.ContentType `json:"type"`
	Slug     string              `json:"slug"`
	Title    string              `json:"title"`
	Category string              `json:"category,omitempty"`
	Tags     []string            `json:"tags"`
	URL      string              `json:"url"`
	Featured bool                `json:"featured"`
	Degree   int                 `json:"degree"`
}

// GraphEdge represents either a direct wikilink, series link, or tag co-occurrence edge.
type GraphEdge struct {
	Source string  `json:"source"`
	Target string  `json:"target"`
	Kind   string  `json:"kind"` // "wikilink" | "series" | "shared-tag"
	Weight float64 `json:"weight"`
}

// GlobalGraph holds nodes and edges for /graph and mini-graphs.
type GlobalGraph struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

// BacklinkItem describes an external article linking into the viewed article.
type BacklinkItem struct {
	Type           content.ContentType `json:"type"`
	Slug           string              `json:"slug"`
	Title          string              `json:"title"`
	URL            string              `json:"url"`
	ContextSnippet string              `json:"contextSnippet"`
}

// RelatedItem summarizes a semantically close document.
type RelatedItem struct {
	Type           content.ContentType `json:"type"`
	Slug           string              `json:"slug"`
	Title          string              `json:"title"`
	Description    string              `json:"description"`
	URL            string              `json:"url"`
	ReadingMinutes int                 `json:"readingMinutes"`
	Score          float64             `json:"score"`
}

// TranslationSibling links translated editions sharing the same translationKey.
type TranslationSibling struct {
	Lang  string `json:"lang"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

// SeriesEntry represents a document in a series collection.
type SeriesEntry struct {
	Slug           string              `json:"slug"`
	Type           content.ContentType `json:"type"`
	Title          string              `json:"title"`
	URL            string              `json:"url"`
	Order          int                 `json:"order"`
	ReadingMinutes int                 `json:"readingMinutes"`
}

// SeriesNav carries ordered series items and prev/next navigation around the current document.
type SeriesNav struct {
	Name         string        `json:"name"`
	Slug         string        `json:"slug"`
	CurrentIndex int           `json:"currentIndex"`
	Total        int           `json:"total"`
	Items        []SeriesEntry `json:"items"`
	Prev         *SeriesEntry  `json:"prev,omitempty"`
	Next         *SeriesEntry  `json:"next,omitempty"`
}

// DocumentContext bundles neighborhood graph, backlinks, related posts, translations, and series nav.
type DocumentContext struct {
	LocalGraph   GlobalGraph          `json:"localGraph"`
	Backlinks    []BacklinkItem       `json:"backlinks"`
	Related      []RelatedItem        `json:"related"`
	Translations []TranslationSibling `json:"translations"`
	SeriesNav    *SeriesNav           `json:"seriesNav,omitempty"`
}

func nodeID(docType content.ContentType, slug string) string {
	return string(docType) + ":" + slug
}

// BuildGlobalGraph computes nodes and edges from published documents with optional type/tag filtering.
func BuildGlobalGraph(docs []*content.Document, filterType content.ContentType, filterTag string) GlobalGraph {
	nodeMap := make(map[string]*GraphNode, len(docs))
	docByID := make(map[string]*content.Document, len(docs))

	for _, doc := range docs {
		if filterType != "" && doc.Type != filterType {
			continue
		}
		if filterTag != "" && !hasTag(doc.Tags, filterTag) {
			continue
		}
		id := nodeID(doc.Type, doc.Slug)
		docByID[id] = doc
		nodeMap[id] = &GraphNode{
			ID:       id,
			Type:     doc.Type,
			Slug:     doc.Slug,
			Title:    doc.Title,
			Category: doc.Category,
			Tags:     doc.Tags,
			URL:      doc.CanonicalURL(),
			Featured: doc.Featured,
		}
	}

	var edges []GraphEdge
	edgeSeen := make(map[string]struct{})

	// 1. Direct wikilink / internal link edges.
	for srcID, srcDoc := range docByID {
		for _, link := range srcDoc.OutgoingLinks {
			tgtID := findMatchingNodeID(docByID, link.TargetType, link.TargetSlug)
			if tgtID == "" || tgtID == srcID {
				continue
			}
			key := srcID + "->" + tgtID + ":wikilink"
			if _, ok := edgeSeen[key]; ok {
				continue
			}
			edgeSeen[key] = struct{}{}
			edges = append(edges, GraphEdge{
				Source: srcID,
				Target: tgtID,
				Kind:   "wikilink",
				Weight: 3.0,
			})
			nodeMap[srcID].Degree++
			nodeMap[tgtID].Degree++
		}
	}

	// 2. Series & shared-tag edges across sorted node pairs.
	ids := make([]string, 0, len(docByID))
	for id := range docByID {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for i := 0; i < len(ids); i++ {
		for j := i + 1; j < len(ids); j++ {
			a, b := docByID[ids[i]], docByID[ids[j]]
			if a.Series != "" && strings.EqualFold(a.Series, b.Series) {
				edges = append(edges, GraphEdge{
					Source: ids[i],
					Target: ids[j],
					Kind:   "series",
					Weight: 2.0,
				})
				nodeMap[ids[i]].Degree++
				nodeMap[ids[j]].Degree++
			}
			if shared := countSharedTags(a.Tags, b.Tags); shared >= 2 {
				edges = append(edges, GraphEdge{
					Source: ids[i],
					Target: ids[j],
					Kind:   "shared-tag",
					Weight: 0.5 * float64(shared),
				})
				nodeMap[ids[i]].Degree++
				nodeMap[ids[j]].Degree++
			}
		}
	}

	nodes := make([]GraphNode, 0, len(nodeMap))
	for _, n := range nodeMap {
		nodes = append(nodes, *n)
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Degree != nodes[j].Degree {
			return nodes[i].Degree > nodes[j].Degree
		}
		return nodes[i].Title < nodes[j].Title
	})

	return GlobalGraph{Nodes: nodes, Edges: edges}
}

// BuildDocumentContext calculates the target document's neighborhood mini-graph, backlinks,
// related articles, translation siblings, and series reading progress card.
func BuildDocumentContext(target *content.Document, allPublished []*content.Document) DocumentContext {
	global := BuildGlobalGraph(allPublished, "", "")
	targetID := nodeID(target.Type, target.Slug)

	// Extract 1-hop ego network around targetID.
	neighborIDs := map[string]bool{targetID: true}
	var localEdges []GraphEdge
	for _, e := range global.Edges {
		if e.Source == targetID {
			neighborIDs[e.Target] = true
			localEdges = append(localEdges, e)
		} else if e.Target == targetID {
			neighborIDs[e.Source] = true
			localEdges = append(localEdges, e)
		}
	}
	var localNodes []GraphNode
	for _, n := range global.Nodes {
		if neighborIDs[n.ID] {
			localNodes = append(localNodes, n)
		}
	}

	// Extract Backlinks from other published documents linking to target.
	var backlinks []BacklinkItem
	linkedPeers := make(map[string]bool)
	for _, e := range localEdges {
		if e.Kind == "wikilink" {
			if e.Source == targetID {
				linkedPeers[e.Target] = true
			} else {
				linkedPeers[e.Source] = true
			}
		}
	}

	for _, doc := range allPublished {
		if doc.Type == target.Type && doc.Slug == target.Slug {
			continue
		}
		for _, out := range doc.OutgoingLinks {
			if (out.TargetType == "" || out.TargetType == string(target.Type)) && strings.EqualFold(out.TargetSlug, target.Slug) {
				backlinks = append(backlinks, BacklinkItem{
					Type:           doc.Type,
					Slug:           doc.Slug,
					Title:          doc.Title,
					URL:            doc.CanonicalURL(),
					ContextSnippet: out.ContextSnippet,
				})
				break
			}
		}
	}

	// Score related documents (top 4).
	var related []RelatedItem
	for _, doc := range allPublished {
		if doc.Type == target.Type && doc.Slug == target.Slug {
			continue
		}
		score := 0.0
		if linkedPeers[nodeID(doc.Type, doc.Slug)] {
			score += 5.0
		}
		if target.Series != "" && strings.EqualFold(target.Series, doc.Series) {
			score += 4.0
		}
		if target.Category != "" && strings.EqualFold(target.Category, doc.Category) {
			score += 1.5
		}
		score += float64(countSharedTags(target.Tags, doc.Tags)) * 2.0
		if score > 0 {
			related = append(related, RelatedItem{
				Type:           doc.Type,
				Slug:           doc.Slug,
				Title:          doc.Title,
				Description:    doc.Description,
				URL:            doc.CanonicalURL(),
				ReadingMinutes: doc.ReadingMinutes,
				Score:          score,
			})
		}
	}
	sort.Slice(related, func(i, j int) bool {
		if related[i].Score != related[j].Score {
			return related[i].Score > related[j].Score
		}
		return related[i].Title < related[j].Title
	})
	if len(related) > 4 {
		related = related[:4]
	}

	// Bilingual translation siblings sharing translationKey.
	var translations []TranslationSibling
	if target.TranslationKey != "" {
		for _, doc := range allPublished {
			if doc.TranslationKey == target.TranslationKey && !(doc.Type == target.Type && doc.Slug == target.Slug) {
				translations = append(translations, TranslationSibling{
					Lang:  doc.Lang,
					Title: doc.Title,
					URL:   doc.CanonicalURL(),
				})
			}
		}
		sort.Slice(translations, func(i, j int) bool {
			return translations[i].Lang < translations[j].Lang
		})
	}

	// Series progression.
	var seriesNav *SeriesNav
	if target.Series != "" {
		seriesNav = buildSeriesNav(target, allPublished)
	}

	return DocumentContext{
		LocalGraph:   GlobalGraph{Nodes: localNodes, Edges: localEdges},
		Backlinks:    backlinks,
		Related:      related,
		Translations: translations,
		SeriesNav:    seriesNav,
	}
}

func buildSeriesNav(target *content.Document, docs []*content.Document) *SeriesNav {
	var members []*content.Document
	for _, doc := range docs {
		if strings.EqualFold(doc.Series, target.Series) {
			members = append(members, doc)
		}
	}
	if len(members) == 0 {
		return nil
	}
	sort.Slice(members, func(i, j int) bool {
		oi := seriesOrderOrMax(members[i])
		oj := seriesOrderOrMax(members[j])
		if oi != oj {
			return oi < oj
		}
		if members[i].PublishedAt != nil && members[j].PublishedAt != nil && !members[i].PublishedAt.Equal(*members[j].PublishedAt) {
			return members[i].PublishedAt.Before(*members[j].PublishedAt)
		}
		return members[i].Slug < members[j].Slug
	})

	items := make([]SeriesEntry, 0, len(members))
	curIdx := -1
	for idx, m := range members {
		order := idx + 1
		if m.SeriesOrder != nil {
			order = *m.SeriesOrder
		}
		items = append(items, SeriesEntry{
			Slug:           m.Slug,
			Type:           m.Type,
			Title:          m.Title,
			URL:            m.CanonicalURL(),
			Order:          order,
			ReadingMinutes: m.ReadingMinutes,
		})
		if m.Type == target.Type && m.Slug == target.Slug {
			curIdx = idx
		}
	}

	nav := &SeriesNav{
		Name:         target.Series,
		Slug:         content.Slugify(target.Series, "series"),
		CurrentIndex: curIdx,
		Total:        len(items),
		Items:        items,
	}
	if curIdx > 0 {
		prev := items[curIdx-1]
		nav.Prev = &prev
	}
	if curIdx >= 0 && curIdx+1 < len(items) {
		next := items[curIdx+1]
		nav.Next = &next
	}
	return nav
}

func seriesOrderOrMax(d *content.Document) int {
	if d.SeriesOrder != nil {
		return *d.SeriesOrder
	}
	return 1 << 30
}

func findMatchingNodeID(docByID map[string]*content.Document, targetType, targetSlug string) string {
	if targetType != "" {
		id := targetType + ":" + targetSlug
		if _, ok := docByID[id]; ok {
			return id
		}
	}
	for _, t := range content.AllTypes {
		id := string(t) + ":" + strings.ToLower(targetSlug)
		if _, ok := docByID[id]; ok {
			return id
		}
	}
	return ""
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

func countSharedTags(a, b []string) int {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	set := make(map[string]struct{}, len(a))
	for _, t := range a {
		set[content.TagSlug(t)] = struct{}{}
	}
	count := 0
	for _, t := range b {
		if _, ok := set[content.TagSlug(t)]; ok {
			count++
		}
	}
	return count
}
