package content

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var (
	// ErrConflict indicates optimistic concurrency checksum mismatch during save.
	ErrConflict = errors.New("document modified on disk since last read")
	// ErrLocked indicates an active concurrent writer holds the advisory lock.
	ErrLocked = errors.New("document is currently locked by another write")
)

// WriteAtomicOptions configures crash-safe atomic Markdown persistence.
type WriteAtomicOptions struct {
	ContentDir     string
	RelativePath   string // e.g. "posts/my-post.md"
	Data           []byte
	ExpectedSHA256 string // empty disables optimistic check
}

// WriteAtomicResult returns metadata recorded after atomic commit.
type WriteAtomicResult struct {
	SHA256       string
	ByteSize     int64
	MtimeNs      int64
	RecoveryPath string
}

// WriteAtomic persists a Markdown document using PID advisory locking, pre-write recovery backup,
// temp file write + fsync, atomic rename, and parent directory fsync.
func WriteAtomic(opts WriteAtomicOptions) (*WriteAtomicResult, error) {
	if strings.TrimSpace(opts.ContentDir) == "" || strings.TrimSpace(opts.RelativePath) == "" {
		return nil, fmt.Errorf("ContentDir and RelativePath are required")
	}
	cleanRel := filepath.ToSlash(filepath.Clean(opts.RelativePath))
	if strings.HasPrefix(cleanRel, "..") || filepath.IsAbs(cleanRel) {
		return nil, fmt.Errorf("invalid relative path %q", opts.RelativePath)
	}

	target := filepath.Join(opts.ContentDir, filepath.FromSlash(cleanRel))
	targetDir := filepath.Dir(target)
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return nil, fmt.Errorf("ensure target dir: %w", err)
	}

	unlock, err := acquirePIDLock(opts.ContentDir, cleanRel)
	if err != nil {
		return nil, err
	}
	defer unlock()

	// Check existing file for optimistic concurrency & pre-replacement recovery snapshot.
	var recoveryPath string
	if existing, err := os.ReadFile(target); err == nil {
		existingSum := SHA256Hex(existing)
		if opts.ExpectedSHA256 != "" && existingSum != opts.ExpectedSHA256 {
			return nil, ErrConflict
		}
		recoveryPath, _ = writeRecoveryBackup(opts.ContentDir, cleanRel, existing)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read existing file: %w", err)
	} else if opts.ExpectedSHA256 != "" {
		return nil, ErrConflict
	}

	tmpPath := filepath.Join(targetDir, fmt.Sprintf(".%s.%s.tmp", filepath.Base(target), randomHex(8)))
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("create temp file: %w", err)
	}

	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := f.Write(opts.Data); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("write temp file: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("fsync temp file: %w", err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("close temp file: %w", err)
	}

	if err := os.Rename(tmpPath, target); err != nil {
		return nil, fmt.Errorf("atomic rename: %w", err)
	}
	cleanupTmp = false

	if dirHandle, err := os.Open(targetDir); err == nil {
		_ = dirHandle.Sync()
		_ = dirHandle.Close()
	}

	st, err := os.Stat(target)
	if err != nil {
		return nil, fmt.Errorf("stat committed file: %w", err)
	}

	return &WriteAtomicResult{
		SHA256:       SHA256Hex(opts.Data),
		ByteSize:     st.Size(),
		MtimeNs:      st.ModTime().UnixNano(),
		RecoveryPath: recoveryPath,
	}, nil
}

// DeleteDocumentFile safely deletes a Markdown document under contentDir after recording a recovery snapshot.
func DeleteDocumentFile(contentDir, relPath string) error {
	if strings.TrimSpace(contentDir) == "" || strings.TrimSpace(relPath) == "" {
		return fmt.Errorf("ContentDir and RelativePath are required")
	}
	cleanRel := filepath.ToSlash(filepath.Clean(relPath))
	if strings.HasPrefix(cleanRel, "..") || strings.HasPrefix(cleanRel, "/") || filepath.IsAbs(cleanRel) {
		return fmt.Errorf("invalid relative path %q", relPath)
	}

	target := filepath.Join(contentDir, filepath.FromSlash(cleanRel))
	unlock, err := acquirePIDLock(contentDir, cleanRel)
	if err != nil {
		return err
	}
	defer unlock()

	if existing, err := os.ReadFile(target); err == nil {
		_, _ = writeRecoveryBackup(contentDir, cleanRel, existing)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read existing file: %w", err)
	} else {
		return os.ErrNotExist
	}

	if err := os.Remove(target); err != nil {
		return fmt.Errorf("remove document: %w", err)
	}

	if dirHandle, err := os.Open(filepath.Dir(target)); err == nil {
		_ = dirHandle.Sync()
		_ = dirHandle.Close()
	}
	return nil
}

// SHA256Hex computes the lowercase hex SHA-256 digest of bytes.
func SHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func acquirePIDLock(contentDir, relPath string) (func(), error) {
	lockDir := filepath.Join(contentDir, ".locks")
	if err := os.MkdirAll(lockDir, 0o755); err != nil {
		return nil, fmt.Errorf("create lock dir: %w", err)
	}
	safeName := strings.NewReplacer("/", "__", "\\", "__").Replace(relPath) + ".lock"
	lockPath := filepath.Join(lockDir, safeName)

	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = f.WriteString(strconv.Itoa(os.Getpid()) + "\n")
			_ = f.Close()
			return func() { _ = os.Remove(lockPath) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("acquire lock: %w", err)
		}

		if isLockStale(lockPath) {
			_ = os.Remove(lockPath)
			continue
		}
		return nil, ErrLocked
	}
	return nil, ErrLocked
}

func isLockStale(lockPath string) bool {
	b, err := os.ReadFile(lockPath)
	if err != nil {
		return true
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		return true
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return true
	}
	// On POSIX, signal 0 probes process existence without sending a signal.
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		return true
	}
	return false
}

func writeRecoveryBackup(contentDir, relPath string, data []byte) (string, error) {
	recDir := filepath.Join(contentDir, ".recovery")
	if err := os.MkdirAll(recDir, 0o755); err != nil {
		return "", err
	}
	safeName := strings.NewReplacer("/", "__", "\\", "__").Replace(relPath)
	path := filepath.Join(recDir, fmt.Sprintf("%s.%d.bak", safeName, time.Now().UnixNano()))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func randomHex(nBytes int) string {
	buf := make([]byte, nBytes)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}
