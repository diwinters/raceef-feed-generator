import dotenv from 'dotenv'
import { AtpAgent } from '@atproto/api'
import { createDb, migrateToLatest, Database } from '../src/db'

dotenv.config()

const NSFW_LABELS = new Set([
  'porn', 'sexual', 'nudity', 'graphic-media',
  'adult', 'nsfw', 'gore', 'corpse', 'self-harm',
])

const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F]/

async function backfillUser(agent: AtpAgent, db: Database, handle: string) {
  console.log(`Backfilling posts from @${handle}...`)
  
  let cursor: string | undefined
  let totalIndexed = 0
  
  try {
    const profile = await agent.getProfile({ actor: handle })
    const did = profile.data.did
    
    do {
      const res = await agent.getAuthorFeed({
        actor: did,
        limit: 100,
        cursor,
        filter: 'posts_no_replies',
      })
      
      for (const item of res.data.feed) {
        const post = item.post
        const record = post.record as any
        
        const embed = record.embed
        if (!embed) continue
        
        const isVideo = embed.$type === 'app.bsky.embed.video' ||
          (embed.$type === 'app.bsky.embed.recordWithMedia' && 
           embed.media?.$type === 'app.bsky.embed.video')
        
        if (!isVideo) continue
        
        const hasArabicLang = record.langs?.some((l: string) => 
          l.toLowerCase().startsWith('ar'))
        const hasArabicText = record.text && ARABIC_REGEX.test(record.text)
        
        if (!hasArabicLang && !hasArabicText) continue
        
        const labels = post.labels || []
        const hasNsfw = labels.some((l: any) => NSFW_LABELS.has(l.val?.toLowerCase()))
        if (hasNsfw) continue
        
        try {
          await db.insertInto('post').values({
            uri: post.uri,
            cid: post.cid,
            indexedAt: post.indexedAt || new Date().toISOString(),
          }).onConflict((oc) => oc.doNothing()).execute()
          totalIndexed++
        } catch (e) {
          // Ignore
        }
      }
      
      cursor = res.data.cursor
      console.log(`  Processed batch, indexed ${totalIndexed} videos so far...`)
      await new Promise(r => setTimeout(r, 500))
      
    } while (cursor)
    
    console.log(`Done! Indexed ${totalIndexed} Arabic videos from @${handle}`)
    
  } catch (error) {
    console.error(`Error backfilling @${handle}:`, error)
  }
  
  return totalIndexed
}

async function main() {
  const handles = process.argv.slice(2)
  
  if (handles.length === 0) {
    console.log('Usage: npx ts-node scripts/backfill.ts <handle1> <handle2> ...')
    process.exit(1)
  }
  
  const agent = new AtpAgent({ service: 'https://public.api.bsky.app' })
  
  const sqliteLocation = process.env.FEEDGEN_SQLITE_LOCATION || 'db.sqlite'
  const db = createDb(sqliteLocation)
  await migrateToLatest(db)
  
  let total = 0
  for (const handle of handles) {
    total += await backfillUser(agent, db, handle)
  }
  
  console.log(`\nTotal: Indexed ${total} Arabic videos from ${handles.length} users`)
  process.exit(0)
}

main()
