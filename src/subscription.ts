import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import { Record as PostRecord } from './lexicon/types/app/bsky/feed/post'
import { Record as LikeRecord } from './lexicon/types/app/bsky/feed/like'

const NSFW_LABELS = new Set([
  'porn', 'sexual', 'nudity', 'graphic-media',
  'adult', 'nsfw', 'gore', 'corpse', 'self-harm',
])

// Arabic Unicode range
const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F]/

// Valid reaction emojis
const VALID_REACTIONS = new Set(['👍', '😆', '❤️', '👀', '😢'])

function hasVideoEmbed(record: PostRecord): boolean {
  if (!record.embed) return false
  const embed = record.embed as any
  if (embed.$type === 'app.bsky.embed.video') return true
  if (embed.$type === 'app.bsky.embed.recordWithMedia') {
    const media = embed.media as any
    if (media?.$type === 'app.bsky.embed.video') return true
  }
  return false
}

function hasNsfwLabels(record: PostRecord): boolean {
  if (!record.labels) return false
  const labels = record.labels as any
  if (labels.$type === 'com.atproto.label.defs#selfLabels' && Array.isArray(labels.values)) {
    for (const label of labels.values) {
      if (label.val && NSFW_LABELS.has(label.val.toLowerCase())) return true
    }
  }
  return false
}

function isArabicPost(record: PostRecord): boolean {
  // Check if langs array includes Arabic
  if (record.langs && Array.isArray(record.langs)) {
    for (const lang of record.langs) {
      if (typeof lang === 'string' && lang.toLowerCase().startsWith('ar')) {
        return true
      }
    }
  }
  // Fallback: check if text contains Arabic characters
  if (record.text && ARABIC_REGEX.test(record.text)) {
    return true
  }
  return false
}

// Index only Arabic video posts without NSFW labels
function isValidPost(record: PostRecord): boolean {
  return hasVideoEmbed(record) && isArabicPost(record) && !hasNsfwLabels(record)
}

// Extract reaction emoji from like record (custom field)
function getReactionFromLike(record: LikeRecord): string | null {
  const reaction = (record as any).reaction
  if (typeof reaction === 'string' && VALID_REACTIONS.has(reaction)) {
    return reaction
  }
  return null
}

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return
    const ops = await getOpsByType(evt)

    // Handle posts
    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate = ops.posts.creates
      .filter((create) => isValidPost(create.record))
      .map((create) => ({
        uri: create.uri,
        cid: create.cid,
        indexedAt: new Date().toISOString(),
      }))

    if (postsToCreate.length > 0) {
      console.log('[Raceef] Indexed ' + postsToCreate.length + ' Arabic video post(s)')
    }

    if (postsToDelete.length > 0) {
      await this.db.deleteFrom('post').where('uri', 'in', postsToDelete).execute()
    }
    if (postsToCreate.length > 0) {
      await this.db.insertInto('post').values(postsToCreate).onConflict((oc) => oc.doNothing()).execute()
    }

    // Handle reactions (likes with reaction emoji)
    const reactionsToDelete = ops.likes.deletes.map((del) => del.uri)
    const reactionsToCreate = ops.likes.creates
      .map((create) => {
        const reaction = getReactionFromLike(create.record)
        if (!reaction) return null
        return {
          uri: create.uri,
          author: create.author,
          subject: create.record.subject.uri,
          reaction,
          indexedAt: new Date().toISOString(),
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)

    if (reactionsToDelete.length > 0) {
      await this.db.deleteFrom('reaction').where('uri', 'in', reactionsToDelete).execute()
    }
    if (reactionsToCreate.length > 0) {
      await this.db.insertInto('reaction').values(reactionsToCreate).onConflict((oc) => oc.doNothing()).execute()
    }
  }
}
