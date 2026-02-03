import dotenv from 'dotenv'
import { AtpAgent } from '@atproto/api'
import { createDb, migrateToLatest, Database } from '../src/db'

dotenv.config()

const NSFW_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'adult', 'nsfw', 'gore', 'corpse', 'self-harm', 'sexual-figurative'])
const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F]/
const visitedUsers = new Set<string>()
const arabicCreators = new Set<string>()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function hasNsfwLabels(post: any): boolean {
  // Check post.labels (from API response)
  if (post.labels && Array.isArray(post.labels)) {
    for (const label of post.labels) {
      const val = (label.val || label.value || '').toLowerCase()
      if (NSFW_LABELS.has(val)) return true
    }
  }
  // Check author labels
  if (post.author?.labels && Array.isArray(post.author.labels)) {
    for (const label of post.author.labels) {
      const val = (label.val || label.value || '').toLowerCase()
      if (val === 'porn' || val === 'adult' || val === 'nsfw') return true
    }
  }
  // Check embed labels (for quoted posts with NSFW content)
  if (post.embed?.record?.labels && Array.isArray(post.embed.record.labels)) {
    for (const label of post.embed.record.labels) {
      const val = (label.val || label.value || '').toLowerCase()
      if (NSFW_LABELS.has(val)) return true
    }
  }
  return false
}

async function getFollowers(agent: AtpAgent, did: string): Promise<string[]> {
  const dids: string[] = []
  let cursor: string | undefined
  try {
    do {
      const res = await agent.getFollowers({ actor: did, limit: 100, cursor })
      for (const f of res.data.followers) dids.push(f.did)
      cursor = res.data.cursor
      await sleep(300)
    } while (cursor && dids.length < 500)
  } catch (e) {}
  return dids
}

async function getFollowing(agent: AtpAgent, did: string): Promise<string[]> {
  const dids: string[] = []
  let cursor: string | undefined
  try {
    do {
      const res = await agent.getFollows({ actor: did, limit: 100, cursor })
      for (const f of res.data.follows) dids.push(f.did)
      cursor = res.data.cursor
      await sleep(300)
    } while (cursor && dids.length < 500)
  } catch (e) {}
  return dids
}

async function checkIfArabicCreator(agent: AtpAgent, did: string): Promise<boolean> {
  try {
    const res = await agent.getAuthorFeed({ actor: did, limit: 30, filter: 'posts_no_replies' })
    let arabicPosts = 0, videoPosts = 0
    for (const item of res.data.feed) {
      const record = item.post.record as any
      const hasArabic = record.langs?.some((l: string) => l.toLowerCase().startsWith('ar')) || (record.text && ARABIC_REGEX.test(record.text))
      if (hasArabic) arabicPosts++
      const embed = record.embed
      if (embed && hasArabic) {
        const isVideo = embed.$type === 'app.bsky.embed.video' || (embed.$type === 'app.bsky.embed.recordWithMedia' && embed.media?.$type === 'app.bsky.embed.video')
        if (isVideo) videoPosts++
      }
    }
    return videoPosts > 0 || arabicPosts > 10
  } catch (e) { return false }
}

async function backfillUser(agent: AtpAgent, db: Database, did: string): Promise<number> {
  let cursor: string | undefined, total = 0
  try {
    do {
      const res = await agent.getAuthorFeed({ actor: did, limit: 100, cursor, filter: 'posts_no_replies' })
      for (const item of res.data.feed) {
        const post = item.post, record = post.record as any, embed = record.embed
        if (!embed) continue
        const isVideo = embed.$type === 'app.bsky.embed.video' || (embed.$type === 'app.bsky.embed.recordWithMedia' && embed.media?.$type === 'app.bsky.embed.video')
        if (!isVideo) continue
        const hasArabic = record.langs?.some((l: string) => l.toLowerCase().startsWith('ar')) || (record.text && ARABIC_REGEX.test(record.text))
        if (!hasArabic) continue
        // Skip NSFW content
        if (hasNsfwLabels(post)) {
          console.log(`    Skipping NSFW post: ${post.uri}`)
          continue
        }
        try { 
          await db.insertInto('post').values({ uri: post.uri, cid: post.cid, indexedAt: post.indexedAt || new Date().toISOString() }).onConflict((oc) => oc.doNothing()).execute()
          total++ 
        } catch (e) {}
      }
      cursor = res.data.cursor
      await sleep(400)
    } while (cursor)
  } catch (e) {}
  return total
}

async function crawlUser(agent: AtpAgent, db: Database, did: string, depth: number, maxDepth: number): Promise<void> {
  if (visitedUsers.has(did) || depth > maxDepth) return
  visitedUsers.add(did)
  try {
    const profile = await agent.getProfile({ actor: did })
    console.log(`\n[Depth ${depth}] Checking @${profile.data.handle}...`)
    const isArabic = await checkIfArabicCreator(agent, did)
    if (isArabic) {
      console.log(`  ✓ Found Arabic creator!`)
      arabicCreators.add(did)
      const indexed = await backfillUser(agent, db, did)
      console.log(`  → Indexed ${indexed} Arabic videos`)
      if (depth < maxDepth) {
        const following = await getFollowing(agent, did)
        const followers = await getFollowers(agent, did)
        console.log(`  → Network: ${followers.length} followers, ${following.length} following`)
        for (const d of following) await crawlUser(agent, db, d, depth + 1, maxDepth)
        for (const d of followers) await crawlUser(agent, db, d, depth + 1, maxDepth)
      }
    } else { 
      console.log(`  ✗ Not Arabic, skipping`) 
    }
    await sleep(300)
  } catch (e) {}
}

async function main() {
  const startHandle = process.argv[2]
  const maxDepth = parseInt(process.argv[3] || '2', 10)
  
  if (!startHandle) { 
    console.log('Usage: npx ts-node scripts/crawl-and-backfill.ts <handle> [depth]')
    console.log('')
    console.log('Example: npx ts-node scripts/crawl-and-backfill.ts arabuser.bsky.social 2')
    console.log('')
    console.log('Depth:')
    console.log('  1 = Only the starting user')
    console.log('  2 = User + their connections (default)')
    console.log('  3 = Two levels deep (slow but thorough)')
    process.exit(1) 
  }
  
  console.log(`🔍 Crawling Arabic creators from @${startHandle}`)
  console.log(`   Depth: ${maxDepth} levels`)
  console.log('')
  
  const agent = new AtpAgent({ service: 'https://public.api.bsky.app' })
  const db = createDb(process.env.FEEDGEN_SQLITE_LOCATION || 'db.sqlite')
  await migrateToLatest(db)
  
  const profile = await agent.getProfile({ actor: startHandle })
  await crawlUser(agent, db, profile.data.did, 1, maxDepth)
  
  console.log('\n' + '='.repeat(50))
  console.log(`✅ Crawl complete!`)
  console.log(`   Visited: ${visitedUsers.size} users`)
  console.log(`   Found: ${arabicCreators.size} Arabic creators`)
  
  const count = await db.selectFrom('post').select(db.fn.count('uri').as('count')).executeTakeFirst()
  console.log(`   Total posts in database: ${count?.count || 0}`)
  
  process.exit(0)
}

main()
