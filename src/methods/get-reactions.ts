import { Express, Request, Response, NextFunction } from 'express'
import { AppContext } from '../config'
import { validateAuth } from '../auth'

type ReactionCounts = {
  [emoji: string]: number
}

// Valid reaction emojis
const VALID_REACTIONS = new Set(['👍', '😆', '❤️', '👀', '😢'])

// Simple in-memory rate limiter
const rateLimitStore = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100 // 100 requests per minute

function rateLimit(identifier: string): boolean {
  const now = Date.now()
  const record = rateLimitStore.get(identifier)
  
  if (!record || record.resetAt < now) {
    rateLimitStore.set(identifier, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
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
  const now = Date.now()
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetAt < now) {
      rateLimitStore.delete(key)
    }
  }
}, 60 * 1000) // Clean every minute

// Rate limit middleware
function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  // Use IP or author DID as identifier
  const identifier = req.ip || req.body?.author || 'unknown'
  
  if (!rateLimit(identifier)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' })
  }
  
  next()
}

export default function (app: Express, ctx: AppContext) {
  // Apply rate limiting to all reaction routes
  app.use('/reactions', rateLimitMiddleware)
  
  // POST /reactions - Create or update a reaction (with DID validation)
  app.post('/reactions', async (req: Request, res: Response) => {
    try {
      const { uri, author, subject, reaction } = req.body as {
        uri: string // The like record URI (at://did/app.bsky.feed.like/rkey)
        author: string // The user's DID
        subject: string // The post URI being reacted to
        reaction: string // The emoji reaction
      }

      if (!uri || !author || !subject || !reaction) {
        return res.status(400).json({ error: 'Missing required fields: uri, author, subject, reaction' })
      }

      if (!VALID_REACTIONS.has(reaction)) {
        return res.status(400).json({ error: 'Invalid reaction emoji' })
      }

      // Verify the author DID matches the like record URI
      // The URI format is at://did/app.bsky.feed.like/rkey
      const uriDid = uri.split('/')[2]
      if (uriDid !== author) {
        console.warn('[Raceef API] ⚠️ Author DID mismatch:', { uriDid, author })
        return res.status(403).json({ error: 'Author DID does not match like record URI' })
      }

      // Upsert the reaction (insert or update if exists)
      await ctx.db
        .insertInto('reaction')
        .values({
          uri,
          author,
          subject,
          reaction,
          indexedAt: new Date().toISOString(),
        })
        .onConflict((oc) => oc.column('uri').doUpdateSet({ reaction, indexedAt: new Date().toISOString() }))
        .execute()

      return res.json({ success: true })
    } catch (error) {
      console.error('[Raceef API] Error saving reaction:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // DELETE /reactions - Remove a reaction when unliking
  app.delete('/reactions', async (req: Request, res: Response) => {
    try {
      const { subject, author } = req.body as { subject: string; author: string }

      if (!subject || !author) {
        return res.status(400).json({ error: 'Missing required fields: subject, author' })
      }

      // Validate that the author DID format is correct
      if (!author.startsWith('did:')) {
        return res.status(400).json({ error: 'Invalid author DID format' })
      }

      const result = await ctx.db
        .deleteFrom('reaction')
        .where('subject', '=', subject)
        .where('author', '=', author)
        .execute()

      return res.json({ success: true, deleted: result.length > 0 })
    } catch (error) {
      console.error('[Raceef API] Error deleting reaction:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /reactions?uri=at://...
  app.get('/reactions', async (req: Request, res: Response) => {
    try {
      const uri = req.query.uri as string

      if (!uri) {
        return res.status(400).json({ error: 'Missing uri parameter' })
      }

      // Query all reactions for this post
      const reactions = await ctx.db
        .selectFrom('reaction')
        .select(['reaction'])
        .where('subject', '=', uri)
        .execute()

      // Count reactions by emoji
      const counts: ReactionCounts = {}
      for (const r of reactions) {
        counts[r.reaction] = (counts[r.reaction] || 0) + 1
      }

      return res.json({
        uri,
        reactions: counts,
        total: reactions.length,
      })
    } catch (error) {
      console.error('[Raceef API] Error getting reactions:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /reactions/bulk - Get reactions for multiple posts (POST for larger payloads)
  app.post('/reactions/bulk', async (req: Request, res: Response) => {
    try {
      const { uris } = req.body as { uris: string[] }

      if (!uris || !Array.isArray(uris) || uris.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid uris array' })
      }

      // Limit to 100 URIs per request
      const limitedUris = uris.slice(0, 100)

      // Query all reactions for these posts
      const reactions = await ctx.db
        .selectFrom('reaction')
        .select(['subject', 'reaction'])
        .where('subject', 'in', limitedUris)
        .execute()

      // Group and count by post URI
      const result: { [uri: string]: ReactionCounts } = {}
      for (const uri of limitedUris) {
        result[uri] = {}
      }
      for (const r of reactions) {
        if (!result[r.subject]) {
          result[r.subject] = {}
        }
        result[r.subject][r.reaction] = (result[r.subject][r.reaction] || 0) + 1
      }

      return res.json({ reactions: result })
    } catch (error) {
      console.error('[Raceef API] Error getting bulk reactions:', error)
      return res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Health check endpoint
  app.get('/reactions/health', async (_req: Request, res: Response) => {
    try {
      // Quick DB check
      await ctx.db.selectFrom('reaction').select('uri').limit(1).execute()
      return res.json({ status: 'healthy', timestamp: new Date().toISOString() })
    } catch (error) {
      return res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' })
    }
  })
}
