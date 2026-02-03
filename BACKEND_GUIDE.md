# Raceef Backend - Complete Developer Guide

This document provides comprehensive information about the Raceef backend system, including setup, architecture, API endpoints, database schema, monitoring, and best practices.

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Architecture](#architecture)
4. [Database](#database)
5. [API Reference](#api-reference)
6. [Chat System](#chat-system)
7. [Stories System](#stories-system)
8. [Voice Messages](#voice-messages)
9. [Privacy & Settings](#privacy--settings)
10. [Monitoring & Logging](#monitoring--logging)
11. [Testing](#testing)
12. [Production Deployment](#production-deployment)
13. [Troubleshooting](#troubleshooting)

---

## Overview

Raceef Backend extends the Bluesky AT Protocol feed generator to support:
- **Real-time Chat** - WhatsApp-style messaging with reactions, read receipts
- **Stories** - Ephemeral 24-hour content sharing
- **Voice Messages** - Audio recording and playback
- **Privacy Controls** - Reciprocal privacy settings
- **Media Uploads** - Images, audio, and video handling

### Technology Stack
- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: SQLite with Kysely ORM
- **Real-time**: Long-polling (WebSocket upgrade planned)
- **Monitoring**: Sentry for error tracking
- **Storage**: Local filesystem (configurable for S3)

---

## Quick Start

### Prerequisites
- Node.js >= 18
- Yarn 1.x
- SQLite3

### Installation
```bash
cd raceef-feed-generator
yarn install
```

### Configuration
Create a `.env` file from the example:
```bash
cp .env.example .env
```

Required environment variables:
```env
# Server
FEEDGEN_PORT=3000
FEEDGEN_LISTENHOST="localhost"
FEEDGEN_HOSTNAME="example.com"
FEEDGEN_SQLITE_LOCATION="db.sqlite"

# Publisher Identity
FEEDGEN_PUBLISHER_DID="did:plc:..."
FEEDGEN_SERVICE_DID="did:web:example.com"

# Optional: Production Auth (leave empty for development)
RACEEF_AUTH_SECRET=""

# Optional: Sentry Monitoring
SENTRY_DSN=""
SENTRY_ENVIRONMENT="development"

# Subscription
FEEDGEN_SUBSCRIPTION_ENDPOINT="wss://bsky.network"
FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY=3000
```

### Start the Server
```bash
# Development
yarn start

# Production
yarn build && node dist/index.js
```

### Verify Installation
```bash
# Health check
curl http://localhost:3000/health

# Should return:
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "version": "1.0.0",
  "services": {
    "database": "connected",
    "firehose": "running"
  }
}
```

---

## Architecture

### Directory Structure
```
raceef-feed-generator/
├── src/
│   ├── index.ts           # Entry point
│   ├── server.ts          # Express app setup
│   ├── config.ts          # App context types
│   ├── logger.ts          # Logging utilities
│   ├── monitoring.ts      # Sentry integration
│   ├── subscription.ts    # Firehose subscription
│   ├── db/
│   │   ├── index.ts       # Database connection
│   │   ├── migrations.ts  # Schema migrations
│   │   └── schema.ts      # Type definitions
│   ├── methods/
│   │   ├── chat.ts        # Chat API (1700+ lines)
│   │   ├── stories.ts     # Stories API
│   │   ├── media.ts       # File uploads
│   │   └── ...
│   └── lexicon/           # AT Protocol types
├── uploads/               # Media storage
├── db.sqlite              # Database file
├── app.log                # Application logs
└── server.log             # Server logs
```

### Request Flow
```
Client Request
     │
     ▼
Express Middleware
     │
     ├── Sentry Request Handler
     ├── Rate Limiter
     ├── Auth Middleware
     │
     ▼
Route Handler (chat.ts, stories.ts, etc.)
     │
     ▼
Kysely Database Query
     │
     ▼
Response + Sentry Error Handler
```

---

## Database

### Accessing the Database
```bash
# Open SQLite CLI
sqlite3 db.sqlite

# List all tables
.tables

# Show table schema
.schema messages

# Query examples
SELECT * FROM conversations LIMIT 10;
SELECT COUNT(*) FROM messages;
```

### Database Schema

#### Core Tables

**conversations**
```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
```

**conversation_member**
```sql
CREATE TABLE conversation_member (
  conversationId TEXT NOT NULL,
  memberDid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted', -- 'accepted' | 'request' | 'left'
  muted INTEGER NOT NULL DEFAULT 0,
  lastReadRev TEXT,
  joinedAt TEXT NOT NULL,
  PRIMARY KEY (conversationId, memberDid)
);
```

**messages**
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  senderDid TEXT NOT NULL,
  text TEXT NOT NULL,
  facets TEXT,           -- JSON: rich text formatting
  embed TEXT,            -- JSON: voice message, quote, etc.
  reactions TEXT,        -- JSON: array of reactions
  rev TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  deleted INTEGER DEFAULT 0
);
```

**stories**
```sql
CREATE TABLE stories (
  id TEXT PRIMARY KEY,
  authorDid TEXT NOT NULL,
  mediaUrl TEXT NOT NULL,
  mediaType TEXT NOT NULL,
  text TEXT,
  duration INTEGER DEFAULT 5000,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  deleted INTEGER DEFAULT 0
);
```

**chat_privacy**
```sql
CREATE TABLE chat_privacy (
  did TEXT PRIMARY KEY,
  showReadReceipts INTEGER DEFAULT 1,
  showOnlineStatus INTEGER DEFAULT 1,
  showLastSeen INTEGER DEFAULT 1,
  updatedAt TEXT NOT NULL
);
```

**user_presence**
```sql
CREATE TABLE user_presence (
  did TEXT PRIMARY KEY,
  isOnline INTEGER DEFAULT 0,
  lastSeen TEXT,
  updatedAt TEXT NOT NULL
);
```

---

## API Reference

### Health & Monitoring Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Full health check with service status |
| `/ready` | GET | Kubernetes readiness probe |
| `/live` | GET | Kubernetes liveness probe |
| `/metrics` | GET | Database statistics |

### Chat Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/chat/convo/list` | GET | List user's conversations |
| `/chat/convo/:id` | GET | Get single conversation |
| `/chat/convo/getOrCreate` | POST | Get or create conversation |
| `/chat/convo/:id/messages` | GET | Get conversation messages |
| `/chat/convo/:id/send` | POST | Send a message |
| `/chat/convo/:id/accept` | POST | Accept chat request |
| `/chat/convo/:id/mute` | POST | Mute conversation |
| `/chat/convo/:id/leave` | POST | Leave conversation |
| `/chat/message/:id/reaction` | POST | Add reaction |
| `/chat/message/:id/reaction` | DELETE | Remove reaction |
| `/chat/privacy` | GET | Get privacy settings |
| `/chat/privacy` | PUT | Update privacy settings |
| `/chat/presence/update` | POST | Update online status |
| `/chat/presence/:did` | GET | Get user presence |
| `/chat/events` | GET | Long-poll for events |

### Stories Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/stories` | GET | Get stories feed |
| `/stories/user/:did` | GET | Get user's stories |
| `/stories` | POST | Create a story |
| `/stories/:id/view` | POST | Mark story as viewed |
| `/stories/:id` | DELETE | Delete a story |

### Media Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/media/upload` | POST | Upload media file |
| `/media/voice` | POST | Upload voice message |
| `/uploads/:filename` | GET | Serve uploaded files |

---

## Chat System

### Message Flow
```
1. Client sends POST /chat/convo/:id/send
2. Server validates auth and rate limit
3. Message inserted into database
4. Event added to chat_event_log
5. Other participants poll /chat/events
6. They receive the new message event
```

### Message Format
```typescript
interface MessageView {
  $type: 'chat.bsky.convo.defs#messageView'
  id: string
  rev: string
  text: string
  facets?: RichtextFacet[]  // Links, mentions
  embed?: VoiceMessageEmbed | QuoteEmbed
  reactions?: Array<{
    value: string  // Emoji
    sender: { did: string }
  }>
  sender: { did: string }
  sentAt: string  // ISO 8601
}
```

### Reactions
```bash
# Add reaction
curl -X POST http://localhost:3000/chat/message/msg123/reaction \
  -H "X-User-Did: did:plc:user" \
  -H "Content-Type: application/json" \
  -d '{"value": "👍"}'

# Remove reaction
curl -X DELETE http://localhost:3000/chat/message/msg123/reaction \
  -H "X-User-Did: did:plc:user" \
  -H "Content-Type: application/json" \
  -d '{"value": "👍"}'
```

### Chat Requests
Messages from non-followers appear as "requests":
- Initial message creates conversation with `status: 'request'`
- Recipient sees it in their requests list
- They can accept (changes to 'accepted') or ignore

---

## Voice Messages

### Recording Flow
```
1. User holds mic button (app)
2. Recording starts with expo-av
3. User releases → preview or direct send
4. Upload to /media/voice with waveform data
5. Server stores file, returns key
6. Message sent with voice embed
```

### Voice Message Embed
```typescript
interface VoiceMessageEmbed {
  $type: 'app.raceef.embed.voice'
  audio: {
    key: string       // Storage key/URL
    mimeType: string  // 'audio/aac' | 'audio/m4a'
    size: number      // Bytes
  }
  duration: number    // Milliseconds
  waveform: number[]  // Normalized samples (0-1)
}
```

### Upload Voice Message
```bash
curl -X POST http://localhost:3000/media/voice \
  -H "X-User-Did: did:plc:user" \
  -F "audio=@recording.m4a" \
  -F "duration=5000" \
  -F "waveform=[0.2,0.5,0.8,0.3,0.6]"
```

---

## Privacy & Settings

### Reciprocal Privacy Model
When a user disables a privacy feature, they also lose the ability to see that information from others:

| Setting | If Disabled |
|---------|-------------|
| Read Receipts | Can't see when others read your messages |
| Online Status | Can't see when others are online |
| Last Seen | Can't see others' last active time |

### Get/Update Privacy Settings
```bash
# Get settings
curl http://localhost:3000/chat/privacy \
  -H "X-User-Did: did:plc:user"

# Update settings
curl -X PUT http://localhost:3000/chat/privacy \
  -H "X-User-Did: did:plc:user" \
  -H "Content-Type: application/json" \
  -d '{
    "showReadReceipts": true,
    "showOnlineStatus": false,
    "showLastSeen": true
  }'
```

---

## Monitoring & Logging

### Log Files
- `app.log` - Application events, errors
- `server.log` - HTTP request logs

### View Logs
```bash
# Real-time monitoring
tail -f app.log

# Search for errors
grep -i error app.log

# Last 100 lines
tail -100 app.log
```

### Sentry Integration
Set environment variables for production:
```env
SENTRY_DSN=https://xxxxx@sentry.io/xxxxx
SENTRY_ENVIRONMENT=production
```

Error tracking includes:
- Automatic error capture
- Request context
- User identification (by DID)
- Performance monitoring

### Custom Error Capture
```typescript
import { captureChatError } from './monitoring'

captureChatError(error, {
  operation: 'send_message',
  userDid: 'did:plc:user',
  conversationId: 'conv123',
})
```

---

## Testing

### Run Tests
```bash
# All tests
yarn test

# Specific file
yarn test src/__tests__/chat.test.ts

# Watch mode
yarn test --watch
```

### Test Coverage Areas
- Rate limiting logic
- Auth middleware
- Message building
- Reaction handling
- Privacy settings
- Health checks

---

## Production Deployment

### Pre-Deployment Checklist
- [ ] Set `RACEEF_AUTH_SECRET` for JWT validation
- [ ] Configure `SENTRY_DSN` for error tracking
- [ ] Set up HTTPS/SSL termination
- [ ] Configure proper CORS headers
- [ ] Set up database backups
- [ ] Configure log rotation
- [ ] Set up health check monitoring

### Environment Variables
```env
NODE_ENV=production
FEEDGEN_PORT=3000
FEEDGEN_HOSTNAME=chat.raceef.com
RACEEF_AUTH_SECRET=your-secret-key
SENTRY_DSN=https://...
SENTRY_ENVIRONMENT=production
```

### Docker Deployment
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --production
COPY dist ./dist
CMD ["node", "dist/index.js"]
```

### Health Check Configuration
For container orchestration:
```yaml
livenessProbe:
  httpGet:
    path: /live
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
```

---

## Troubleshooting

### Common Issues

**1. "Missing or invalid X-User-Did header"**
- Ensure client sends `X-User-Did` header with valid DID
- Format: `did:plc:xxxxx` or `did:web:xxxxx`

**2. Rate limit errors (429)**
- Default: 200 requests/minute per IP
- For testing, restart server to reset counters

**3. Database locked**
- SQLite allows only one writer at a time
- Ensure no concurrent write operations
- Consider WAL mode for better concurrency

**4. Voice message upload fails**
- Check file size limits (5MB default)
- Verify MIME type is `audio/aac`, `audio/m4a`, or `audio/mp4`
- Ensure `uploads/` directory exists and is writable

**5. Reactions showing "Cannot read property 'createdAt' of undefined"**
- This was fixed - malformed reactions are now filtered
- Check if reactions JSON is properly formatted

### Debug Mode
Enable verbose logging:
```bash
DEBUG=* yarn start
```

### Database Recovery
```bash
# Backup
cp db.sqlite db.sqlite.backup

# Check integrity
sqlite3 db.sqlite "PRAGMA integrity_check;"

# Vacuum/optimize
sqlite3 db.sqlite "VACUUM;"
```

---

## Contact & Support

For issues with the backend:
1. Check logs: `tail -f app.log`
2. Check Sentry dashboard
3. Run health check: `curl localhost:3000/health`
4. Review this documentation

---

*Last updated: February 2026*
*Version: 1.0.0*
