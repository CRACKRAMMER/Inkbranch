package state

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore implements Store against PostgreSQL 17 using pgx/v5.
type PostgresStore struct {
	pool *pgxpool.Pool
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

func (p *PostgresStore) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := p.pool.QueryRow(ctx, `SELECT COUNT(*)::int FROM users`).Scan(&n)
	return n, err
}

func (p *PostgresStore) CreateUser(ctx context.Context, u User) (User, error) {
	if u.ID == uuid.Nil {
		u.ID = uuid.New()
	}
	now := time.Now().UTC()
	if u.CreatedAt.IsZero() {
		u.CreatedAt = now
	}
	if u.UpdatedAt.IsZero() {
		u.UpdatedAt = now
	}
	u.Email = strings.ToLower(strings.TrimSpace(u.Email))
	if u.Role == "" {
		u.Role = "admin"
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO users (id, email, name, password_hash, role, avatar_url, bio, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7, $8, $9)
	`, u.ID, u.Email, u.Name, u.PasswordHash, u.Role, u.AvatarURL, u.Bio, u.CreatedAt, u.UpdatedAt)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			return User{}, ErrConflict
		}
		return User{}, err
	}
	return u, nil
}

func (p *PostgresStore) GetUserByID(ctx context.Context, id uuid.UUID) (*User, error) {
	return p.getUserWhere(ctx, `WHERE id = $1`, id)
}

func (p *PostgresStore) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	return p.getUserWhere(ctx, `WHERE lower(email) = lower($1)`, strings.TrimSpace(email))
}

func (p *PostgresStore) getUserWhere(ctx context.Context, where string, arg any) (*User, error) {
	var u User
	var avatar *string
	err := p.pool.QueryRow(ctx, `
		SELECT id, email, name, password_hash, role, avatar_url, bio, created_at, updated_at
		FROM users `+where, arg).
		Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.Role, &avatar, &u.Bio, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if avatar != nil {
		u.AvatarURL = *avatar
	}
	return &u, nil
}

func (p *PostgresStore) UpdateUserPassword(ctx context.Context, userID uuid.UUID, passwordHash string) error {
	tag, err := p.pool.Exec(ctx, `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, passwordHash, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresStore) UpdateUserProfile(ctx context.Context, userID uuid.UUID, name, bio, avatarURL string) error {
	tag, err := p.pool.Exec(ctx, `UPDATE users SET name = $1, bio = $2, avatar_url = NULLIF($3, ''), updated_at = now() WHERE id = $4`,
		name, bio, avatarURL, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresStore) CreateSession(ctx context.Context, s Session) error {
	if s.ID == uuid.Nil {
		s.ID = uuid.New()
	}
	now := time.Now().UTC()
	if s.CreatedAt.IsZero() {
		s.CreatedAt = now
	}
	if s.LastSeenAt.IsZero() {
		s.LastSeenAt = now
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, token_hash, csrf_secret, ip_hash, user_agent, last_seen_at, expires_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, s.ID, s.UserID, s.TokenHash, s.CSRFSecret, s.IPHash, s.UserAgent, s.LastSeenAt, s.ExpiresAt, s.CreatedAt)
	return err
}

func (p *PostgresStore) GetSessionByTokenHash(ctx context.Context, tokenHash string) (*Session, error) {
	var s Session
	err := p.pool.QueryRow(ctx, `
		SELECT id, user_id, token_hash, csrf_secret, ip_hash, user_agent, last_seen_at, expires_at, created_at
		FROM sessions WHERE token_hash = $1
	`, tokenHash).Scan(&s.ID, &s.UserID, &s.TokenHash, &s.CSRFSecret, &s.IPHash, &s.UserAgent, &s.LastSeenAt, &s.ExpiresAt, &s.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (p *PostgresStore) TouchSession(ctx context.Context, sessionID uuid.UUID, seenAt time.Time) error {
	_, err := p.pool.Exec(ctx, `UPDATE sessions SET last_seen_at = $1 WHERE id = $2`, seenAt.UTC(), sessionID)
	return err
}

func (p *PostgresStore) DeleteSession(ctx context.Context, sessionID uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, sessionID)
	return err
}

func (p *PostgresStore) DeleteSessionsByUser(ctx context.Context, userID uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
	return err
}

func (p *PostgresStore) ListSessionsByUser(ctx context.Context, userID uuid.UUID) ([]Session, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, user_id, token_hash, csrf_secret, ip_hash, user_agent, last_seen_at, expires_at, created_at
		FROM sessions WHERE user_id = $1 AND expires_at > now()
		ORDER BY last_seen_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var s Session
		if err := rows.Scan(&s.ID, &s.UserID, &s.TokenHash, &s.CSRFSecret, &s.IPHash, &s.UserAgent, &s.LastSeenAt, &s.ExpiresAt, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *PostgresStore) GetTOTP(ctx context.Context, userID uuid.UUID) (*TOTPRecord, error) {
	var rec TOTPRecord
	err := p.pool.QueryRow(ctx, `
		SELECT user_id, encrypted_secret, recovery_code_hashes, enabled, verified_at, created_at
		FROM totp_secrets WHERE user_id = $1
	`, userID).Scan(&rec.UserID, &rec.EncryptedSecret, &rec.RecoveryCodeHashes, &rec.Enabled, &rec.VerifiedAt, &rec.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

func (p *PostgresStore) UpsertTOTP(ctx context.Context, rec TOTPRecord) error {
	if rec.RecoveryCodeHashes == nil {
		rec.RecoveryCodeHashes = []string{}
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO totp_secrets (user_id, encrypted_secret, recovery_code_hashes, enabled, verified_at, created_at)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (user_id) DO UPDATE SET
			encrypted_secret = EXCLUDED.encrypted_secret,
			recovery_code_hashes = EXCLUDED.recovery_code_hashes,
			enabled = EXCLUDED.enabled,
			verified_at = EXCLUDED.verified_at
	`, rec.UserID, rec.EncryptedSecret, rec.RecoveryCodeHashes, rec.Enabled, rec.VerifiedAt)
	return err
}

func (p *PostgresStore) DeleteTOTP(ctx context.Context, userID uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM totp_secrets WHERE user_id = $1`, userID)
	return err
}

func (p *PostgresStore) ListPasskeys(ctx context.Context, userID uuid.UUID) ([]PasskeyRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, user_id, credential_id, public_key, attestation_type, aaguid, sign_count, transports, credential_json, label, last_used_at, created_at
		FROM passkey_credentials WHERE user_id = $1 ORDER BY created_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PasskeyRecord
	for rows.Next() {
		var pk PasskeyRecord
		var signCount int64
		if err := rows.Scan(&pk.ID, &pk.UserID, &pk.CredentialID, &pk.PublicKey, &pk.AttestationType, &pk.AAGUID, &signCount, &pk.Transports, &pk.CredentialJSON, &pk.Label, &pk.LastUsedAt, &pk.CreatedAt); err != nil {
			return nil, err
		}
		pk.SignCount = uint32(signCount)
		out = append(out, pk)
	}
	return out, rows.Err()
}

func (p *PostgresStore) GetPasskeyByCredentialID(ctx context.Context, credID []byte) (*PasskeyRecord, error) {
	var pk PasskeyRecord
	var signCount int64
	err := p.pool.QueryRow(ctx, `
		SELECT id, user_id, credential_id, public_key, attestation_type, aaguid, sign_count, transports, credential_json, label, last_used_at, created_at
		FROM passkey_credentials WHERE credential_id = $1
	`, credID).Scan(&pk.ID, &pk.UserID, &pk.CredentialID, &pk.PublicKey, &pk.AttestationType, &pk.AAGUID, &signCount, &pk.Transports, &pk.CredentialJSON, &pk.Label, &pk.LastUsedAt, &pk.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	pk.SignCount = uint32(signCount)
	return &pk, nil
}

func (p *PostgresStore) CreatePasskey(ctx context.Context, pk PasskeyRecord) error {
	if pk.ID == uuid.Nil {
		pk.ID = uuid.New()
	}
	if pk.Transports == nil {
		pk.Transports = []string{}
	}
	if len(pk.CredentialJSON) == 0 {
		pk.CredentialJSON = []byte("{}")
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, attestation_type, aaguid, sign_count, transports, credential_json, label, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
	`, pk.ID, pk.UserID, pk.CredentialID, pk.PublicKey, pk.AttestationType, pk.AAGUID, int64(pk.SignCount), pk.Transports, pk.CredentialJSON, pk.Label)
	return err
}

func (p *PostgresStore) UpdatePasskeyUsage(ctx context.Context, passkeyID uuid.UUID, signCount uint32, credentialJSON []byte, usedAt time.Time) error {
	_, err := p.pool.Exec(ctx, `
		UPDATE passkey_credentials
		SET sign_count = $1,
		    credential_json = CASE WHEN length($2::bytea) > 2 THEN $2::jsonb ELSE credential_json END,
		    last_used_at = $3
		WHERE id = $4
	`, int64(signCount), credentialJSON, usedAt.UTC(), passkeyID)
	return err
}

func (p *PostgresStore) DeletePasskey(ctx context.Context, userID, passkeyID uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM passkey_credentials WHERE id = $1 AND user_id = $2`, passkeyID, userID)
	return err
}

func (p *PostgresStore) CreateAPIToken(ctx context.Context, t APITokenRecord) error {
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	if t.Scopes == nil {
		t.Scopes = []string{}
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO api_tokens (id, user_id, name, token_prefix, token_hash, scopes, expires_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now())
	`, t.ID, t.UserID, t.Name, t.TokenPrefix, t.TokenHash, t.Scopes, t.ExpiresAt)
	return err
}

func (p *PostgresStore) GetAPITokenByHash(ctx context.Context, tokenHash string) (*APITokenRecord, error) {
	var t APITokenRecord
	err := p.pool.QueryRow(ctx, `
		SELECT id, user_id, name, token_prefix, token_hash, scopes, last_used_at, expires_at, revoked_at, created_at
		FROM api_tokens WHERE token_hash = $1
	`, tokenHash).Scan(&t.ID, &t.UserID, &t.Name, &t.TokenPrefix, &t.TokenHash, &t.Scopes, &t.LastUsedAt, &t.ExpiresAt, &t.RevokedAt, &t.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (p *PostgresStore) TouchAPIToken(ctx context.Context, tokenID uuid.UUID, usedAt time.Time) error {
	_, err := p.pool.Exec(ctx, `UPDATE api_tokens SET last_used_at = $1 WHERE id = $2`, usedAt.UTC(), tokenID)
	return err
}

func (p *PostgresStore) ListAPITokens(ctx context.Context, userID uuid.UUID) ([]APITokenRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, user_id, name, token_prefix, token_hash, scopes, last_used_at, expires_at, revoked_at, created_at
		FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []APITokenRecord
	for rows.Next() {
		var t APITokenRecord
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.TokenPrefix, &t.TokenHash, &t.Scopes, &t.LastUsedAt, &t.ExpiresAt, &t.RevokedAt, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (p *PostgresStore) RevokeAPIToken(ctx context.Context, userID, tokenID uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2`, tokenID, userID)
	return err
}

func (p *PostgresStore) AppendAuditLog(ctx context.Context, rec AuditLogRecord) error {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if len(rec.MetaJSON) == 0 {
		rec.MetaJSON = []byte("{}")
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, ip_hash, meta_json, created_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, $8, now())
	`, rec.ID, rec.ActorType, rec.ActorID, rec.Action, rec.TargetType, rec.TargetID, rec.IPHash, rec.MetaJSON)
	return err
}

func (p *PostgresStore) ListAuditLogs(ctx context.Context, limit int) ([]AuditLogRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := p.pool.Query(ctx, `
		SELECT id, actor_type, actor_id, action, coalesce(target_type, ''), coalesce(target_id, ''), ip_hash, meta_json, created_at
		FROM audit_logs ORDER BY created_at DESC LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditLogRecord
	for rows.Next() {
		var r AuditLogRecord
		if err := rows.Scan(&r.ID, &r.ActorType, &r.ActorID, &r.Action, &r.TargetType, &r.TargetID, &r.IPHash, &r.MetaJSON, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *PostgresStore) CreateRevision(ctx context.Context, rec RevisionRecord) (RevisionRecord, error) {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	cid := rec.ContentID
	if cid == uuid.Nil {
		cid = ContentUUID(rec.Path)
	}
	rec.ContentID = cid
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	err := p.pool.QueryRow(ctx, `
		INSERT INTO content_revisions (id, content_id, revision_num, checksum, compressed_body, diff_text, actor_id, note, created_at)
		VALUES (
			$1, $2,
			COALESCE((SELECT MAX(revision_num) FROM content_revisions WHERE content_id = $2), 0) + 1,
			$3, $4, $5, $6, $7, $8
		)
		RETURNING revision_num
	`, rec.ID, cid, rec.Checksum, rec.CompressedBody, rec.DiffText, rec.ActorID, rec.Note, rec.CreatedAt).Scan(&rec.RevisionNum)
	return rec, err
}

func (p *PostgresStore) ListRevisions(ctx context.Context, contentType, contentSlug string) ([]RevisionRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT r.id, r.content_id, ci.type, ci.slug, ci.path, r.revision_num, r.checksum, r.diff_text, r.actor_id, r.note, r.created_at
		FROM content_revisions r
		JOIN content_index ci ON ci.id = r.content_id
		WHERE ci.type = $1 AND ci.slug = $2
		ORDER BY r.revision_num DESC
	`, contentType, contentSlug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RevisionRecord
	for rows.Next() {
		var r RevisionRecord
		if err := rows.Scan(&r.ID, &r.ContentID, &r.ContentType, &r.ContentSlug, &r.Path, &r.RevisionNum, &r.Checksum, &r.DiffText, &r.ActorID, &r.Note, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *PostgresStore) GetRevision(ctx context.Context, id uuid.UUID) (*RevisionRecord, error) {
	var r RevisionRecord
	err := p.pool.QueryRow(ctx, `
		SELECT r.id, r.content_id, ci.type, ci.slug, ci.path, r.revision_num, r.checksum, r.compressed_body, r.diff_text, r.actor_id, r.note, r.created_at
		FROM content_revisions r
		JOIN content_index ci ON ci.id = r.content_id
		WHERE r.id = $1
	`, id).Scan(&r.ID, &r.ContentID, &r.ContentType, &r.ContentSlug, &r.Path, &r.RevisionNum, &r.Checksum, &r.CompressedBody, &r.DiffText, &r.ActorID, &r.Note, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (p *PostgresStore) MigrateContentPath(ctx context.Context, oldPath, newPath string) error {
	if oldPath == newPath || oldPath == "" || newPath == "" {
		return nil
	}
	newSlug := strings.TrimSuffix(newPath[strings.LastIndex(newPath, "/")+1:], ".md")
	_, err := p.pool.Exec(ctx, `UPDATE content_index SET path = $1, slug = $2 WHERE path = $3`, newPath, newSlug, oldPath)
	return err
}

func (p *PostgresStore) CreateDraftPreview(ctx context.Context, rec DraftPreviewRecord) error {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO draft_previews (id, token_hash, content_type, content_slug, label, expires_at, created_by, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now())
	`, rec.ID, rec.TokenHash, rec.ContentType, rec.ContentSlug, rec.Label, rec.ExpiresAt.UTC(), rec.CreatedBy)
	return err
}

func (p *PostgresStore) GetDraftPreviewByTokenHash(ctx context.Context, tokenHash string) (*DraftPreviewRecord, error) {
	var d DraftPreviewRecord
	err := p.pool.QueryRow(ctx, `
		SELECT id, token_hash, content_type, content_slug, label, expires_at, revoked_at, created_by, created_at
		FROM draft_previews WHERE token_hash = $1
	`, tokenHash).Scan(&d.ID, &d.TokenHash, &d.ContentType, &d.ContentSlug, &d.Label, &d.ExpiresAt, &d.RevokedAt, &d.CreatedBy, &d.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (p *PostgresStore) ListDraftPreviews(ctx context.Context, contentType, contentSlug string) ([]DraftPreviewRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, token_hash, content_type, content_slug, label, expires_at, revoked_at, created_by, created_at
		FROM draft_previews
		WHERE ($1 = '' OR content_type = $1) AND ($2 = '' OR content_slug = $2)
		ORDER BY created_at DESC
	`, contentType, contentSlug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DraftPreviewRecord
	for rows.Next() {
		var d DraftPreviewRecord
		if err := rows.Scan(&d.ID, &d.TokenHash, &d.ContentType, &d.ContentSlug, &d.Label, &d.ExpiresAt, &d.RevokedAt, &d.CreatedBy, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (p *PostgresStore) RevokeDraftPreview(ctx context.Context, id uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `UPDATE draft_previews SET revoked_at = now() WHERE id = $1`, id)
	return err
}

func (p *PostgresStore) CreateAsset(ctx context.Context, rec AssetRecord) error {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if len(rec.VariantsJSON) == 0 {
		rec.VariantsJSON = []byte("{}")
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO assets (id, storage_driver, storage_key, public_url, filename, mime_type, byte_size, width, height, thumbhash, exif_stripped, alt_text, variants_json, created_by, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULLIF($10, ''), $11, $12, $13, $14, now())
	`, rec.ID, rec.StorageDriver, rec.StorageKey, rec.PublicURL, rec.Filename, rec.MimeType, rec.ByteSize, rec.Width, rec.Height, rec.Thumbhash, rec.EXIFStripped, rec.AltText, rec.VariantsJSON, rec.CreatedBy)
	return err
}

func (p *PostgresStore) GetAssetByID(ctx context.Context, id uuid.UUID) (*AssetRecord, error) {
	var a AssetRecord
	var th *string
	err := p.pool.QueryRow(ctx, `
		SELECT id, storage_driver, storage_key, public_url, filename, mime_type, byte_size, width, height, thumbhash, exif_stripped, alt_text, variants_json, created_by, created_at
		FROM assets WHERE id = $1
	`, id).Scan(&a.ID, &a.StorageDriver, &a.StorageKey, &a.PublicURL, &a.Filename, &a.MimeType, &a.ByteSize, &a.Width, &a.Height, &th, &a.EXIFStripped, &a.AltText, &a.VariantsJSON, &a.CreatedBy, &a.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if th != nil {
		a.Thumbhash = *th
	}
	return &a, nil
}

func (p *PostgresStore) ListAssets(ctx context.Context) ([]AssetRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, storage_driver, storage_key, public_url, filename, mime_type, byte_size, width, height, coalesce(thumbhash, ''), exif_stripped, alt_text, variants_json, created_by, created_at
		FROM assets ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AssetRecord
	for rows.Next() {
		var a AssetRecord
		if err := rows.Scan(&a.ID, &a.StorageDriver, &a.StorageKey, &a.PublicURL, &a.Filename, &a.MimeType, &a.ByteSize, &a.Width, &a.Height, &a.Thumbhash, &a.EXIFStripped, &a.AltText, &a.VariantsJSON, &a.CreatedBy, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (p *PostgresStore) DeleteAsset(ctx context.Context, id uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM assets WHERE id = $1`, id)
	return err
}

func (p *PostgresStore) CreateBackup(ctx context.Context, rec BackupRecord) error {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO backups (id, filename, storage_driver, storage_key, byte_size, checksum, status, error_message, created_by, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
	`, rec.ID, rec.Filename, rec.StorageDriver, rec.StorageKey, rec.ByteSize, rec.Checksum, rec.Status, rec.ErrorMessage, rec.CreatedBy)
	return err
}

func (p *PostgresStore) GetBackupByID(ctx context.Context, id uuid.UUID) (*BackupRecord, error) {
	var b BackupRecord
	err := p.pool.QueryRow(ctx, `
		SELECT id, filename, storage_driver, storage_key, byte_size, checksum, status, error_message, created_by, created_at
		FROM backups WHERE id = $1
	`, id).Scan(&b.ID, &b.Filename, &b.StorageDriver, &b.StorageKey, &b.ByteSize, &b.Checksum, &b.Status, &b.ErrorMessage, &b.CreatedBy, &b.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func (p *PostgresStore) ListBackups(ctx context.Context) ([]BackupRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, filename, storage_driver, storage_key, byte_size, checksum, status, error_message, created_by, created_at
		FROM backups ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BackupRecord
	for rows.Next() {
		var b BackupRecord
		if err := rows.Scan(&b.ID, &b.Filename, &b.StorageDriver, &b.StorageKey, &b.ByteSize, &b.Checksum, &b.Status, &b.ErrorMessage, &b.CreatedBy, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (p *PostgresStore) DeleteBackup(ctx context.Context, id uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM backups WHERE id = $1`, id)
	return err
}

func (p *PostgresStore) CreateWebhook(ctx context.Context, rec WebhookRecord) error {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.Events == nil {
		rec.Events = []string{}
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO webhooks (id, name, target_url, secret_enc, events, enabled, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, now(), now())
	`, rec.ID, rec.Name, rec.TargetURL, rec.SecretEnc, rec.Events, rec.Enabled)
	return err
}

func (p *PostgresStore) UpdateWebhook(ctx context.Context, rec WebhookRecord) error {
	if rec.Events == nil {
		rec.Events = []string{}
	}
	tag, err := p.pool.Exec(ctx, `
		UPDATE webhooks
		SET name = $1,
		    target_url = $2,
		    secret_enc = CASE WHEN length($3::bytea) > 0 THEN $3 ELSE secret_enc END,
		    events = $4,
		    enabled = $5,
		    updated_at = now()
		WHERE id = $6
	`, rec.Name, rec.TargetURL, rec.SecretEnc, rec.Events, rec.Enabled, rec.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresStore) GetWebhook(ctx context.Context, id uuid.UUID) (*WebhookRecord, error) {
	var w WebhookRecord
	err := p.pool.QueryRow(ctx, `
		SELECT id, name, target_url, secret_enc, events, enabled, created_at, updated_at
		FROM webhooks WHERE id = $1
	`, id).Scan(&w.ID, &w.Name, &w.TargetURL, &w.SecretEnc, &w.Events, &w.Enabled, &w.CreatedAt, &w.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

func (p *PostgresStore) ListWebhooks(ctx context.Context) ([]WebhookRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, name, target_url, secret_enc, events, enabled, created_at, updated_at
		FROM webhooks ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WebhookRecord
	for rows.Next() {
		var w WebhookRecord
		if err := rows.Scan(&w.ID, &w.Name, &w.TargetURL, &w.SecretEnc, &w.Events, &w.Enabled, &w.CreatedAt, &w.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (p *PostgresStore) DeleteWebhook(ctx context.Context, id uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM webhooks WHERE id = $1`, id)
	return err
}

func (p *PostgresStore) RecordWebhookDelivery(ctx context.Context, rec WebhookDeliveryRecord) error {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if len(rec.PayloadJSON) == 0 {
		rec.PayloadJSON = []byte("{}")
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO webhook_deliveries (id, webhook_id, event_name, payload_json, attempt, status_code, response_body, error_message, delivered_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
	`, rec.ID, rec.WebhookID, rec.EventName, rec.PayloadJSON, rec.Attempt, rec.StatusCode, rec.ResponseBody, rec.ErrorMessage, rec.DeliveredAt)
	return err
}

func (p *PostgresStore) ListWebhookDeliveries(ctx context.Context, webhookID *uuid.UUID, limit int) ([]WebhookDeliveryRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := p.pool.Query(ctx, `
		SELECT id, webhook_id, event_name, payload_json, attempt, status_code, response_body, error_message, delivered_at, created_at
		FROM webhook_deliveries
		WHERE ($1::uuid IS NULL OR webhook_id = $1)
		ORDER BY created_at DESC LIMIT $2
	`, webhookID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WebhookDeliveryRecord
	for rows.Next() {
		var d WebhookDeliveryRecord
		if err := rows.Scan(&d.ID, &d.WebhookID, &d.EventName, &d.PayloadJSON, &d.Attempt, &d.StatusCode, &d.ResponseBody, &d.ErrorMessage, &d.DeliveredAt, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (p *PostgresStore) CreateComment(ctx context.Context, rec CommentRecord) error {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO comments (id, content_type, content_slug, parent_id, author_name, author_email_hash, author_url, is_admin, body_markdown, body_html, status, pinned, notify_reply, notify_email_enc, ip_hash, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), now())
	`, rec.ID, rec.ContentType, rec.ContentSlug, rec.ParentID, rec.AuthorName, rec.AuthorEmailHash, rec.AuthorURL, rec.IsAdmin, rec.BodyMarkdown, rec.BodyHTML, rec.Status, rec.Pinned, rec.NotifyReply, rec.NotifyEmailEnc, rec.IPHash)
	return err
}

func (p *PostgresStore) GetCommentByID(ctx context.Context, id uuid.UUID) (*CommentRecord, error) {
	var c CommentRecord
	err := p.pool.QueryRow(ctx, `
		SELECT id, content_type, content_slug, parent_id, author_name, author_email_hash, author_url, is_admin, body_markdown, body_html, status, pinned, notify_reply, notify_email_enc, ip_hash, created_at, updated_at
		FROM comments WHERE id = $1
	`, id).Scan(&c.ID, &c.ContentType, &c.ContentSlug, &c.ParentID, &c.AuthorName, &c.AuthorEmailHash, &c.AuthorURL, &c.IsAdmin, &c.BodyMarkdown, &c.BodyHTML, &c.Status, &c.Pinned, &c.NotifyReply, &c.NotifyEmailEnc, &c.IPHash, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (p *PostgresStore) ListComments(ctx context.Context, contentType, contentSlug, status string) ([]CommentRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, content_type, content_slug, parent_id, author_name, author_email_hash, author_url, is_admin, body_markdown, body_html, status, pinned, notify_reply, notify_email_enc, ip_hash, created_at, updated_at
		FROM comments
		WHERE ($1 = '' OR content_type = $1)
		  AND ($2 = '' OR content_slug = $2)
		  AND ($3 = '' OR status = $3)
		ORDER BY pinned DESC, created_at ASC
	`, contentType, contentSlug, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CommentRecord
	for rows.Next() {
		var c CommentRecord
		if err := rows.Scan(&c.ID, &c.ContentType, &c.ContentSlug, &c.ParentID, &c.AuthorName, &c.AuthorEmailHash, &c.AuthorURL, &c.IsAdmin, &c.BodyMarkdown, &c.BodyHTML, &c.Status, &c.Pinned, &c.NotifyReply, &c.NotifyEmailEnc, &c.IPHash, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (p *PostgresStore) UpdateCommentStatus(ctx context.Context, id uuid.UUID, status string, pinned *bool) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE comments
		SET status = CASE WHEN $1 <> '' THEN $1 ELSE status END,
		    pinned = COALESCE($2, pinned),
		    updated_at = now()
		WHERE id = $3
	`, status, pinned, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresStore) DeleteComment(ctx context.Context, id uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM comments WHERE id = $1`, id)
	return err
}

func (p *PostgresStore) ToggleReaction(ctx context.Context, contentType, contentSlug, emoji, voterHash string) (bool, error) {
	tag, err := p.pool.Exec(ctx, `
		DELETE FROM reactions WHERE content_type = $1 AND content_slug = $2 AND emoji = $3 AND voter_hash = $4
	`, contentType, contentSlug, emoji, voterHash)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() > 0 {
		return false, nil
	}
	_, err = p.pool.Exec(ctx, `
		INSERT INTO reactions (id, content_type, content_slug, emoji, voter_hash, created_at)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (content_type, content_slug, emoji, voter_hash) DO NOTHING
	`, uuid.New(), contentType, contentSlug, emoji, voterHash)
	return true, err
}

func (p *PostgresStore) GetReactionCounts(ctx context.Context, contentType, contentSlug, voterHash string, allowedEmojis []string) ([]ReactionSummary, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT emoji, COUNT(*)::int AS cnt, BOOL_OR(voter_hash = $3) AS reacted
		FROM reactions
		WHERE content_type = $1 AND content_slug = $2
		GROUP BY emoji
	`, contentType, contentSlug, voterHash)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byEmoji := make(map[string]ReactionSummary, len(allowedEmojis))
	for rows.Next() {
		var emoji string
		var cnt int
		var reacted bool
		if err := rows.Scan(&emoji, &cnt, &reacted); err != nil {
			return nil, err
		}
		byEmoji[emoji] = ReactionSummary{Emoji: emoji, Count: cnt, Reacted: reacted}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]ReactionSummary, 0, len(allowedEmojis))
	for _, e := range allowedEmojis {
		if s, ok := byEmoji[e]; ok {
			out = append(out, s)
		} else {
			out = append(out, ReactionSummary{Emoji: e, Count: 0, Reacted: false})
		}
	}
	return out, nil
}

func (p *PostgresStore) UpsertSubscriber(ctx context.Context, rec SubscriberRecord) (SubscriberRecord, error) {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	rec.Email = strings.ToLower(strings.TrimSpace(rec.Email))
	var out SubscriberRecord
	var ct *string
	err := p.pool.QueryRow(ctx, `
		INSERT INTO subscribers (id, email, status, confirm_token, unsubscribe_token, confirmed_at, unsubscribed_at, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, now())
		ON CONFLICT (email) DO UPDATE SET
			status = EXCLUDED.status,
			confirm_token = EXCLUDED.confirm_token,
			unsubscribe_token = EXCLUDED.unsubscribe_token,
			confirmed_at = EXCLUDED.confirmed_at,
			unsubscribed_at = EXCLUDED.unsubscribed_at
		RETURNING id, email, status, confirm_token, unsubscribe_token, confirmed_at, unsubscribed_at, created_at
	`, rec.ID, rec.Email, rec.Status, rec.ConfirmToken, rec.UnsubscribeToken, rec.ConfirmedAt, rec.UnsubscribedAt).
		Scan(&out.ID, &out.Email, &out.Status, &ct, &out.UnsubscribeToken, &out.ConfirmedAt, &out.UnsubscribedAt, &out.CreatedAt)
	if ct != nil {
		out.ConfirmToken = *ct
	}
	return out, err
}

func (p *PostgresStore) GetSubscriberByEmail(ctx context.Context, email string) (*SubscriberRecord, error) {
	return p.getSubscriberWhere(ctx, `WHERE lower(email) = lower($1)`, strings.TrimSpace(email))
}

func (p *PostgresStore) GetSubscriberByConfirmToken(ctx context.Context, token string) (*SubscriberRecord, error) {
	return p.getSubscriberWhere(ctx, `WHERE confirm_token = $1`, token)
}

func (p *PostgresStore) GetSubscriberByUnsubscribeToken(ctx context.Context, token string) (*SubscriberRecord, error) {
	return p.getSubscriberWhere(ctx, `WHERE unsubscribe_token = $1`, token)
}

func (p *PostgresStore) getSubscriberWhere(ctx context.Context, where string, arg any) (*SubscriberRecord, error) {
	var s SubscriberRecord
	var ct *string
	err := p.pool.QueryRow(ctx, `
		SELECT id, email, status, confirm_token, unsubscribe_token, confirmed_at, unsubscribed_at, created_at
		FROM subscribers `+where, arg).
		Scan(&s.ID, &s.Email, &s.Status, &ct, &s.UnsubscribeToken, &s.ConfirmedAt, &s.UnsubscribedAt, &s.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if ct != nil {
		s.ConfirmToken = *ct
	}
	return &s, nil
}

func (p *PostgresStore) UpdateSubscriberStatus(ctx context.Context, id uuid.UUID, status string, ts time.Time) error {
	u := ts.UTC()
	var err error
	if status == "active" {
		_, err = p.pool.Exec(ctx, `UPDATE subscribers SET status = 'active', confirm_token = NULL, confirmed_at = $1, unsubscribed_at = NULL WHERE id = $2`, u, id)
	} else {
		_, err = p.pool.Exec(ctx, `UPDATE subscribers SET status = $1, unsubscribed_at = $2 WHERE id = $3`, status, u, id)
	}
	return err
}

func (p *PostgresStore) ListSubscribers(ctx context.Context, status string) ([]SubscriberRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, email, status, coalesce(confirm_token, ''), unsubscribe_token, confirmed_at, unsubscribed_at, created_at
		FROM subscribers WHERE ($1 = '' OR status = $1) ORDER BY created_at DESC
	`, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SubscriberRecord
	for rows.Next() {
		var s SubscriberRecord
		if err := rows.Scan(&s.ID, &s.Email, &s.Status, &s.ConfirmToken, &s.UnsubscribeToken, &s.ConfirmedAt, &s.UnsubscribedAt, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *PostgresStore) DeleteSubscriber(ctx context.Context, id uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM subscribers WHERE id = $1`, id)
	return err
}

func (p *PostgresStore) CreateNewsletter(ctx context.Context, rec NewsletterRecord) error {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO newsletters (id, subject, body_markdown, body_html, content_type, content_slug, status, sent_count, failed_count, sent_at, created_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, $8, $9, $10, now())
	`, rec.ID, rec.Subject, rec.BodyMarkdown, rec.BodyHTML, rec.ContentType, rec.ContentSlug, rec.Status, rec.SentCount, rec.FailedCount, rec.SentAt)
	return err
}

func (p *PostgresStore) UpdateNewsletterCounts(ctx context.Context, id uuid.UUID, status string, sentCount, failedCount int, sentAt *time.Time) error {
	_, err := p.pool.Exec(ctx, `
		UPDATE newsletters SET status = $1, sent_count = $2, failed_count = $3, sent_at = $4 WHERE id = $5
	`, status, sentCount, failedCount, sentAt, id)
	return err
}

func (p *PostgresStore) ListNewsletters(ctx context.Context) ([]NewsletterRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, subject, body_markdown, body_html, coalesce(content_type, ''), coalesce(content_slug, ''), status, sent_count, failed_count, sent_at, created_at
		FROM newsletters ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NewsletterRecord
	for rows.Next() {
		var n NewsletterRecord
		if err := rows.Scan(&n.ID, &n.Subject, &n.BodyMarkdown, &n.BodyHTML, &n.ContentType, &n.ContentSlug, &n.Status, &n.SentCount, &n.FailedCount, &n.SentAt, &n.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (p *PostgresStore) CreateFriendLink(ctx context.Context, rec FriendLinkRecord) error {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.GroupName == "" {
		rec.GroupName = "Friends"
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO friend_links (id, name, url, feed_url, avatar_url, description, group_name, status, sort_order, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
	`, rec.ID, rec.Name, rec.URL, rec.FeedURL, rec.AvatarURL, rec.Description, rec.GroupName, rec.Status, rec.SortOrder)
	if err != nil && strings.Contains(err.Error(), "duplicate key") {
		return ErrConflict
	}
	return err
}

func (p *PostgresStore) GetFriendLink(ctx context.Context, id uuid.UUID) (*FriendLinkRecord, error) {
	var f FriendLinkRecord
	err := p.pool.QueryRow(ctx, `
		SELECT id, name, url, feed_url, avatar_url, description, group_name, status, sort_order, etag, last_modified, last_checked_at, created_at
		FROM friend_links WHERE id = $1
	`, id).Scan(&f.ID, &f.Name, &f.URL, &f.FeedURL, &f.AvatarURL, &f.Description, &f.GroupName, &f.Status, &f.SortOrder, &f.ETag, &f.LastModified, &f.LastCheckedAt, &f.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (p *PostgresStore) GetFriendLinkByURL(ctx context.Context, linkURL string) (*FriendLinkRecord, error) {
	var f FriendLinkRecord
	err := p.pool.QueryRow(ctx, `
		SELECT id, name, url, feed_url, avatar_url, description, group_name, status, sort_order, etag, last_modified, last_checked_at, created_at
		FROM friend_links WHERE url = $1
	`, linkURL).Scan(&f.ID, &f.Name, &f.URL, &f.FeedURL, &f.AvatarURL, &f.Description, &f.GroupName, &f.Status, &f.SortOrder, &f.ETag, &f.LastModified, &f.LastCheckedAt, &f.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (p *PostgresStore) UpdateFriendLink(ctx context.Context, rec FriendLinkRecord) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE friend_links
		SET name = $1, url = $2, feed_url = $3, avatar_url = $4, description = $5, group_name = $6, status = $7, sort_order = $8
		WHERE id = $9
	`, rec.Name, rec.URL, rec.FeedURL, rec.AvatarURL, rec.Description, rec.GroupName, rec.Status, rec.SortOrder, rec.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresStore) UpdateFriendFeedCheck(ctx context.Context, id uuid.UUID, status, etag, lastModified string, checkedAt time.Time) error {
	_, err := p.pool.Exec(ctx, `
		UPDATE friend_links
		SET status = CASE WHEN $1 <> '' THEN $1 ELSE status END,
		    etag = $2,
		    last_modified = $3,
		    last_checked_at = $4
		WHERE id = $5
	`, status, etag, lastModified, checkedAt.UTC(), id)
	return err
}

func (p *PostgresStore) ListFriendLinks(ctx context.Context, status string) ([]FriendLinkRecord, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, name, url, feed_url, avatar_url, description, group_name, status, sort_order, etag, last_modified, last_checked_at, created_at
		FROM friend_links WHERE ($1 = '' OR status = $1)
		ORDER BY sort_order ASC, created_at DESC
	`, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FriendLinkRecord
	for rows.Next() {
		var f FriendLinkRecord
		if err := rows.Scan(&f.ID, &f.Name, &f.URL, &f.FeedURL, &f.AvatarURL, &f.Description, &f.GroupName, &f.Status, &f.SortOrder, &f.ETag, &f.LastModified, &f.LastCheckedAt, &f.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (p *PostgresStore) DeleteFriendLink(ctx context.Context, id uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM friend_links WHERE id = $1`, id)
	return err
}

func (p *PostgresStore) UpsertFriendFeedItems(ctx context.Context, items []FriendFeedRecord) error {
	for _, item := range items {
		if item.ID == uuid.Nil {
			item.ID = uuid.New()
		}
		if _, err := p.pool.Exec(ctx, `
			INSERT INTO friend_feeds (id, friend_id, item_guid, title, link, summary, published_at, fetched_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, now())
			ON CONFLICT (friend_id, item_guid) DO UPDATE SET
				title = EXCLUDED.title,
				link = EXCLUDED.link,
				summary = EXCLUDED.summary,
				published_at = EXCLUDED.published_at,
				fetched_at = now()
		`, item.ID, item.FriendID, item.ItemGUID, item.Title, item.Link, item.Summary, item.PublishedAt.UTC()); err != nil {
			return err
		}
	}
	return nil
}

func (p *PostgresStore) ListFriendFeedItems(ctx context.Context, limit int) ([]FriendFeedRecord, error) {
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	rows, err := p.pool.Query(ctx, `
		SELECT ff.id, ff.friend_id, fl.name, fl.url, fl.avatar_url, ff.item_guid, ff.title, ff.link, ff.summary, ff.published_at, ff.fetched_at
		FROM friend_feeds ff
		JOIN friend_links fl ON fl.id = ff.friend_id
		WHERE fl.status IN ('active', 'unreachable')
		ORDER BY ff.published_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FriendFeedRecord
	for rows.Next() {
		var item FriendFeedRecord
		if err := rows.Scan(&item.ID, &item.FriendID, &item.FriendName, &item.FriendURL, &item.FriendAvatar, &item.ItemGUID, &item.Title, &item.Link, &item.Summary, &item.PublishedAt, &item.FetchedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (p *PostgresStore) GetAllSettings(ctx context.Context) (map[string]json.RawMessage, error) {
	rows, err := p.pool.Query(ctx, `SELECT key, value_json FROM site_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]json.RawMessage)
	for rows.Next() {
		var k string
		var v json.RawMessage
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

func (p *PostgresStore) SetSetting(ctx context.Context, key string, value json.RawMessage) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO site_settings (key, value_json, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now()
	`, key, value)
	return err
}

func (p *PostgresStore) ListRedirects(ctx context.Context) ([]RedirectRecord, error) {
	rows, err := p.pool.Query(ctx, `SELECT id, source_path, target_path, status_code, hits, created_at FROM redirects ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RedirectRecord
	for rows.Next() {
		var r RedirectRecord
		if err := rows.Scan(&r.ID, &r.SourcePath, &r.TargetPath, &r.StatusCode, &r.Hits, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *PostgresStore) FindRedirect(ctx context.Context, sourcePath string) (*RedirectRecord, error) {
	var r RedirectRecord
	err := p.pool.QueryRow(ctx, `SELECT id, source_path, target_path, status_code, hits, created_at FROM redirects WHERE source_path = $1`, sourcePath).
		Scan(&r.ID, &r.SourcePath, &r.TargetPath, &r.StatusCode, &r.Hits, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (p *PostgresStore) IncrementRedirectHit(ctx context.Context, id uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `UPDATE redirects SET hits = hits + 1 WHERE id = $1`, id)
	return err
}

func (p *PostgresStore) CreateRedirect(ctx context.Context, rec RedirectRecord) error {
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.StatusCode == 0 {
		rec.StatusCode = 301
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO redirects (id, source_path, target_path, status_code, hits, created_at)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (source_path) DO UPDATE SET target_path = EXCLUDED.target_path, status_code = EXCLUDED.status_code
	`, rec.ID, rec.SourcePath, rec.TargetPath, rec.StatusCode, rec.Hits)
	return err
}

func (p *PostgresStore) DeleteRedirect(ctx context.Context, id uuid.UUID) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM redirects WHERE id = $1`, id)
	return err
}

func (p *PostgresStore) InsertAnalyticsEvent(ctx context.Context, ev AnalyticsEventInput) error {
	occ := ev.OccurredAt.UTC()
	if occ.IsZero() {
		occ = time.Now().UTC()
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO analytics_events (id, path, content_type, content_slug, visitor_hash, referrer_host, device_kind, dwell_ms, scroll_pct, occurred_at)
		VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, $7, $8, $9, $10)
	`, uuid.New(), ev.Path, ev.ContentType, ev.ContentSlug, ev.VisitorHash, ev.ReferrerHost, ev.DeviceKind, ev.DwellMs, ev.ScrollPct, occ)
	return err
}

func (p *PostgresStore) RollupAnalyticsDaily(ctx context.Context, day time.Time) error {
	d := day.UTC().Format("2006-01-02")
	_, err := p.pool.Exec(ctx, `
		INSERT INTO analytics_daily (day, path, views, unique_visitors, avg_dwell_ms, avg_scroll_pct)
		SELECT
			$1::date AS day,
			path,
			COUNT(*) FILTER (WHERE dwell_ms = 0 AND scroll_pct = 0)::int AS views,
			COUNT(DISTINCT visitor_hash)::int AS unique_visitors,
			COALESCE(AVG(dwell_ms) FILTER (WHERE dwell_ms > 0), 0)::int AS avg_dwell_ms,
			COALESCE(AVG(scroll_pct) FILTER (WHERE scroll_pct > 0), 0)::int AS avg_scroll_pct
		FROM analytics_events
		WHERE occurred_at >= $1::date AND occurred_at < ($1::date + interval '1 day')
		GROUP BY path
		ON CONFLICT (day, path) DO UPDATE SET
			views = EXCLUDED.views,
			unique_visitors = EXCLUDED.unique_visitors,
			avg_dwell_ms = EXCLUDED.avg_dwell_ms,
			avg_scroll_pct = EXCLUDED.avg_scroll_pct
	`, d)
	return err
}

func (p *PostgresStore) GetAnalyticsOverview(ctx context.Context, days int) (AnalyticsOverview, error) {
	if days <= 0 || days > 90 {
		days = 30
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -days)
	var out AnalyticsOverview
	if err := p.pool.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE dwell_ms = 0 AND scroll_pct = 0)::int,
			COUNT(DISTINCT visitor_hash)::int,
			COALESCE(AVG(dwell_ms) FILTER (WHERE dwell_ms > 0), 0)::int,
			COALESCE(AVG(scroll_pct) FILTER (WHERE scroll_pct > 0), 0)::int
		FROM analytics_events
		WHERE occurred_at >= $1
	`, cutoff).Scan(&out.TotalViews, &out.UniqueVisitors, &out.AvgDwellMs, &out.AvgScrollPct); err != nil {
		return out, err
	}

	sRows, err := p.pool.Query(ctx, `
		SELECT
			to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
			COUNT(*) FILTER (WHERE dwell_ms = 0 AND scroll_pct = 0)::int,
			COUNT(DISTINCT visitor_hash)::int,
			COALESCE(AVG(dwell_ms) FILTER (WHERE dwell_ms > 0), 0)::int,
			COALESCE(AVG(scroll_pct) FILTER (WHERE scroll_pct > 0), 0)::int
		FROM analytics_events
		WHERE occurred_at >= $1
		GROUP BY 1 ORDER BY 1 ASC
	`, cutoff)
	if err != nil {
		return out, err
	}
	for sRows.Next() {
		var pt AnalyticsDayPoint
		if err := sRows.Scan(&pt.Day, &pt.Views, &pt.UniqueVisitors, &pt.AvgDwellMs, &pt.AvgScrollPct); err != nil {
			sRows.Close()
			return out, err
		}
		out.Series = append(out.Series, pt)
	}
	sRows.Close()

	pRows, err := p.pool.Query(ctx, `
		SELECT path, COUNT(*)::int AS views
		FROM analytics_events
		WHERE occurred_at >= $1 AND dwell_ms = 0 AND scroll_pct = 0
		GROUP BY path ORDER BY views DESC LIMIT 10
	`, cutoff)
	if err != nil {
		return out, err
	}
	for pRows.Next() {
		var item AnalyticsTopItem
		if err := pRows.Scan(&item.Path, &item.Views); err != nil {
			pRows.Close()
			return out, err
		}
		out.TopPaths = append(out.TopPaths, item)
	}
	pRows.Close()

	rRows, err := p.pool.Query(ctx, `
		SELECT referrer_host, COUNT(*)::int AS views
		FROM analytics_events
		WHERE occurred_at >= $1 AND dwell_ms = 0 AND scroll_pct = 0 AND referrer_host <> ''
		GROUP BY referrer_host ORDER BY views DESC LIMIT 10
	`, cutoff)
	if err != nil {
		return out, err
	}
	for rRows.Next() {
		var item AnalyticsReferrerItem
		if err := rRows.Scan(&item.Referrer, &item.Views); err != nil {
			rRows.Close()
			return out, err
		}
		out.TopReferrers = append(out.TopReferrers, item)
	}
	rRows.Close()

	return out, nil
}

func (p *PostgresStore) ExportSnapshot(ctx context.Context) (*StateSnapshot, error) {
	settings, err := p.GetAllSettings(ctx)
	if err != nil {
		return nil, err
	}
	redirects, err := p.ListRedirects(ctx)
	if err != nil {
		return nil, err
	}
	comments, err := p.ListComments(ctx, "", "", "")
	if err != nil {
		return nil, err
	}
	friends, err := p.ListFriendLinks(ctx, "")
	if err != nil {
		return nil, err
	}
	subs, err := p.ListSubscribers(ctx, "")
	if err != nil {
		return nil, err
	}
	newsletters, err := p.ListNewsletters(ctx)
	if err != nil {
		return nil, err
	}
	assets, err := p.ListAssets(ctx)
	if err != nil {
		return nil, err
	}
	previews, err := p.ListDraftPreviews(ctx, "", "")
	if err != nil {
		return nil, err
	}
	return &StateSnapshot{
		Version:       "2.0",
		ExportedAt:    time.Now().UTC(),
		Settings:      settings,
		Redirects:     redirects,
		Comments:      comments,
		FriendLinks:   friends,
		Subscribers:   subs,
		Newsletters:   newsletters,
		Assets:        assets,
		DraftPreviews: previews,
	}, nil
}

func (p *PostgresStore) ImportSnapshot(ctx context.Context, snap *StateSnapshot) error {
	if snap == nil {
		return nil
	}
	for k, v := range snap.Settings {
		if err := p.SetSetting(ctx, k, v); err != nil {
			return err
		}
	}
	for _, r := range snap.Redirects {
		if err := p.CreateRedirect(ctx, r); err != nil {
			return err
		}
	}
	for _, f := range snap.FriendLinks {
		if _, err := p.pool.Exec(ctx, `
			INSERT INTO friend_links (id, name, url, feed_url, avatar_url, description, group_name, status, sort_order, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (url) DO UPDATE SET
				name = EXCLUDED.name, feed_url = EXCLUDED.feed_url, avatar_url = EXCLUDED.avatar_url,
				description = EXCLUDED.description, group_name = EXCLUDED.group_name,
				status = EXCLUDED.status, sort_order = EXCLUDED.sort_order
		`, f.ID, f.Name, f.URL, f.FeedURL, f.AvatarURL, f.Description, f.GroupName, f.Status, f.SortOrder, f.CreatedAt); err != nil {
			return err
		}
	}
	for _, c := range snap.Comments {
		if _, err := p.pool.Exec(ctx, `
			INSERT INTO comments (id, content_type, content_slug, parent_id, author_name, author_email_hash, author_url, is_admin, body_markdown, body_html, status, pinned, notify_reply, notify_email_enc, ip_hash, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
			ON CONFLICT (id) DO NOTHING
		`, c.ID, c.ContentType, c.ContentSlug, c.ParentID, c.AuthorName, c.AuthorEmailHash, c.AuthorURL, c.IsAdmin, c.BodyMarkdown, c.BodyHTML, c.Status, c.Pinned, c.NotifyReply, c.NotifyEmailEnc, c.IPHash, c.CreatedAt, c.UpdatedAt); err != nil {
			return err
		}
	}
	for _, s := range snap.Subscribers {
		if _, err := p.UpsertSubscriber(ctx, s); err != nil {
			return err
		}
	}
	for _, n := range snap.Newsletters {
		if _, err := p.pool.Exec(ctx, `
			INSERT INTO newsletters (id, subject, body_markdown, body_html, content_type, content_slug, status, sent_count, failed_count, sent_at, created_at)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, $8, $9, $10, $11)
			ON CONFLICT (id) DO NOTHING
		`, n.ID, n.Subject, n.BodyMarkdown, n.BodyHTML, n.ContentType, n.ContentSlug, n.Status, n.SentCount, n.FailedCount, n.SentAt, n.CreatedAt); err != nil {
			return err
		}
	}
	for _, a := range snap.Assets {
		if len(a.VariantsJSON) == 0 {
			a.VariantsJSON = []byte("{}")
		}
		if _, err := p.pool.Exec(ctx, `
			INSERT INTO assets (id, storage_driver, storage_key, public_url, filename, mime_type, byte_size, width, height, thumbhash, exif_stripped, alt_text, variants_json, created_by, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULLIF($10, ''), $11, $12, $13, $14, $15)
			ON CONFLICT (storage_key) DO NOTHING
		`, a.ID, a.StorageDriver, a.StorageKey, a.PublicURL, a.Filename, a.MimeType, a.ByteSize, a.Width, a.Height, a.Thumbhash, a.EXIFStripped, a.AltText, a.VariantsJSON, a.CreatedBy, a.CreatedAt); err != nil {
			return err
		}
	}
	return nil
}
