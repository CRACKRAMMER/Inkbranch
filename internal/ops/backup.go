package ops

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/media"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/google/uuid"
	"github.com/klauspost/compress/zstd"
)

type ManifestFileEntry struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type BackupManifest struct {
	Version   string              `json:"version"`
	CreatedAt time.Time           `json:"createdAt"`
	Files     []ManifestFileEntry `json:"files"`
}

// CreateBackup builds a verified .tar.zst archive containing state_snapshot.json, content/,
// uploads/, and manifest.json, saves it with 0600 permissions under cfg.BackupsDir, and records it.
func CreateBackup(ctx context.Context, cfg *config.Config, st state.Store, storage media.StorageDriver, createdBy *uuid.UUID, prefix string) (*state.BackupRecord, string, error) {
	if cfg == nil {
		return nil, "", fmt.Errorf("config is required")
	}
	if prefix == "" {
		prefix = "inkbranch-backup"
	}
	if err := os.MkdirAll(cfg.BackupsDir, 0o700); err != nil {
		return nil, "", fmt.Errorf("create backups dir: %w", err)
	}
	filename := fmt.Sprintf("%s-%s.tar.zst", prefix, time.Now().UTC().Format("20060102-150405.000"))
	outPath := filepath.Join(cfg.BackupsDir, filename)

	var entries []struct {
		tarPath string
		data    []byte
		modTime time.Time
	}

	if st != nil {
		snap, err := st.ExportSnapshot(ctx)
		if err != nil {
			return nil, "", fmt.Errorf("export state snapshot: %w", err)
		}
		snapBytes, err := json.MarshalIndent(snap, "", "  ")
		if err != nil {
			return nil, "", err
		}
		entries = append(entries, struct {
			tarPath string
			data    []byte
			modTime time.Time
		}{
			tarPath: "state_snapshot.json",
			data:    snapBytes,
			modTime: time.Now().UTC(),
		})
	}

	for _, rootSpec := range []struct {
		prefix string
		dir    string
	}{
		{"content", cfg.ContentDir},
		{"uploads", cfg.UploadsDir},
	} {
		collected, err := collectTreeEntries(rootSpec.dir, rootSpec.prefix)
		if err != nil {
			return nil, "", err
		}
		entries = append(entries, collected...)
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].tarPath < entries[j].tarPath })

	manifest := BackupManifest{
		Version:   "2.0",
		CreatedAt: time.Now().UTC(),
		Files:     make([]ManifestFileEntry, 0, len(entries)),
	}
	for _, e := range entries {
		sum := sha256.Sum256(e.data)
		manifest.Files = append(manifest.Files, ManifestFileEntry{
			Path:   e.tarPath,
			SHA256: hex.EncodeToString(sum[:]),
			Size:   int64(len(e.data)),
		})
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, "", err
	}

	var archiveBuf bytes.Buffer
	zw, err := zstd.NewWriter(&archiveBuf)
	if err != nil {
		return nil, "", err
	}
	tw := tar.NewWriter(zw)

	writeTarEntry := func(name string, data []byte, modTime time.Time) error {
		hdr := &tar.Header{
			Name:     name,
			Mode:     0o644,
			Size:     int64(len(data)),
			ModTime:  modTime,
			Typeflag: tar.TypeReg,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		_, err := tw.Write(data)
		return err
	}

	if err := writeTarEntry("manifest.json", manifestBytes, manifest.CreatedAt); err != nil {
		_ = tw.Close()
		_ = zw.Close()
		return nil, "", err
	}
	for _, e := range entries {
		if err := writeTarEntry(e.tarPath, e.data, e.modTime); err != nil {
			_ = tw.Close()
			_ = zw.Close()
			return nil, "", err
		}
	}
	if err := tw.Close(); err != nil {
		_ = zw.Close()
		return nil, "", err
	}
	if err := zw.Close(); err != nil {
		return nil, "", err
	}

	archiveBytes := archiveBuf.Bytes()
	tmpPath := outPath + ".tmp"
	if err := os.WriteFile(tmpPath, archiveBytes, 0o600); err != nil {
		return nil, "", err
	}
	if err := os.Rename(tmpPath, outPath); err != nil {
		_ = os.Remove(tmpPath)
		return nil, "", err
	}

	sum := sha256.Sum256(archiveBytes)
	driverName := "local"
	storageKey := filename
	if storage != nil && storage.DriverName() == "r2" {
		if _, err := storage.Put(ctx, "backups/"+filename, archiveBytes, "application/zstd"); err == nil {
			driverName = "r2"
			storageKey = "backups/" + filename
		}
	}

	rec := state.BackupRecord{
		ID:            uuid.New(),
		Filename:      filename,
		StorageDriver: driverName,
		StorageKey:    storageKey,
		ByteSize:      int64(len(archiveBytes)),
		Checksum:      hex.EncodeToString(sum[:]),
		Status:        "completed",
		CreatedBy:     createdBy,
		CreatedAt:     time.Now().UTC(),
	}
	if st != nil {
		if err := st.CreateBackup(ctx, rec); err != nil {
			return nil, outPath, err
		}
	}
	return &rec, outPath, nil
}

// RestoreBackup validates a .tar.zst backup (path safety, symlink rejection, SHA-256 manifest match),
// saves a pre-restore rollback backup, swaps content & uploads safely, and restores database state.
func RestoreBackup(ctx context.Context, cfg *config.Config, st state.Store, storage media.StorageDriver, archiveReader io.Reader) (*state.BackupRecord, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}

	zr, err := zstd.NewReader(archiveReader)
	if err != nil {
		return nil, fmt.Errorf("open zstd archive: %w", err)
	}
	defer zr.Close()

	tr := tar.NewReader(zr)
	files := make(map[string][]byte)
	var totalBytes int64
	const maxRestoreBytes = 512 << 20 // 512 MiB safety ceiling

	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read tar header: %w", err)
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		if hdr.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("unsafe tar entry type for %q (symlinks/special files rejected)", hdr.Name)
		}
		cleanName, ok := sanitizeArchiveEntryPath(hdr.Name)
		if !ok {
			return nil, fmt.Errorf("unsafe archive entry path %q", hdr.Name)
		}
		totalBytes += hdr.Size
		if totalBytes > maxRestoreBytes {
			return nil, fmt.Errorf("archive exceeds max restore size limit")
		}
		data, err := io.ReadAll(io.LimitReader(tr, maxRestoreBytes))
		if err != nil {
			return nil, fmt.Errorf("read entry %q: %w", cleanName, err)
		}
		files[cleanName] = data
	}

	manifestRaw, ok := files["manifest.json"]
	if !ok {
		return nil, fmt.Errorf("archive missing manifest.json")
	}
	var manifest BackupManifest
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		return nil, fmt.Errorf("invalid manifest.json: %w", err)
	}

	// Verify per-file SHA-256 checksums before mutating any live state.
	for _, mf := range manifest.Files {
		cleanName, valid := sanitizeArchiveEntryPath(mf.Path)
		if !valid || cleanName == "manifest.json" {
			return nil, fmt.Errorf("invalid manifest entry %q", mf.Path)
		}
		data, exists := files[cleanName]
		if !exists {
			return nil, fmt.Errorf("archive missing file %q listed in manifest", cleanName)
		}
		sum := sha256.Sum256(data)
		got := hex.EncodeToString(sum[:])
		if got != mf.SHA256 {
			return nil, fmt.Errorf("SHA-256 mismatch for %q: got %s want %s", cleanName, got, mf.SHA256)
		}
	}

	// Capture an automatic pre-restore rollback backup before modifying live content/uploads/DB.
	rollbackRec, _, err := CreateBackup(ctx, cfg, st, storage, nil, "pre-restore-rollback")
	if err != nil {
		return nil, fmt.Errorf("create pre-restore rollback backup: %w", err)
	}

	if err := restoreDirTree(cfg.ContentDir, "content/", files); err != nil {
		return nil, fmt.Errorf("restore content: %w", err)
	}
	if err := restoreDirTree(cfg.UploadsDir, "uploads/", files); err != nil {
		return nil, fmt.Errorf("restore uploads: %w", err)
	}

	if st != nil {
		if snapRaw, hasSnap := files["state_snapshot.json"]; hasSnap {
			var snap state.StateSnapshot
			if err := json.Unmarshal(snapRaw, &snap); err != nil {
				return nil, fmt.Errorf("parse state_snapshot.json: %w", err)
			}
			if err := st.ImportSnapshot(ctx, &snap); err != nil {
				return nil, fmt.Errorf("import state snapshot: %w", err)
			}
		}
	}

	return rollbackRec, nil
}

func collectTreeEntries(rootDir, tarPrefix string) ([]struct {
	tarPath string
	data    []byte
	modTime time.Time
}, error) {
	var out []struct {
		tarPath string
		data    []byte
		modTime time.Time
	}
	if _, err := os.Stat(rootDir); errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	err := filepath.WalkDir(rootDir, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		name := d.Name()
		if d.IsDir() {
			if name == ".locks" || name == ".tmp" || name == ".recovery" {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(rootDir, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		info, _ := d.Info()
		mod := time.Now().UTC()
		if info != nil {
			mod = info.ModTime().UTC()
		}
		out = append(out, struct {
			tarPath string
			data    []byte
			modTime time.Time
		}{
			tarPath: path.Join(tarPrefix, filepath.ToSlash(rel)),
			data:    data,
			modTime: mod,
		})
		return nil
	})
	return out, err
}

func sanitizeArchiveEntryPath(raw string) (string, bool) {
	if strings.ContainsRune(raw, '\x00') || strings.Contains(raw, "\\") || strings.HasPrefix(raw, "/") {
		return "", false
	}
	clean := path.Clean("/" + raw)
	rel := strings.TrimPrefix(clean, "/")
	if rel == "" || rel == "." || strings.Contains(rel, "..") {
		return "", false
	}
	if rel == "manifest.json" || rel == "state_snapshot.json" ||
		strings.HasPrefix(rel, "content/") || strings.HasPrefix(rel, "uploads/") {
		return rel, true
	}
	return "", false
}

func restoreDirTree(targetDir, archivePrefix string, files map[string][]byte) error {
	parent := filepath.Dir(filepath.Clean(targetDir))
	if parent == "" {
		parent = "."
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	stagingDir, err := os.MkdirTemp(parent, ".restore-stage-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stagingDir)

	for name, data := range files {
		if !strings.HasPrefix(name, archivePrefix) {
			continue
		}
		rel := strings.TrimPrefix(name, archivePrefix)
		if rel == "" {
			continue
		}
		dest := filepath.Join(stagingDir, filepath.FromSlash(rel))
		if !strings.HasPrefix(dest, stagingDir+string(filepath.Separator)) {
			return fmt.Errorf("staged path escapes staging dir: %s", rel)
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, data, 0o644); err != nil {
			return err
		}
	}

	// Clear existing regular entries in targetDir and copy staged files cleanly so mounted volumes work seamlessly.
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(targetDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		n := entry.Name()
		if n == ".gitkeep" || n == ".locks" || n == ".recovery" || n == ".tmp" {
			continue
		}
		_ = os.RemoveAll(filepath.Join(targetDir, n))
	}

	return filepath.WalkDir(stagingDir, func(srcPath string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(stagingDir, srcPath)
		if err != nil || rel == "." {
			return err
		}
		dstPath := filepath.Join(targetDir, rel)
		if d.IsDir() {
			return os.MkdirAll(dstPath, 0o755)
		}
		data, err := os.ReadFile(srcPath)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dstPath, data, 0o644)
	})
}

// ZstdCompressBytes / ZstdDecompressBytes provide compact revision storage for content_revisions.
func ZstdCompressBytes(data []byte) ([]byte, error) {
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		return nil, err
	}
	defer enc.Close()
	return enc.EncodeAll(data, nil), nil
}

func ZstdDecompressBytes(compressed []byte) ([]byte, error) {
	dec, err := zstd.NewReader(nil)
	if err != nil {
		return nil, err
	}
	defer dec.Close()
	return dec.DecodeAll(compressed, nil)
}
