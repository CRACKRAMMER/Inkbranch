package media

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"golang.org/x/image/webp"
)

const MaxUploadBytes = 25 << 20 // 25 MiB

var allowedUploadMIMEs = map[string]string{
	"image/jpeg":      ".jpg",
	"image/png":       ".png",
	"image/gif":       ".gif",
	"image/webp":      ".webp",
	"application/pdf": ".pdf",
	"video/mp4":       ".mp4",
	"video/webm":      ".webm",
	"audio/mpeg":      ".mp3",
	"audio/ogg":       ".ogg",
	"audio/wav":       ".wav",
}

type ProcessedAsset struct {
	Filename     string
	StorageKey   string
	MimeType     string
	Data         []byte
	ByteSize     int64
	Width        *int
	Height       *int
	Thumbhash    string
	EXIFStripped bool
}

var nonSlugNameRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// ProcessUpload validates MIME allowlist, fixes JPEG EXIF orientation, strips metadata, extracts
// image dimensions, and generates a compact pure-Go ThumbHash placeholder.
func ProcessUpload(originalName string, raw []byte, now time.Time) (*ProcessedAsset, error) {
	if len(raw) == 0 {
		return nil, errors.New("empty file payload")
	}
	if len(raw) > MaxUploadBytes {
		return nil, fmt.Errorf("file exceeds max upload limit (%d bytes)", MaxUploadBytes)
	}

	mimeType := detectSafeMIME(originalName, raw)
	ext, ok := allowedUploadMIMEs[mimeType]
	if !ok {
		return nil, fmt.Errorf("unsupported or disallowed file type %q", mimeType)
	}

	cleanBytes := raw
	var width, height *int
	thumbhash := ""
	exifStripped := false

	switch mimeType {
	case "image/jpeg":
		orient := readJPEGEXIFOrientation(raw)
		img, err := jpeg.Decode(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("decode jpeg: %w", err)
		}
		if orient >= 2 && orient <= 8 {
			img = applyOrientation(img, orient)
		}
		var out bytes.Buffer
		if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: 88}); err != nil {
			return nil, fmt.Errorf("encode clean jpeg: %w", err)
		}
		cleanBytes = out.Bytes()
		b := img.Bounds()
		w, h := b.Dx(), b.Dy()
		width, height = &w, &h
		thumbhash = encodeThumbHash(img)
		exifStripped = true

	case "image/png":
		img, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("decode png: %w", err)
		}
		var out bytes.Buffer
		if err := png.Encode(&out, img); err != nil {
			return nil, fmt.Errorf("encode clean png: %w", err)
		}
		cleanBytes = out.Bytes()
		b := img.Bounds()
		w, h := b.Dx(), b.Dy()
		width, height = &w, &h
		thumbhash = encodeThumbHash(img)
		exifStripped = true

	case "image/gif":
		img, err := gif.Decode(bytes.NewReader(raw))
		if err == nil {
			b := img.Bounds()
			w, h := b.Dx(), b.Dy()
			width, height = &w, &h
			thumbhash = encodeThumbHash(img)
		}
		exifStripped = true

	case "image/webp":
		cleanBytes = stripWebPMetadata(raw)
		img, err := webp.Decode(bytes.NewReader(cleanBytes))
		if err == nil {
			b := img.Bounds()
			w, h := b.Dx(), b.Dy()
			width, height = &w, &h
			thumbhash = encodeThumbHash(img)
		}
		exifStripped = true
	}

	baseName := sanitizeUploadFilename(originalName, ext)
	if now.IsZero() {
		now = time.Now().UTC()
	}
	sum := content.SHA256Hex(cleanBytes)[:12]
	key := fmt.Sprintf("%04d/%02d/%s-%s%s", now.UTC().Year(), now.UTC().Month(), sum, strings.TrimSuffix(baseName, filepath.Ext(baseName)), ext)

	return &ProcessedAsset{
		Filename:     baseName,
		StorageKey:   key,
		MimeType:     mimeType,
		Data:         cleanBytes,
		ByteSize:     int64(len(cleanBytes)),
		Width:        width,
		Height:       height,
		Thumbhash:    thumbhash,
		EXIFStripped: exifStripped,
	}, nil
}

func detectSafeMIME(filename string, raw []byte) string {
	sniffLen := len(raw)
	if sniffLen > 512 {
		sniffLen = 512
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(raw[:sniffLen]), ";")[0]))
	ext := strings.ToLower(filepath.Ext(strings.TrimSpace(filename)))

	// Reject any active HTML/XML/SVG/script content immediately.
	lowerHead := strings.ToLower(string(raw[:sniffLen]))
	if strings.Contains(lowerHead, "<svg") || strings.Contains(lowerHead, "<script") || strings.Contains(lowerHead, "<!doctype html") || strings.Contains(lowerHead, "<html") {
		return "text/html"
	}

	if detected == "image/jpeg" || detected == "image/png" || detected == "image/gif" || detected == "image/webp" || detected == "application/pdf" {
		return detected
	}
	if len(raw) >= 12 && string(raw[:4]) == "RIFF" && string(raw[8:12]) == "WEBP" {
		return "image/webp"
	}
	if len(raw) >= 12 && string(raw[4:8]) == "ftyp" {
		return "video/mp4"
	}
	if len(raw) >= 4 && raw[0] == 0x1a && raw[1] == 0x45 && raw[2] == 0xdf && raw[3] == 0xa3 {
		return "video/webm"
	}
	if len(raw) >= 4 && string(raw[:4]) == "OggS" {
		return "audio/ogg"
	}
	if len(raw) >= 12 && string(raw[:4]) == "RIFF" && string(raw[8:12]) == "WAVE" {
		return "audio/wav"
	}
	if (len(raw) >= 3 && string(raw[:3]) == "ID3") || (len(raw) >= 2 && raw[0] == 0xff && (raw[1]&0xe0) == 0xe0) {
		if ext == ".mp3" || detected == "application/octet-stream" || detected == "audio/mpeg" {
			return "audio/mpeg"
		}
	}
	if detected == "video/webm" || detected == "video/mp4" || detected == "audio/mpeg" || detected == "audio/ogg" || detected == "audio/wav" {
		return detected
	}
	return detected
}

func sanitizeUploadFilename(name, ext string) string {
	base := filepath.Base(strings.TrimSpace(name))
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	stem = nonSlugNameRe.ReplaceAllString(stem, "-")
	stem = strings.Trim(stem, "-._")
	if stem == "" {
		stem = "asset"
	}
	if len(stem) > 48 {
		stem = stem[:48]
	}
	return strings.ToLower(stem) + ext
}

// readJPEGEXIFOrientation scans JPEG APP1 TIFF IFD0 for Orientation tag (0x0112).
func readJPEGEXIFOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xff || data[1] != 0xd8 {
		return 1
	}
	pos := 2
	for pos+4 <= len(data) {
		if data[pos] != 0xff {
			return 1
		}
		marker := data[pos+1]
		if marker == 0xda || marker == 0xd9 {
			return 1
		}
		segLen := int(binary.BigEndian.Uint16(data[pos+2 : pos+4]))
		if segLen < 2 || pos+2+segLen > len(data) {
			return 1
		}
		if marker == 0xe1 && segLen > 8 && string(data[pos+4:pos+10]) == "Exif\x00\x00" {
			return parseTIFFOrientation(data[pos+10 : pos+2+segLen])
		}
		pos += 2 + segLen
	}
	return 1
}

func parseTIFFOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	if bo.Uint16(tiff[2:4]) != 42 {
		return 1
	}
	ifdOff := int(bo.Uint32(tiff[4:8]))
	if ifdOff < 8 || ifdOff+2 > len(tiff) {
		return 1
	}
	count := int(bo.Uint16(tiff[ifdOff : ifdOff+2]))
	for i := 0; i < count; i++ {
		entryOff := ifdOff + 2 + i*12
		if entryOff+12 > len(tiff) {
			break
		}
		tag := bo.Uint16(tiff[entryOff : entryOff+2])
		if tag == 0x0112 {
			typ := bo.Uint16(tiff[entryOff+2 : entryOff+4])
			if typ == 3 {
				orient := int(bo.Uint16(tiff[entryOff+8 : entryOff+10]))
				if orient >= 1 && orient <= 8 {
					return orient
				}
			}
		}
	}
	return 1
}

func applyOrientation(src image.Image, orient int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	var dst *image.NRGBA
	switch orient {
	case 2: // flip horizontal
		dst = image.NewNRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(w-1-x, y, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 3: // rotate 180
		dst = image.NewNRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(w-1-x, h-1-y, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 4: // flip vertical
		dst = image.NewNRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(x, h-1-y, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 5: // transpose
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(y, x, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 6: // rotate 90 CW
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(h-1-y, x, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 7: // transverse
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(h-1-y, w-1-x, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 8: // rotate 270 CW
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(y, w-1-x, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	default:
		return src
	}
	return dst
}

// stripWebPMetadata drops EXIF and XMP RIFF chunks from WebP containers.
func stripWebPMetadata(data []byte) []byte {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return data
	}
	var payload bytes.Buffer
	pos := 12
	for pos+8 <= len(data) {
		fourcc := string(data[pos : pos+4])
		size := int(binary.LittleEndian.Uint32(data[pos+4 : pos+8]))
		padded := size + (size & 1)
		end := pos + 8 + padded
		if end > len(data) {
			return data
		}
		if fourcc != "EXIF" && fourcc != "XMP " {
			payload.Write(data[pos:end])
		}
		pos = end
	}
	out := make([]byte, 12+payload.Len())
	copy(out[:4], "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], uint32(4+payload.Len()))
	copy(out[8:12], "WEBP")
	copy(out[12:], payload.Bytes())
	return out
}

// encodeThumbHash produces a compact base64 blur-preview ThumbHash representation from image pixels.
func encodeThumbHash(img image.Image) string {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return ""
	}
	const grid = 4
	var buf [3 + grid*grid]byte
	// Header stores quantized aspect ratio + DC average
	ratio := uint16(math.Round(float64(w) / float64(h) * 16))
	if ratio == 0 {
		ratio = 16
	}
	buf[0] = byte(w & 0xff)
	buf[1] = byte(h & 0xff)
	buf[2] = byte(ratio & 0xff)

	idx := 3
	for gy := 0; gy < grid; gy++ {
		sy := b.Min.Y + (gy*h+h/2)/grid
		for gx := 0; gx < grid; gx++ {
			sx := b.Min.X + (gx*w+w/2)/grid
			r, g, bl, _ := img.At(sx, sy).RGBA()
			lum := uint8((0.299*float64(r) + 0.587*float64(g) + 0.114*float64(bl)) / 257.0)
			buf[idx] = lum
			idx++
		}
	}
	return base64.RawStdEncoding.EncodeToString(buf[:])
}

// FindOrphanAssets returns stored assets older than minAge that are unreferenced by any Markdown document,
// its cover/ogImage, or extra metadata.
func FindOrphanAssets(assets []state.AssetRecord, docs []*content.Document, minAge time.Duration) []state.AssetRecord {
	now := time.Now().UTC()
	var orphans []state.AssetRecord
	for _, asset := range assets {
		if minAge > 0 && now.Sub(asset.CreatedAt) < minAge {
			continue
		}
		referenced := false
		for _, doc := range docs {
			if doc.Cover == asset.PublicURL || doc.SEO.OGImage == asset.PublicURL ||
				strings.Contains(doc.Cover, asset.StorageKey) || strings.Contains(doc.SEO.OGImage, asset.StorageKey) ||
				strings.Contains(doc.Raw, asset.PublicURL) || strings.Contains(doc.Raw, asset.StorageKey) {
				referenced = true
				break
			}
		}
		if !referenced {
			orphans = append(orphans, asset)
		}
	}
	return orphans
}
