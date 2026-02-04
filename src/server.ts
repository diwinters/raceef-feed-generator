import http from 'http'
import events from 'events'
import express from 'express'
import { DidResolver, MemoryCache } from '@atproto/identity'
import { createServer } from './lexicon'
import feedGeneration from './methods/feed-generation'
import describeGenerator from './methods/describe-generator'
import getReactions from './methods/get-reactions'
import stories from './methods/stories'
import media from './methods/media'
import chat from './methods/chat'
import { createDb, Database, migrateToLatest } from './db'
import { FirehoseSubscription } from './subscription'
import { AppContext, Config } from './config'
import wellKnown from './well-known'
import { log } from './logger'
import { initSentry, sentryRequestHandler, sentryErrorHandler, captureError } from './monitoring'
import { setupWebSocket } from './websocket'
import { WebSocketServer } from 'ws'

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public wss?: WebSocketServer
  public db: Database
  public firehose: FirehoseSubscription
  public cfg: Config
  public didResolver: DidResolver
  private startTime: Date

  constructor(
    app: express.Application,
    db: Database,
    firehose: FirehoseSubscription,
    cfg: Config,
    didResolver: DidResolver,
  ) {
    this.app = app
    this.db = db
    this.firehose = firehose
    this.cfg = cfg
    this.didResolver = didResolver
    this.startTime = new Date()
  }

  static create(cfg: Config) {
    // Initialize Sentry for error tracking
    initSentry()

    const app = express()

    // Add Sentry request handler (must be first)
    app.use(sentryRequestHandler())

    // Middleware to bypass ngrok browser warning
    app.use((req, res, next) => {
      // Check if response is already sent before setting headers
      if (!res.headersSent) {
        res.setHeader("ngrok-skip-browser-warning", "true")
      }
      next()
    })
    // Parse JSON bodies for POST requests
    app.use(express.json())
    const db = createDb(cfg.sqliteLocation)
    const firehose = new FirehoseSubscription(db, cfg.subscriptionEndpoint)

    const didCache = new MemoryCache()
    const didResolver = new DidResolver({
      plcUrl: 'https://plc.directory',
      didCache,
    })

    const server = createServer({
      validateResponse: true,
      payload: {
        jsonLimit: 100 * 1024, // 100kb
        textLimit: 100 * 1024, // 100kb
        blobLimit: 5 * 1024 * 1024, // 5mb
      },
    })
    const ctx: AppContext = {
      db,
      didResolver,
      cfg,
    }

    // Health check endpoint for monitoring
    app.get('/health', async (_req, res) => {
      try {
        // Basic database connectivity check
        await db.selectFrom('post').select('uri').limit(1).execute()
        
        res.json({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          version: process.env.npm_package_version || '1.0.0',
          services: {
            database: 'connected',
            firehose: firehose ? 'running' : 'stopped',
          },
        })
      } catch (error) {
        log(`Health check failed: ${error}`)
        res.status(503).json({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          error: 'Database connection failed',
        })
      }
    })

    // Readiness check for load balancers
    app.get('/ready', async (_req, res) => {
      try {
        await db.selectFrom('post').select('uri').limit(1).execute()
        res.status(200).send('ready')
      } catch {
        res.status(503).send('not ready')
      }
    })

    // Liveness check for container orchestration
    app.get('/live', (_req, res) => {
      res.status(200).send('alive')
    })

    // Metrics endpoint for monitoring
    app.get('/metrics', async (_req, res) => {
      try {
        const [postCount, conversationCount, messageCount, storyCount] = await Promise.all([
          db.selectFrom('post').select(db.fn.count('uri').as('count')).executeTakeFirst(),
          db.selectFrom('conversation').select(db.fn.count('id').as('count')).executeTakeFirst(),
          db.selectFrom('message').select(db.fn.count('id').as('count')).executeTakeFirst(),
          db.selectFrom('story').select(db.fn.count('id').as('count')).executeTakeFirst(),
        ])

        res.json({
          timestamp: new Date().toISOString(),
          database: {
            posts: Number(postCount?.count || 0),
            conversations: Number(conversationCount?.count || 0),
            messages: Number(messageCount?.count || 0),
            stories: Number(storyCount?.count || 0),
          },
        })
      } catch (error) {
        log(`Metrics failed: ${error}`)
        res.status(500).json({error: 'Failed to collect metrics'})
      }
    })

    feedGeneration(server, ctx)
    describeGenerator(server, ctx)
    app.use(server.xrpc.router)
    app.use(wellKnown(ctx))
    getReactions(app, ctx)
    stories(app, ctx)
    media(app, ctx)
    chat(app, ctx)

    // Add Sentry error handler (must be after all routes)
    app.use(sentryErrorHandler())

    // Global error handler
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      log(`Unhandled error: ${err.message}`)
      captureError(err)
      res.status(500).json({error: 'Internal server error'})
    })

    return new FeedGenerator(app, db, firehose, cfg, didResolver)
  }

  async start(): Promise<http.Server> {
    await migrateToLatest(this.db)
    this.firehose.run(this.cfg.subscriptionReconnectDelay)
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')
    
    // Set up WebSocket server on the same HTTP server with JWT verification
    this.wss = setupWebSocket(
      this.server, 
      this.db, 
      this.cfg.serviceDid,
      this.didResolver
    )
    log(`[Server] WebSocket server ready on ws://localhost:${this.cfg.port}/ws`)
    
    return this.server
  }
}

export default FeedGenerator
