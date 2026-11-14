package content

import (
	"math"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	maxPlainTextRunes = 60000
	latinWPM          = 220.0
	cjkCPM            = 400.0
)

var (
	directiveFence    = regexp.MustCompile(`(?m)^:{2,4}(?:[a-zA-Z0-9_-]+(?:\[[^\]]*\])?(?:\{[^}]*\})?)?\s*$`)
	htmlTagRegex      = regexp.MustCompile(`<[^>]+>`)
	mdLinkRegex     = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]+\)`)
	wikilinkRegex   = regexp.MustCompile(`\[\[(?:[^|\]]+\|)?([^\]]+)\]\]`)
	inlineCodeRegex = regexp.MustCompile("`([^`]+)`")
	mdHeadingPrefix = regexp.MustCompile(`(?m)^#{1,6}\s+`)
	quotePrefix     = regexp.MustCompile(`(?m)^>\s?`)
	emphasisRegex   = regexp.MustCompile(`(\*\*|__|~~|\*|_)`)
	whitespaceRegex = regexp.MustCompile(`\s+`)
	headingRegex    = regexp.MustCompile(`(?m)^(#{1,6})\s+(.+?)\s*#*\s*$`)
	latinTokenRegex = regexp.MustCompile(`[A-Za-z0-9][A-Za-z0-9'’_-]*`)
)

// DerivedStats holds body-derived metadata for a document.
type DerivedStats struct {
	Title          string
	Slug           string
	Description    string
	Headings       []Heading
	WordCount      int
	ReadingMinutes int
	PlainText      string
}

// DeriveDocumentMetadata computes title, slug, description, headings, and CJK-aware reading metrics.
func DeriveDocumentMetadata(docType ContentType, filename, body string, declaredTitle, declaredSlug, declaredDesc string) DerivedStats {
	headings := ExtractHeadings(body)
	title := pickTitle(declaredTitle, filename, body, headings)
	slug := strings.TrimSpace(declaredSlug)
	if slug == "" {
		slug = Slugify(title, SlugFromFilename(filename))
	}
	plain := StripMarkdown(body)
	if runes := []rune(plain); len(runes) > maxPlainTextRunes {
		plain = string(runes[:maxPlainTextRunes])
	}
	desc := pickDescription(declaredDesc, plain, headings)
	words, mins := ComputeTextStats(plain)

	return DerivedStats{
		Title:          title,
		Slug:           slug,
		Description:    desc,
		Headings:       headings,
		WordCount:      words,
		ReadingMinutes: mins,
		PlainText:      plain,
	}
}

// ExtractHeadings extracts ATX headings outside fenced code blocks with deterministic slug IDs.
func ExtractHeadings(body string) []Heading {
	lines := strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
	var headings []Heading
	inFence := false
	fenceChar := byte(0)
	usedIDs := make(map[string]int)

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if ch, flen := detectFenceLine(trimmed); flen > 0 {
			if !inFence {
				inFence = true
				fenceChar = ch
			} else if ch == fenceChar {
				inFence = false
			}
			continue
		}
		if inFence {
			continue
		}
		m := headingRegex.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		level := len(m[1])
		text := strings.TrimSpace(stripInlineMarkdown(m[2]))
		if text == "" {
			continue
		}
		baseID := Slugify(text, "section")
		id := baseID
		if n := usedIDs[baseID]; n > 0 {
			id = formatDupHeadingID(baseID, n+1)
		}
		usedIDs[baseID]++
		headings = append(headings, Heading{ID: id, Text: text, Level: level})
	}
	return headings
}

func detectFenceLine(trimmed string) (byte, int) {
	if len(trimmed) < 3 {
		return 0, 0
	}
	ch := trimmed[0]
	if ch != '`' && ch != '~' {
		return 0, 0
	}
	n := 0
	for n < len(trimmed) && trimmed[n] == ch {
		n++
	}
	if n >= 3 {
		return ch, n
	}
	return 0, 0
}

func stripFencedCodeBlocks(input string) string {
	lines := strings.Split(input, "\n")
	out := make([]string, 0, len(lines))
	inFence := false
	fenceChar := byte(0)
	fenceLen := 0

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if ch, flen := detectFenceLine(trimmed); flen > 0 {
			if !inFence {
				inFence = true
				fenceChar = ch
				fenceLen = flen
				continue
			}
			if ch == fenceChar && flen >= fenceLen && strings.TrimSpace(strings.TrimLeft(trimmed, string(ch))) == "" {
				inFence = false
				continue
			}
		}
		if !inFence {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

func formatDupHeadingID(base string, n int) string {
	return base + "-" + itoa(n)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// StripMarkdown converts raw Markdown to readable plain text for search and summaries.
func StripMarkdown(body string) string {
	s := strings.ReplaceAll(body, "\r\n", "\n")
	s = stripFencedCodeBlocks(s)
	s = directiveFence.ReplaceAllString(s, "")
	s = mdLinkRegex.ReplaceAllString(s, "$1")
	s = wikilinkRegex.ReplaceAllString(s, "$1")
	s = inlineCodeRegex.ReplaceAllString(s, "$1")
	s = mdHeadingPrefix.ReplaceAllString(s, "")
	s = quotePrefix.ReplaceAllString(s, "")
	s = htmlTagRegex.ReplaceAllString(s, " ")
	s = emphasisRegex.ReplaceAllString(s, "")
	s = whitespaceRegex.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// ComputeTextStats computes mixed CJK character count + Latin token count and reading time in minutes.
func ComputeTextStats(input string) (words int, readingMinutes int) {
	cjk := 0
	var latinBuf strings.Builder
	for _, r := range input {
		if IsCJK(r) || (r >= 0x3040 && r <= 0x30FF) || (r >= 0xAC00 && r <= 0xD7AF) {
			cjk++
			latinBuf.WriteByte(' ')
		} else {
			latinBuf.WriteRune(r)
		}
	}
	latinWords := len(latinTokenRegex.FindAllString(latinBuf.String(), -1))
	words = cjk + latinWords
	mins := float64(latinWords)/latinWPM + float64(cjk)/cjkCPM
	readingMinutes = int(math.Round(mins))
	if readingMinutes < 1 {
		readingMinutes = 1
	}
	return words, readingMinutes
}

func pickTitle(declared, filename, body string, headings []Heading) string {
	if d := strings.TrimSpace(declared); d != "" {
		return d
	}
	for _, h := range headings {
		if h.Level <= 3 {
			return h.Text
		}
	}
	for _, raw := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, ">") || strings.HasPrefix(line, "|") ||
			strings.HasPrefix(line, "`") || strings.HasPrefix(line, "~") || strings.HasPrefix(line, ":::") {
			continue
		}
		cleaned := strings.TrimSpace(stripInlineMarkdown(line))
		if cleaned != "" {
			runes := []rune(cleaned)
			if len(runes) > 120 {
				return string(runes[:119]) + "…"
			}
			return cleaned
		}
	}
	return HumanizeFilename(filename)
}

func pickDescription(declared, plain string, _ []Heading) string {
	if d := strings.TrimSpace(declared); d != "" {
		return d
	}
	runes := []rune(strings.TrimSpace(plain))
	if len(runes) <= 180 {
		return string(runes)
	}
	return strings.TrimSpace(string(runes[:177])) + "…"
}

func HumanizeFilename(filename string) string {
	stem := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	withoutDate := datePrefixRegex.ReplaceAllString(stem, "")
	replaced := strings.NewReplacer("-", " ", "_", " ").Replace(withoutDate)
	fields := strings.Fields(replaced)
	if len(fields) == 0 {
		return "Untitled"
	}
	for i, w := range fields {
		runes := []rune(w)
		if len(runes) > 0 {
			fields[i] = strings.ToUpper(string(runes[:1])) + string(runes[1:])
		}
	}
	return strings.Join(fields, " ")
}

func stripInlineMarkdown(s string) string {
	s = mdLinkRegex.ReplaceAllString(s, "$1")
	s = wikilinkRegex.ReplaceAllString(s, "$1")
	s = inlineCodeRegex.ReplaceAllString(s, "$1")
	s = emphasisRegex.ReplaceAllString(s, "")
	return s
}
