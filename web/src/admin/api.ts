import type { ContentDetail, ContentSummary, ContentType, Heading } from '../lib/types'

let csrfTokenMemory = ''

export function setCSRFToken(token: string | undefined) {
  if (typeof token === 'string' && token) {
    csrfTokenMemory = token
  }
}

export function clearCSRFToken() {
  csrfTokenMemory = ''
}

export class AdminAPIError extends Error {
  status: number
  title: string
  detail: string

  constructor(status: number, title: string, detail: string) {
    super(detail || title || `HTTP ${status}`)
    this.status = status
    this.title = title
    this.detail = detail
  }
}

async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers)
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData

  if (init?.body && !isForm && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (method !== 'GET' && method !== 'HEAD' && csrfTokenMemory && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', csrfTokenMemory)
  }

  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers,
  })

  if (!res.ok) {
    let title = res.statusText
    let detail = ''
    try {
      const errData = (await res.json()) as { title?: string; detail?: string; error?: string }
      if (errData.title) title = errData.title
      if (errData.detail) detail = errData.detail
      else if (errData.error) detail = errData.error
    } catch {
      // non-JSON response
    }
    throw new AdminAPIError(res.status, title, detail)
  }

  if (res.status === 204) {
    return undefined as T
  }
  return (await res.json()) as T
}

export interface AdminUser {
  id: string
  email: string
  name: string
  role: string
  avatarUrl?: string
  bio?: string
  createdAt: string
}

export interface AuthMeResponse {
  authenticated: boolean
  authKind?: string
  user?: AdminUser
  csrfToken?: string
  totpEnabled?: boolean
  recoveryCodesRemaining?: number
}

export interface LoginResponse {
  authenticated: boolean
  mfaRequired?: boolean
  mfaToken?: string
  user?: AdminUser
  csrfToken?: string
}

export interface AdminOverviewResponse {
  content: Record<string, number>
  inbox: {
    pendingComments: number
    pendingFriends: number
    activeSubscribers: number
    backups: number
  }
  analytics: {
    totalViews: number
    uniqueVisitors: number
    avgDwellMs: number
    avgScrollPct: number
    series: Array<{
      day: string
      views: number
      uniqueVisitors: number
      avgDwellMs: number
      avgScrollPct: number
    }>
    topPaths: Array<{ path: string; views: number }>
    topReferrers: Array<{ referrer: string; views: number }>
  }
  auditLogs: Array<{
    id: string
    actorType: string
    action: string
    targetType?: string
    targetId?: string
    ipHash?: string
    createdAt: string
  }>
}

export interface AdminContentSummary extends ContentSummary {
  relativePath: string
  checksum: string
  scheduledAt?: string
}

export interface RevisionRecord {
  id: string
  contentId: string
  contentType: string
  contentSlug: string
  path: string
  revisionNum: number
  checksum: string
  note?: string
  createdAt: string
}

export interface DraftPreviewRecord {
  id: string
  contentType: string
  contentSlug: string
  label: string
  expiresAt: string
  revokedAt?: string
  createdAt: string
}

export interface AdminContentDetailResponse {
  document: ContentDetail
  relativePath: string
  checksum: string
  rawMarkdown: string
  revisions: RevisionRecord[]
  previews: DraftPreviewRecord[]
}

export interface AssetRecord {
  id: string
  storageDriver: string
  storageKey: string
  publicUrl: string
  filename: string
  mimeType: string
  byteSize: number
  width?: number
  height?: number
  thumbhash?: string
  exifStripped: boolean
  altText: string
  createdAt: string
}

export interface AdminCommentRecord {
  id: string
  contentType: string
  contentSlug: string
  parentId?: string
  authorName: string
  authorEmailHash: string
  authorUrl?: string
  isAdmin: boolean
  bodyMarkdown: string
  bodyHtml: string
  status: 'pending' | 'approved' | 'spam' | 'deleted' | string
  pinned: boolean
  createdAt: string
}

export interface FriendLinkRecord {
  id: string
  name: string
  url: string
  feedUrl?: string
  avatarUrl?: string
  description: string
  groupName: string
  status: string
  sortOrder: number
  lastCheckedAt?: string
  createdAt: string
}

export interface SubscriberRecord {
  id: string
  email: string
  status: string
  confirmedAt?: string
  unsubscribedAt?: string
  createdAt: string
}

export interface NewsletterRecord {
  id: string
  subject: string
  bodyMarkdown: string
  status: string
  sentCount: number
  failedCount: number
  sentAt?: string
  createdAt: string
}

export interface RedirectRecord {
  id: string
  sourcePath: string
  targetPath: string
  statusCode: number
  hits: number
  createdAt: string
}

export interface SiteSettingsMap {
  site_name: string
  site_description: string
  feed_mode: 'full' | 'summary'
  comments_mode: 'builtin' | 'giscus' | 'off'
  comment_auto_approve: boolean
  giscus_repo: string
  giscus_repo_id: string
  giscus_category: string
  giscus_category_id: string
  [key: string]: unknown
}

export interface APITokenRecord {
  id: string
  name: string
  tokenPrefix: string
  scopes: string[]
  lastUsedAt?: string
  expiresAt?: string
  revokedAt?: string
  createdAt: string
}

export interface WebhookRecord {
  id: string
  name: string
  targetUrl: string
  events: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface WebhookDeliveryRecord {
  id: string
  webhookId: string
  eventName: string
  attempt: number
  statusCode?: number
  responseBody?: string
  errorMessage?: string
  deliveredAt?: string
  createdAt: string
}

export interface PasskeyRecord {
  id: string
  label: string
  signCount: number
  transports?: string[]
  lastUsedAt?: string
  createdAt: string
}

export interface SessionRecord {
  id: string
  ipHash?: string
  userAgent?: string
  lastSeenAt: string
  expiresAt: string
  createdAt: string
}

export interface BackupRecord {
  id: string
  filename: string
  storageDriver: string
  byteSize: number
  checksum: string
  status: string
  createdAt: string
}

function base64urlToUint8(val: string): Uint8Array {
  const padded = val.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((val.length + 3) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

function bufferToBase64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (const byte of bytes) {
    bin += String.fromCharCode(byte)
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const adminApi = {
  async authMe(): Promise<AuthMeResponse> {
    const res = await adminRequest<AuthMeResponse>('/api/v1/auth/me')
    if (res.csrfToken) setCSRFToken(res.csrfToken)
    return res
  },

  async login(email: string, password: string): Promise<LoginResponse> {
    const res = await adminRequest<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    if (res.csrfToken) setCSRFToken(res.csrfToken)
    return res
  },

  async verifyMFA(mfaToken: string, code: string): Promise<LoginResponse> {
    const res = await adminRequest<LoginResponse>('/api/v1/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, code }),
    })
    if (res.csrfToken) setCSRFToken(res.csrfToken)
    return res
  },

  async loginWithPasskey(email?: string): Promise<LoginResponse> {
    if (typeof window === 'undefined' || !('credentials' in navigator) || !window.PublicKeyCredential) {
      throw new Error('当前浏览器环境不支持 WebAuthn Passkey')
    }
    const begin = await adminRequest<{
      ceremonyId: string
      options: { publicKey: Record<string, unknown> }
    }>('/api/v1/auth/passkey/login/begin', {
      method: 'POST',
      body: JSON.stringify({ email: email?.trim() ?? '' }),
    })

    const rawPK = begin.options.publicKey
    const allowRaw = (rawPK.allowCredentials as Array<{ id: string; type: PublicKeyCredentialType; transports?: AuthenticatorTransport[] }> | undefined) ?? []
    const reqOptions: PublicKeyCredentialRequestOptions = {
      challenge: base64urlToUint8(String(rawPK.challenge)) as BufferSource,
      timeout: typeof rawPK.timeout === 'number' ? rawPK.timeout : 60000,
      rpId: typeof rawPK.rpId === 'string' ? rawPK.rpId : undefined,
      userVerification: (rawPK.userVerification as UserVerificationRequirement | undefined) ?? 'preferred',
      allowCredentials: allowRaw.map((c) => ({
        ...c,
        id: base64urlToUint8(c.id) as BufferSource,
      })),
    }

    const cred = (await navigator.credentials.get({ publicKey: reqOptions })) as PublicKeyCredential | null
    if (!cred) {
      throw new Error('Passkey 验证已取消')
    }
    const assertResp = cred.response as AuthenticatorAssertionResponse
    const payload = {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufferToBase64url(assertResp.clientDataJSON),
        authenticatorData: bufferToBase64url(assertResp.authenticatorData),
        signature: bufferToBase64url(assertResp.signature),
        userHandle: assertResp.userHandle ? bufferToBase64url(assertResp.userHandle) : undefined,
      },
    }

    const finish = await adminRequest<LoginResponse>(
      `/api/v1/auth/passkey/login/finish?ceremonyId=${encodeURIComponent(begin.ceremonyId)}`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
    if (finish.csrfToken) setCSRFToken(finish.csrfToken)
    return finish
  },

  async registerPasskey(label: string): Promise<PasskeyRecord> {
    if (typeof window === 'undefined' || !('credentials' in navigator) || !window.PublicKeyCredential) {
      throw new Error('当前浏览器不支持 Passkey 注册')
    }
    const begin = await adminRequest<{
      ceremonyId: string
      options: { publicKey: Record<string, unknown> }
    }>('/api/v1/admin/security/passkeys/register/begin', {
      method: 'POST',
      body: JSON.stringify({ label }),
    })

    const rawPK = begin.options.publicKey
    const rawUser = rawPK.user as { id: string; name: string; displayName: string }
    const exclRaw = (rawPK.excludeCredentials as Array<{ id: string; type: PublicKeyCredentialType; transports?: AuthenticatorTransport[] }> | undefined) ?? []
    const createOpts: PublicKeyCredentialCreationOptions = {
      rp: rawPK.rp as PublicKeyCredentialRpEntity,
      user: {
        id: base64urlToUint8(rawUser.id) as BufferSource,
        name: rawUser.name,
        displayName: rawUser.displayName,
      },
      challenge: base64urlToUint8(String(rawPK.challenge)) as BufferSource,
      pubKeyCredParams: rawPK.pubKeyCredParams as PublicKeyCredentialParameters[],
      timeout: typeof rawPK.timeout === 'number' ? rawPK.timeout : 60000,
      attestation: (rawPK.attestation as AttestationConveyancePreference | undefined) ?? 'none',
      authenticatorSelection: rawPK.authenticatorSelection as AuthenticatorSelectionCriteria | undefined,
      excludeCredentials: exclRaw.map((c) => ({
        ...c,
        id: base64urlToUint8(c.id) as BufferSource,
      })),
    }

    const cred = (await navigator.credentials.create({ publicKey: createOpts })) as PublicKeyCredential | null
    if (!cred) {
      throw new Error('Passkey 注册已取消')
    }
    const attResp = cred.response as AuthenticatorAttestationResponse & {
      getTransports?: () => string[]
    }
    const payload = {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufferToBase64url(attResp.clientDataJSON),
        attestationObject: bufferToBase64url(attResp.attestationObject),
        transports: typeof attResp.getTransports === 'function' ? attResp.getTransports() : undefined,
      },
    }

    const res = await adminRequest<{ passkey: PasskeyRecord }>(
      `/api/v1/admin/security/passkeys/register/finish?ceremonyId=${encodeURIComponent(begin.ceremonyId)}`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
    return res.passkey
  },

  async logout(): Promise<void> {
    await adminRequest('/api/v1/auth/logout', { method: 'POST' })
    clearCSRFToken()
  },

  overview: () => adminRequest<AdminOverviewResponse>('/api/v1/admin/overview'),

  listContent: (params?: { type?: string; status?: string; q?: string }) => {
    const sp = new URLSearchParams()
    if (params?.type) sp.set('type', params.type)
    if (params?.status) sp.set('status', params.status)
    if (params?.q) sp.set('q', params.q)
    const qs = sp.toString()
    return adminRequest<{ items: AdminContentSummary[] }>(`/api/v1/admin/content${qs ? `?${qs}` : ''}`)
  },

  getContent: (type: ContentType, slug: string) =>
    adminRequest<AdminContentDetailResponse>(`/api/v1/admin/content/${encodeURIComponent(type)}/${encodeURIComponent(slug)}`),

  saveContent: (payload: {
    type: ContentType
    filename?: string
    rawMarkdown: string
    expectedChecksum?: string
    previousPath?: string
    createRedirectOnRename?: boolean
    note?: string
  }) =>
    adminRequest<{
      ok: boolean
      relativePath: string
      checksum: string
      slug: string
      url: string
      autoRedirectCreated?: string
      document?: ContentDetail
    }>('/api/v1/admin/content', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteContent: (type: ContentType, slug: string) =>
    adminRequest<{ ok: boolean }>(`/api/v1/admin/content/${encodeURIComponent(type)}/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
    }),

  previewMarkdown: (type: ContentType, rawMarkdown: string) =>
    adminRequest<{
      title: string
      frontmatterError: string
      renderedHtml: string
      headings: Heading[]
    }>('/api/v1/admin/markdown/preview', {
      method: 'POST',
      body: JSON.stringify({ type, rawMarkdown }),
    }),

  restoreRevision: (id: string) =>
    adminRequest<{ ok: boolean; checksum: string; rawMarkdown: string }>(`/api/v1/admin/revisions/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
    }),

  createDraftPreview: (payload: { type: ContentType; slug: string; label?: string; ttlHours?: number }) =>
    adminRequest<{ id: string; token: string; previewUrl: string; expiresAt: string; label: string }>('/api/v1/admin/previews', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  revokeDraftPreview: (id: string) =>
    adminRequest<{ ok: boolean }>(`/api/v1/admin/previews/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listMedia: () => adminRequest<{ items: AssetRecord[] }>('/api/v1/admin/media'),
  uploadMedia: (file: File, altText?: string) => {
    const fd = new FormData()
    fd.append('file', file)
    if (altText) fd.append('altText', altText)
    return adminRequest<{ asset: AssetRecord }>('/api/v1/admin/media', { method: 'POST', body: fd })
  },
  listOrphanMedia: () => adminRequest<{ items: AssetRecord[] }>('/api/v1/admin/media/orphans'),
  cleanOrphanMedia: () => adminRequest<{ ok: boolean; deleted: number }>('/api/v1/admin/media/orphans/clean', { method: 'POST' }),
  deleteMedia: (id: string) => adminRequest<{ ok: boolean }>(`/api/v1/admin/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listComments: (status?: string) =>
    adminRequest<{ items: AdminCommentRecord[] }>(`/api/v1/admin/comments${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  moderateComment: (id: string, payload: { status?: string; pinned?: boolean }) =>
    adminRequest<{ ok: boolean }>(`/api/v1/admin/comments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  replyComment: (id: string, bodyMarkdown: string) =>
    adminRequest<{ ok: boolean; comment: AdminCommentRecord }>(`/api/v1/admin/comments/${encodeURIComponent(id)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ bodyMarkdown }),
    }),
  deleteComment: (id: string) => adminRequest<{ ok: boolean }>(`/api/v1/admin/comments/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listFriends: () => adminRequest<{ items: FriendLinkRecord[] }>('/api/v1/admin/friends'),
  createFriend: (payload: Partial<FriendLinkRecord>) =>
    adminRequest<{ ok: boolean; friend: FriendLinkRecord }>('/api/v1/admin/friends', { method: 'POST', body: JSON.stringify(payload) }),
  updateFriend: (id: string, payload: Partial<FriendLinkRecord>) =>
    adminRequest<{ ok: boolean; friend: FriendLinkRecord }>(`/api/v1/admin/friends/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteFriend: (id: string) => adminRequest<{ ok: boolean }>(`/api/v1/admin/friends/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  pollFriends: () => adminRequest<{ ok: boolean; checked: number; itemsUpdated: number }>('/api/v1/admin/friends/poll', { method: 'POST' }),

  listSubscribers: () => adminRequest<{ items: SubscriberRecord[] }>('/api/v1/admin/newsletter/subscribers'),
  deleteSubscriber: (id: string) =>
    adminRequest<{ ok: boolean }>(`/api/v1/admin/newsletter/subscribers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listCampaigns: () => adminRequest<{ items: NewsletterRecord[] }>('/api/v1/admin/newsletter/campaigns'),
  sendCampaign: (payload: { subject: string; bodyMarkdown: string; contentType?: string; contentSlug?: string }) =>
    adminRequest<{ ok: boolean; campaign: NewsletterRecord }>('/api/v1/admin/newsletter/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  listRedirects: () => adminRequest<{ items: RedirectRecord[] }>('/api/v1/admin/redirects'),
  createRedirect: (payload: { sourcePath: string; targetPath: string; statusCode: number }) =>
    adminRequest<{ ok: boolean; redirect: RedirectRecord }>('/api/v1/admin/redirects', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteRedirect: (id: string) => adminRequest<{ ok: boolean }>(`/api/v1/admin/redirects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getSettings: () => adminRequest<{ settings: SiteSettingsMap }>('/api/v1/admin/settings'),
  putSettings: (settings: Partial<SiteSettingsMap>) =>
    adminRequest<{ settings: SiteSettingsMap }>('/api/v1/admin/settings', { method: 'PUT', body: JSON.stringify(settings) }),

  listTokens: () => adminRequest<{ items: APITokenRecord[] }>('/api/v1/admin/tokens'),
  createToken: (payload: { name: string; scopes: string[]; expiresInDays: number }) =>
    adminRequest<{ token: string; item: APITokenRecord }>('/api/v1/admin/tokens', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  revokeToken: (id: string) => adminRequest<{ ok: boolean }>(`/api/v1/admin/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listWebhooks: () => adminRequest<{ items: WebhookRecord[] }>('/api/v1/admin/webhooks'),
  createWebhook: (payload: { name: string; targetUrl: string; events: string[]; enabled: boolean }) =>
    adminRequest<{ ok: boolean; webhook: WebhookRecord; signingSecret: string }>('/api/v1/admin/webhooks', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateWebhook: (id: string, payload: { name?: string; targetUrl?: string; events?: string[]; enabled?: boolean }) =>
    adminRequest<{ ok: boolean; webhook: WebhookRecord }>(`/api/v1/admin/webhooks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteWebhook: (id: string) => adminRequest<{ ok: boolean }>(`/api/v1/admin/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testWebhook: (id: string) =>
    adminRequest<{ ok: boolean; delivery?: WebhookDeliveryRecord; error?: string }>(`/api/v1/admin/webhooks/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
  listWebhookDeliveries: (id: string) =>
    adminRequest<{ items: WebhookDeliveryRecord[] }>(`/api/v1/admin/webhooks/${encodeURIComponent(id)}/deliveries`),

  securityOverview: () =>
    adminRequest<{
      totpEnabled: boolean
      recoveryCodesRemaining: number
      passkeys: PasskeyRecord[]
      sessions: SessionRecord[]
      currentSessionId: string
    }>('/api/v1/admin/security'),
  changePassword: (currentPassword: string, newPassword: string) =>
    adminRequest<{ ok: boolean }>('/api/v1/admin/security/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  setupTOTP: () =>
    adminRequest<{ secret: string; otpauthUrl: string; recoveryCodes: string[] }>('/api/v1/admin/security/totp/setup', {
      method: 'POST',
    }),
  verifyTOTP: (code: string) =>
    adminRequest<{ ok: boolean }>('/api/v1/admin/security/totp/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  disableTOTP: () => adminRequest<{ ok: boolean }>('/api/v1/admin/security/totp', { method: 'DELETE' }),
  deletePasskey: (id: string) => adminRequest<{ ok: boolean }>(`/api/v1/admin/security/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeSession: (id: string) => adminRequest<{ ok: boolean }>(`/api/v1/admin/security/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listBackups: () => adminRequest<{ items: BackupRecord[] }>('/api/v1/admin/backups'),
  createBackup: () => adminRequest<{ ok: boolean; backup: BackupRecord }>('/api/v1/admin/backups', { method: 'POST' }),
  restoreBackupById: (backupId: string) =>
    adminRequest<{ ok: boolean; rollbackBackup: BackupRecord }>('/api/v1/admin/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ backupId }),
    }),
  restoreBackupFile: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return adminRequest<{ ok: boolean; rollbackBackup: BackupRecord }>('/api/v1/admin/backups/restore', {
      method: 'POST',
      body: fd,
    })
  },
}
