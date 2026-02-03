import { Express, Request, Response, NextFunction } from 'express'
import { AppContext } from '../config'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'

// ============================================
// TYPES (matching Bluesky chat schema)
// ============================================

// Facet for rich text (links, mentions)
interface RichtextFacet {
  index: { byteStart: number; byteEnd: number }
  features: Array<{ $type: string; [key: string]: unknown }>
}

// Member profile view (minimal, will be hydrated client-side)
interface ProfileViewBasic {
  did: string
  handle: string
  displayName?: string
  avatar?: string
}

// Message view (matches ChatBskyConvoDefs.MessageView)
interface MessageView {
  $type: 'chat.bsky.convo.defs#messageView'
  id: string
  rev: string
  text: string
  facets?: RichtextFacet[]
  embed?: unknown
  reactions?: Array<{ value: string; sender: { did: string } }>
  sender: { did: string }
  sentAt: string
}

// Deleted message view
interface DeletedMessageView {
  $type: 'chat.bsky.convo.defs#deletedMessageView'
  id: string
  rev: string
  sender: { did: string }
  sentAt: string
}

// Conversation view (matches ChatBskyConvoDefs.ConvoView)
interface ConvoView {
  id: string
  rev: string
  members: ProfileViewBasic[]
  lastMessage?: MessageView | DeletedMessageView
  muted: boolean
  status: 'accepted' | 'request'
  unreadCount: number
}

// Log event types
type LogEvent =
  | { $type: 'chat.bsky.convo.defs#logCreateMessage'; rev: string; convoId: string; message: MessageView }
  | { $type: 'chat.bsky.convo.defs#logDeleteMessage'; rev: string; convoId: string; message: DeletedMessageView }
  | { $type: 'chat.bsky.convo.defs#logReadConvo'; rev: string; convoId: string }

// ============================================
// UTILITIES
// ============================================

/**
 * Generate monotonically increasing, collision-resistant revision ID
 * Format: timestamp(base36) + random(hex)
 */
function generateRev(): string {
  const timestamp = Date.now().toString(36)
  const random = crypto.randomBytes(4).toString('hex')
  return `${timestamp}${random}`
}

/**
 * Get current ISO timestamp
 */
function now(): string {
  return new Date().toISOString()
}

/**
 * Build a MessageView from a database message record
 */
async function buildMessageView(ctx: AppContext, message: any): Promise<MessageView> {
  let reactions: Array<{ value: string; sender: { did: string } }> | undefined
  if (message.reactions) {
    try {
      reactions = JSON.parse(message.reactions)
    } catch {
      reactions = undefined
    }
  }

  return {
    $type: 'chat.bsky.convo.defs#messageView',
    id: message.id,
    rev: message.rev,
    text: message.text,
    facets: message.facets ? JSON.parse(message.facets) : undefined,
    sender: { did: message.senderDid },
    sentAt: message.createdAt,
    reactions,
  }
}

// Rate limiting (reuse pattern from get-reactions.ts)
const rateLimitStore = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 200 // 200 requests per minute for chat

function rateLimit(identifier: string): boolean {
  const nowMs = Date.now()
  const record = rateLimitStore.get(identifier)

  if (!record || record.resetAt < nowMs) {
    rateLimitStore.set(identifier, { count: 1, resetAt: nowMs + RATE_LIMIT_WINDOW })
    return true
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false
  }

  record.count++
  return true
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const nowMs = Date.now()
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetAt < nowMs) {
      rateLimitStore.delete(key)
    }
  }
}, 60 * 1000)

// ============================================
// MIDDLEWARE
// ============================================

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const identifier = req.ip || 'unknown'
  if (!rateLimit(identifier)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' })
  }
  next()
}

/**
 * Auth middleware that extracts and validates user DID
 * For now, we trust the X-User-Did header (will add JWT validation in production)
 * TODO: Implement proper service auth token validation
 */
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const userDid = req.headers['x-user-did'] as string

  if (!userDid || !userDid.startsWith('did:')) {
    return res.status(401).json({ error: 'Missing or invalid X-User-Did header' })
  }

  // Attach to request for handlers
  ;(req as any).userDid = userDid
  next()
}

// ============================================
// MAIN EXPORT
// ============================================

export default function (app: Express, ctx: AppContext) {
  // Apply middleware to all chat routes
  app.use('/chat', rateLimitMiddleware)
  app.use('/chat', authMiddleware)

  // ========================================
  // GET /chat/convo/list - List conversations
  // ========================================
  app.get('/chat/convo/list', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
      const cursor = req.query.cursor as string | undefined

      // Get user's conversations with latest message
      const memberships = await ctx.db
        .selectFrom('conversation_member')
        .innerJoin('conversation', 'conversation.id', 'conversation_member.conversationId')
        .select([
          'conversation.id',
          'conversation.updatedAt',
          'conversation_member.lastReadRev',
          'conversation_member.muted',
          'conversation_member.status',
        ])
        .where('conversation_member.memberDid', '=', userDid)
        .where('conversation_member.status', '!=', 'left')
        .orderBy('conversation.updatedAt', 'desc')
        .$if(!!cursor, (qb) => qb.where('conversation.updatedAt', '<', cursor!))
        .limit(limit + 1)
        .execute()

      const hasMore = memberships.length > limit
      const results = hasMore ? memberships.slice(0, limit) : memberships

      // Hydrate each conversation
      const convos: ConvoView[] = await Promise.all(
        results.map(async (m) => {
          // Get all members of this conversation
          const members = await ctx.db
            .selectFrom('conversation_member')
            .leftJoin('raceef_user', 'raceef_user.did', 'conversation_member.memberDid')
            .select([
              'conversation_member.memberDid as did',
              'raceef_user.handle',
              'raceef_user.displayName',
              'raceef_user.avatar',
            ])
            .where('conversation_member.conversationId', '=', m.id)
            .where('conversation_member.status', '!=', 'left')
            .execute()

          // Get last message
          const lastMessageRow = await ctx.db
            .selectFrom('message')
            .selectAll()
            .where('conversationId', '=', m.id)
            .orderBy('rev', 'desc')
            .limit(1)
            .executeTakeFirst()

          // Get unread count
          const unreadResult = await ctx.db
            .selectFrom('message')
            .select(ctx.db.fn.count('id').as('count'))
            .where('conversationId', '=', m.id)
            .where('deletedAt', 'is', null)
            .$if(!!m.lastReadRev, (qb) => qb.where('rev', '>', m.lastReadRev!))
            .executeTakeFirst()

          const unreadCount = m.lastReadRev ? Number(unreadResult?.count || 0) : 0

          let lastMessage: MessageView | DeletedMessageView | undefined
          if (lastMessageRow) {
            if (lastMessageRow.deletedAt) {
              lastMessage = {
                $type: 'chat.bsky.convo.defs#deletedMessageView',
                id: lastMessageRow.id,
                rev: lastMessageRow.rev,
                sender: { did: lastMessageRow.senderDid },
                sentAt: lastMessageRow.createdAt,
              }
            } else {
              lastMessage = {
                $type: 'chat.bsky.convo.defs#messageView',
                id: lastMessageRow.id,
                rev: lastMessageRow.rev,
                text: lastMessageRow.text,
                facets: lastMessageRow.facets ? JSON.parse(lastMessageRow.facets) : undefined,
                sender: { did: lastMessageRow.senderDid },
                sentAt: lastMessageRow.createdAt,
              }
            }
          }

          // Get latest rev for the conversation
          const latestEvent = await ctx.db
            .selectFrom('message_event')
            .select('rev')
            .where('conversationId', '=', m.id)
            .orderBy('rev', 'desc')
            .limit(1)
            .executeTakeFirst()

          return {
            id: m.id,
            rev: latestEvent?.rev || m.updatedAt,
            members: members.map((member) => ({
              did: member.did,
              handle: member.handle || member.did.split(':').pop() || 'unknown',
              displayName: member.displayName || undefined,
              avatar: member.avatar || undefined,
            })),
            lastMessage,
            muted: m.muted === 1,
            status: m.status as 'accepted' | 'request',
            unreadCount,
          }
        })
      )

      const nextCursor = hasMore ? results[results.length - 1].updatedAt : undefined

      return res.json({
        convos,
        cursor: nextCursor,
      })
    } catch (error) {
      console.error('[Raceef Chat] Error listing conversations:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // GET /chat/convo/log - Get event log for polling (CRITICAL)
  // NOTE: This route MUST come before /chat/convo/:id to avoid matching 'log' as an ID
  // ========================================
  app.get('/chat/convo/log', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const cursor = req.query.cursor as string | undefined

      // Get user's conversation IDs
      const memberships = await ctx.db
        .selectFrom('conversation_member')
        .select('conversationId')
        .where('memberDid', '=', userDid)
        .where('status', '!=', 'left')
        .execute()

      const convoIds = memberships.map((m) => m.conversationId)

      if (convoIds.length === 0) {
        return res.json({ logs: [], cursor: undefined })
      }

      // Get events since cursor
      const events = await ctx.db
        .selectFrom('message_event')
        .selectAll()
        .where('conversationId', 'in', convoIds)
        .$if(!!cursor, (qb) => qb.where('rev', '>', cursor!))
        .orderBy('rev', 'asc')
        .limit(100)
        .execute()

      const logs: LogEvent[] = events.map((e) => JSON.parse(e.payload))
      const newCursor = events.length > 0 ? events[events.length - 1].rev : cursor

      return res.json({
        logs,
        cursor: newCursor,
      })
    } catch (error) {
      console.error('[Raceef Chat] Error getting log:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // GET /chat/convo/:id - Get single conversation
  // ========================================
  app.get('/chat/convo/:id', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const convoId = req.params.id

      // Verify user is a member
      const membership = await ctx.db
        .selectFrom('conversation_member')
        .selectAll()
        .where('conversationId', '=', convoId)
        .where('memberDid', '=', userDid)
        .where('status', '!=', 'left')
        .executeTakeFirst()

      if (!membership) {
        return res.status(404).json({ error: 'Conversation not found' })
      }

      // Get all members
      const members = await ctx.db
        .selectFrom('conversation_member')
        .leftJoin('raceef_user', 'raceef_user.did', 'conversation_member.memberDid')
        .select([
          'conversation_member.memberDid as did',
          'raceef_user.handle',
          'raceef_user.displayName',
          'raceef_user.avatar',
        ])
        .where('conversation_member.conversationId', '=', convoId)
        .where('conversation_member.status', '!=', 'left')
        .execute()

      // Get last message
      const lastMessageRow = await ctx.db
        .selectFrom('message')
        .selectAll()
        .where('conversationId', '=', convoId)
        .orderBy('rev', 'desc')
        .limit(1)
        .executeTakeFirst()

      // Get unread count
      const unreadResult = await ctx.db
        .selectFrom('message')
        .select(ctx.db.fn.count('id').as('count'))
        .where('conversationId', '=', convoId)
        .where('deletedAt', 'is', null)
        .$if(!!membership.lastReadRev, (qb) => qb.where('rev', '>', membership.lastReadRev!))
        .executeTakeFirst()

      const unreadCount = membership.lastReadRev ? Number(unreadResult?.count || 0) : 0

      let lastMessage: MessageView | DeletedMessageView | undefined
      if (lastMessageRow) {
        if (lastMessageRow.deletedAt) {
          lastMessage = {
            $type: 'chat.bsky.convo.defs#deletedMessageView',
            id: lastMessageRow.id,
            rev: lastMessageRow.rev,
            sender: { did: lastMessageRow.senderDid },
            sentAt: lastMessageRow.createdAt,
          }
        } else {
          lastMessage = {
            $type: 'chat.bsky.convo.defs#messageView',
            id: lastMessageRow.id,
            rev: lastMessageRow.rev,
            text: lastMessageRow.text,
            facets: lastMessageRow.facets ? JSON.parse(lastMessageRow.facets) : undefined,
            sender: { did: lastMessageRow.senderDid },
            sentAt: lastMessageRow.createdAt,
          }
        }
      }

      // Get latest rev
      const latestEvent = await ctx.db
        .selectFrom('message_event')
        .select('rev')
        .where('conversationId', '=', convoId)
        .orderBy('rev', 'desc')
        .limit(1)
        .executeTakeFirst()

      const convo: ConvoView = {
        id: convoId,
        rev: latestEvent?.rev || membership.joinedAt,
        members: members.map((m) => ({
          did: m.did,
          handle: m.handle || m.did.split(':').pop() || 'unknown',
          displayName: m.displayName || undefined,
          avatar: m.avatar || undefined,
        })),
        lastMessage,
        muted: membership.muted === 1,
        status: membership.status as 'accepted' | 'request',
        unreadCount,
      }

      return res.json({ convo })
    } catch (error) {
      console.error('[Raceef Chat] Error getting conversation:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // POST /chat/convo/getOrCreate - Find or create conversation by members
  // ========================================
  app.post('/chat/convo/getOrCreate', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const { members: memberDids } = req.body as { members: string[] }

      if (!memberDids || !Array.isArray(memberDids) || memberDids.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid members array' })
      }

      // Ensure current user is in the list
      const allMembers = Array.from(new Set([userDid, ...memberDids]))

      // For 1:1 chats, try to find existing conversation
      if (allMembers.length === 2) {
        // Find conversations where both users are members
        const existingConvos = await ctx.db
          .selectFrom('conversation_member as cm1')
          .innerJoin('conversation_member as cm2', 'cm1.conversationId', 'cm2.conversationId')
          .select('cm1.conversationId')
          .where('cm1.memberDid', '=', allMembers[0])
          .where('cm2.memberDid', '=', allMembers[1])
          .where('cm1.status', '!=', 'left')
          .where('cm2.status', '!=', 'left')
          .execute()

        // Check each to find one with exactly 2 members (1:1 chat)
        for (const { conversationId } of existingConvos) {
          const memberCount = await ctx.db
            .selectFrom('conversation_member')
            .select(ctx.db.fn.count('memberDid').as('count'))
            .where('conversationId', '=', conversationId)
            .where('status', '!=', 'left')
            .executeTakeFirst()

          if (Number(memberCount?.count) === 2) {
            // Found existing 1:1 conversation, return it
            const getRes = await fetch(`http://localhost:${ctx.cfg.port}/chat/convo/${conversationId}`, {
              headers: { 'x-user-did': userDid },
            })
            const data = await getRes.json()
            return res.json(data)
          }
        }
      }

      // Create new conversation
      const convoId = uuidv4()
      const timestamp = now()

      await ctx.db
        .insertInto('conversation')
        .values({
          id: convoId,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .execute()

      // Add all members
      for (const memberDid of allMembers) {
        await ctx.db
          .insertInto('conversation_member')
          .values({
            conversationId: convoId,
            memberDid,
            joinedAt: timestamp,
            lastReadRev: null,
            muted: 0,
            status: memberDid === userDid ? 'accepted' : 'request',
          })
          .execute()
      }

      // Get members with profile info
      const members = await ctx.db
        .selectFrom('conversation_member')
        .leftJoin('raceef_user', 'raceef_user.did', 'conversation_member.memberDid')
        .select([
          'conversation_member.memberDid as did',
          'raceef_user.handle',
          'raceef_user.displayName',
          'raceef_user.avatar',
        ])
        .where('conversation_member.conversationId', '=', convoId)
        .execute()

      const convo: ConvoView = {
        id: convoId,
        rev: timestamp,
        members: members.map((m) => ({
          did: m.did,
          handle: m.handle || m.did.split(':').pop() || 'unknown',
          displayName: m.displayName || undefined,
          avatar: m.avatar || undefined,
        })),
        muted: false,
        status: 'accepted',
        unreadCount: 0,
      }

      return res.json({ convo })
    } catch (error) {
      console.error('[Raceef Chat] Error creating conversation:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // GET /chat/convo/:id/messages - Get messages
  // ========================================
  app.get('/chat/convo/:id/messages', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const convoId = req.params.id
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
      const cursor = req.query.cursor as string | undefined

      // Verify user is a member
      const membership = await ctx.db
        .selectFrom('conversation_member')
        .select('memberDid')
        .where('conversationId', '=', convoId)
        .where('memberDid', '=', userDid)
        .where('status', '!=', 'left')
        .executeTakeFirst()

      if (!membership) {
        return res.status(404).json({ error: 'Conversation not found' })
      }

      // Get messages
      const messages = await ctx.db
        .selectFrom('message')
        .selectAll()
        .where('conversationId', '=', convoId)
        .orderBy('rev', 'desc')
        .$if(!!cursor, (qb) => qb.where('rev', '<', cursor!))
        .limit(limit + 1)
        .execute()

      const hasMore = messages.length > limit
      const results = hasMore ? messages.slice(0, limit) : messages

      const messageViews: (MessageView | DeletedMessageView)[] = results.map((m) => {
        if (m.deletedAt) {
          return {
            $type: 'chat.bsky.convo.defs#deletedMessageView' as const,
            id: m.id,
            rev: m.rev,
            sender: { did: m.senderDid },
            sentAt: m.createdAt,
          }
        }
        let reactions: Array<{ value: string; sender: { did: string } }> | undefined
        if (m.reactions) {
          try {
            reactions = JSON.parse(m.reactions)
          } catch {
            reactions = undefined
          }
        }
        return {
          $type: 'chat.bsky.convo.defs#messageView' as const,
          id: m.id,
          rev: m.rev,
          text: m.text,
          facets: m.facets ? JSON.parse(m.facets) : undefined,
          sender: { did: m.senderDid },
          sentAt: m.createdAt,
          reactions,
        }
      })

      const nextCursor = hasMore ? results[results.length - 1].rev : undefined

      return res.json({
        messages: messageViews,
        cursor: nextCursor,
      })
    } catch (error) {
      console.error('[Raceef Chat] Error getting messages:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // POST /chat/convo/:id/message - Send message
  // ========================================
  app.post('/chat/convo/:id/message', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const convoId = req.params.id
      const { message } = req.body as {
        message: { text: string; facets?: RichtextFacet[] }
      }

      if (!message || typeof message.text !== 'string' || message.text.trim() === '') {
        return res.status(400).json({ error: 'Message text is required' })
      }

      // Verify user is a member and accepted
      const membership = await ctx.db
        .selectFrom('conversation_member')
        .select(['status'])
        .where('conversationId', '=', convoId)
        .where('memberDid', '=', userDid)
        .executeTakeFirst()

      if (!membership) {
        return res.status(404).json({ error: 'Conversation not found' })
      }

      if (membership.status === 'left') {
        return res.status(403).json({ error: 'You have left this conversation' })
      }

      // Create message
      const messageId = uuidv4()
      const rev = generateRev()
      const timestamp = now()

      await ctx.db
        .insertInto('message')
        .values({
          id: messageId,
          conversationId: convoId,
          senderDid: userDid,
          text: message.text,
          facets: message.facets ? JSON.stringify(message.facets) : null,
          embed: null,
          rev,
          createdAt: timestamp,
          deletedAt: null,
        })
        .execute()

      // Update conversation timestamp
      await ctx.db
        .updateTable('conversation')
        .set({ updatedAt: timestamp })
        .where('id', '=', convoId)
        .execute()

      // Create event log entry
      const messageView: MessageView = {
        $type: 'chat.bsky.convo.defs#messageView',
        id: messageId,
        rev,
        text: message.text,
        facets: message.facets,
        sender: { did: userDid },
        sentAt: timestamp,
      }

      await ctx.db
        .insertInto('message_event')
        .values({
          conversationId: convoId,
          eventType: 'message',
          payload: JSON.stringify({
            $type: 'chat.bsky.convo.defs#logCreateMessage',
            rev,
            convoId,
            message: messageView,
          }),
          rev,
          createdAt: timestamp,
        })
        .execute()

      // Auto-mark as read for sender
      await ctx.db
        .updateTable('conversation_member')
        .set({ lastReadRev: rev })
        .where('conversationId', '=', convoId)
        .where('memberDid', '=', userDid)
        .execute()

      return res.json(messageView)
    } catch (error) {
      console.error('[Raceef Chat] Error sending message:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // DELETE /chat/convo/:convoId/message/:messageId - Delete message
  // ========================================
  app.delete('/chat/convo/:convoId/message/:messageId', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const { convoId, messageId } = req.params

      // Get message and verify ownership
      const message = await ctx.db
        .selectFrom('message')
        .selectAll()
        .where('id', '=', messageId)
        .where('conversationId', '=', convoId)
        .executeTakeFirst()

      if (!message) {
        return res.status(404).json({ error: 'Message not found' })
      }

      if (message.senderDid !== userDid) {
        return res.status(403).json({ error: 'You can only delete your own messages' })
      }

      // Soft delete
      const rev = generateRev()
      const timestamp = now()

      await ctx.db
        .updateTable('message')
        .set({ deletedAt: timestamp })
        .where('id', '=', messageId)
        .execute()

      // Create delete event
      const deletedView: DeletedMessageView = {
        $type: 'chat.bsky.convo.defs#deletedMessageView',
        id: messageId,
        rev: message.rev,
        sender: { did: message.senderDid },
        sentAt: message.createdAt,
      }

      await ctx.db
        .insertInto('message_event')
        .values({
          conversationId: convoId,
          eventType: 'delete',
          payload: JSON.stringify({
            $type: 'chat.bsky.convo.defs#logDeleteMessage',
            rev,
            convoId,
            message: deletedView,
          }),
          rev,
          createdAt: timestamp,
        })
        .execute()

      return res.json(deletedView)
    } catch (error) {
      console.error('[Raceef Chat] Error deleting message:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // POST /chat/convo/:convoId/message/:messageId/reaction - Add reaction
  // ========================================
  app.post('/chat/convo/:convoId/message/:messageId/reaction', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const { convoId, messageId } = req.params
      const { value } = req.body as { value: string }

      if (!value || typeof value !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid reaction value' })
      }

      // Verify membership
      const membership = await ctx.db
        .selectFrom('conversation_member')
        .selectAll()
        .where('conversationId', '=', convoId)
        .where('memberDid', '=', userDid)
        .where('status', '!=', 'left')
        .executeTakeFirst()

      if (!membership) {
        return res.status(403).json({ error: 'Not a member of this conversation' })
      }

      // Get message
      const message = await ctx.db
        .selectFrom('message')
        .selectAll()
        .where('id', '=', messageId)
        .where('conversationId', '=', convoId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst()

      if (!message) {
        return res.status(404).json({ error: 'Message not found' })
      }

      // Parse existing reactions
      let reactions: Array<{ value: string; sender: { did: string } }> = []
      if (message.reactions) {
        try {
          reactions = JSON.parse(message.reactions)
        } catch {
          reactions = []
        }
      }

      // Check if user already reacted with this value
      const existingIndex = reactions.findIndex(
        r => r.sender.did === userDid && r.value === value
      )
      if (existingIndex >= 0) {
        // Already exists, return current state
        const messageView = await buildMessageView(ctx, message)
        return res.json({ message: messageView })
      }

      // Check max reactions per user (5)
      const userReactions = reactions.filter(r => r.sender.did === userDid)
      if (userReactions.length >= 5) {
        return res.status(400).json({ error: 'Maximum reactions reached' })
      }

      // Add reaction
      reactions.push({ value, sender: { did: userDid } })

      // Update message
      const timestamp = now()
      await ctx.db
        .updateTable('message')
        .set({ reactions: JSON.stringify(reactions) })
        .where('id', '=', messageId)
        .execute()

      // Create reaction event
      const rev = generateRev()
      await ctx.db
        .insertInto('message_event')
        .values({
          conversationId: convoId,
          eventType: 'reaction',
          payload: JSON.stringify({
            $type: 'chat.bsky.convo.defs#logAddReaction',
            rev,
            convoId,
            messageId,
            value,
            senderDid: userDid,
          }),
          rev,
          createdAt: timestamp,
        })
        .execute()

      // Return updated message
      const updatedMessage = await ctx.db
        .selectFrom('message')
        .selectAll()
        .where('id', '=', messageId)
        .executeTakeFirst()

      const messageView = await buildMessageView(ctx, updatedMessage!)
      return res.json({ message: messageView })
    } catch (error) {
      console.error('[Raceef Chat] Error adding reaction:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // DELETE /chat/convo/:convoId/message/:messageId/reaction - Remove reaction
  // ========================================
  app.delete('/chat/convo/:convoId/message/:messageId/reaction', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const { convoId, messageId } = req.params
      const { value } = req.body as { value: string }

      if (!value || typeof value !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid reaction value' })
      }

      // Verify membership
      const membership = await ctx.db
        .selectFrom('conversation_member')
        .selectAll()
        .where('conversationId', '=', convoId)
        .where('memberDid', '=', userDid)
        .where('status', '!=', 'left')
        .executeTakeFirst()

      if (!membership) {
        return res.status(403).json({ error: 'Not a member of this conversation' })
      }

      // Get message
      const message = await ctx.db
        .selectFrom('message')
        .selectAll()
        .where('id', '=', messageId)
        .where('conversationId', '=', convoId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst()

      if (!message) {
        return res.status(404).json({ error: 'Message not found' })
      }

      // Parse existing reactions
      let reactions: Array<{ value: string; sender: { did: string } }> = []
      if (message.reactions) {
        try {
          reactions = JSON.parse(message.reactions)
        } catch {
          reactions = []
        }
      }

      // Remove reaction
      const originalLength = reactions.length
      reactions = reactions.filter(
        r => !(r.sender.did === userDid && r.value === value)
      )

      if (reactions.length === originalLength) {
        // Reaction didn't exist, just return success
        return res.json({ success: true })
      }

      // Update message
      const timestamp = now()
      await ctx.db
        .updateTable('message')
        .set({ reactions: JSON.stringify(reactions) })
        .where('id', '=', messageId)
        .execute()

      // Create remove reaction event
      const rev = generateRev()
      await ctx.db
        .insertInto('message_event')
        .values({
          conversationId: convoId,
          eventType: 'reaction',
          payload: JSON.stringify({
            $type: 'chat.bsky.convo.defs#logRemoveReaction',
            rev,
            convoId,
            messageId,
            value,
            senderDid: userDid,
          }),
          rev,
          createdAt: timestamp,
        })
        .execute()

      return res.json({ success: true })
    } catch (error) {
      console.error('[Raceef Chat] Error removing reaction:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // POST /chat/convo/:id/read - Mark conversation as read
  // ========================================
  app.post('/chat/convo/:id/read', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const convoId = req.params.id

      // Get latest message rev
      const latestMessage = await ctx.db
        .selectFrom('message')
        .select('rev')
        .where('conversationId', '=', convoId)
        .orderBy('rev', 'desc')
        .limit(1)
        .executeTakeFirst()

      if (latestMessage) {
        await ctx.db
          .updateTable('conversation_member')
          .set({ lastReadRev: latestMessage.rev })
          .where('conversationId', '=', convoId)
          .where('memberDid', '=', userDid)
          .execute()

        // Create read event
        const rev = generateRev()
        await ctx.db
          .insertInto('message_event')
          .values({
            conversationId: convoId,
            eventType: 'read',
            payload: JSON.stringify({
              $type: 'chat.bsky.convo.defs#logReadConvo',
              rev,
              convoId,
            }),
            rev,
            createdAt: now(),
          })
          .execute()
      }

      return res.json({ success: true })
    } catch (error) {
      console.error('[Raceef Chat] Error marking as read:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // POST /chat/convo/:id/mute - Mute conversation
  // ========================================
  app.post('/chat/convo/:id/mute', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const convoId = req.params.id

      await ctx.db
        .updateTable('conversation_member')
        .set({ muted: 1 })
        .where('conversationId', '=', convoId)
        .where('memberDid', '=', userDid)
        .execute()

      return res.json({ success: true })
    } catch (error) {
      console.error('[Raceef Chat] Error muting conversation:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // POST /chat/convo/:id/unmute - Unmute conversation
  // ========================================
  app.post('/chat/convo/:id/unmute', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const convoId = req.params.id

      await ctx.db
        .updateTable('conversation_member')
        .set({ muted: 0 })
        .where('conversationId', '=', convoId)
        .where('memberDid', '=', userDid)
        .execute()

      return res.json({ success: true })
    } catch (error) {
      console.error('[Raceef Chat] Error unmuting conversation:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // POST /chat/convo/:id/accept - Accept chat request
  // ========================================
  app.post('/chat/convo/:id/accept', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const convoId = req.params.id

      await ctx.db
        .updateTable('conversation_member')
        .set({ status: 'accepted' })
        .where('conversationId', '=', convoId)
        .where('memberDid', '=', userDid)
        .execute()

      return res.json({ success: true })
    } catch (error) {
      console.error('[Raceef Chat] Error accepting conversation:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ========================================
  // POST /chat/convo/:id/leave - Leave conversation
  // ========================================
  app.post('/chat/convo/:id/leave', async (req: Request, res: Response) => {
    try {
      const userDid = (req as any).userDid as string
      const convoId = req.params.id

      await ctx.db
        .updateTable('conversation_member')
        .set({ status: 'left' })
        .where('conversationId', '=', convoId)
        .where('memberDid', '=', userDid)
        .execute()

      return res.json({ success: true })
    } catch (error) {
      console.error('[Raceef Chat] Error leaving conversation:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  console.log('[Raceef Chat] Chat routes initialized')
}
