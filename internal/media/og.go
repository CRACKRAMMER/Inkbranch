package media

import (
	"bytes"
	_ "embed"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"strings"
	"sync"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

//go:embed fonts/NotoSansSC-Regular-subset.ttf
var notoSansFontBytes []byte

const (
	ogWidth  = 1200
	ogHeight = 630
)

// OGInput describes text rendered on an editorial 1200x630 OpenGraph share image.
type OGInput struct {
	SiteName    string
	TypeLabel   string
	Title       string
	Description string
	FooterMeta  string
}

// OGRenderer generates cached 1200x630 PNG social preview cards using embedded CJK/Latin fonts.
type OGRenderer struct {
	parsedFont *opentype.Font

	mu    sync.RWMutex
	cache map[string][]byte
}

// NewOGRenderer loads the embedded NotoSansSC subset font and prepares the renderer cache.
func NewOGRenderer() (*OGRenderer, error) {
	f, err := opentype.Parse(notoSansFontBytes)
	if err != nil {
		return nil, fmt.Errorf("parse embedded font: %w", err)
	}
	return &OGRenderer{
		parsedFont: f,
		cache:      make(map[string][]byte, 32),
	}, nil
}

// RenderPNG builds (or serves from cache) a crisp 1200x630 PNG social share card.
func (r *OGRenderer) RenderPNG(in OGInput) ([]byte, error) {
	if in.SiteName == "" {
		in.SiteName = "Inkbranch"
	}
	if in.Title == "" {
		in.Title = in.SiteName
	}

	cacheKey := strings.Join([]string{in.SiteName, in.TypeLabel, in.Title, in.Description, in.FooterMeta}, "\x00")
	r.mu.RLock()
	if hit, ok := r.cache[cacheKey]; ok {
		r.mu.RUnlock()
		return hit, nil
	}
	r.mu.RUnlock()

	img := image.NewRGBA(image.Rect(0, 0, ogWidth, ogHeight))

	// Warm obsidian background + subtle top amber accent border.
	bg := color.RGBA{R: 24, G: 22, B: 21, A: 255}
	surface := color.RGBA{R: 34, G: 31, B: 29, A: 255}
	border := color.RGBA{R: 62, G: 56, B: 52, A: 255}
	accent := color.RGBA{R: 214, G: 138, B: 56, A: 255}
	brandSq := color.RGBA{R: 138, G: 76, B: 0, A: 255}
	cream := color.RGBA{R: 248, G: 245, B: 240, A: 255}
	muted := color.RGBA{R: 175, G: 168, B: 160, A: 255}

	draw.Draw(img, img.Bounds(), &image.Uniform{C: bg}, image.Point{}, draw.Src)

	// Inner editorial card frame.
	cardRect := image.Rect(44, 44, ogWidth-44, ogHeight-44)
	draw.Draw(img, cardRect, &image.Uniform{C: border}, image.Point{}, draw.Src)
	innerRect := image.Rect(46, 46, ogWidth-46, ogHeight-46)
	draw.Draw(img, innerRect, &image.Uniform{C: surface}, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(46, 46, ogWidth-46, 52), &image.Uniform{C: accent}, image.Point{}, draw.Src)

	// Inkbranch "#" mark at top-left (60x60 rounded-feel square).
	drawBrandMark(img, 96, 98, 56, brandSq, cream)

	titleFace, _ := opentype.NewFace(r.parsedFont, &opentype.FaceOptions{Size: 52, DPI: 72, Hinting: font.HintingFull})
	metaFace, _ := opentype.NewFace(r.parsedFont, &opentype.FaceOptions{Size: 26, DPI: 72, Hinting: font.HintingFull})
	subFace, _ := opentype.NewFace(r.parsedFont, &opentype.FaceOptions{Size: 24, DPI: 72, Hinting: font.HintingFull})
	defer func() {
		_ = titleFace.Close()
		_ = metaFace.Close()
		_ = subFace.Close()
	}()

	// Site name & type label on header row.
	drawString(img, metaFace, 174, 134, cream, in.SiteName)
	if in.TypeLabel != "" {
		drawString(img, subFace, 940, 134, accent, strings.ToUpper(in.TypeLabel))
	}

	// Wrapped title lines (max 3 lines, width 1008px).
	titleLines := wrapText(titleFace, in.Title, 1008, 3)
	y := 245
	for _, line := range titleLines {
		drawString(img, titleFace, 96, y, cream, line)
		y += 70
	}

	// Description lines (max 2 lines) if room remains.
	if in.Description != "" && y < 440 {
		descLines := wrapText(subFace, in.Description, 1008, 2)
		dy := y + 18
		for _, line := range descLines {
			drawString(img, subFace, 96, dy, muted, line)
			dy += 36
		}
	}

	// Bottom footer divider + metadata line.
	draw.Draw(img, image.Rect(96, 514, ogWidth-96, 516), &image.Uniform{C: border}, image.Point{}, draw.Src)
	footer := in.FooterMeta
	if footer == "" {
		footer = "blog.crackrammer.com"
	}
	drawString(img, subFace, 96, 556, muted, footer)

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("encode OG PNG: %w", err)
	}
	raw := buf.Bytes()

	r.mu.Lock()
	if len(r.cache) > 256 {
		r.cache = make(map[string][]byte, 32)
	}
	r.cache[cacheKey] = raw
	r.mu.Unlock()

	return raw, nil
}

func drawBrandMark(img *image.RGBA, x, y, size int, bg, fg color.RGBA) {
	draw.Draw(img, image.Rect(x, y, x+size, y+size), &image.Uniform{C: bg}, image.Point{}, draw.Src)
	barW := size / 10
	if barW < 3 {
		barW = 3
	}
	pad := size / 5
	// Vertical hash bars
	v1 := x + size*33/100
	v2 := x + size*58/100
	draw.Draw(img, image.Rect(v1, y+pad, v1+barW, y+size-pad), &image.Uniform{C: fg}, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(v2, y+pad, v2+barW, y+size-pad), &image.Uniform{C: fg}, image.Point{}, draw.Src)
	// Horizontal hash bars
	h1 := y + size*33/100
	h2 := y + size*58/100
	draw.Draw(img, image.Rect(x+pad, h1, x+size-pad, h1+barW), &image.Uniform{C: fg}, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(x+pad, h2, x+size-pad, h2+barW), &image.Uniform{C: fg}, image.Point{}, draw.Src)
}

func drawString(img *image.RGBA, face font.Face, x, y int, c color.RGBA, text string) {
	d := &font.Drawer{
		Dst:  img,
		Src:  image.NewUniform(c),
		Face: face,
		Dot:  fixed.P(x, y),
	}
	d.DrawString(text)
}

func wrapText(face font.Face, input string, maxWidthPx int, maxLines int) []string {
	var lines []string
	var cur strings.Builder

	flush := func() {
		if cur.Len() > 0 {
			lines = append(lines, strings.TrimSpace(cur.String()))
			cur.Reset()
		}
	}

	runes := []rune(strings.TrimSpace(input))
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if r == '\n' || r == '\r' {
			flush()
			if len(lines) >= maxLines {
				return truncateLastLine(lines, maxLines)
			}
			continue
		}
		candidate := cur.String() + string(r)
		w := font.MeasureString(face, candidate).Ceil()
		if w > maxWidthPx && cur.Len() > 0 {
			str := cur.String()
			// Break cleanly on whitespace if inside a Latin run near the right margin.
			if lastSpace := strings.LastIndexByte(str, ' '); lastSpace > len(str)/2 && r != ' ' {
				head := strings.TrimSpace(str[:lastSpace])
				tail := strings.TrimLeft(str[lastSpace+1:], " ") + string(r)
				lines = append(lines, head)
				cur.Reset()
				cur.WriteString(tail)
			} else {
				flush()
				if r != ' ' {
					cur.WriteRune(r)
				}
			}
			if len(lines) >= maxLines {
				return truncateLastLine(lines, maxLines)
			}
			continue
		}
		cur.WriteRune(r)
	}
	flush()
	if len(lines) > maxLines {
		return truncateLastLine(lines, maxLines)
	}
	return lines
}

func truncateLastLine(lines []string, maxLines int) []string {
	if len(lines) > maxLines {
		lines = lines[:maxLines]
	}
	last := []rune(lines[len(lines)-1])
	if len(last) > 2 {
		lines[len(lines)-1] = strings.TrimSpace(string(last[:len(last)-1])) + "…"
	}
	return lines
}
