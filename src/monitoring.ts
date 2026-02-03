/**
 * Sentry Monitoring Configuration
 * 
 * Provides error tracking, performance monitoring, and alerting for the backend.
 * 
 * Setup:
 * 1. Install @sentry/node: yarn add @sentry/node
 * 2. Set SENTRY_DSN environment variable in production
 * 3. Optionally set SENTRY_ENVIRONMENT (defaults to 'development')
 * 4. Import and call initSentry() before starting the server
 */

import { Express, Request, Response, NextFunction } from 'express'
import { log } from './logger'

// Sentry is an optional dependency - load dynamically
let Sentry: any = null
let isInitialized = false

/**
 * Initialize Sentry for error tracking
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN
  
  if (!dsn) {
    log('Sentry DSN not configured - error tracking disabled')
    return
  }

  try {
    // Dynamic import to make Sentry optional
    Sentry = require('@sentry/node')
    
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || 'development',
      release: process.env.npm_package_version || '1.0.0',
      
      // Performance monitoring
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
      
      // Filter out non-error events
      beforeSend(event: any, hint: any) {
        // Don't send rate limit errors
        if (event.exception?.values?.[0]?.value?.includes('Too many requests')) {
          return null
        }
        return event
      },
    })

    isInitialized = true
    log('Sentry initialized for error tracking')
  } catch (e) {
    log(`Sentry not available: ${e}`)
  }
}

/**
 * Express middleware for Sentry request handling
 */
export function sentryRequestHandler() {
  if (!isInitialized) {
    return (_req: Request, _res: Response, next: NextFunction) => next()
  }
  return Sentry.expressRequestHandler()
}

/**
 * Express middleware for Sentry error handling
 */
export function sentryErrorHandler() {
  if (!isInitialized) {
    return (err: Error, _req: Request, _res: Response, next: NextFunction) => next(err)
  }
  return Sentry.expressErrorHandler()
}

/**
 * Capture an error with context
 */
export function captureError(
  error: Error | string,
  context?: {
    tags?: Record<string, string>
    extra?: Record<string, unknown>
    user?: { id: string; username?: string }
    level?: string
  }
): void {
  if (!isInitialized || !Sentry) {
    log(`Error (not sent to Sentry): ${error}`)
    return
  }

  Sentry.withScope((scope: any) => {
    if (context?.tags) {
      Object.entries(context.tags).forEach(([key, value]) => {
        scope.setTag(key, value)
      })
    }
    
    if (context?.extra) {
      scope.setExtras(context.extra)
    }
    
    if (context?.user) {
      scope.setUser(context.user)
    }
    
    if (context?.level) {
      scope.setLevel(context.level)
    }

    if (typeof error === 'string') {
      Sentry.captureMessage(error, context?.level || 'error')
    } else {
      Sentry.captureException(error)
    }
  })
}

/**
 * Capture a chat-specific error
 */
export function captureChatError(
  error: Error | string,
  context: {
    operation: 'send_message' | 'get_messages' | 'reaction' | 'upload' | 'privacy' | 'presence' | 'other'
    userDid?: string
    conversationId?: string
    messageId?: string
    extra?: Record<string, unknown>
  }
): void {
  captureError(error, {
    tags: {
      module: 'chat',
      operation: context.operation,
    },
    extra: {
      conversationId: context.conversationId,
      messageId: context.messageId,
      ...context.extra,
    },
    user: context.userDid ? { id: context.userDid } : undefined,
  })
}

/**
 * Capture a story-specific error
 */
export function captureStoryError(
  error: Error | string,
  context: {
    operation: 'create' | 'view' | 'delete' | 'upload' | 'other'
    userDid?: string
    storyId?: string
    extra?: Record<string, unknown>
  }
): void {
  captureError(error, {
    tags: {
      module: 'stories',
      operation: context.operation,
    },
    extra: {
      storyId: context.storyId,
      ...context.extra,
    },
    user: context.userDid ? { id: context.userDid } : undefined,
  })
}

/**
 * Start a performance transaction
 */
export function startTransaction(
  name: string,
  op: string
): any | null {
  if (!isInitialized || !Sentry) return null
  return Sentry.startInactiveSpan({ name, op })
}

/**
 * Add breadcrumb for debugging
 */
export function addBreadcrumb(
  message: string,
  category: string,
  data?: Record<string, unknown>
): void {
  if (!isInitialized || !Sentry) return
  Sentry.addBreadcrumb({
    message,
    category,
    data,
    level: 'info',
  })
}

export default {
  initSentry,
  sentryRequestHandler,
  sentryErrorHandler,
  captureError,
  captureChatError,
  captureStoryError,
  startTransaction,
  addBreadcrumb,
}
