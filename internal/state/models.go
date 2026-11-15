package state

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	ErrNotFound = errors.New("record not found")
	ErrConflict = errors.New("record conflict")
)

type User struct {
	ID           uuid.UUID `json:"id"`
	Email        string    `json:"email"`
	Name         string    `json:"name"`
	PasswordHash string    `json:"-"`
	Role         string    `json:"role"`
	AvatarURL    string    `json:"avatarUrl,omitempty"`
	Bio          string    `json:"bio,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type Session struct {
	ID         uuid.UUID `json:"id"`
	UserID     uuid.UUID `json:"userId"`
	TokenHash  string    `json:"-"`
	CSRFSecret string    `json:"-"`
	IPHash     string    `json:"ipHash,omitempty"`
	UserAgent  string    `json:"userAgent,omitempty"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	CreatedAt  time.Time `json:"createdAt"`
}

type PasskeyRecord struct {
	ID              uuid.UUID  `json:"id"`
	UserID          uuid.UUID  `json:"userId"`
	CredentialID    []byte     `json:"credentialId"`
	PublicKey       []byte     `json:"-"`
	AttestationType string     `json:"attestationType"`
	AAGUID          []byte     `json:"aaguid,omitempty"`
	SignCount       uint32     `json:"signCount"`
	Transports      []string   `json:"transports"`
	CredentialJSON  []byte     `json:"-"`
	Label           string     `json:"label"`
	LastUsedAt      *time.Time `json:"lastUsedAt,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
}

type TOTPRecord struct {
	UserID             uuid.UUID  `json:"userId"`
	EncryptedSecret    []byte     `json:"-"`
	RecoveryCodeHashes []string   `json:"-"`
	Enabled            bool       `json:"enabled"`
	VerifiedAt         *time.Time `json:"verifiedAt,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
}

type APITokenRecord struct {
	ID          uuid.UUID  `json:"id"`
	UserID      uuid.UUID  `json:"userId"`
	Name        string     `json:"name"`
	TokenPrefix string     `json:"tokenPrefix"`
	TokenHash   string     `json:"-"`
	Scopes      []string   `json:"scopes"`
	LastUsedAt  *time.Time `json:"lastUsedAt,omitempty"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	RevokedAt   *time.Time `json:"revokedAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
}

type AuditLogRecord struct {
	ID         uuid.UUID       `json:"id"`
	ActorType  string          `json:"actorType"`
	ActorID    *uuid.UUID      `json:"actorId,omitempty"`
	Action     string          `json:"action"`
	TargetType string          `json:"targetType,omitempty"`
	TargetID   string          `json:"targetId,omitempty"`
	IPHash     string          `json:"ipHash,omitempty"`
	MetaJSON   json.RawMessage `json:"meta,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
}

type RevisionRecord struct {
	ID             uuid.UUID  `json:"id"`
	ContentID      uuid.UUID  `json:"contentId"`
	ContentType    string     `json:"contentType"`
	ContentSlug    string     `json:"contentSlug"`
	Path           string     `json:"path"`
	RevisionNum    int        `json:"revisionNum"`
	Checksum       string     `json:"checksum"`
	CompressedBody []byte     `json:"-"`
	DiffText       string     `json:"diffText,omitempty"`
	ActorID        *uuid.UUID `json:"actorId,omitempty"`
	Note           string     `json:"note,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
}

type DraftPreviewRecord struct {
	ID          uuid.UUID  `json:"id"`
	TokenHash   string     `json:"-"`
	ContentType string     `json:"contentType"`
	ContentSlug string     `json:"contentSlug"`
	Label       string     `json:"label"`
	ExpiresAt   time.Time  `json:"expiresAt"`
	RevokedAt   *time.Time `json:"revokedAt,omitempty"`
	CreatedBy   *uuid.UUID `json:"createdBy,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
}

type AssetRecord struct {
	ID            uuid.UUID       `json:"id"`
	StorageDriver string          `json:"storageDriver"`
	StorageKey    string          `json:"storageKey"`
	PublicURL     string          `json:"publicUrl"`
	Filename      string          `json:"filename"`
	MimeType      string          `json:"mimeType"`
	ByteSize      int64           `json:"byteSize"`
	Width         *int            `json:"width,omitempty"`
	Height        *int            `json:"height,omitempty"`
	Thumbhash     string          `json:"thumbhash,omitempty"`
	EXIFStripped  bool            `json:"exifStripped"`
	AltText       string          `json:"altText"`
	VariantsJSON  json.RawMessage `json:"variants,omitempty"`
	CreatedBy     *uuid.UUID      `json:"createdBy,omitempty"`
	CreatedAt     time.Time       `json:"createdAt"`
}

type BackupRecord struct {
	ID            uuid.UUID  `json:"id"`
	Filename      string     `json:"filename"`
	StorageDriver string     `json:"storageDriver"`
	StorageKey    string     `json:"storageKey"`
	ByteSize      int64      `json:"byteSize"`
	Checksum      string     `json:"checksum"`
	Status        string     `json:"status"`
	ErrorMessage  string     `json:"errorMessage,omitempty"`
	CreatedBy     *uuid.UUID `json:"createdBy,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
}

type WebhookRecord struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	TargetURL string    `json:"targetUrl"`
	SecretEnc []byte    `json:"-"`
	Events    []string  `json:"events"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type WebhookDeliveryRecord struct {
	ID           uuid.UUID       `json:"id"`
	WebhookID    uuid.UUID       `json:"webhookId"`
	EventName    string          `json:"eventName"`
	PayloadJSON  json.RawMessage `json:"payload"`
	Attempt      int             `json:"attempt"`
	StatusCode   *int            `json:"statusCode,omitempty"`
	ResponseBody string          `json:"responseBody,omitempty"`
	ErrorMessage string          `json:"errorMessage,omitempty"`
	DeliveredAt  *time.Time      `json:"deliveredAt,omitempty"`
	CreatedAt    time.Time       `json:"createdAt"`
}

type CommentRecord struct {
	ID              uuid.UUID  `json:"id"`
	ContentType     string     `json:"contentType"`
	ContentSlug     string     `json:"contentSlug"`
	ParentID        *uuid.UUID `json:"parentId,omitempty"`
	AuthorName      string     `json:"authorName"`
	AuthorEmailHash string     `json:"authorEmailHash"`
	AuthorURL       string     `json:"authorUrl,omitempty"`
	IsAdmin         bool       `json:"isAdmin"`
	BodyMarkdown    string     `json:"bodyMarkdown"`
	BodyHTML        string     `json:"bodyHtml"`
	Status          string     `json:"status"`
	Pinned          bool       `json:"pinned"`
	NotifyReply     bool       `json:"notifyReply"`
	NotifyEmailEnc  []byte     `json:"-"`
	IPHash          string     `json:"ipHash,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

type ReactionSummary struct {
	Emoji   string `json:"emoji"`
	Count   int    `json:"count"`
	Reacted bool   `json:"reacted"`
}

type SubscriberRecord struct {
	ID               uuid.UUID  `json:"id"`
	Email            string     `json:"email"`
	Status           string     `json:"status"`
	ConfirmToken     string     `json:"-"`
	UnsubscribeToken string     `json:"-"`
	ConfirmedAt      *time.Time `json:"confirmedAt,omitempty"`
	UnsubscribedAt   *time.Time `json:"unsubscribedAt,omitempty"`
	CreatedAt        time.Time  `json:"createdAt"`
}

type NewsletterRecord struct {
	ID           uuid.UUID  `json:"id"`
	Subject      string     `json:"subject"`
	BodyMarkdown string     `json:"bodyMarkdown"`
	BodyHTML     string     `json:"bodyHtml"`
	ContentType  string     `json:"contentType,omitempty"`
	ContentSlug  string     `json:"contentSlug,omitempty"`
	Status       string     `json:"status"`
	SentCount    int        `json:"sentCount"`
	FailedCount  int        `json:"failedCount"`
	SentAt       *time.Time `json:"sentAt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
}

type FriendLinkRecord struct {
	ID            uuid.UUID  `json:"id"`
	Name          string     `json:"name"`
	URL           string     `json:"url"`
	FeedURL       string     `json:"feedUrl,omitempty"`
	AvatarURL     string     `json:"avatarUrl,omitempty"`
	Description   string     `json:"description"`
	GroupName     string     `json:"groupName"`
	Status        string     `json:"status"`
	SortOrder     int        `json:"sortOrder"`
	ETag          string     `json:"etag,omitempty"`
	LastModified  string     `json:"lastModified,omitempty"`
	LastCheckedAt *time.Time `json:"lastCheckedAt,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
}

type FriendFeedRecord struct {
	ID           uuid.UUID `json:"id"`
	FriendID     uuid.UUID `json:"friendId"`
	FriendName   string    `json:"friendName"`
	FriendURL    string    `json:"friendUrl"`
	FriendAvatar string    `json:"friendAvatar,omitempty"`
	ItemGUID     string    `json:"itemGuid"`
	Title        string    `json:"title"`
	Link         string    `json:"link"`
	Summary      string    `json:"summary,omitempty"`
	PublishedAt  time.Time `json:"publishedAt"`
	FetchedAt    time.Time `json:"fetchedAt"`
}

type RedirectRecord struct {
	ID         uuid.UUID `json:"id"`
	SourcePath string    `json:"sourcePath"`
	TargetPath string    `json:"targetPath"`
	StatusCode int       `json:"statusCode"`
	Hits       int64     `json:"hits"`
	CreatedAt  time.Time `json:"createdAt"`
}

type AnalyticsEventInput struct {
	Path         string
	ContentType  string
	ContentSlug  string
	VisitorHash  string
	ReferrerHost string
	DeviceKind   string
	DwellMs      int
	ScrollPct    int
	OccurredAt   time.Time
}

type AnalyticsDayPoint struct {
	Day            string `json:"day"`
	Views          int    `json:"views"`
	UniqueVisitors int    `json:"uniqueVisitors"`
	AvgDwellMs     int    `json:"avgDwellMs"`
	AvgScrollPct   int    `json:"avgScrollPct"`
}

type AnalyticsTopItem struct {
	Path  string `json:"path"`
	Views int    `json:"views"`
}

type AnalyticsReferrerItem struct {
	Referrer string `json:"referrer"`
	Views    int    `json:"views"`
}

type AnalyticsOverview struct {
	TotalViews     int                     `json:"totalViews"`
	UniqueVisitors int                     `json:"uniqueVisitors"`
	AvgDwellMs     int                     `json:"avgDwellMs"`
	AvgScrollPct   int                     `json:"avgScrollPct"`
	Series         []AnalyticsDayPoint     `json:"series"`
	TopPaths       []AnalyticsTopItem      `json:"topPaths"`
	TopReferrers   []AnalyticsReferrerItem `json:"topReferrers"`
}

// StateSnapshot serializes operational state into full-site .tar.zst backups.
type StateSnapshot struct {
	Version      string                    `json:"version"`
	ExportedAt   time.Time                 `json:"exportedAt"`
	Settings     map[string]json.RawMessage `json:"settings"`
	Redirects    []RedirectRecord          `json:"redirects"`
	Comments     []CommentRecord           `json:"comments"`
	FriendLinks  []FriendLinkRecord        `json:"friendLinks"`
	Subscribers  []SubscriberRecord        `json:"subscribers"`
	Newsletters  []NewsletterRecord        `json:"newsletters"`
	Assets       []AssetRecord             `json:"assets"`
	DraftPreviews []DraftPreviewRecord     `json:"draftPreviews"`
}

// Store abstracts persistence over PostgreSQL 17 or thread-safe in-memory state.
type Store interface {
	// Users & Auth
	CountUsers(ctx context.Context) (int, error)
	CreateUser(ctx context.Context, u User) (User, error)
	EnsureCitadelUser(ctx context.Context, id uuid.UUID, email, name, avatarURL, role string) (User, error)
	GetUserByID(ctx context.Context, id uuid.UUID) (*User, error)
	GetUserByEmail(ctx context.Context, email string) (*User, error)
	UpdateUserPassword(ctx context.Context, userID uuid.UUID, passwordHash string) error
	UpdateUserProfile(ctx context.Context, userID uuid.UUID, name, bio, avatarURL string) error

	CreateSession(ctx context.Context, s Session) error
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (*Session, error)
	TouchSession(ctx context.Context, sessionID uuid.UUID, seenAt time.Time) error
	DeleteSession(ctx context.Context, sessionID uuid.UUID) error
	DeleteSessionsByUser(ctx context.Context, userID uuid.UUID) error
	ListSessionsByUser(ctx context.Context, userID uuid.UUID) ([]Session, error)

	GetTOTP(ctx context.Context, userID uuid.UUID) (*TOTPRecord, error)
	UpsertTOTP(ctx context.Context, rec TOTPRecord) error
	DeleteTOTP(ctx context.Context, userID uuid.UUID) error

	ListPasskeys(ctx context.Context, userID uuid.UUID) ([]PasskeyRecord, error)
	GetPasskeyByCredentialID(ctx context.Context, credID []byte) (*PasskeyRecord, error)
	CreatePasskey(ctx context.Context, p PasskeyRecord) error
	UpdatePasskeyUsage(ctx context.Context, passkeyID uuid.UUID, signCount uint32, credentialJSON []byte, usedAt time.Time) error
	DeletePasskey(ctx context.Context, userID, passkeyID uuid.UUID) error

	CreateAPIToken(ctx context.Context, t APITokenRecord) error
	GetAPITokenByHash(ctx context.Context, tokenHash string) (*APITokenRecord, error)
	TouchAPIToken(ctx context.Context, tokenID uuid.UUID, usedAt time.Time) error
	ListAPITokens(ctx context.Context, userID uuid.UUID) ([]APITokenRecord, error)
	RevokeAPIToken(ctx context.Context, userID, tokenID uuid.UUID) error

	AppendAuditLog(ctx context.Context, rec AuditLogRecord) error
	ListAuditLogs(ctx context.Context, limit int) ([]AuditLogRecord, error)

	// Content Revisions & Previews
	CreateRevision(ctx context.Context, rec RevisionRecord) (RevisionRecord, error)
	ListRevisions(ctx context.Context, contentType, contentSlug string) ([]RevisionRecord, error)
	GetRevision(ctx context.Context, id uuid.UUID) (*RevisionRecord, error)
	MigrateContentPath(ctx context.Context, oldPath, newPath string) error

	CreateDraftPreview(ctx context.Context, rec DraftPreviewRecord) error
	GetDraftPreviewByTokenHash(ctx context.Context, tokenHash string) (*DraftPreviewRecord, error)
	ListDraftPreviews(ctx context.Context, contentType, contentSlug string) ([]DraftPreviewRecord, error)
	RevokeDraftPreview(ctx context.Context, id uuid.UUID) error

	// Media & Backups
	CreateAsset(ctx context.Context, rec AssetRecord) error
	GetAssetByID(ctx context.Context, id uuid.UUID) (*AssetRecord, error)
	ListAssets(ctx context.Context) ([]AssetRecord, error)
	DeleteAsset(ctx context.Context, id uuid.UUID) error

	CreateBackup(ctx context.Context, rec BackupRecord) error
	GetBackupByID(ctx context.Context, id uuid.UUID) (*BackupRecord, error)
	ListBackups(ctx context.Context) ([]BackupRecord, error)
	DeleteBackup(ctx context.Context, id uuid.UUID) error

	// Webhooks
	CreateWebhook(ctx context.Context, rec WebhookRecord) error
	UpdateWebhook(ctx context.Context, rec WebhookRecord) error
	GetWebhook(ctx context.Context, id uuid.UUID) (*WebhookRecord, error)
	ListWebhooks(ctx context.Context) ([]WebhookRecord, error)
	DeleteWebhook(ctx context.Context, id uuid.UUID) error
	RecordWebhookDelivery(ctx context.Context, rec WebhookDeliveryRecord) error
	ListWebhookDeliveries(ctx context.Context, webhookID *uuid.UUID, limit int) ([]WebhookDeliveryRecord, error)

	// Community & Distribution
	CreateComment(ctx context.Context, rec CommentRecord) error
	GetCommentByID(ctx context.Context, id uuid.UUID) (*CommentRecord, error)
	ListComments(ctx context.Context, contentType, contentSlug, status string) ([]CommentRecord, error)
	UpdateCommentStatus(ctx context.Context, id uuid.UUID, status string, pinned *bool) error
	DeleteComment(ctx context.Context, id uuid.UUID) error

	ToggleReaction(ctx context.Context, contentType, contentSlug, emoji, voterHash string) (bool, error)
	GetReactionCounts(ctx context.Context, contentType, contentSlug, voterHash string, allowedEmojis []string) ([]ReactionSummary, error)

	UpsertSubscriber(ctx context.Context, rec SubscriberRecord) (SubscriberRecord, error)
	GetSubscriberByEmail(ctx context.Context, email string) (*SubscriberRecord, error)
	GetSubscriberByConfirmToken(ctx context.Context, token string) (*SubscriberRecord, error)
	GetSubscriberByUnsubscribeToken(ctx context.Context, token string) (*SubscriberRecord, error)
	UpdateSubscriberStatus(ctx context.Context, id uuid.UUID, status string, ts time.Time) error
	ListSubscribers(ctx context.Context, status string) ([]SubscriberRecord, error)
	DeleteSubscriber(ctx context.Context, id uuid.UUID) error

	CreateNewsletter(ctx context.Context, rec NewsletterRecord) error
	UpdateNewsletterCounts(ctx context.Context, id uuid.UUID, status string, sentCount, failedCount int, sentAt *time.Time) error
	ListNewsletters(ctx context.Context) ([]NewsletterRecord, error)

	CreateFriendLink(ctx context.Context, rec FriendLinkRecord) error
	GetFriendLink(ctx context.Context, id uuid.UUID) (*FriendLinkRecord, error)
	GetFriendLinkByURL(ctx context.Context, linkURL string) (*FriendLinkRecord, error)
	UpdateFriendLink(ctx context.Context, rec FriendLinkRecord) error
	UpdateFriendFeedCheck(ctx context.Context, id uuid.UUID, status, etag, lastModified string, checkedAt time.Time) error
	ListFriendLinks(ctx context.Context, status string) ([]FriendLinkRecord, error)
	DeleteFriendLink(ctx context.Context, id uuid.UUID) error
	UpsertFriendFeedItems(ctx context.Context, items []FriendFeedRecord) error
	ListFriendFeedItems(ctx context.Context, limit int) ([]FriendFeedRecord, error)

	// Site Settings & Redirects
	GetAllSettings(ctx context.Context) (map[string]json.RawMessage, error)
	SetSetting(ctx context.Context, key string, value json.RawMessage) error

	ListRedirects(ctx context.Context) ([]RedirectRecord, error)
	FindRedirect(ctx context.Context, sourcePath string) (*RedirectRecord, error)
	IncrementRedirectHit(ctx context.Context, id uuid.UUID) error
	CreateRedirect(ctx context.Context, rec RedirectRecord) error
	DeleteRedirect(ctx context.Context, id uuid.UUID) error

	// Analytics
	InsertAnalyticsEvent(ctx context.Context, ev AnalyticsEventInput) error
	RollupAnalyticsDaily(ctx context.Context, day time.Time) error
	GetAnalyticsOverview(ctx context.Context, days int) (AnalyticsOverview, error)

	// Snapshots
	ExportSnapshot(ctx context.Context) (*StateSnapshot, error)
	ImportSnapshot(ctx context.Context, snap *StateSnapshot) error
}

// ContentUUID derives a deterministic content UUID matching db.Repo.UpsertContent.
func ContentUUID(relPath string) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("inkbranch:path:"+relPath))
}

// SHA256Hex returns lowercase SHA-256 hex digest of s.
func SHA256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return fmt.Sprintf("%x", sum[:])
}

// ValidateRedirectGraph checks path hygiene, prevents reserved prefix hijacking, and rejects redirect loops.
func ValidateRedirectGraph(existing []RedirectRecord, sourcePath, targetPath string) error {
	src := strings.TrimSpace(sourcePath)
	dst := strings.TrimSpace(targetPath)
	if !strings.HasPrefix(src, "/") || len(src) > 512 {
		return fmt.Errorf("sourcePath must start with /")
	}
	if src == "/" || strings.HasPrefix(src, "/api/") || src == "/api" || src == "/admin" || strings.HasPrefix(src, "/admin/") || src == "/blog" || strings.HasPrefix(src, "/blog/") {
		return fmt.Errorf("sourcePath %q is reserved", src)
	}
	if dst == "" || len(dst) > 1024 {
		return fmt.Errorf("targetPath is required")
	}
	if strings.HasPrefix(dst, "/") {
		if strings.HasPrefix(dst, "//") {
			return fmt.Errorf("protocol-relative targetPath is not allowed")
		}
	} else {
		u, err := url.Parse(dst)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("targetPath must be a site path or http/https URL")
		}
	}
	if src == dst {
		return fmt.Errorf("redirect source and target cannot be identical")
	}

	nextMap := make(map[string]string, len(existing)+1)
	for _, r := range existing {
		nextMap[r.SourcePath] = r.TargetPath
	}
	nextMap[src] = dst

	cur := dst
	seen := map[string]bool{src: true}
	for hop := 0; hop < 16; hop++ {
		if !strings.HasPrefix(cur, "/") {
			break
		}
		if seen[cur] {
			return fmt.Errorf("redirect loop detected involving %q", cur)
		}
		seen[cur] = true
		next, ok := nextMap[cur]
		if !ok {
			break
		}
		cur = next
	}
	return nil
}
