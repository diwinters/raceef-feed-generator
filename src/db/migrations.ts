import { Kysely, Migration, MigrationProvider } from 'kysely'

const migrations: Record<string, Migration> = {}

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}

migrations['001'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('post')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('cid', 'varchar', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createTable('sub_state')
      .addColumn('service', 'varchar', (col) => col.primaryKey())
      .addColumn('cursor', 'integer', (col) => col.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('post').execute()
    await db.schema.dropTable('sub_state').execute()
  },
}

migrations['002'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('reaction')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('author', 'varchar', (col) => col.notNull())
      .addColumn('subject', 'varchar', (col) => col.notNull())
      .addColumn('reaction', 'varchar', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .execute()
    // Index for querying reactions by subject (post)
    await db.schema
      .createIndex('reaction_subject_idx')
      .on('reaction')
      .column('subject')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('reaction').execute()
  },
}

// Migration 003: Add compound index for efficient DELETE operations
migrations['003'] = {
  async up(db: Kysely<unknown>) {
    // Compound index for DELETE by (subject, author)
    await db.schema
      .createIndex('reaction_subject_author_idx')
      .on('reaction')
      .columns(['subject', 'author'])
      .execute()
    // Index for author-specific queries
    await db.schema
      .createIndex('reaction_author_idx')
      .on('reaction')
      .column('author')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropIndex('reaction_subject_author_idx').execute()
    await db.schema.dropIndex('reaction_author_idx').execute()
  },
}

// Migration 004: Stories feature - users, lists, stories, views
migrations['004'] = {
  async up(db: Kysely<unknown>) {
    // Raceef users table
    await db.schema
      .createTable('raceef_user')
      .addColumn('did', 'varchar', (col) => col.primaryKey())
      .addColumn('handle', 'varchar', (col) => col.notNull())
      .addColumn('displayName', 'varchar')
      .addColumn('avatar', 'varchar')
      .addColumn('joinedAt', 'varchar', (col) => col.notNull())
      .addColumn('lastActiveAt', 'varchar', (col) => col.notNull())
      .execute()

    // Story lists table (for close friends, etc.)
    await db.schema
      .createTable('story_list')
      .addColumn('id', 'varchar', (col) => col.primaryKey())
      .addColumn('ownerDid', 'varchar', (col) => col.notNull())
      .addColumn('name', 'varchar', (col) => col.notNull())
      .addColumn('type', 'varchar', (col) => col.notNull()) // close_friends, mutuals, followers, custom
      .addColumn('isDefault', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('createdAt', 'varchar', (col) => col.notNull())
      .addColumn('updatedAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createIndex('story_list_owner_idx')
      .on('story_list')
      .column('ownerDid')
      .execute()

    // Story list members
    await db.schema
      .createTable('story_list_member')
      .addColumn('listId', 'varchar', (col) => col.notNull())
      .addColumn('memberDid', 'varchar', (col) => col.notNull())
      .addColumn('addedAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createIndex('story_list_member_pk')
      .on('story_list_member')
      .columns(['listId', 'memberDid'])
      .unique()
      .execute()
    await db.schema
      .createIndex('story_list_member_did_idx')
      .on('story_list_member')
      .column('memberDid')
      .execute()

    // Stories table
    await db.schema
      .createTable('story')
      .addColumn('id', 'varchar', (col) => col.primaryKey())
      .addColumn('authorDid', 'varchar', (col) => col.notNull())
      .addColumn('mediaKey', 'varchar', (col) => col.notNull())
      .addColumn('mediaType', 'varchar', (col) => col.notNull())
      .addColumn('thumbnailKey', 'varchar')
      .addColumn('duration', 'integer')
      .addColumn('text', 'varchar')
      .addColumn('listId', 'varchar')
      .addColumn('createdAt', 'varchar', (col) => col.notNull())
      .addColumn('expiresAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createIndex('story_author_idx')
      .on('story')
      .columns(['authorDid', 'createdAt'])
      .execute()
    await db.schema
      .createIndex('story_expires_idx')
      .on('story')
      .column('expiresAt')
      .execute()

    // Story views
    await db.schema
      .createTable('story_view')
      .addColumn('storyId', 'varchar', (col) => col.notNull())
      .addColumn('viewerDid', 'varchar', (col) => col.notNull())
      .addColumn('viewedAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createIndex('story_view_pk')
      .on('story_view')
      .columns(['storyId', 'viewerDid'])
      .unique()
      .execute()
    await db.schema
      .createIndex('story_view_story_idx')
      .on('story_view')
      .column('storyId')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('story_view').execute()
    await db.schema.dropTable('story').execute()
    await db.schema.dropTable('story_list_member').execute()
    await db.schema.dropTable('story_list').execute()
    await db.schema.dropTable('raceef_user').execute()
  },
}
// Migration 005: Story replies metadata table
migrations['005'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('story_reply')
      .addColumn('id', 'varchar', (col) => col.primaryKey())
      .addColumn('storyId', 'varchar', (col) => col.notNull())
      .addColumn('fromDid', 'varchar', (col) => col.notNull())
      .addColumn('toDid', 'varchar', (col) => col.notNull())
      .addColumn('messagePreview', 'varchar')
      .addColumn('createdAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createIndex('story_reply_story_idx')
      .on('story_reply')
      .column('storyId')
      .execute()
    await db.schema
      .createIndex('story_reply_to_idx')
      .on('story_reply')
      .column('toDid')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('story_reply').execute()
  },
}

// Migration 006: Chat/Messaging tables
migrations['006'] = {
  async up(db: Kysely<unknown>) {
    // Conversations table
    await db.schema
      .createTable('conversation')
      .addColumn('id', 'varchar', (col) => col.primaryKey())
      .addColumn('createdAt', 'varchar', (col) => col.notNull())
      .addColumn('updatedAt', 'varchar', (col) => col.notNull())
      .execute()

    // Conversation members table
    await db.schema
      .createTable('conversation_member')
      .addColumn('conversationId', 'varchar', (col) => col.notNull())
      .addColumn('memberDid', 'varchar', (col) => col.notNull())
      .addColumn('joinedAt', 'varchar', (col) => col.notNull())
      .addColumn('lastReadRev', 'varchar')
      .addColumn('muted', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('accepted'))
      .execute()
    // Primary key on (conversationId, memberDid)
    await db.schema
      .createIndex('conversation_member_pk')
      .on('conversation_member')
      .columns(['conversationId', 'memberDid'])
      .unique()
      .execute()
    // Index for finding user's conversations
    await db.schema
      .createIndex('conversation_member_did_idx')
      .on('conversation_member')
      .column('memberDid')
      .execute()

    // Messages table
    await db.schema
      .createTable('message')
      .addColumn('id', 'varchar', (col) => col.primaryKey())
      .addColumn('conversationId', 'varchar', (col) => col.notNull())
      .addColumn('senderDid', 'varchar', (col) => col.notNull())
      .addColumn('text', 'varchar', (col) => col.notNull())
      .addColumn('facets', 'varchar') // JSON
      .addColumn('embed', 'varchar')  // JSON - for future embedded content
      .addColumn('reactions', 'varchar') // JSON array of reactions
      .addColumn('rev', 'varchar', (col) => col.notNull())
      .addColumn('createdAt', 'varchar', (col) => col.notNull())
      .addColumn('deletedAt', 'varchar')
      .execute()
    // Index for fetching messages by conversation, ordered by rev
    await db.schema
      .createIndex('message_convo_rev_idx')
      .on('message')
      .columns(['conversationId', 'rev'])
      .execute()
    // Index for sender queries
    await db.schema
      .createIndex('message_sender_idx')
      .on('message')
      .column('senderDid')
      .execute()

    // Message events table (for getLog polling)
    await db.schema
      .createTable('message_event')
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('conversationId', 'varchar', (col) => col.notNull())
      .addColumn('eventType', 'varchar', (col) => col.notNull())
      .addColumn('payload', 'varchar', (col) => col.notNull()) // JSON
      .addColumn('rev', 'varchar', (col) => col.notNull())
      .addColumn('createdAt', 'varchar', (col) => col.notNull())
      .execute()
    // Index for polling events by conversation and rev cursor
    await db.schema
      .createIndex('message_event_convo_rev_idx')
      .on('message_event')
      .columns(['conversationId', 'rev'])
      .execute()
    // Index for global event polling (all user's conversations)
    await db.schema
      .createIndex('message_event_rev_idx')
      .on('message_event')
      .column('rev')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('message_event').execute()
    await db.schema.dropTable('message').execute()
    await db.schema.dropTable('conversation_member').execute()
    await db.schema.dropTable('conversation').execute()
  },
}

// Migration 007: Add reactions column to message table
migrations['007'] = {
  async up(db: Kysely<unknown>) {
    // Check if column exists first (SQLite doesn't have IF NOT EXISTS for columns)
    try {
      await db.schema
        .alterTable('message')
        .addColumn('reactions', 'varchar')
        .execute()
    } catch (e) {
      // Column might already exist
      console.log('reactions column might already exist')
    }
  },
  async down(db: Kysely<unknown>) {
    // SQLite doesn't support DROP COLUMN easily, so we skip this
  },
}

// Migration 008: Message status, user presence, and chat privacy tables
migrations['008'] = {
  async up(db: Kysely<unknown>) {
    // Message status tracking table
    await db.schema
      .createTable('message_status')
      .addColumn('messageId', 'varchar', (col) => col.notNull())
      .addColumn('recipientDid', 'varchar', (col) => col.notNull())
      .addColumn('deliveredAt', 'varchar')
      .addColumn('readAt', 'varchar')
      .execute()
    // Primary key on (messageId, recipientDid)
    await db.schema
      .createIndex('message_status_pk')
      .on('message_status')
      .columns(['messageId', 'recipientDid'])
      .unique()
      .execute()
    // Index for message lookups
    await db.schema
      .createIndex('message_status_msg_idx')
      .on('message_status')
      .column('messageId')
      .execute()

    // User presence table
    await db.schema
      .createTable('user_presence')
      .addColumn('did', 'varchar', (col) => col.primaryKey())
      .addColumn('isOnline', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('lastSeenAt', 'varchar', (col) => col.notNull())
      .addColumn('updatedAt', 'varchar', (col) => col.notNull())
      .execute()

    // Chat privacy settings table
    await db.schema
      .createTable('chat_privacy')
      .addColumn('did', 'varchar', (col) => col.primaryKey())
      .addColumn('showReadReceipts', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('showOnlineStatus', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('showLastSeen', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('updatedAt', 'varchar', (col) => col.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('chat_privacy').execute()
    await db.schema.dropTable('user_presence').execute()
    await db.schema.dropTable('message_status').execute()
  },
}