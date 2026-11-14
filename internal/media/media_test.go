package media

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/content"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
)

func buildTestJPEGWithEXIFOrientation(w, h, orientation int) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8((x * 15) % 255), G: uint8((y * 20) % 255), B: 180, A: 255})
		}
	}
	var base bytes.Buffer
	if err := jpeg.Encode(&base, img, &jpeg.Options{Quality: 90}); err != nil {
		return nil, err
	}
	raw := base.Bytes()

	// Construct APP1 Exif header with TIFF IFD0 Orientation + fake GPS marker string
	var tiff bytes.Buffer
	tiff.WriteString("II")                                   // Little-endian
	binary.Write(&tiff, binary.LittleEndian, uint16(42))     // Magic
	binary.Write(&tiff, binary.LittleEndian, uint32(8))      // IFD0 offset
	binary.Write(&tiff, binary.LittleEndian, uint16(1))      // 1 entry
	binary.Write(&tiff, binary.LittleEndian, uint16(0x0112)) // Orientation tag
	binary.Write(&tiff, binary.LittleEndian, uint16(3))      // SHORT
	binary.Write(&tiff, binary.LittleEndian, uint32(1))      // count
	binary.Write(&tiff, binary.LittleEndian, uint16(orientation))
	binary.Write(&tiff, binary.LittleEndian, uint16(0))
	binary.Write(&tiff, binary.LittleEndian, uint32(0)) // next IFD
	tiff.WriteString("GPS_LATITUDE_FAKE_SECRET")

	var app1 bytes.Buffer
	app1.Write([]byte{0xff, 0xe1})
	segLen := uint16(2 + 6 + tiff.Len())
	binary.Write(&app1, binary.BigEndian, segLen)
	app1.WriteString("Exif\x00\x00")
	app1.Write(tiff.Bytes())

	var out bytes.Buffer
	out.Write(raw[:2]) // SOI
	out.Write(app1.Bytes())
	out.Write(raw[2:])
	return out.Bytes(), nil
}

func TestProcessUploadStripsEXIFAndRotatesJPEG(t *testing.T) {
	// 24x12 landscape image marked Orientation=6 (90 CW) -> should become 12x24 portrait
	raw, err := buildTestJPEGWithEXIFOrientation(24, 12, 6)
	if err != nil {
		t.Fatalf("buildTestJPEGWithEXIFOrientation: %v", err)
	}
	if !bytes.Contains(raw, []byte("GPS_LATITUDE_FAKE_SECRET")) {
		t.Fatalf("expected fake EXIF marker in source test bytes")
	}

	processed, err := ProcessUpload("Vacation Photo (1).JPEG", raw, time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("ProcessUpload: %v", err)
	}
	if !processed.EXIFStripped {
		t.Fatalf("expected EXIFStripped=true")
	}
	if bytes.Contains(processed.Data, []byte("GPS_LATITUDE_FAKE_SECRET")) || bytes.Contains(processed.Data, []byte("Exif\x00\x00")) {
		t.Fatalf("expected all EXIF/GPS metadata to be stripped")
	}
	if processed.Width == nil || processed.Height == nil || *processed.Width != 12 || *processed.Height != 24 {
		t.Fatalf("expected rotated dimensions 12x24, got %v x %v", processed.Width, processed.Height)
	}
	if processed.Thumbhash == "" {
		t.Fatalf("expected non-empty thumbhash")
	}

	// Reject HTML/SVG XSS payloads disguised with .png filename
	if _, err := ProcessUpload("evil.png", []byte("<svg onload=alert(1)></svg>"), time.Now()); err == nil {
		t.Fatalf("expected SVG payload to be rejected")
	}

	// LocalStorage round-trip
	store := NewLocalStorage(t.TempDir())
	pubURL, err := store.Put(context.Background(), processed.StorageKey, processed.Data, processed.MimeType)
	if err != nil {
		t.Fatalf("LocalStorage.Put: %v", err)
	}
	got, err := store.Get(context.Background(), processed.StorageKey)
	if err != nil || !bytes.Equal(got, processed.Data) {
		t.Fatalf("LocalStorage.Get mismatch: err=%v len=%d", err, len(got))
	}

	// Orphan scanner test
	oldTime := time.Now().UTC().Add(-48 * time.Hour)
	assets := []state.AssetRecord{
		{StorageKey: "used.jpg", PublicURL: pubURL, CreatedAt: oldTime},
		{StorageKey: "orphan.jpg", PublicURL: "/uploads/2026/11/orphan.jpg", CreatedAt: oldTime},
	}
	docs := []*content.Document{
		{Raw: "Here is an embedded image ![](" + pubURL + ")"},
	}
	orphans := FindOrphanAssets(assets, docs, 24*time.Hour)
	if len(orphans) != 1 || orphans[0].StorageKey != "orphan.jpg" {
		t.Fatalf("unexpected orphan list: %+v", orphans)
	}
}
