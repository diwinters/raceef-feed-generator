import dotenv from 'dotenv'
import FeedGenerator from './server'
import { log, logError } from './logger'

const run = async () => {
  dotenv.config()
  
  log('Starting Raceef Feed Generator...')
  log('Environment: ' + JSON.stringify({
    FEEDGEN_PORT: process.env.FEEDGEN_PORT,
    FEEDGEN_LISTENHOST: process.env.FEEDGEN_LISTENHOST,
    FEEDGEN_HOSTNAME: process.env.FEEDGEN_HOSTNAME,
    FEEDGEN_PUBLISHER_DID: process.env.FEEDGEN_PUBLISHER_DID,
  }))
  
  const hostname = maybeStr(process.env.FEEDGEN_HOSTNAME) ?? 'example.com'
  const serviceDid =
    maybeStr(process.env.FEEDGEN_SERVICE_DID) ?? `did:web:${hostname}`
  
  log('Hostname: ' + hostname)
  log('Service DID: ' + serviceDid)
  
  const server = FeedGenerator.create({
    port: maybeInt(process.env.FEEDGEN_PORT) ?? 3000,
    listenhost: maybeStr(process.env.FEEDGEN_LISTENHOST) ?? 'localhost',
    sqliteLocation: maybeStr(process.env.FEEDGEN_SQLITE_LOCATION) ?? ':memory:',
    subscriptionEndpoint:
      maybeStr(process.env.FEEDGEN_SUBSCRIPTION_ENDPOINT) ??
      'wss://bsky.network',
    publisherDid:
      maybeStr(process.env.FEEDGEN_PUBLISHER_DID) ?? 'did:example:alice',
    subscriptionReconnectDelay:
      maybeInt(process.env.FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY) ?? 3000,
    hostname,
    serviceDid,
  })
  
  try {
    await server.start()
    log(`🤖 Feed generator started successfully at http://${server.cfg.listenhost}:${server.cfg.port}`)
  } catch (error) {
    logError('Failed to start server', error)
    process.exit(1)
  }
}

const maybeStr = (val?: string) => {
  if (!val) return undefined
  return val
}

const maybeInt = (val?: string) => {
  if (!val) return undefined
  const int = parseInt(val, 10)
  if (isNaN(int)) return undefined
  return int
}

process.on('uncaughtException', (error) => {
  logError('Uncaught Exception', error)
  // Don't exit on ERR_HTTP_HEADERS_SENT - it's not fatal
  if (error && (error as NodeJS.ErrnoException).code === 'ERR_HTTP_HEADERS_SENT') {
    log('Ignoring non-fatal headers-sent error')
    return
  }
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logError('Unhandled Rejection', reason)
  // Don't exit immediately, just log it
})

run()
