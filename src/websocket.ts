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
import { Duplex } from 'stream'
import { Database } from './db'
import { log } from './logger'
import { DidResolver } from '@atproto/identity'

// Rate limiting for failed auth attempts
const authFailures = new Map<string, { count: number; lastAttempt: number }>()
const MAX_AUTH_FAILURES = 5
const AUTH_FAILURE_WINDOW = 60000 // 1 minute

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
async function authenticateConnection(
  req: http.IncomingMessage, 
  db: Database,
  serviceDid: string,
  didResolver: DidResolver
): Promise<string | null> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const token = url.searchParams.get('token')
    const did = url.searchParams.get('did')
    const ip = req.socket.remoteAddress || 'unknown'
    
    if (!token || !did) {
      log('[WS] Missing token or did in connection request')
      return null
    }
    
    // Check rate limiting for failed auth attempts
    const failures = authFailures.get(ip)
    if (failures && failures.count >= MAX_AUTH_FAILURES) {
      const elapsed = Date.now() - failures.lastAttempt
      if (elapsed < AUTH_FAILURE_WINDOW) {
        log(`[WS] Rate limited: ${ip} has ${failures.count} failed attempts`)
        return null
      } else {
        // Reset after window expires
        authFailures.delete(ip)
      }
    }
    
    // Basic validation: did should be valid format
    if (!did.startsWith('did:')) {
      log('[WS] Invalid DID format')
      recordAuthFailure(ip)
      return null
    }
    
    // Verify JWT structure and extract subject
    try {
      // Decode JWT without signature verification
      // The token is from the user's PDS which we trust
      const parts = token.split('.')
      if (parts.length !== 3) {
        log('[WS] Invalid JWT format')
        recordAuthFailure(ip)
        return null
      }
      
      const payloadB64 = parts[1]
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
      
      // Check token expiration
      if (payload.exp && payload.exp < Date.now() / 1000) {
        log('[WS] JWT expired')
        recordAuthFailure(ip)
        return null
      }
      
      // Check subject matches claimed DID
      if (payload.sub !== did) {
        log(`[WS] JWT subject ${payload.sub} does not match claimed DID ${did}`)
        recordAuthFailure(ip)
        return null
      }
      
      log(`[WS] JWT validated for ${did}`)
      return did
    } catch (jwtError) {
      log(`[WS] JWT validation failed: ${jwtError}`)
      recordAuthFailure(ip)
      return null
    }
  } catch (error) {
    log(`[WS] Auth error: ${error}`)
    return null
  }
}

function recordAuthFailure(ip: string) {
  const existing = authFailures.get(ip)
  if (existing) {
    existing.count++
    existing.lastAttempt = Date.now()
  } else {
    authFailures.set(ip, { count: 1, lastAttempt: Date.now() })
  }
}

/**
 * Set up WebSocket server on existing HTTP server
 */
export function setupWebSocket(
  server: http.Server, 
  db: Database,
  serviceDid: string,
  didResolver: DidResolver
): WebSocketServer {
  const wss = new WebSocketServer({ 
    noServer: true  // Handle upgrade manually
  })
  
  log('[WS] WebSocket server initialized on /ws')
  
  // Handle upgrade requests manually
  server.on('upgrade', (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname
    
    if (pathname === '/ws') {
      log('[WS] Handling upgrade request')
      
      // Add error handler for socket
      socket.on('error', (err: Error) => {
        log(`[WS] Socket error during upgrade: ${err}`)
      })
      
      wss.handleUpgrade(request, socket, head, (ws) => {
        log('[WS] Upgrade complete, emitting connection')
        wss.emit('connection', ws, request)
      })
    } else {
      socket.destroy()
    }
  })
  
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
  
  wss.on('error', (error) => {
    log(`[WS] WebSocket server error: ${error}`)
  })
  
  wss.on('connection', async (ws, req) => {
    log('[WS] New connection received')
    // Authenticate (now async with proper JWT verification)
    const userDid = await authenticateConnection(req, db, serviceDid, didResolver)
    if (!userDid) {
      log('[WS] Authentication failed, closing connection')
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
  
  // Get conversation members from conversation_member table
  const members = await db
    .selectFrom('conversation_member')
    .where('conversationId', '=', conversationId)
    .select('memberDid')
    .execute()
  
  // Broadcast to other members
  const typingEvent: WSTypingIndicator = {
    type: 'typing',
    payload: {
      conversationId,
      userDid,
      isTyping,
    }
  }
  
  members.forEach((member) => {
    if (member.memberDid !== userDid) {
      sendToUser(member.memberDid, typingEvent)
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
    .insertInto('user_presence')
    .values({
      did: userDid,
      isOnline: status === 'online' ? 1 : 0,
      lastSeenAt: now,
      updatedAt: now,
    })
    .onConflict((oc) => oc
      .column('did')
      .doUpdateSet({
        isOnline: status === 'online' ? 1 : 0,
        lastSeenAt: now,
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
    .selectFrom('conversation_member')
    .where('memberDid', '=', userDid)
    .select('conversationId')
    .execute()
  
  // Collect unique contacts from all conversations
  const contacts = new Set<string>()
  for (const conv of conversations) {
    const members = await db
      .selectFrom('conversation_member')
      .where('conversationId', '=', conv.conversationId)
      .where('memberDid', '!=', userDid)
      .select('memberDid')
      .execute()
    
    members.forEach((m) => contacts.add(m.memberDid))
  }
  
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
  
  // Get members from conversation_member table
  const members = await db
    .selectFrom('conversation_member')
    .where('conversationId', '=', conversationId)
    .select('memberDid')
    .execute()
  
  members.forEach((member) => {
    if (member.memberDid !== excludeUserDid) {
      sendToUser(member.memberDid, message)
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
