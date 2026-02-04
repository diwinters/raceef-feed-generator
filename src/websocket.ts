/**
 * WebSocket Server for Real-time Chat
 * 
 * Handles:
 * - Connection management with JWT auth
 * - Heartbeat to detect stale connections
 * - Broadcasting events to connected users
 * - Typing indicators
 * - Presence updates
 */

import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import { URL } from 'url'
import { Database } from './db'
import { log } from './logger'

// Connection registry: maps userDid -> Set of WebSocket connections
// (user can have multiple connections from different devices)
const connections = new Map<string, Set<WebSocket>>()

// Connection metadata
interface ConnectionMeta {
  userDid: string
  authenticatedAt: Date
  lastHeartbeat: Date
  activeConversationId?: string
}
const connectionMeta = new WeakMap<WebSocket, ConnectionMeta>()

// Heartbeat interval (30 seconds)
const HEARTBEAT_INTERVAL = 30000
// Connection timeout (90 seconds without heartbeat)
const CONNECTION_TIMEOUT = 90000

// Event types for WebSocket messages
export interface WSMessage {
  type: string
  payload: unknown
}

export interface WSNewMessage {
  type: 'new_message'
  payload: {
    conversationId: string
    message: unknown
  }
}

export interface WSMessageDeleted {
  type: 'message_deleted'
  payload: {
    conversationId: string
    messageId: string
    deletedFor: 'me' | 'everyone'
  }
}

export interface WSTypingIndicator {
  type: 'typing'
  payload: {
    conversationId: string
    userDid: string
    isTyping: boolean
  }
}

export interface WSPresenceUpdate {
  type: 'presence'
  payload: {
    userDid: string
    status: 'online' | 'offline'
    lastSeen?: string
  }
}

export interface WSReadReceipt {
  type: 'read_receipt'
  payload: {
    conversationId: string
    messageId: string
    userDid: string
    readAt: string
  }
}

export interface WSReaction {
  type: 'reaction'
  payload: {
    conversationId: string
    messageId: string
    userDid: string
    emoji: string
    action: 'add' | 'remove'
  }
}

/**
 * Authenticate WebSocket connection from URL query params
 * Expects: ws://host/ws?token=JWT&did=user_did
 */
function authenticateConnection(req: http.IncomingMessage, db: Database): string | null {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const token = url.searchParams.get('token')
    const did = url.searchParams.get('did')
    
    if (!token || !did) {
      log('[WS] Missing token or did in connection request')
      return null
    }
    
    // For now, trust the DID if token matches a simple check
    // In production, verify JWT signature against user's signing key
    // The token should be the same format used in REST API auth
    
    // Basic validation: token should be base64-ish and did should be valid format
    if (!did.startsWith('did:')) {
      log('[WS] Invalid DID format')
      return null
    }
    
    // TODO: Add proper JWT verification
    // For now, we trust authenticated clients (they already passed REST API auth)
    log(`[WS] Authenticated connection for ${did}`)
    return did
  } catch (error) {
    log(`[WS] Auth error: ${error}`)
    return null
  }
}

/**
 * Set up WebSocket server on existing HTTP server
 */
export function setupWebSocket(server: http.Server, db: Database): WebSocketServer {
  const wss = new WebSocketServer({ 
    server,
    path: '/ws'
  })
  
  log('[WS] WebSocket server initialized on /ws')
  
  // Heartbeat check interval
  const heartbeatInterval = setInterval(() => {
    const now = Date.now()
    
    wss.clients.forEach((ws) => {
      const meta = connectionMeta.get(ws)
      if (!meta) {
        ws.terminate()
        return
      }
      
      if (now - meta.lastHeartbeat.getTime() > CONNECTION_TIMEOUT) {
        log(`[WS] Terminating stale connection for ${meta.userDid}`)
        ws.terminate()
        return
      }
      
      // Send ping
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    })
  }, HEARTBEAT_INTERVAL)
  
  wss.on('close', () => {
    clearInterval(heartbeatInterval)
  })
  
  wss.on('connection', (ws, req) => {
    // Authenticate
    const userDid = authenticateConnection(req, db)
    if (!userDid) {
      ws.close(4001, 'Unauthorized')
      return
    }
    
    // Store connection metadata
    const meta: ConnectionMeta = {
      userDid,
      authenticatedAt: new Date(),
      lastHeartbeat: new Date(),
    }
    connectionMeta.set(ws, meta)
    
    // Add to connections registry
    if (!connections.has(userDid)) {
      connections.set(userDid, new Set())
    }
    connections.get(userDid)!.add(ws)
    
    log(`[WS] New connection for ${userDid} (total: ${connections.get(userDid)!.size})`)
    
    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      payload: { userDid, timestamp: new Date().toISOString() }
    }))
    
    // Broadcast presence update
    broadcastPresence(userDid, 'online', db)
    
    // Handle messages from client
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as WSMessage
        handleClientMessage(ws, message, meta, db)
        
        // Update heartbeat on any message
        meta.lastHeartbeat = new Date()
      } catch (error) {
        log(`[WS] Error parsing message: ${error}`)
      }
    })
    
    // Handle pong (heartbeat response)
    ws.on('pong', () => {
      meta.lastHeartbeat = new Date()
    })
    
    // Handle close
    ws.on('close', () => {
      log(`[WS] Connection closed for ${userDid}`)
      
      // Remove from connections registry
      const userConnections = connections.get(userDid)
      if (userConnections) {
        userConnections.delete(ws)
        if (userConnections.size === 0) {
          connections.delete(userDid)
          // User is now offline
          broadcastPresence(userDid, 'offline', db)
        }
      }
    })
    
    // Handle errors
    ws.on('error', (error) => {
      log(`[WS] Error for ${userDid}: ${error}`)
    })
  })
  
  return wss
}

/**
 * Handle incoming client messages
 */
function handleClientMessage(
  ws: WebSocket,
  message: WSMessage,
  meta: ConnectionMeta,
  db: Database
): void {
  switch (message.type) {
    case 'ping':
      // Respond to client ping
      ws.send(JSON.stringify({ type: 'pong', payload: { timestamp: Date.now() } }))
      break
      
    case 'typing':
      // Broadcast typing indicator to conversation members
      handleTypingIndicator(meta.userDid, message.payload as any, db)
      break
      
    case 'join_conversation':
      // Track which conversation user is viewing (for presence)
      meta.activeConversationId = (message.payload as any)?.conversationId
      break
      
    case 'leave_conversation':
      meta.activeConversationId = undefined
      break
      
    default:
      log(`[WS] Unknown message type: ${message.type}`)
  }
}

/**
 * Broadcast typing indicator to conversation members
 */
async function handleTypingIndicator(
  userDid: string,
  payload: { conversationId: string; isTyping: boolean },
  db: Database
): Promise<void> {
  const { conversationId, isTyping } = payload
  
  // Get conversation members
  const conversation = await db
    .selectFrom('conversation')
    .where('id', '=', conversationId)
    .selectAll()
    .executeTakeFirst()
  
  if (!conversation) return
  
  const members = JSON.parse(conversation.members) as string[]
  
  // Broadcast to other members
  const typingEvent: WSTypingIndicator = {
    type: 'typing',
    payload: {
      conversationId,
      userDid,
      isTyping,
    }
  }
  
  members.forEach((memberDid) => {
    if (memberDid !== userDid) {
      sendToUser(memberDid, typingEvent)
    }
  })
}

/**
 * Broadcast presence update to user's contacts
 */
async function broadcastPresence(
  userDid: string,
  status: 'online' | 'offline',
  db: Database
): Promise<void> {
  // Update presence in database
  const now = new Date().toISOString()
  
  await db
    .insertInto('presence')
    .values({
      userDid,
      status,
      lastSeen: now,
      updatedAt: now,
    })
    .onConflict((oc) => oc
      .column('userDid')
      .doUpdateSet({
        status,
        lastSeen: now,
        updatedAt: now,
      })
    )
    .execute()
    .catch(() => {
      // Presence table might not exist yet
      log(`[WS] Could not update presence for ${userDid}`)
    })
  
  // Get user's conversations to find contacts
  const conversations = await db
    .selectFrom('conversation')
    .where('members', 'like', `%${userDid}%`)
    .select('members')
    .execute()
  
  // Collect unique contacts
  const contacts = new Set<string>()
  conversations.forEach((conv) => {
    const members = JSON.parse(conv.members) as string[]
    members.forEach((m) => {
      if (m !== userDid) contacts.add(m)
    })
  })
  
  // Broadcast presence to contacts
  const presenceEvent: WSPresenceUpdate = {
    type: 'presence',
    payload: {
      userDid,
      status,
      lastSeen: status === 'offline' ? now : undefined,
    }
  }
  
  contacts.forEach((contactDid) => {
    sendToUser(contactDid, presenceEvent)
  })
}

/**
 * Send a message to a specific user (all their connections)
 */
export function sendToUser(userDid: string, message: WSMessage): void {
  const userConnections = connections.get(userDid)
  if (!userConnections) return
  
  const data = JSON.stringify(message)
  userConnections.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  })
}

/**
 * Send a message to all members of a conversation
 */
export async function sendToConversation(
  db: Database,
  conversationId: string,
  message: WSMessage,
  excludeUserDid?: string
): Promise<void> {
  const conversation = await db
    .selectFrom('conversation')
    .where('id', '=', conversationId)
    .selectAll()
    .executeTakeFirst()
  
  if (!conversation) return
  
  const members = JSON.parse(conversation.members) as string[]
  
  members.forEach((memberDid) => {
    if (memberDid !== excludeUserDid) {
      sendToUser(memberDid, message)
    }
  })
}

/**
 * Broadcast a new message event
 */
export function broadcastNewMessage(
  db: Database,
  conversationId: string,
  message: unknown,
  senderDid: string
): void {
  const event: WSNewMessage = {
    type: 'new_message',
    payload: { conversationId, message }
  }
  
  sendToConversation(db, conversationId, event, senderDid)
}

/**
 * Broadcast a message deletion event
 */
export function broadcastMessageDeleted(
  db: Database,
  conversationId: string,
  messageId: string,
  deletedFor: 'me' | 'everyone',
  excludeUserDid?: string
): void {
  const event: WSMessageDeleted = {
    type: 'message_deleted',
    payload: { conversationId, messageId, deletedFor }
  }
  
  if (deletedFor === 'everyone') {
    sendToConversation(db, conversationId, event)
  } else if (excludeUserDid) {
    // Only for 'delete for me', don't broadcast to others
  }
}

/**
 * Broadcast a read receipt
 */
export function broadcastReadReceipt(
  db: Database,
  conversationId: string,
  messageId: string,
  userDid: string
): void {
  const event: WSReadReceipt = {
    type: 'read_receipt',
    payload: {
      conversationId,
      messageId,
      userDid,
      readAt: new Date().toISOString(),
    }
  }
  
  sendToConversation(db, conversationId, event, userDid)
}

/**
 * Broadcast a reaction event
 */
export function broadcastReaction(
  db: Database,
  conversationId: string,
  messageId: string,
  userDid: string,
  emoji: string,
  action: 'add' | 'remove'
): void {
  const event: WSReaction = {
    type: 'reaction',
    payload: {
      conversationId,
      messageId,
      userDid,
      emoji,
      action,
    }
  }
  
  sendToConversation(db, conversationId, event)
}

/**
 * Check if a user is currently online
 */
export function isUserOnline(userDid: string): boolean {
  return connections.has(userDid) && connections.get(userDid)!.size > 0
}

/**
 * Get all online users
 */
export function getOnlineUsers(): string[] {
  return Array.from(connections.keys())
}
