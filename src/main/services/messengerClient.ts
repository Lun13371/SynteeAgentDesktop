/**
 * REST client for the Syntee-Gateway messenger API.
 *
 * All calls go through gatewayClient.request (JWT bearer + auto-refresh-on-401).
 * Real-time delivery is handled by messengerWs.ts (WebSocket); this module
 * covers the read/sync paths and mutations that are awkward over WS
 * (paginated reads, file uploads, friend search).
 */
import { request, getGatewayApiUrl } from './gatewayClient'

export interface UserBrief {
  id: string
  email: string
  username?: string | null
  display_name?: string | null
  avatar_url?: string | null
}

export interface ReactionOut {
  user_id: string
  emoji: string
}

export interface MessageResponse {
  id: string
  conversation_id: string
  sender_id: string
  message_type: 'text' | 'code' | 'image' | 'file' | 'chat_share'
  body?: string | null
  has_attachment: boolean
  attachment_token?: string | null
  attachment_filename?: string | null
  attachment_mime?: string | null
  attachment_size?: number | null
  reply_to_id?: string | null
  created_at: string
  deleted: boolean
  reactions: ReactionOut[]
}

export interface ConversationResponse {
  id: string
  other_user: UserBrief
  last_message: MessageResponse | null
  last_message_at: string | null
  unread_count: number
  other_online: boolean
  other_typing: boolean
}

export interface AttachmentUploadResponse {
  token: string
  filename: string
  mime: string
  size: number
}

export interface FriendResponse {
  id: string
  user: UserBrief
  status: string
  direction: string
}

// ── Friends ──────────────────────────────────────────────────────────────

export async function listFriends(): Promise<UserBrief[]> {
  return request<UserBrief[]>('/api/user/friends')
}

export async function listFriendRequests(): Promise<FriendResponse[]> {
  return request<FriendResponse[]>('/api/user/friends/requests')
}

export async function searchUsers(username: string): Promise<UserBrief[]> {
  const data = await request<{ results: UserBrief[] }>(
    `/api/user/friends/search?username=${encodeURIComponent(username)}`,
  )
  return data.results
}

export async function sendFriendRequest(username: string): Promise<UserBrief> {
  return request<UserBrief>('/api/user/friends/request', { method: 'POST', body: { username } })
}

export async function acceptFriendRequest(userId: string): Promise<UserBrief> {
  return request<UserBrief>(`/api/user/friends/${userId}/accept`, { method: 'POST' })
}

export async function declineFriendRequest(userId: string): Promise<void> {
  await request(`/api/user/friends/${userId}/decline`, { method: 'POST' })
}

export async function unfriend(userId: string): Promise<void> {
  await request(`/api/user/friends/${userId}`, { method: 'DELETE' })
}

export async function blockUser(userId: string): Promise<void> {
  await request('/api/user/friends/block', { method: 'POST', body: { user_id: userId } })
}

export async function unblockUser(userId: string): Promise<void> {
  await request(`/api/user/friends/block/${userId}`, { method: 'DELETE' })
}

export async function hideUser(userId: string): Promise<void> {
  await request('/api/user/friends/hide', { method: 'POST', body: { user_id: userId } })
}

export async function unhideUser(userId: string): Promise<void> {
  await request(`/api/user/friends/hide/${userId}`, { method: 'DELETE' })
}

// ── Conversations & messages ─────────────────────────────────────────────

export async function listConversations(): Promise<ConversationResponse[]> {
  const data = await request<{ conversations: ConversationResponse[] }>('/api/user/conversations')
  return data.conversations
}

export async function createConversation(otherId: string): Promise<ConversationResponse> {
  return request<ConversationResponse>(`/api/user/conversations?other_id=${encodeURIComponent(otherId)}`, {
    method: 'POST',
  })
}

export async function listMessages(
  conversationId: string,
  cursor?: string | null,
  limit = 50,
): Promise<{ messages: MessageResponse[]; next_cursor: string | null; has_more: boolean }> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  params.set('limit', String(limit))
  return request(`/api/user/conversations/${conversationId}/messages?${params.toString()}`)
}

export interface SendMessagePayload {
  message_type?: 'text' | 'code' | 'image' | 'file'
  body?: string | null
  attachment_token?: string | null
  attachment_filename?: string | null
  attachment_mime?: string | null
  attachment_size?: number | null
  reply_to_id?: string | null
}

export async function sendMessage(conversationId: string, payload: SendMessagePayload): Promise<MessageResponse> {
  return request<MessageResponse>(`/api/user/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: payload,
  })
}

export async function markRead(conversationId: string, messageId: string): Promise<void> {
  await request(`/api/user/conversations/${conversationId}/read`, {
    method: 'POST',
    body: { message_id: messageId },
  })
}

export async function notifyTyping(conversationId: string): Promise<void> {
  await request(`/api/user/conversations/${conversationId}/typing`, { method: 'POST' })
}

export async function setReaction(
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<{ added: boolean }> {
  return request(`/api/user/conversations/${conversationId}/messages/${messageId}/reactions`, {
    method: 'POST',
    body: { emoji },
  })
}

export async function deleteMessage(conversationId: string, messageId: string): Promise<void> {
  await request(`/api/user/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' })
}

export async function searchMessages(
  q: string,
  conversationId?: string,
): Promise<MessageResponse[]> {
  const params = new URLSearchParams({ q })
  if (conversationId) params.set('conversation_id', conversationId)
  const data = await request<{ results: MessageResponse[] }>(`/api/user/messages/search?${params.toString()}`)
  return data.results
}

// ── Attachments ──────────────────────────────────────────────────────────

export async function uploadAttachment(file: File): Promise<AttachmentUploadResponse> {
  const formData = new FormData()
  formData.append('file', file)
  // Use fetch directly — gatewayClient.request always sends JSON.
  const base = getGatewayApiUrl()
  // Lazy import tokenStore to avoid circular concerns.
  const { getAccessToken } = await import('./tokenStore')
  const token = getAccessToken()
  const res = await fetch(`${base}/api/user/messenger/uploads`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const errBody = (await res.json()) as { detail?: string }
      detail = errBody.detail ?? detail
    } catch { /* keep default */ }
    throw new Error(detail)
  }
  return (await res.json()) as AttachmentUploadResponse
}

/** Fetch an attachment's bytes (authed). Renderer wraps in a Blob URL. */
export async function fetchAttachment(conversationId: string, messageId: string): Promise<ArrayBuffer> {
  return request<ArrayBuffer>(
    `/api/user/conversations/${conversationId}/messages/${messageId}/attachment`,
    { responseType: 'bytes' },
  )
}

// ── Chat sharing (Phase 3) ────────────────────────────────────────────────

export interface SharedChatRow {
  id: string
  owner_id: string
  recipient_id: string
  conversation_id: string | null
  message_id: string | null
  title: string
  message_count: number
  imported_at: string | null
  created_at: string
}

export interface SharedChatDetail extends SharedChatRow {
  snapshot: Record<string, unknown>
}

export async function createShare(payload: {
  recipient_id: string
  conversation_id: string
  title: string
  message_count: number
  snapshot: Record<string, unknown>
}): Promise<SharedChatRow> {
  return request<SharedChatRow>('/api/user/shares', { method: 'POST', body: payload })
}

export async function listShareInbox(): Promise<SharedChatRow[]> {
  return request<SharedChatRow[]>('/api/user/shares/inbox')
}

export async function getShare(shareId: string): Promise<SharedChatDetail> {
  return request<SharedChatDetail>(`/api/user/shares/${shareId}`)
}

export async function markShareImported(shareId: string): Promise<void> {
  await request(`/api/user/shares/${shareId}/import`, { method: 'POST' })
}

// ── Global Lounge chat (Phase 2) ──────────────────────────────────────────

export interface GlobalMessageResponse {
  id: string
  sender_id: string
  sender: UserBrief | null
  message_type: 'text' | 'code' | 'image' | 'file' | 'chat_share'
  body?: string | null
  has_attachment: boolean
  attachment_token?: string | null
  attachment_filename?: string | null
  attachment_mime?: string | null
  attachment_size?: number | null
  reply_to_id?: string | null
  created_at: string
  deleted: boolean
  reactions: ReactionOut[]
}

export async function listGlobalMessages(
  cursor?: string | null,
  limit = 50,
): Promise<{ messages: GlobalMessageResponse[]; next_cursor: string | null; has_more: boolean }> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  params.set('limit', String(limit))
  return request(`/api/user/global/messages?${params.toString()}`)
}

export async function sendGlobalMessage(payload: SendMessagePayload): Promise<GlobalMessageResponse> {
  return request<GlobalMessageResponse>('/api/user/global/messages', {
    method: 'POST',
    body: payload,
  })
}

export async function markGlobalRead(messageId: string): Promise<void> {
  await request('/api/user/global/read', {
    method: 'POST',
    body: { message_id: messageId },
  })
}

export async function getGlobalUnread(): Promise<number> {
  const data = await request<{ unread_count: number }>('/api/user/global/unread')
  return data.unread_count
}

export async function setGlobalReaction(messageId: string, emoji: string): Promise<{ added: boolean }> {
  return request(`/api/user/global/messages/${messageId}/reactions`, {
    method: 'POST',
    body: { emoji },
  })
}

export async function deleteGlobalMessage(messageId: string): Promise<void> {
  await request(`/api/user/global/messages/${messageId}`, { method: 'DELETE' })
}

export async function createGlobalShare(payload: {
  title: string
  message_count: number
  snapshot: Record<string, unknown>
}): Promise<GlobalMessageResponse> {
  return request<GlobalMessageResponse>('/api/user/global/shares', {
    method: 'POST',
    body: payload,
  })
}

export async function fetchGlobalAttachment(messageId: string): Promise<ArrayBuffer> {
  return request<ArrayBuffer>(
    `/api/user/global/messages/${messageId}/attachment`,
    { responseType: 'bytes' },
  )
}
