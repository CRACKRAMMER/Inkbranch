package ops

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CRACKRAMMER/Inkbranch/internal/config"
	"github.com/CRACKRAMMER/Inkbranch/internal/media"
	"github.com/CRACKRAMMER/Inkbranch/internal/state"
	"github.com/klauspost/compress/zstd"
)

func TestBackupRestoreRoundTripAndSecurityChecks(t *testing.T) {
	tmp := t.TempDir()
	contentDir := filepath.Join(tmp, "content")
	uploadsDir := filepath.Join(tmp, "uploads")
	backupsDir := filepath.Join(tmp, "backups")
	_ = os.MkdirAll(filepath.Join(contentDir, "posts"), 0o755)
	_ = os.MkdirAll(uploadsDir, 0o755)

	postPath := filepath.Join(contentDir, "posts", "hello.md")
	origMD := "---\ntitle: Hello Backup\npublishedAt: 2026-11-14\nstatus: published\n---\nBody\n"
	if err := os.WriteFile(postPath, []byte(origMD), 0o644); err != nil {
		t.Fatalf("write post: %v", err)
	}
	_ = os.WriteFile(filepath.Join(uploadsDir, "sample.txt"), []byte("imgdata"), 0o644)

	cfg := &config.Config{
		ContentDir: contentDir,
		UploadsDir: uploadsDir,
		BackupsDir: backupsDir,
	}
	st := state.NewMemoryStore()
	_ = st.SetSetting(context.Background(), "feed_mode", json.RawMessage(`"summary"`))
	storage := media.NewLocalStorage(uploadsDir)

	rec, archivePath, err := CreateBackup(context.Background(), cfg, st, storage, nil, "test-backup")
	if err != nil {
		t.Fatalf("CreateBackup: %v", err)
	}
	fi, err := os.Stat(archivePath)
	if err != nil {
		t.Fatalf("stat archive: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("expected backup mode 0600, got %o", fi.Mode().Perm())
	}
	if rec.Checksum == "" || rec.ByteSize == 0 {
		t.Fatalf("expected non-empty backup metadata: %+v", rec)
	}

	// Mutate content + state, then restore from backup archive
	_ = os.WriteFile(postPath, []byte("corrupted"), 0o644)
	_ = st.SetSetting(context.Background(), "feed_mode", json.RawMessage(`"full"`))

	f, err := os.Open(archivePath)
	if err != nil {
		t.Fatalf("open backup: %v", err)
	}
	defer f.Close()
	rollback, err := RestoreBackup(context.Background(), cfg, st, storage, f)
	if err != nil {
		t.Fatalf("RestoreBackup: %v", err)
	}
	if rollback == nil {
		t.Fatalf("expected pre-restore rollback backup record")
	}
	restoredMD, _ := os.ReadFile(postPath)
	if string(restoredMD) != origMD {
		t.Fatalf("restored markdown mismatch: got=%q", restoredMD)
	}
	settings, _ := st.GetAllSettings(context.Background())
	if string(settings["feed_mode"]) != `"summary"` {
		t.Fatalf("expected restored setting feed_mode=summary, got %s", settings["feed_mode"])
	}

	// Verify traversal rejection on malicious archive
	var badBuf bytes.Buffer
	zw, _ := zstd.NewWriter(&badBuf)
	tw := tar.NewWriter(zw)
	evil := []byte("owned")
	_ = tw.WriteHeader(&tar.Header{Name: "../../etc/passwd", Mode: 0o644, Size: int64(len(evil)), ModTime: time.Now(), Typeflag: tar.TypeReg})
	_, _ = tw.Write(evil)
	_ = tw.Close()
	_ = zw.Close()
	if _, err := RestoreBackup(context.Background(), cfg, st, storage, bytes.NewReader(badBuf.Bytes())); err == nil {
		t.Fatalf("expected path traversal archive to be rejected")
	}
}
