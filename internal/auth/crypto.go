package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

const (
	argonMemoryKiB uint32 = 64 * 1024
	argonTime      uint32 = 3
	argonThreads   uint8  = 4
	argonKeyLen    uint32 = 32
	argonSaltLen          = 16
)

const passwordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*-_=+"

// HashPassword hashes plain using Argon2id and encodes a standard PHC string.
func HashPassword(plain string) (string, error) {
	if len(plain) < 8 {
		return "", fmt.Errorf("password must be at least 8 characters")
	}
	salt := make([]byte, argonSaltLen)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}
	hash := argon2.IDKey([]byte(plain), salt, argonTime, argonMemoryKiB, argonThreads, argonKeyLen)
	b64Salt := base64.RawStdEncoding.EncodeToString(salt)
	b64Hash := base64.RawStdEncoding.EncodeToString(hash)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemoryKiB, argonTime, argonThreads, b64Salt, b64Hash), nil
}

// VerifyPassword verifies a plaintext password against a stored Argon2id PHC string in constant time.
func VerifyPassword(plain, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("invalid argon2id hash format")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errors.New("unsupported argon2id version")
	}
	var mem uint32
	var iter uint32
	var threads uint8
	for _, kv := range strings.Split(parts[3], ",") {
		p := strings.SplitN(kv, "=", 2)
		if len(p) != 2 {
			continue
		}
		v, err := strconv.ParseUint(p[1], 10, 32)
		if err != nil {
			return false, errors.New("invalid argon2id params")
		}
		switch p[0] {
		case "m":
			mem = uint32(v)
		case "t":
			iter = uint32(v)
		case "p":
			threads = uint8(v)
		}
	}
	if mem == 0 || iter == 0 || threads == 0 {
		return false, errors.New("incomplete argon2id params")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	expectedHash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	candidate := argon2.IDKey([]byte(plain), salt, iter, mem, threads, uint32(len(expectedHash)))
	ok := subtle.ConstantTimeCompare(candidate, expectedHash) == 1
	return ok, nil
}

// EncryptBytes encrypts plain using AES-256-GCM with a random 12-byte nonce prepended.
func EncryptBytes(key32, plain []byte) ([]byte, error) {
	if len(key32) != 32 {
		return nil, fmt.Errorf("encryption key must be 32 bytes")
	}
	block, err := aes.NewCipher(key32)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	out := make([]byte, len(nonce))
	copy(out, nonce)
	return gcm.Seal(out, nonce, plain, nil), nil
}

// DecryptBytes decrypts a payload produced by EncryptBytes.
func DecryptBytes(key32, cipherData []byte) ([]byte, error) {
	if len(key32) != 32 {
		return nil, fmt.Errorf("decryption key must be 32 bytes")
	}
	block, err := aes.NewCipher(key32)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(cipherData) < ns+gcm.Overhead() {
		return nil, errors.New("ciphertext too short")
	}
	return gcm.Open(nil, cipherData[:ns], cipherData[ns:], nil)
}

// GenerateHighEntropyPassword creates a 36-character CSPRNG password with mixed classes.
func GenerateHighEntropyPassword() (string, error) {
	const length = 36
	maxIdx := big.NewInt(int64(len(passwordAlphabet)))
	out := make([]byte, length)
	for i := 0; i < length; i++ {
		n, err := rand.Int(rand.Reader, maxIdx)
		if err != nil {
			return "", err
		}
		out[i] = passwordAlphabet[n.Int64()]
	}
	return string(out), nil
}

// GenerateRandomToken generates a prefixed URL-safe token along with its SHA-256 hex digest and visible prefix.
func GenerateRandomToken(prefix string, nBytes int) (plainToken string, sha256Hex string, visiblePrefix string, err error) {
	if nBytes < 16 {
		nBytes = 24
	}
	buf := make([]byte, nBytes)
	if _, err = io.ReadFull(rand.Reader, buf); err != nil {
		return "", "", "", err
	}
	raw := base64.RawURLEncoding.EncodeToString(buf)
	plainToken = prefix + raw
	sum := sha256.Sum256([]byte(plainToken))
	sha256Hex = hex.EncodeToString(sum[:])
	visibleLen := 12
	if len(plainToken) < visibleLen {
		visibleLen = len(plainToken)
	}
	visiblePrefix = plainToken[:visibleLen]
	return plainToken, sha256Hex, visiblePrefix, nil
}

// HashToken computes lowercase SHA-256 hex digest of an opaque token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// DailyRotatingHash computes an unlinkable daily HMAC-SHA256 pseudonym suitable for rate limits, analytics, and reactions.
func DailyRotatingHash(secretKey []byte, namespace, value string, now time.Time) string {
	mac := hmac.New(sha256.New, secretKey)
	day := now.UTC().Format("2006-01-02")
	mac.Write([]byte(day))
	mac.Write([]byte{':'})
	mac.Write([]byte(namespace))
	mac.Write([]byte{':'})
	mac.Write([]byte(strings.TrimSpace(value)))
	return hex.EncodeToString(mac.Sum(nil))
}

// GenerateRecoveryCodes generates count human-readable 10-character recovery codes and their SHA-256 hex hashes.
func GenerateRecoveryCodes(count int) ([]string, []string, error) {
	if count <= 0 {
		count = 10
	}
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	maxIdx := big.NewInt(int64(len(alphabet)))
	plain := make([]string, count)
	hashes := make([]string, count)
	for i := 0; i < count; i++ {
		var b strings.Builder
		for j := 0; j < 10; j++ {
			if j == 5 {
				b.WriteByte('-')
			}
			n, err := rand.Int(rand.Reader, maxIdx)
			if err != nil {
				return nil, nil, err
			}
			b.WriteByte(alphabet[n.Int64()])
		}
		code := b.String()
		plain[i] = code
		hashes[i] = HashToken(strings.ToUpper(strings.ReplaceAll(code, "-", "")))
	}
	return plain, hashes, nil
}
