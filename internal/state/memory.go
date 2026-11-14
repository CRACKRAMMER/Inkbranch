package state

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type MemoryStore struct {
	mu sync.RWMutex

	users      map[uuid.UUID]User
	usersEmail map[string]uuid.UUID
	sessions   map[uuid.UUID]Session
	sessToken  map[string]uuid.UUID
	totp       map[uuid.UUID]TOTPRecord
	passkeys   map[uuid.UUID]PasskeyRecord
	apiTokens  map[uuid.UUID]APITokenRecord
	auditLogs  []AuditLogRecord

	revisions  map[uuid.UUID]RevisionRecord
	previews   map[uuid.UUID]DraftPreviewRecord
	assets     map[uuid.UUID]AssetRecord
	backups    map[uuid.UUID]BackupRecord
	webhooks   map[uuid.UUID]WebhookRecord
	deliveries []WebhookDeliveryRecord

	comments    map[uuid.UUID]CommentRecord
	reactions   map[string]map[string]bool // "<type>:<slug>:<emoji>" -> set of voterHash
	subscribers map[uuid.UUID]SubscriberRecord
	newsletters map[uuid.UUID]NewsletterRecord
	friendLinks map[uuid.UUID]FriendLinkRecord
	friendFeeds map[string]FriendFeedRecord // "<friendID>:<guid>"

	settings        map[string]json.RawMessage
	redirects       map[uuid.UUID]RedirectRecord
	analyticsEvents []AnalyticsEventInput
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		users:       make(map[uuid.UUID]User),
		usersEmail:  make(map[string]uuid.UUID),
		sessions:    make(map[uuid.UUID]Session),
		sessToken:   make(map[string]uuid.UUID),
		totp:        make(map[uuid.UUID]TOTPRecord),
		passkeys:    make(map[uuid.UUID]PasskeyRecord),
		apiTokens:   make(map[uuid.UUID]APITokenRecord),
		revisions:   make(map[uuid.UUID]RevisionRecord),
		previews:    make(map[uuid.UUID]DraftPreviewRecord),
		assets:      make(map[uuid.UUID]AssetRecord),
		backups:     make(map[uuid.UUID]BackupRecord),
		webhooks:    make(map[uuid.UUID]WebhookRecord),
		comments:    make(map[uuid.UUID]CommentRecord),
		reactions:   make(map[string]map[string]bool),
		subscribers: make(map[uuid.UUID]SubscriberRecord),
		newsletters: make(map[uuid.UUID]NewsletterRecord),
		friendLinks: make(map[uuid.UUID]FriendLinkRecord),
		friendFeeds: make(map[string]FriendFeedRecord),
		settings:    make(map[string]json.RawMessage),
		redirects:   make(map[uuid.UUID]RedirectRecord),
	}
}

func (m *MemoryStore) CountUsers(context.Context) (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.users), nil
}

func (m *MemoryStore) CreateUser(_ context.Context, u User) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	emailKey := strings.ToLower(strings.TrimSpace(u.Email))
	if _, exists := m.usersEmail[emailKey]; exists {
		return User{}, ErrConflict
	}
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
	u.Email = emailKey
	if u.Role == "" {
		u.Role = "admin"
	}
	m.users[u.ID] = u
	m.usersEmail[emailKey] = u.ID
	return u, nil
}

func (m *MemoryStore) GetUserByID(_ context.Context, id uuid.UUID) (*User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	u, ok := m.users[id]
	if !ok {
		return nil, nil
	}
	cp := u
	return &cp, nil
}

func (m *MemoryStore) GetUserByEmail(_ context.Context, email string) (*User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	id, ok := m.usersEmail[strings.ToLower(strings.TrimSpace(email))]
	if !ok {
		return nil, nil
	}
	u := m.users[id]
	return &u, nil
}

func (m *MemoryStore) UpdateUserPassword(_ context.Context, userID uuid.UUID, passwordHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[userID]
	if !ok {
		return ErrNotFound
	}
	u.PasswordHash = passwordHash
	u.UpdatedAt = time.Now().UTC()
	m.users[userID] = u
	return nil
}

func (m *MemoryStore) UpdateUserProfile(_ context.Context, userID uuid.UUID, name, bio, avatarURL string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[userID]
	if !ok {
		return ErrNotFound
	}
	u.Name = name
	u.Bio = bio
	u.AvatarURL = avatarURL
	u.UpdatedAt = time.Now().UTC()
	m.users[userID] = u
	return nil
}

func (m *MemoryStore) CreateSession(_ context.Context, s Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
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
	m.sessions[s.ID] = s
	m.sessToken[s.TokenHash] = s.ID
	return nil
}

func (m *MemoryStore) GetSessionByTokenHash(_ context.Context, tokenHash string) (*Session, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	id, ok := m.sessToken[tokenHash]
	if !ok {
		return nil, nil
	}
	s, ok := m.sessions[id]
	if !ok {
		return nil, nil
	}
	cp := s
	return &cp, nil
}

func (m *MemoryStore) TouchSession(_ context.Context, sessionID uuid.UUID, seenAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return nil
	}
	s.LastSeenAt = seenAt.UTC()
	m.sessions[sessionID] = s
	return nil
}

func (m *MemoryStore) DeleteSession(_ context.Context, sessionID uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[sessionID]; ok {
		delete(m.sessToken, s.TokenHash)
		delete(m.sessions, sessionID)
	}
	return nil
}

func (m *MemoryStore) DeleteSessionsByUser(_ context.Context, userID uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.sessions {
		if s.UserID == userID {
			delete(m.sessToken, s.TokenHash)
			delete(m.sessions, id)
		}
	}
	return nil
}

func (m *MemoryStore) ListSessionsByUser(_ context.Context, userID uuid.UUID) ([]Session, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	now := time.Now().UTC()
	var out []Session
	for _, s := range m.sessions {
		if s.UserID == userID && s.ExpiresAt.After(now) {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeenAt.After(out[j].LastSeenAt) })
	return out, nil
}

func (m *MemoryStore) GetTOTP(_ context.Context, userID uuid.UUID) (*TOTPRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	t, ok := m.totp[userID]
	if !ok {
		return nil, nil
	}
	cp := t
	cp.EncryptedSecret = append([]byte(nil), t.EncryptedSecret...)
	cp.RecoveryCodeHashes = append([]string(nil), t.RecoveryCodeHashes...)
	return &cp, nil
}

func (m *MemoryStore) UpsertTOTP(_ context.Context, rec TOTPRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	cp := rec
	cp.EncryptedSecret = append([]byte(nil), rec.EncryptedSecret...)
	cp.RecoveryCodeHashes = append([]string(nil), rec.RecoveryCodeHashes...)
	m.totp[rec.UserID] = cp
	return nil
}

func (m *MemoryStore) DeleteTOTP(_ context.Context, userID uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.totp, userID)
	return nil
}

func (m *MemoryStore) ListPasskeys(_ context.Context, userID uuid.UUID) ([]PasskeyRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []PasskeyRecord
	for _, p := range m.passkeys {
		if p.UserID == userID {
			out = append(out, clonePasskey(p))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *MemoryStore) GetPasskeyByCredentialID(_ context.Context, credID []byte) (*PasskeyRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, p := range m.passkeys {
		if string(p.CredentialID) == string(credID) {
			cp := clonePasskey(p)
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *MemoryStore) CreatePasskey(_ context.Context, p PasskeyRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	if p.CreatedAt.IsZero() {
		p.CreatedAt = time.Now().UTC()
	}
	m.passkeys[p.ID] = clonePasskey(p)
	return nil
}

func (m *MemoryStore) UpdatePasskeyUsage(_ context.Context, passkeyID uuid.UUID, signCount uint32, credentialJSON []byte, usedAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.passkeys[passkeyID]
	if !ok {
		return ErrNotFound
	}
	p.SignCount = signCount
	if len(credentialJSON) > 0 {
		p.CredentialJSON = append([]byte(nil), credentialJSON...)
	}
	u := usedAt.UTC()
	p.LastUsedAt = &u
	m.passkeys[passkeyID] = p
	return nil
}

func (m *MemoryStore) DeletePasskey(_ context.Context, userID, passkeyID uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.passkeys[passkeyID]; ok && p.UserID == userID {
		delete(m.passkeys, passkeyID)
	}
	return nil
}

func clonePasskey(p PasskeyRecord) PasskeyRecord {
	cp := p
	cp.CredentialID = append([]byte(nil), p.CredentialID...)
	cp.PublicKey = append([]byte(nil), p.PublicKey...)
	cp.AAGUID = append([]byte(nil), p.AAGUID...)
	cp.Transports = append([]string(nil), p.Transports...)
	cp.CredentialJSON = append([]byte(nil), p.CredentialJSON...)
	return cp
}

func (m *MemoryStore) CreateAPIToken(_ context.Context, t APITokenRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	if t.CreatedAt.IsZero() {
		t.CreatedAt = time.Now().UTC()
	}
	cp := t
	cp.Scopes = append([]string(nil), t.Scopes...)
	m.apiTokens[cp.ID] = cp
	return nil
}

func (m *MemoryStore) GetAPITokenByHash(_ context.Context, tokenHash string) (*APITokenRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, t := range m.apiTokens {
		if t.TokenHash == tokenHash {
			cp := t
			cp.Scopes = append([]string(nil), t.Scopes...)
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *MemoryStore) TouchAPIToken(_ context.Context, tokenID uuid.UUID, usedAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t, ok := m.apiTokens[tokenID]; ok {
		u := usedAt.UTC()
		t.LastUsedAt = &u
		m.apiTokens[tokenID] = t
	}
	return nil
}

func (m *MemoryStore) ListAPITokens(_ context.Context, userID uuid.UUID) ([]APITokenRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []APITokenRecord
	for _, t := range m.apiTokens {
		if t.UserID == userID {
			cp := t
			cp.Scopes = append([]string(nil), t.Scopes...)
			out = append(out, cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *MemoryStore) RevokeAPIToken(_ context.Context, userID, tokenID uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t, ok := m.apiTokens[tokenID]; ok && t.UserID == userID {
		now := time.Now().UTC()
		t.RevokedAt = &now
		m.apiTokens[tokenID] = t
	}
	return nil
}

func (m *MemoryStore) AppendAuditLog(_ context.Context, rec AuditLogRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	m.auditLogs = append(m.auditLogs, rec)
	if len(m.auditLogs) > 2000 {
		m.auditLogs = m.auditLogs[len(m.auditLogs)-2000:]
	}
	return nil
}

func (m *MemoryStore) ListAuditLogs(_ context.Context, limit int) ([]AuditLogRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	out := make([]AuditLogRecord, 0, minInt(limit, len(m.auditLogs)))
	for i := len(m.auditLogs) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, m.auditLogs[i])
	}
	return out, nil
}

func (m *MemoryStore) CreateRevision(_ context.Context, rec RevisionRecord) (RevisionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	maxRev := 0
	for _, r := range m.revisions {
		if r.ContentType == rec.ContentType && r.ContentSlug == rec.ContentSlug && r.RevisionNum > maxRev {
			maxRev = r.RevisionNum
		}
	}
	if rec.RevisionNum <= 0 {
		rec.RevisionNum = maxRev + 1
	}
	rec.ContentID = ContentUUID(rec.Path)
	rec.CompressedBody = append([]byte(nil), rec.CompressedBody...)
	m.revisions[rec.ID] = rec
	return rec, nil
}

func (m *MemoryStore) ListRevisions(_ context.Context, contentType, contentSlug string) ([]RevisionRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []RevisionRecord
	for _, r := range m.revisions {
		if r.ContentType == contentType && r.ContentSlug == contentSlug {
			cp := r
			cp.CompressedBody = nil
			out = append(out, cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RevisionNum > out[j].RevisionNum })
	return out, nil
}

func (m *MemoryStore) GetRevision(_ context.Context, id uuid.UUID) (*RevisionRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.revisions[id]
	if !ok {
		return nil, nil
	}
	cp := r
	cp.CompressedBody = append([]byte(nil), r.CompressedBody...)
	return &cp, nil
}

func (m *MemoryStore) MigrateContentPath(_ context.Context, oldPath, newPath string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	newSlug := strings.TrimSuffix(newPath[strings.LastIndex(newPath, "/")+1:], ".md")
	newCID := ContentUUID(newPath)
	for id, r := range m.revisions {
		if r.Path == oldPath {
			r.Path = newPath
			r.ContentSlug = newSlug
			r.ContentID = newCID
			m.revisions[id] = r
		}
	}
	return nil
}

func (m *MemoryStore) CreateDraftPreview(_ context.Context, rec DraftPreviewRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	m.previews[rec.ID] = rec
	return nil
}

func (m *MemoryStore) GetDraftPreviewByTokenHash(_ context.Context, tokenHash string) (*DraftPreviewRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, p := range m.previews {
		if p.TokenHash == tokenHash {
			cp := p
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *MemoryStore) ListDraftPreviews(_ context.Context, contentType, contentSlug string) ([]DraftPreviewRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []DraftPreviewRecord
	for _, p := range m.previews {
		if (contentType == "" || p.ContentType == contentType) && (contentSlug == "" || p.ContentSlug == contentSlug) {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *MemoryStore) RevokeDraftPreview(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.previews[id]; ok {
		now := time.Now().UTC()
		p.RevokedAt = &now
		m.previews[id] = p
	}
	return nil
}

func (m *MemoryStore) CreateAsset(_ context.Context, rec AssetRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	m.assets[rec.ID] = rec
	return nil
}

func (m *MemoryStore) GetAssetByID(_ context.Context, id uuid.UUID) (*AssetRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	a, ok := m.assets[id]
	if !ok {
		return nil, nil
	}
	cp := a
	return &cp, nil
}

func (m *MemoryStore) ListAssets(_ context.Context) ([]AssetRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]AssetRecord, 0, len(m.assets))
	for _, a := range m.assets {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *MemoryStore) DeleteAsset(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.assets, id)
	return nil
}

func (m *MemoryStore) CreateBackup(_ context.Context, rec BackupRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	m.backups[rec.ID] = rec
	return nil
}

func (m *MemoryStore) GetBackupByID(_ context.Context, id uuid.UUID) (*BackupRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	b, ok := m.backups[id]
	if !ok {
		return nil, nil
	}
	cp := b
	return &cp, nil
}

func (m *MemoryStore) ListBackups(_ context.Context) ([]BackupRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]BackupRecord, 0, len(m.backups))
	for _, b := range m.backups {
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *MemoryStore) DeleteBackup(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.backups, id)
	return nil
}

func (m *MemoryStore) CreateWebhook(_ context.Context, rec WebhookRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	now := time.Now().UTC()
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = now
	}
	rec.UpdatedAt = now
	cp := rec
	cp.Events = append([]string(nil), rec.Events...)
	cp.SecretEnc = append([]byte(nil), rec.SecretEnc...)
	m.webhooks[cp.ID] = cp
	return nil
}

func (m *MemoryStore) UpdateWebhook(_ context.Context, rec WebhookRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, ok := m.webhooks[rec.ID]
	if !ok {
		return ErrNotFound
	}
	rec.CreatedAt = old.CreatedAt
	rec.UpdatedAt = time.Now().UTC()
	if len(rec.SecretEnc) == 0 {
		rec.SecretEnc = old.SecretEnc
	}
	cp := rec
	cp.Events = append([]string(nil), rec.Events...)
	cp.SecretEnc = append([]byte(nil), rec.SecretEnc...)
	m.webhooks[cp.ID] = cp
	return nil
}

func (m *MemoryStore) GetWebhook(_ context.Context, id uuid.UUID) (*WebhookRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	w, ok := m.webhooks[id]
	if !ok {
		return nil, nil
	}
	cp := w
	cp.Events = append([]string(nil), w.Events...)
	cp.SecretEnc = append([]byte(nil), w.SecretEnc...)
	return &cp, nil
}

func (m *MemoryStore) ListWebhooks(_ context.Context) ([]WebhookRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]WebhookRecord, 0, len(m.webhooks))
	for _, w := range m.webhooks {
		cp := w
		cp.Events = append([]string(nil), w.Events...)
		cp.SecretEnc = append([]byte(nil), w.SecretEnc...)
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *MemoryStore) DeleteWebhook(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.webhooks, id)
	return nil
}

func (m *MemoryStore) RecordWebhookDelivery(_ context.Context, rec WebhookDeliveryRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	m.deliveries = append(m.deliveries, rec)
	if len(m.deliveries) > 1000 {
		m.deliveries = m.deliveries[len(m.deliveries)-1000:]
	}
	return nil
}

func (m *MemoryStore) ListWebhookDeliveries(_ context.Context, webhookID *uuid.UUID, limit int) ([]WebhookDeliveryRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var out []WebhookDeliveryRecord
	for i := len(m.deliveries) - 1; i >= 0 && len(out) < limit; i-- {
		d := m.deliveries[i]
		if webhookID != nil && d.WebhookID != *webhookID {
			continue
		}
		out = append(out, d)
	}
	return out, nil
}

func (m *MemoryStore) CreateComment(_ context.Context, rec CommentRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	now := time.Now().UTC()
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = now
	}
	if rec.UpdatedAt.IsZero() {
		rec.UpdatedAt = now
	}
	m.comments[rec.ID] = rec
	return nil
}

func (m *MemoryStore) GetCommentByID(_ context.Context, id uuid.UUID) (*CommentRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.comments[id]
	if !ok {
		return nil, nil
	}
	cp := c
	return &cp, nil
}

func (m *MemoryStore) ListComments(_ context.Context, contentType, contentSlug, status string) ([]CommentRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []CommentRecord
	for _, c := range m.comments {
		if contentType != "" && c.ContentType != contentType {
			continue
		}
		if contentSlug != "" && c.ContentSlug != contentSlug {
			continue
		}
		if status != "" && c.Status != status {
			continue
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Pinned != out[j].Pinned {
			return out[i].Pinned
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out, nil
}

func (m *MemoryStore) UpdateCommentStatus(_ context.Context, id uuid.UUID, status string, pinned *bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.comments[id]
	if !ok {
		return ErrNotFound
	}
	if status != "" {
		c.Status = status
	}
	if pinned != nil {
		c.Pinned = *pinned
	}
	c.UpdatedAt = time.Now().UTC()
	m.comments[id] = c
	return nil
}

func (m *MemoryStore) DeleteComment(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.comments, id)
	for cid, c := range m.comments {
		if c.ParentID != nil && *c.ParentID == id {
			delete(m.comments, cid)
		}
	}
	return nil
}

func (m *MemoryStore) ToggleReaction(_ context.Context, contentType, contentSlug, emoji, voterHash string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := contentType + ":" + contentSlug + ":" + emoji
	set := m.reactions[k]
	if set == nil {
		set = make(map[string]bool)
		m.reactions[k] = set
	}
	if set[voterHash] {
		delete(set, voterHash)
		return false, nil
	}
	set[voterHash] = true
	return true, nil
}

func (m *MemoryStore) GetReactionCounts(_ context.Context, contentType, contentSlug, voterHash string, allowedEmojis []string) ([]ReactionSummary, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]ReactionSummary, 0, len(allowedEmojis))
	for _, emoji := range allowedEmojis {
		k := contentType + ":" + contentSlug + ":" + emoji
		set := m.reactions[k]
		out = append(out, ReactionSummary{
			Emoji:   emoji,
			Count:   len(set),
			Reacted: voterHash != "" && set[voterHash],
		})
	}
	return out, nil
}

func (m *MemoryStore) UpsertSubscriber(_ context.Context, rec SubscriberRecord) (SubscriberRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	email := strings.ToLower(strings.TrimSpace(rec.Email))
	for id, s := range m.subscribers {
		if s.Email == email {
			s.Status = rec.Status
			s.ConfirmToken = rec.ConfirmToken
			s.UnsubscribeToken = rec.UnsubscribeToken
			s.ConfirmedAt = rec.ConfirmedAt
			s.UnsubscribedAt = rec.UnsubscribedAt
			m.subscribers[id] = s
			return s, nil
		}
	}
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	rec.Email = email
	m.subscribers[rec.ID] = rec
	return rec, nil
}

func (m *MemoryStore) GetSubscriberByEmail(_ context.Context, email string) (*SubscriberRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	target := strings.ToLower(strings.TrimSpace(email))
	for _, s := range m.subscribers {
		if s.Email == target {
			cp := s
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *MemoryStore) GetSubscriberByConfirmToken(_ context.Context, token string) (*SubscriberRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.subscribers {
		if s.ConfirmToken != "" && s.ConfirmToken == token {
			cp := s
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *MemoryStore) GetSubscriberByUnsubscribeToken(_ context.Context, token string) (*SubscriberRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.subscribers {
		if s.UnsubscribeToken == token {
			cp := s
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *MemoryStore) UpdateSubscriberStatus(_ context.Context, id uuid.UUID, status string, ts time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.subscribers[id]
	if !ok {
		return ErrNotFound
	}
	u := ts.UTC()
	s.Status = status
	if status == "active" {
		s.ConfirmedAt = &u
		s.ConfirmToken = ""
		s.UnsubscribedAt = nil
	} else if status == "unsubscribed" {
		s.UnsubscribedAt = &u
	}
	m.subscribers[id] = s
	return nil
}

func (m *MemoryStore) ListSubscribers(_ context.Context, status string) ([]SubscriberRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []SubscriberRecord
	for _, s := range m.subscribers {
		if status != "" && s.Status != status {
			continue
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *MemoryStore) DeleteSubscriber(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.subscribers, id)
	return nil
}

func (m *MemoryStore) CreateNewsletter(_ context.Context, rec NewsletterRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	m.newsletters[rec.ID] = rec
	return nil
}

func (m *MemoryStore) UpdateNewsletterCounts(_ context.Context, id uuid.UUID, status string, sentCount, failedCount int, sentAt *time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	n, ok := m.newsletters[id]
	if !ok {
		return ErrNotFound
	}
	n.Status = status
	n.SentCount = sentCount
	n.FailedCount = failedCount
	n.SentAt = sentAt
	m.newsletters[id] = n
	return nil
}

func (m *MemoryStore) ListNewsletters(_ context.Context) ([]NewsletterRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]NewsletterRecord, 0, len(m.newsletters))
	for _, n := range m.newsletters {
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *MemoryStore) CreateFriendLink(_ context.Context, rec FriendLinkRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.friendLinks {
		if existing.URL == rec.URL {
			return ErrConflict
		}
	}
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	if rec.GroupName == "" {
		rec.GroupName = "Friends"
	}
	m.friendLinks[rec.ID] = rec
	return nil
}

func (m *MemoryStore) GetFriendLink(_ context.Context, id uuid.UUID) (*FriendLinkRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	f, ok := m.friendLinks[id]
	if !ok {
		return nil, nil
	}
	cp := f
	return &cp, nil
}

func (m *MemoryStore) GetFriendLinkByURL(_ context.Context, linkURL string) (*FriendLinkRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, f := range m.friendLinks {
		if f.URL == linkURL {
			cp := f
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *MemoryStore) UpdateFriendLink(_ context.Context, rec FriendLinkRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, ok := m.friendLinks[rec.ID]
	if !ok {
		return ErrNotFound
	}
	rec.CreatedAt = old.CreatedAt
	m.friendLinks[rec.ID] = rec
	return nil
}

func (m *MemoryStore) UpdateFriendFeedCheck(_ context.Context, id uuid.UUID, status, etag, lastModified string, checkedAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.friendLinks[id]
	if !ok {
		return nil
	}
	if status != "" {
		f.Status = status
	}
	f.ETag = etag
	f.LastModified = lastModified
	u := checkedAt.UTC()
	f.LastCheckedAt = &u
	m.friendLinks[id] = f
	return nil
}

func (m *MemoryStore) ListFriendLinks(_ context.Context, status string) ([]FriendLinkRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []FriendLinkRecord
	for _, f := range m.friendLinks {
		if status != "" && f.Status != status {
			continue
		}
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SortOrder != out[j].SortOrder {
			return out[i].SortOrder < out[j].SortOrder
		}
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out, nil
}

func (m *MemoryStore) DeleteFriendLink(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.friendLinks, id)
	for k, item := range m.friendFeeds {
		if item.FriendID == id {
			delete(m.friendFeeds, k)
		}
	}
	return nil
}

func (m *MemoryStore) UpsertFriendFeedItems(_ context.Context, items []FriendFeedRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, item := range items {
		if item.ID == uuid.Nil {
			item.ID = uuid.New()
		}
		if item.FetchedAt.IsZero() {
			item.FetchedAt = time.Now().UTC()
		}
		key := item.FriendID.String() + ":" + item.ItemGUID
		m.friendFeeds[key] = item
	}
	return nil
}

func (m *MemoryStore) ListFriendFeedItems(_ context.Context, limit int) ([]FriendFeedRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	var out []FriendFeedRecord
	for _, item := range m.friendFeeds {
		fl, ok := m.friendLinks[item.FriendID]
		if !ok || (fl.Status != "active" && fl.Status != "unreachable") {
			continue
		}
		item.FriendName = fl.Name
		item.FriendURL = fl.URL
		item.FriendAvatar = fl.AvatarURL
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PublishedAt.After(out[j].PublishedAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *MemoryStore) GetAllSettings(_ context.Context) (map[string]json.RawMessage, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]json.RawMessage, len(m.settings))
	for k, v := range m.settings {
		out[k] = append([]byte(nil), v...)
	}
	return out, nil
}

func (m *MemoryStore) SetSetting(_ context.Context, key string, value json.RawMessage) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settings[key] = append([]byte(nil), value...)
	return nil
}

func (m *MemoryStore) ListRedirects(_ context.Context) ([]RedirectRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]RedirectRecord, 0, len(m.redirects))
	for _, r := range m.redirects {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *MemoryStore) FindRedirect(_ context.Context, sourcePath string) (*RedirectRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, r := range m.redirects {
		if r.SourcePath == sourcePath {
			cp := r
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *MemoryStore) IncrementRedirectHit(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.redirects[id]; ok {
		r.Hits++
		m.redirects[id] = r
	}
	return nil
}

func (m *MemoryStore) CreateRedirect(_ context.Context, rec RedirectRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.ID == uuid.Nil {
		rec.ID = uuid.New()
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	if rec.StatusCode == 0 {
		rec.StatusCode = 301
	}
	for id, old := range m.redirects {
		if old.SourcePath == rec.SourcePath {
			rec.ID = id
			break
		}
	}
	m.redirects[rec.ID] = rec
	return nil
}

func (m *MemoryStore) DeleteRedirect(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.redirects, id)
	return nil
}

func (m *MemoryStore) InsertAnalyticsEvent(_ context.Context, ev AnalyticsEventInput) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ev.OccurredAt.IsZero() {
		ev.OccurredAt = time.Now().UTC()
	}
	m.analyticsEvents = append(m.analyticsEvents, ev)
	if len(m.analyticsEvents) > 20000 {
		m.analyticsEvents = m.analyticsEvents[len(m.analyticsEvents)-20000:]
	}
	return nil
}

func (m *MemoryStore) RollupAnalyticsDaily(context.Context, time.Time) error {
	return nil
}

func (m *MemoryStore) GetAnalyticsOverview(_ context.Context, days int) (AnalyticsOverview, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if days <= 0 || days > 90 {
		days = 30
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -days)

	type dayAgg struct {
		views     int
		visitors  map[string]bool
		dwellSum  int
		dwellCnt  int
		scrollSum int
		scrollCnt int
	}
	byDay := make(map[string]*dayAgg)
	globalVisitors := make(map[string]bool)
	pathCounts := make(map[string]int)
	refCounts := make(map[string]int)
	totalViews := 0
	dwellTotal, dwellCount := 0, 0
	scrollTotal, scrollCount := 0, 0

	for _, ev := range m.analyticsEvents {
		if ev.OccurredAt.Before(cutoff) {
			continue
		}
		dayKey := ev.OccurredAt.UTC().Format("2006-01-02")
		agg := byDay[dayKey]
		if agg == nil {
			agg = &dayAgg{visitors: make(map[string]bool)}
			byDay[dayKey] = agg
		}
		if ev.VisitorHash != "" {
			globalVisitors[ev.VisitorHash] = true
			agg.visitors[ev.VisitorHash] = true
		}
		if ev.DwellMs > 0 {
			agg.dwellSum += ev.DwellMs
			agg.dwellCnt++
			dwellTotal += ev.DwellMs
			dwellCount++
		}
		if ev.ScrollPct > 0 {
			agg.scrollSum += ev.ScrollPct
			agg.scrollCnt++
			scrollTotal += ev.ScrollPct
			scrollCount++
		}
		// Count views on pageview events (or any event when pageview isn't separated).
		if ev.ScrollPct == 0 && ev.DwellMs == 0 {
			totalViews++
			agg.views++
			pathCounts[ev.Path]++
			if ev.ReferrerHost != "" {
				refCounts[ev.ReferrerHost]++
			}
		}
	}

	dayKeys := make([]string, 0, len(byDay))
	for k := range byDay {
		dayKeys = append(dayKeys, k)
	}
	sort.Strings(dayKeys)
	series := make([]AnalyticsDayPoint, 0, len(dayKeys))
	for _, k := range dayKeys {
		agg := byDay[k]
		avgD, avgS := 0, 0
		if agg.dwellCnt > 0 {
			avgD = agg.dwellSum / agg.dwellCnt
		}
		if agg.scrollCnt > 0 {
			avgS = agg.scrollSum / agg.scrollCnt
		}
		series = append(series, AnalyticsDayPoint{
			Day:            k,
			Views:          agg.views,
			UniqueVisitors: len(agg.visitors),
			AvgDwellMs:     avgD,
			AvgScrollPct:   avgS,
		})
	}

	topPaths := make([]AnalyticsTopItem, 0, len(pathCounts))
	for p, c := range pathCounts {
		topPaths = append(topPaths, AnalyticsTopItem{Path: p, Views: c})
	}
	sort.Slice(topPaths, func(i, j int) bool { return topPaths[i].Views > topPaths[j].Views })
	if len(topPaths) > 10 {
		topPaths = topPaths[:10]
	}

	topRefs := make([]AnalyticsReferrerItem, 0, len(refCounts))
	for r, c := range refCounts {
		topRefs = append(topRefs, AnalyticsReferrerItem{Referrer: r, Views: c})
	}
	sort.Slice(topRefs, func(i, j int) bool { return topRefs[i].Views > topRefs[j].Views })
	if len(topRefs) > 10 {
		topRefs = topRefs[:10]
	}

	avgD, avgS := 0, 0
	if dwellCount > 0 {
		avgD = dwellTotal / dwellCount
	}
	if scrollCount > 0 {
		avgS = scrollTotal / scrollCount
	}

	return AnalyticsOverview{
		TotalViews:     totalViews,
		UniqueVisitors: len(globalVisitors),
		AvgDwellMs:     avgD,
		AvgScrollPct:   avgS,
		Series:         series,
		TopPaths:       topPaths,
		TopReferrers:   topRefs,
	}, nil
}

func (m *MemoryStore) ExportSnapshot(ctx context.Context) (*StateSnapshot, error) {
	settings, _ := m.GetAllSettings(ctx)
	redirects, _ := m.ListRedirects(ctx)
	comments, _ := m.ListComments(ctx, "", "", "")
	friends, _ := m.ListFriendLinks(ctx, "")
	subs, _ := m.ListSubscribers(ctx, "")
	newsletters, _ := m.ListNewsletters(ctx)
	assets, _ := m.ListAssets(ctx)
	previews, _ := m.ListDraftPreviews(ctx, "", "")
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

func (m *MemoryStore) ImportSnapshot(_ context.Context, snap *StateSnapshot) error {
	if snap == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, v := range snap.Settings {
		m.settings[k] = append([]byte(nil), v...)
	}
	for _, r := range snap.Redirects {
		m.redirects[r.ID] = r
	}
	for _, c := range snap.Comments {
		m.comments[c.ID] = c
	}
	for _, f := range snap.FriendLinks {
		m.friendLinks[f.ID] = f
	}
	for _, s := range snap.Subscribers {
		m.subscribers[s.ID] = s
	}
	for _, n := range snap.Newsletters {
		m.newsletters[n.ID] = n
	}
	for _, a := range snap.Assets {
		m.assets[a.ID] = a
	}
	for _, p := range snap.DraftPreviews {
		m.previews[p.ID] = p
	}
	return nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
