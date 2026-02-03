import { Express, Request, Response, NextFunction } from 'express'
import { AppContext } from '../config'
import { v4 as uuidv4 } from 'uuid'

// Rate limiting for stories
const rateLimitStore = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW = 60 * 1000
const RATE_LIMIT_MAX = 60

function rateLimit(identifier: string): boolean {
  const now = Date.now()
  const record = rateLimitStore.get(identifier)
  if (!record || record.resetAt < now) {
    rateLimitStore.set(identifier, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
    return true
  }
  if (record.count >= RATE_LIMIT_MAX) return false
  record.count++
  return true
}

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const identifier = req.ip || (req.body?.did as string) || 'unknown'
  if (!rateLimit(identifier)) {
    return res.status(429).json({ error: 'Too many requests' })
  }
  next()
}

// Story expiry cleanup job (runs every 5 minutes)
function startCleanupJob(ctx: AppContext) {
  setInterval(async () => {
    try {
      const now = new Date().toISOString()
      // Delete expired stories
      const deleted = await ctx.db
        .deleteFrom('story')
        .where('expiresAt', '<', now)
        .execute()
      
      // Clean up views for deleted stories (orphaned)
      await ctx.db
        .deleteFrom('story_view')
        .where('storyId', 'not in', 
          ctx.db.selectFrom('story').select('id')
        )
        .execute()
        
      if (deleted.length > 0) {
        console.log(`[Stories] Cleaned up ${deleted.length} expired stories`)
      }
    } catch (err) {
      console.error('[Stories] Cleanup error:', err)
    }
  }, 5 * 60 * 1000) // Every 5 minutes
}

export default function (app: Express, ctx: AppContext) {
  // Start cleanup job
  startCleanupJob(ctx)
  
  // Apply rate limiting
  app.use('/stories', rateLimitMiddleware)
  app.use('/story-lists', rateLimitMiddleware)
  app.use('/users', rateLimitMiddleware)

  // ============================================
  // USER REGISTRATION (on app login)
  // ============================================
  
  app.post('/users/register', async (req: Request, res: Response) => {
    try {
      const { did, handle, displayName, avatar } = req.body
      
      if (!did || !handle) {
        return res.status(400).json({ error: 'Missing did or handle' })
      }

      const now = new Date().toISOString()
      
      await ctx.db
        .insertInto('raceef_user')
        .values({
          did,
          handle,
          displayName: displayName || null,
          avatar: avatar || null,
          joinedAt: now,
          lastActiveAt: now,
        })
        .onConflict((oc) => oc.column('did').doUpdateSet({
          handle,
          displayName: displayName || null,
          avatar: avatar || null,
          lastActiveAt: now,
        }))
        .execute()

      return res.json({ success: true })
    } catch (error) {
      console.error('[Users] Register error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Check if a user is on Raceef
  app.get('/users/check', async (req: Request, res: Response) => {
    try {
      const did = req.query.did as string
      if (!did) {
        return res.status(400).json({ error: 'Missing did' })
      }

      const user = await ctx.db
        .selectFrom('raceef_user')
        .select(['did', 'handle', 'displayName', 'avatar'])
        .where('did', '=', did)
        .executeTakeFirst()

      return res.json({ 
        isRaceefUser: !!user,
        user: user || null
      })
    } catch (error) {
      console.error('[Users] Check error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Bulk check multiple users
  app.post('/users/check-bulk', async (req: Request, res: Response) => {
    try {
      const { dids } = req.body as { dids: string[] }
      if (!dids || !Array.isArray(dids)) {
        return res.status(400).json({ error: 'Missing dids array' })
      }

      const users = await ctx.db
        .selectFrom('raceef_user')
        .select(['did', 'handle', 'displayName', 'avatar'])
        .where('did', 'in', dids.slice(0, 500))
        .execute()

      const raceefDids = new Set(users.map(u => u.did))
      
      return res.json({ 
        users,
        raceefDids: Array.from(raceefDids)
      })
    } catch (error) {
      console.error('[Users] Bulk check error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ============================================
  // STORY LISTS (Close Friends, etc.)
  // ============================================

  // Get user's story lists
  app.get('/story-lists', async (req: Request, res: Response) => {
    try {
      const ownerDid = req.query.did as string
      if (!ownerDid) {
        return res.status(400).json({ error: 'Missing did' })
      }

      const lists = await ctx.db
        .selectFrom('story_list')
        .selectAll()
        .where('ownerDid', '=', ownerDid)
        .orderBy('isDefault', 'desc')
        .orderBy('createdAt', 'asc')
        .execute()

      // Get member counts for each list
      const listsWithCounts = await Promise.all(
        lists.map(async (list) => {
          const members = await ctx.db
            .selectFrom('story_list_member')
            .select('memberDid')
            .where('listId', '=', list.id)
            .execute()
          return {
            ...list,
            memberCount: members.length,
          }
        })
      )

      return res.json({ lists: listsWithCounts })
    } catch (error) {
      console.error('[StoryLists] Get error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Get members of a specific list
  app.get('/story-lists/:listId/members', async (req: Request, res: Response) => {
    try {
      const { listId } = req.params
      
      const members = await ctx.db
        .selectFrom('story_list_member')
        .innerJoin('raceef_user', 'raceef_user.did', 'story_list_member.memberDid')
        .select([
          'raceef_user.did',
          'raceef_user.handle',
          'raceef_user.displayName',
          'raceef_user.avatar',
          'story_list_member.addedAt',
        ])
        .where('story_list_member.listId', '=', listId)
        .orderBy('story_list_member.addedAt', 'desc')
        .execute()

      return res.json({ members })
    } catch (error) {
      console.error('[StoryLists] Get members error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Create a new story list
  app.post('/story-lists', async (req: Request, res: Response) => {
    try {
      const { ownerDid, name, type, members, isDefault } = req.body as {
        ownerDid: string
        name: string
        type: 'close_friends' | 'mutuals' | 'followers' | 'custom'
        members: string[] // Array of DIDs
        isDefault?: boolean
      }

      if (!ownerDid || !name || !type) {
        return res.status(400).json({ error: 'Missing required fields' })
      }

      const now = new Date().toISOString()
      const listId = uuidv4()

      // If this is default, unset other defaults
      if (isDefault) {
        await ctx.db
          .updateTable('story_list')
          .set({ isDefault: 0 })
          .where('ownerDid', '=', ownerDid)
          .execute()
      }

      // Create the list
      await ctx.db
        .insertInto('story_list')
        .values({
          id: listId,
          ownerDid,
          name,
          type,
          isDefault: isDefault ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        })
        .execute()

      // Add members
      if (members && members.length > 0) {
        const memberRows = members.map(memberDid => ({
          listId,
          memberDid,
          addedAt: now,
        }))
        await ctx.db
          .insertInto('story_list_member')
          .values(memberRows)
          .execute()
      }

      return res.json({ 
        success: true, 
        listId,
        memberCount: members?.length || 0
      })
    } catch (error) {
      console.error('[StoryLists] Create error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Update a story list (replace members)
  app.put('/story-lists/:listId', async (req: Request, res: Response) => {
    try {
      const { listId } = req.params
      const { name, members, isDefault } = req.body as {
        name?: string
        members?: string[]
        isDefault?: boolean
      }

      const now = new Date().toISOString()

      // Get current list to verify ownership
      const list = await ctx.db
        .selectFrom('story_list')
        .select(['ownerDid'])
        .where('id', '=', listId)
        .executeTakeFirst()

      if (!list) {
        return res.status(404).json({ error: 'List not found' })
      }

      // If setting as default, unset others
      if (isDefault) {
        await ctx.db
          .updateTable('story_list')
          .set({ isDefault: 0 })
          .where('ownerDid', '=', list.ownerDid)
          .execute()
      }

      // Update list metadata
      await ctx.db
        .updateTable('story_list')
        .set({
          ...(name && { name }),
          ...(isDefault !== undefined && { isDefault: isDefault ? 1 : 0 }),
          updatedAt: now,
        })
        .where('id', '=', listId)
        .execute()

      // Replace members if provided
      if (members !== undefined) {
        await ctx.db
          .deleteFrom('story_list_member')
          .where('listId', '=', listId)
          .execute()

        if (members.length > 0) {
          const memberRows = members.map(memberDid => ({
            listId,
            memberDid,
            addedAt: now,
          }))
          await ctx.db
            .insertInto('story_list_member')
            .values(memberRows)
            .execute()
        }
      }

      return res.json({ success: true })
    } catch (error) {
      console.error('[StoryLists] Update error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Delete a story list
  app.delete('/story-lists/:listId', async (req: Request, res: Response) => {
    try {
      const { listId } = req.params

      await ctx.db
        .deleteFrom('story_list_member')
        .where('listId', '=', listId)
        .execute()

      await ctx.db
        .deleteFrom('story_list')
        .where('id', '=', listId)
        .execute()

      return res.json({ success: true })
    } catch (error) {
      console.error('[StoryLists] Delete error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ============================================
  // STORIES
  // ============================================

  // Get stories feed (users who have active stories that viewer can see)
  app.get('/stories/feed', async (req: Request, res: Response) => {
    try {
      const viewerDid = req.query.viewerDid as string
      if (!viewerDid) {
        return res.status(400).json({ error: 'Missing viewerDid' })
      }

      console.log('[Stories] Feed request from:', viewerDid)

      const now = new Date().toISOString()

      // First, get viewer's own stories (always show regardless of lists)
      const ownStories = await ctx.db
        .selectFrom('story')
        .innerJoin('raceef_user', 'raceef_user.did', 'story.authorDid')
        .select([
          'story.authorDid',
          'raceef_user.handle',
          'raceef_user.displayName',
          'raceef_user.avatar',
        ])
        .where('story.authorDid', '=', viewerDid)
        .where('story.expiresAt', '>', now)
        .groupBy('story.authorDid')
        .executeTakeFirst()

      console.log('[Stories] Own stories found:', ownStories ? 'yes' : 'no')

      // Get all story authors where viewer is in the target list
      const storiesWithAuthors = await ctx.db
        .selectFrom('story')
        .innerJoin('raceef_user', 'raceef_user.did', 'story.authorDid')
        .innerJoin('story_list', (join) =>
          join.on((eb) =>
            eb.or([
              // Story targets a specific list
              eb('story_list.id', '=', eb.ref('story.listId')),
              // Or story uses author's default list
              eb.and([
                eb('story.listId', 'is', null),
                eb('story_list.ownerDid', '=', eb.ref('story.authorDid')),
                eb('story_list.isDefault', '=', 1),
              ]),
            ])
          )
        )
        .innerJoin('story_list_member', 'story_list_member.listId', 'story_list.id')
        .select([
          'story.authorDid',
          'raceef_user.handle',
          'raceef_user.displayName',
          'raceef_user.avatar',
        ])
        .where('story.expiresAt', '>', now)
        .where('story_list_member.memberDid', '=', viewerDid)
        .where('story.authorDid', '!=', viewerDid) // Exclude own (already fetched)
        .groupBy('story.authorDid')
        .execute()

      console.log('[Stories] Other authors found:', storiesWithAuthors.length)

      // Get latest story timestamp and unread count for each author
      const authorsWithMeta = await Promise.all(
        [...(ownStories ? [ownStories] : []), ...storiesWithAuthors].map(async (author) => {
          const latestStory = await ctx.db
            .selectFrom('story')
            .select(['id', 'createdAt', 'thumbnailKey', 'mediaType'])
            .where('authorDid', '=', author.authorDid)
            .where('expiresAt', '>', now)
            .orderBy('createdAt', 'desc')
            .executeTakeFirst()

          // Count unread stories (not viewed by this viewer)
          const unreadCount = await ctx.db
            .selectFrom('story')
            .select(ctx.db.fn.count('id').as('count'))
            .where('authorDid', '=', author.authorDid)
            .where('expiresAt', '>', now)
            .where('id', 'not in', 
              ctx.db.selectFrom('story_view')
                .select('storyId')
                .where('viewerDid', '=', viewerDid)
            )
            .executeTakeFirst()

          return {
            ...author,
            latestStoryAt: latestStory?.createdAt,
            thumbnailKey: latestStory?.thumbnailKey,
            mediaType: latestStory?.mediaType,
            hasUnread: Number(unreadCount?.count || 0) > 0,
            isOwnStory: author.authorDid === viewerDid,
          }
        })
      )

      // Sort: own story first, then by latest story timestamp
      const sorted = authorsWithMeta.sort((a, b) => {
        if (a.isOwnStory) return -1
        if (b.isOwnStory) return 1
        if (a.hasUnread !== b.hasUnread) return a.hasUnread ? -1 : 1
        return new Date(b.latestStoryAt || 0).getTime() - new Date(a.latestStoryAt || 0).getTime()
      })

      return res.json({ storyAuthors: sorted })
    } catch (error) {
      console.error('[Stories] Feed error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Get stories for a specific user
  app.get('/stories/:authorDid', async (req: Request, res: Response) => {
    try {
      const { authorDid } = req.params
      const viewerDid = req.query.viewerDid as string
      
      if (!viewerDid) {
        return res.status(400).json({ error: 'Missing viewerDid' })
      }

      const now = new Date().toISOString()

      // Check if viewer can see this author's stories
      const canView = viewerDid === authorDid || await ctx.db
        .selectFrom('story_list')
        .innerJoin('story_list_member', 'story_list_member.listId', 'story_list.id')
        .select('story_list.id')
        .where('story_list.ownerDid', '=', authorDid)
        .where('story_list_member.memberDid', '=', viewerDid)
        .executeTakeFirst()

      if (!canView) {
        return res.status(403).json({ error: 'Not authorized to view stories' })
      }

      // Get all active stories
      const stories = await ctx.db
        .selectFrom('story')
        .selectAll()
        .where('authorDid', '=', authorDid)
        .where('expiresAt', '>', now)
        .orderBy('createdAt', 'asc')
        .execute()

      // Get view status for each story
      const storiesWithViews = await Promise.all(
        stories.map(async (story) => {
          const viewed = await ctx.db
            .selectFrom('story_view')
            .select('viewedAt')
            .where('storyId', '=', story.id)
            .where('viewerDid', '=', viewerDid)
            .executeTakeFirst()

          // For author, include view count
          let viewCount = 0
          if (viewerDid === authorDid) {
            const views = await ctx.db
              .selectFrom('story_view')
              .select(ctx.db.fn.count('viewerDid').as('count'))
              .where('storyId', '=', story.id)
              .executeTakeFirst()
            viewCount = Number(views?.count || 0)
          }

          return {
            ...story,
            isViewed: !!viewed,
            viewCount: viewerDid === authorDid ? viewCount : undefined,
          }
        })
      )

      return res.json({ stories: storiesWithViews })
    } catch (error) {
      console.error('[Stories] Get author stories error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Create a story
  app.post('/stories', async (req: Request, res: Response) => {
    try {
      const { authorDid, mediaKey, mediaType, thumbnailKey, duration, text, listId } = req.body

      console.log('[Stories] Create request:', { authorDid, mediaKey, mediaType })

      if (!authorDid || !mediaKey || !mediaType) {
        return res.status(400).json({ error: 'Missing required fields' })
      }

      // Check if user is registered
      const user = await ctx.db
        .selectFrom('raceef_user')
        .select(['did'])
        .where('did', '=', authorDid)
        .executeTakeFirst()

      if (!user) {
        console.log('[Stories] User not registered:', authorDid)
        return res.status(400).json({ error: 'User not registered. Please register first.' })
      }

      const now = new Date()
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000) // +24 hours

      const storyId = uuidv4()

      await ctx.db
        .insertInto('story')
        .values({
          id: storyId,
          authorDid,
          mediaKey,
          mediaType,
          thumbnailKey: thumbnailKey || null,
          duration: duration || null,
          text: text || null,
          listId: listId || null,
          createdAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        })
        .execute()

      console.log('[Stories] Story created:', storyId, 'by:', authorDid)

      return res.json({ 
        success: true, 
        storyId,
        expiresAt: expiresAt.toISOString()
      })
    } catch (error) {
      console.error('[Stories] Create error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Mark story as viewed
  app.post('/stories/:storyId/view', async (req: Request, res: Response) => {
    try {
      const { storyId } = req.params
      const { viewerDid } = req.body

      if (!viewerDid) {
        return res.status(400).json({ error: 'Missing viewerDid' })
      }

      const now = new Date().toISOString()

      await ctx.db
        .insertInto('story_view')
        .values({
          storyId,
          viewerDid,
          viewedAt: now,
        })
        .onConflict((oc) => oc.columns(['storyId', 'viewerDid']).doNothing())
        .execute()

      return res.json({ success: true })
    } catch (error) {
      console.error('[Stories] View error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Get story viewers (for story author)
  app.get('/stories/:storyId/viewers', async (req: Request, res: Response) => {
    try {
      const { storyId } = req.params
      const { authorDid } = req.query

      // Verify author owns this story
      const story = await ctx.db
        .selectFrom('story')
        .select('authorDid')
        .where('id', '=', storyId)
        .executeTakeFirst()

      if (!story || story.authorDid !== authorDid) {
        return res.status(403).json({ error: 'Not authorized' })
      }

      const viewers = await ctx.db
        .selectFrom('story_view')
        .innerJoin('raceef_user', 'raceef_user.did', 'story_view.viewerDid')
        .select([
          'raceef_user.did',
          'raceef_user.handle',
          'raceef_user.displayName',
          'raceef_user.avatar',
          'story_view.viewedAt',
        ])
        .where('story_view.storyId', '=', storyId)
        .orderBy('story_view.viewedAt', 'desc')
        .execute()

      return res.json({ viewers })
    } catch (error) {
      console.error('[Stories] Get viewers error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Delete a story
  app.delete('/stories/:storyId', async (req: Request, res: Response) => {
    try {
      const { storyId } = req.params
      const { authorDid } = req.body

      // Verify ownership
      const story = await ctx.db
        .selectFrom('story')
        .select('authorDid')
        .where('id', '=', storyId)
        .executeTakeFirst()

      if (!story || story.authorDid !== authorDid) {
        return res.status(403).json({ error: 'Not authorized' })
      }

      await ctx.db
        .deleteFrom('story_view')
        .where('storyId', '=', storyId)
        .execute()

      await ctx.db
        .deleteFrom('story')
        .where('id', '=', storyId)
        .execute()

      return res.json({ success: true })
    } catch (error) {
      console.error('[Stories] Delete error:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Store story reply metadata (actual message goes via ATProto DM)
  app.post('/stories/:storyId/reply', async (req: Request, res: Response) => {
    try {
      const { storyId } = req.params
      const { fromDid, toDid, messagePreview } = req.body

      if (!fromDid || !toDid) {
        return res.status(400).json({ error: 'Missing required fields' })
      }

      const now = new Date().toISOString()

      // Store reply metadata for analytics/notifications
      // Note: We don't store the full message for privacy - only a preview
      await ctx.db
        .insertInto('story_reply')
        .values({
          id: uuidv4(),
          storyId,
          fromDid,
          toDid,
          messagePreview: messagePreview?.slice(0, 50) || null,
          createdAt: now,
        })
        .execute()

      console.log('[Stories] Reply metadata stored:', { storyId, fromDid, toDid })

      return res.json({ success: true })
    } catch (error) {
      console.error('[Stories] Reply metadata error:', error)
      // Don't fail the request - the DM will still be sent
      return res.json({ success: true, warning: 'Metadata storage failed' })
    }
  })
}