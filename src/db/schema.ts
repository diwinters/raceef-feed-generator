export type DatabaseSchema = {
  post: Post
  sub_state: SubState
  reaction: Reaction
  raceef_user: RaceefUser
  story_list: StoryList
  story_list_member: StoryListMember
  story: Story
  story_view: StoryView
  story_reply: StoryReply
  // Chat tables
  conversation: Conversation
  conversation_member: ConversationMember
  message: Message
  message_event: MessageEvent
}

export type Post = {
  uri: string
  cid: string
  indexedAt: string
}

export type SubState = {
  service: string
  cursor: number
}

export type Reaction = {
  uri: string           // like record URI
  author: string        // who reacted (DID)
  subject: string       // post URI being reacted to
  reaction: string      // emoji reaction (👍, 😆, ❤️, 👀, 😢)
  indexedAt: string
}

// Raceef app users (anyone who logs in)
export type RaceefUser = {
  did: string           // Primary key - user's DID
  handle: string        // Cached handle for display
  displayName: string | null
  avatar: string | null // Cached avatar URL
  joinedAt: string
  lastActiveAt: string
}

// Story visibility lists (expandable to multiple lists per user)
export type StoryList = {
  id: string            // UUID
  ownerDid: string      // Who owns this list
  name: string          // "Close Friends", "Family", etc.
  type: string          // 'close_friends' | 'mutuals' | 'followers' | 'custom'
  isDefault: number     // 1 = default list for stories, 0 = not
  createdAt: string
  updatedAt: string
}

// Members of a story list
export type StoryListMember = {
  listId: string        // FK to story_list.id
  memberDid: string     // Who is in this list
  addedAt: string
}

// Stories (24h ephemeral content)
export type Story = {
  id: string            // UUID
  authorDid: string     // Who posted
  mediaKey: string      // CDN path/key for the media
  mediaType: string     // 'image' | 'video'
  thumbnailKey: string | null  // Thumbnail for video stories
  duration: number | null      // Video duration in seconds
  text: string | null   // Optional text overlay
  listId: string | null // Which list can see (null = default list)
  createdAt: string
  expiresAt: string     // createdAt + 24h
}

// Story view tracking (for "seen by" feature)
export type StoryView = {
  storyId: string       // FK to story.id
  viewerDid: string     // Who viewed
  viewedAt: string
}
// Story reply metadata (actual message content in ATProto DM)
export type StoryReply = {
  id: string            // UUID
  storyId: string       // FK to story.id
  fromDid: string       // Who sent the reply
  toDid: string         // Story author
  messagePreview: string | null  // First 50 chars for notifications
  createdAt: string
}

// ============================================
// CHAT / MESSAGING TABLES
// ============================================

// Conversations (supports 1:1 and future group chats)
export type Conversation = {
  id: string            // UUID
  createdAt: string     // ISO timestamp
  updatedAt: string     // Last activity timestamp
}

// Conversation members
export type ConversationMember = {
  conversationId: string    // FK to conversation.id
  memberDid: string         // User's DID
  joinedAt: string          // When they joined
  lastReadRev: string | null // Last message rev they've read (for unread count)
  muted: number             // 0 = not muted, 1 = muted
  status: string            // 'accepted' | 'request' | 'left'
}

// Messages
export type Message = {
  id: string            // UUID
  conversationId: string // FK to conversation.id
  senderDid: string     // Who sent it
  text: string          // Message content
  facets: string | null // JSON array of RichtextFacet (links, mentions)
  embed: string | null  // JSON for embedded content (quoted posts, etc.) - Phase 2
  reactions: string | null // JSON array of reactions [{value: emoji, sender: {did}}]
  rev: string           // Monotonic revision for ordering (timestamp-based)
  createdAt: string     // ISO timestamp
  deletedAt: string | null // Soft delete timestamp
}

// Event log for real-time polling (critical for getLog endpoint)
export type MessageEvent = {
  id?: number           // Auto-increment (SQLite) - optional for inserts
  conversationId: string // FK to conversation.id
  eventType: string     // 'message' | 'delete' | 'read' | 'reaction' | 'leave'
  payload: string       // JSON of the event data
  rev: string           // Same rev as the message for ordering
  createdAt: string     // ISO timestamp
}