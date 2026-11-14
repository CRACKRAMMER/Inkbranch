package markdown

import (
	"regexp"
	"strconv"
	"strings"
)

// FenceMeta captures parsed options attached to a Markdown fenced code block info string.
type FenceMeta struct {
	Language        string
	Title           string
	Badge           string
	ShowLineNumbers bool
	HighlightLines  map[int]bool
	HighlightWords  []string
	StartLine       int
	IsDiff          bool
	IsTerminal      bool
	IsMermaid       bool
}

var (
	terminalLanguages = map[string]bool{
		"terminal":     true,
		"console":      true,
		"shellsession": true,
	}
	titleAttrRegex = regexp.MustCompile(`(?:^|\s)(?:title|filename|file)=("([^"]*)"|'([^']*)'|(\S+))`)
	badgeAttrRegex = regexp.MustCompile(`(?:^|\s)(?:badge|label)=("([^"]*)"|'([^']*)'|(\S+))`)
	lineSpecRegex  = regexp.MustCompile(`\{([\d,\s-]+)\}`)
	wordSpecRegex  = regexp.MustCompile(`(?:^|\s)/([^/\n]+)/`)
	startLineRegex = regexp.MustCompile(`(?:^|\s)start=(\d+)`)
	terminalTokRe  = regexp.MustCompile(`(?:^|\s)terminal(?:\s|$)`)
	showLinesTokRe = regexp.MustCompile(`(?:^|\s)showLineNumbers(?:\s|$)`)
)

// ParseCodeFenceMeta splits an info string like `ts title="writer.ts" showLineNumbers {12-14}`.
func ParseCodeFenceMeta(info string) FenceMeta {
	meta := FenceMeta{
		HighlightLines: make(map[int]bool),
		StartLine:      1,
	}

	trimmed := strings.TrimSpace(info)
	if trimmed == "" {
		return meta
	}

	fields := strings.Fields(trimmed)
	meta.Language = strings.ToLower(fields[0])
	rest := strings.TrimSpace(strings.TrimPrefix(trimmed, fields[0]))

	if m := titleAttrRegex.FindStringSubmatch(" " + rest); m != nil {
		for _, idx := range []int{2, 3, 4} {
			if m[idx] != "" {
				meta.Title = m[idx]
				break
			}
		}
		rest = strings.Replace(rest, strings.TrimSpace(m[0]), "", 1)
	}

	if m := badgeAttrRegex.FindStringSubmatch(" " + rest); m != nil {
		for _, idx := range []int{2, 3, 4} {
			if m[idx] != "" {
				meta.Badge = m[idx]
				break
			}
		}
		rest = strings.Replace(rest, strings.TrimSpace(m[0]), "", 1)
	}

	if m := lineSpecRegex.FindStringSubmatch(rest); m != nil {
		parseLineSpec(m[1], meta.HighlightLines)
	}

	for _, m := range wordSpecRegex.FindAllStringSubmatch(" "+rest+" ", -1) {
		if len(m) > 1 && m[1] != "" {
			meta.HighlightWords = append(meta.HighlightWords, m[1])
		}
	}

	if m := startLineRegex.FindStringSubmatch(" " + rest); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil && n > 0 {
			meta.StartLine = n
		}
	}

	meta.ShowLineNumbers = showLinesTokRe.MatchString(" " + rest + " ")
	meta.IsDiff = meta.Language == "diff"
	meta.IsMermaid = meta.Language == "mermaid"
	meta.IsTerminal = terminalLanguages[meta.Language] || terminalTokRe.MatchString(" "+rest+" ")

	if meta.Badge == "" && !meta.IsTerminal && meta.Language != "" {
		meta.Badge = meta.Language
	}

	return meta
}

func parseLineSpec(spec string, target map[int]bool) {
	for _, part := range strings.Split(spec, ",") {
		p := strings.TrimSpace(part)
		if p == "" {
			continue
		}
		if strings.Contains(p, "-") {
			bounds := strings.SplitN(p, "-", 2)
			start, err1 := strconv.Atoi(strings.TrimSpace(bounds[0]))
			end, err2 := strconv.Atoi(strings.TrimSpace(bounds[1]))
			if err1 == nil && err2 == nil && start > 0 && end >= start && end-start <= 500 {
				for n := start; n <= end; n++ {
					target[n] = true
				}
			}
			continue
		}
		if n, err := strconv.Atoi(p); err == nil && n > 0 {
			target[n] = true
		}
	}
}
