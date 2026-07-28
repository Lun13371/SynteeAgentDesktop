/**
 * Messenger IPC handlers — bridge between renderer and the gateway messenger
 * (REST via messengerClient + WS via messengerWs).
 *
 * Renderer calls `window.syntee.messenger.*`. Real-time inbound events arrive
 * on the `messenger:event` channel (forwarded from the WS client).
 */
import { ipcMain, BrowserWindow } from 'electron'
import {
  listFriends,
  listFriendRequests,
  searchUsers,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  unfriend,
  blockUser,
  unblockUser,
  hideUser,
  unhideUser,
  listConversations,
  createConversation,
  listMessages,
  sendMessage,
  markRead,
  notifyTyping,
  setReaction,
  deleteMessage,
  searchMessages,
  uploadAttachment,
  fetchAttachment,
  createShare,
  getShare,
  markShareImported,
  listGlobalMessages,
  sendGlobalMessage,
  markGlobalRead,
  getGlobalUnread,
  setGlobalReaction,
  deleteGlobalMessage,
  createGlobalShare,
  fetchGlobalAttachment,
} from '../services/messengerClient'
import {
  connectMessenger,
  disconnectMessenger,
  sendMessengerEnvelope,
  setMessengerWindowGetter,
  setActiveConversation,
} from '../services/messengerWs'
import { packChatForShare, importChatFromShare } from '../../core/db'

export function registerMessengerIPC(getMainWindow: () => BrowserWindow | null): void {
  setMessengerWindowGetter(getMainWindow)

  // ── Connection lifecycle ──
  ipcMain.handle('messenger:connect', () => {
    connectMessenger()
    return { ok: true }
  })
  ipcMain.handle('messenger:disconnect', () => {
    disconnectMessenger()
    return { ok: true }
  })

  // ── Outbound WS envelope (dm.send / dm.read / dm.typing / dm.reaction / dm.delete) ──
  ipcMain.handle('messenger:ws:send', (_e, envelope) => {
    sendMessengerEnvelope(envelope)
    return { ok: true }
  })

  // ── Active conversation (controls tray-notification suppression) ──
  ipcMain.handle('messenger:setActive', (_e, conversationId: string | null) => {
    setActiveConversation(conversationId)
    return { ok: true }
  })

  // ── Friends ──
  ipcMain.handle('messenger:friends:list', () => listFriends())
  ipcMain.handle('messenger:friends:requests', () => listFriendRequests())
  ipcMain.handle('messenger:friends:search', (_e, email: string) => searchUsers(email))
  ipcMain.handle('messenger:friends:request', (_e, email: string) => sendFriendRequest(email))
  ipcMain.handle('messenger:friends:accept', (_e, userId: string) => acceptFriendRequest(userId))
  ipcMain.handle('messenger:friends:decline', (_e, userId: string) => declineFriendRequest(userId))
  ipcMain.handle('messenger:friends:unfriend', (_e, userId: string) => unfriend(userId))
  ipcMain.handle('messenger:friends:block', (_e, userId: string) => blockUser(userId))
  ipcMain.handle('messenger:friends:unblock', (_e, userId: string) => unblockUser(userId))
  ipcMain.handle('messenger:friends:hide', (_e, userId: string) => hideUser(userId))
  ipcMain.handle('messenger:friends:unhide', (_e, userId: string) => unhideUser(userId))

  // ── Conversations & messages ──
  ipcMain.handle('messenger:conversations:list', () => listConversations())
  ipcMain.handle('messenger:conversations:create', (_e, otherId: string) => createConversation(otherId))
  ipcMain.handle(
    'messenger:messages:list',
    (_e, conversationId: string, cursor?: string | null, limit?: number) =>
      listMessages(conversationId, cursor, limit),
  )
  ipcMain.handle('messenger:messages:send', (_e, conversationId: string, payload: unknown) =>
    sendMessage(conversationId, payload as Parameters<typeof sendMessage>[1]),
  )
  ipcMain.handle('messenger:messages:read', (_e, conversationId: string, messageId: string) =>
    markRead(conversationId, messageId),
  )
  ipcMain.handle('messenger:messages:typing', (_e, conversationId: string) =>
    notifyTyping(conversationId),
  )
  ipcMain.handle(
    'messenger:messages:react',
    (_e, conversationId: string, messageId: string, emoji: string) =>
      setReaction(conversationId, messageId, emoji),
  )
  ipcMain.handle('messenger:messages:delete', (_e, conversationId: string, messageId: string) =>
    deleteMessage(conversationId, messageId),
  )
  ipcMain.handle('messenger:messages:search', (_e, q: string, conversationId?: string) =>
    searchMessages(q, conversationId),
  )

  // ── Attachments ──
  // Upload: renderer passes a File (from <input type=file> or drag&drop).
  // The File object crosses the preload boundary fine (it's a structured-clone
  // candidate; ipcRenderer.invoke serialises it).
  ipcMain.handle('messenger:attachments:upload', (_e, file: File) => uploadAttachment(file))
  // Fetch bytes: renderer gets an ArrayBuffer and builds a Blob URL.
  ipcMain.handle(
    'messenger:attachments:fetch',
    (_e, conversationId: string, messageId: string) =>
      fetchAttachment(conversationId, messageId),
  )

  // ── Шаринг чатов (Фаза 3) ──
  // shareChat: упаковывает чат (chat + messages + working memory + summary)
  // через packChatForShare, отправляет на гетвей как SharedChat, который
  // создаёт DM с message_type=chat_share и fanout'ит через WS получателю.
  // importShare: тянет JSONB-снапшот с гетвея, импортирует в локальную SQLite
  // через importChatFromShare, помечает шар импортированным.
  ipcMain.handle(
    'messenger:shareChat',
    async (_e, chatId: string, recipientId: string) => {
      const snapshot = packChatForShare(chatId)
      if (!snapshot) return { error: 'Чат не найден' }
      try {
        const row = await createShare({
          recipient_id: recipientId,
          conversation_id: recipientId,
          title: snapshot.chat.title,
          message_count: snapshot.messages.length,
          snapshot: snapshot as unknown as Record<string, unknown>,
        })
        return { ok: true, share: row }
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Ошибка шаринга' }
      }
    },
  )
  ipcMain.handle(
    'messenger:importShare',
    async (_e, shareId: string) => {
      try {
        const detail = await getShare(shareId)
        const result = importChatFromShare(
          detail.snapshot as unknown as Parameters<typeof importChatFromShare>[0],
        )
        if ('error' in result) return result
        await markShareImported(shareId)
        return result
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Ошибка импорта' }
      }
    },
  )

  // ── Общий чат (Lounge, Фаза 2) ──
  ipcMain.handle(
    'messenger:global:list',
    (_e, cursor?: string | null, limit?: number) =>
      listGlobalMessages(cursor ?? null, limit ?? 50),
  )
  ipcMain.handle('messenger:global:send', (_e, payload: unknown) =>
    sendGlobalMessage(payload as Parameters<typeof sendGlobalMessage>[0]),
  )
  ipcMain.handle('messenger:global:read', (_e, messageId: string) =>
    markGlobalRead(messageId),
  )
  ipcMain.handle('messenger:global:unread', () => getGlobalUnread())
  ipcMain.handle('messenger:global:react', (_e, messageId: string, emoji: string) =>
    setGlobalReaction(messageId, emoji),
  )
  ipcMain.handle('messenger:global:delete', (_e, messageId: string) =>
    deleteGlobalMessage(messageId),
  )
  ipcMain.handle('messenger:global:typing', () =>
    sendMessengerEnvelope({ type: 'global.typing', data: {} }),
  )
  ipcMain.handle('messenger:global:fetchAttachment', (_e, messageId: string) =>
    fetchGlobalAttachment(messageId),
  )
  ipcMain.handle(
    'messenger:global:shareChat',
    async (_e, chatId: string) => {
      const snapshot = packChatForShare(chatId)
      if (!snapshot) return { error: 'Чат не найден' }
      try {
        const msg = await createGlobalShare({
          title: snapshot.chat.title,
          message_count: snapshot.messages.length,
          snapshot: snapshot as unknown as Record<string, unknown>,
        })
        return { ok: true, message: msg }
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Ошибка шаринга' }
      }
    },
  )
}
