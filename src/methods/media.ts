import { Express, Request, Response, NextFunction } from 'express'
import { AppContext } from '../config'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import sharp from 'sharp'

// Storage configuration - easy to migrate to CDN later
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads')
const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL || '' // Empty means use relative path

// Ensure upload directories exist
const STORIES_DIR = path.join(UPLOAD_DIR, 'stories')
const THUMBNAILS_DIR = path.join(UPLOAD_DIR, 'thumbnails')
const VOICE_DIR = path.join(UPLOAD_DIR, 'voice')

if (!fs.existsSync(STORIES_DIR)) {
  fs.mkdirSync(STORIES_DIR, { recursive: true })
}
if (!fs.existsSync(THUMBNAILS_DIR)) {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true })
}
if (!fs.existsSync(VOICE_DIR)) {
  fs.mkdirSync(VOICE_DIR, { recursive: true })
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, STORIES_DIR)
  },
  filename: (req, file, cb) => {
    const uniqueId = uuidv4()
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg'
    cb(null, `${uniqueId}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/heic',
      'image/heif',
      'video/mp4',
      'video/quicktime',
      'video/x-m4v',
      // Voice message types
      'audio/aac',
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a',
      'audio/mpeg',
    ]
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}`))
    }
  },
})

// Rate limiting for uploads
const uploadRateLimitStore = new Map<string, { count: number; resetAt: number }>()
const UPLOAD_RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute
const UPLOAD_RATE_LIMIT_MAX = 10 // 10 uploads per minute

function uploadRateLimit(identifier: string): boolean {
  const now = Date.now()
  const record = uploadRateLimitStore.get(identifier)
  if (!record || record.resetAt < now) {
    uploadRateLimitStore.set(identifier, { count: 1, resetAt: now + UPLOAD_RATE_LIMIT_WINDOW })
    return true
  }
  if (record.count >= UPLOAD_RATE_LIMIT_MAX) return false
  record.count++
  return true
}

function uploadRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const identifier = req.body?.did || req.ip || 'unknown'
  if (!uploadRateLimit(identifier)) {
    return res.status(429).json({ error: 'Too many uploads. Please wait.' })
  }
  next()
}

/**
 * Generate thumbnail for image/video
 * Returns the thumbnail filename
 */
async function generateThumbnail(
  sourcePath: string,
  mediaType: 'image' | 'video'
): Promise<string> {
  const thumbnailId = uuidv4()
  const thumbnailFilename = `${thumbnailId}.jpg`
  const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailFilename)

  if (mediaType === 'image') {
    // Generate image thumbnail
    await sharp(sourcePath)
      .resize(400, 400, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath)
  } else {
    // For video, we'd need ffmpeg - for now, return a placeholder
    // In production, use fluent-ffmpeg to extract a frame
    // TODO: Implement video thumbnail extraction
    // For now, create a placeholder
    await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 3,
        background: { r: 50, g: 50, b: 50 },
      },
    })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath)
  }

  return thumbnailFilename
}

/**
 * Get the public URL for a media file
 * Easy to swap out for CDN URL in production
 */
function getMediaUrl(filename: string, type: 'story' | 'thumbnail'): string {
  const subdir = type === 'story' ? 'stories' : 'thumbnails'
  if (MEDIA_BASE_URL) {
    return `${MEDIA_BASE_URL}/${subdir}/${filename}`
  }
  // Return relative path for local serving
  return `/media/${subdir}/${filename}`
}

export default function (app: Express, ctx: AppContext) {
  // Serve uploaded media files
  app.use('/media/stories', (req, res, next) => {
    const options = {
      root: STORIES_DIR,
      headers: {
        'Cache-Control': 'public, max-age=31536000', // 1 year cache
      },
    }
    res.sendFile(req.path, options, (err) => {
      if (err) {
        res.status(404).json({ error: 'Media not found' })
      }
    })
  })

  app.use('/media/thumbnails', (req, res, next) => {
    const options = {
      root: THUMBNAILS_DIR,
      headers: {
        'Cache-Control': 'public, max-age=31536000', // 1 year cache
      },
    }
    res.sendFile(req.path, options, (err) => {
      if (err) {
        res.status(404).json({ error: 'Thumbnail not found' })
      }
    })
  })

  // Serve voice message files
  app.use('/media/voice', (req, res, next) => {
    // Add CORS headers for audio playback
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
    
    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
      return res.status(200).end()
    }
    
    const filename = req.path.slice(1) // Remove leading slash
    console.log('[Media] Serving voice file:', filename)
    
    // Determine content type based on extension
    let contentType = 'audio/mp4'
    if (filename.endsWith('.aac')) {
      contentType = 'audio/aac'
    } else if (filename.endsWith('.m4a')) {
      contentType = 'audio/x-m4a'
    }
    
    const options = {
      root: VOICE_DIR,
      headers: {
        'Cache-Control': 'public, max-age=31536000', // 1 year cache
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      },
    }
    
    res.sendFile(filename, options, (err) => {
      if (err) {
        console.error('[Media] Voice file error:', err)
        res.status(404).json({ error: 'Voice message not found' })
      }
    })
  })

  // Upload voice message
  app.post(
    '/chat/media/voice',
    uploadRateLimitMiddleware,
    upload.single('audio') as any,
    async (req: Request, res: Response) => {
      try {
        const file = (req as any).file as Express.Multer.File | undefined
        const userDid = req.headers['x-user-did'] as string
        const { duration, waveform } = req.body

        if (!file) {
          return res.status(400).json({ error: 'No audio file uploaded' })
        }

        if (!userDid) {
          // Clean up the uploaded file
          fs.unlinkSync(file.path)
          return res.status(400).json({ error: 'Missing user DID' })
        }

        // Move file to voice directory with unique name
        const voiceKey = `${uuidv4()}.m4a`
        const voicePath = path.join(VOICE_DIR, voiceKey)
        fs.renameSync(file.path, voicePath)

        // Get file size
        const stats = fs.statSync(voicePath)

        console.log(`[Media] Voice message uploaded: ${voiceKey} by ${userDid}`)

        res.json({
          key: voiceKey,
          size: stats.size,
        })
      } catch (error) {
        console.error('[Media] Voice upload error:', error)
        // Clean up file if it was uploaded
        const uploadedFile = (req as any).file as Express.Multer.File | undefined
        if (uploadedFile) {
          try {
            fs.unlinkSync(uploadedFile.path)
          } catch {}
        }
        return res.status(500).json({ error: 'Voice upload failed' })
      }
    }
  )

  // Get voice message URL
  app.get('/chat/media/voice/:key', async (req: Request, res: Response) => {
    try {
      const { key } = req.params
      const voicePath = path.join(VOICE_DIR, key)

      if (!fs.existsSync(voicePath)) {
        return res.status(404).json({ error: 'Voice message not found' })
      }

      // Return the URL for the voice message
      const url = MEDIA_BASE_URL
        ? `${MEDIA_BASE_URL}/voice/${key}`
        : `/media/voice/${key}`

      res.json({ url })
    } catch (error) {
      console.error('[Media] Voice URL error:', error)
      return res.status(500).json({ error: 'Failed to get voice URL' })
    }
  })

  // Upload story media
  app.post(
    '/media/upload',
    uploadRateLimitMiddleware,
    upload.single('file') as any,
    async (req: Request, res: Response) => {
      try {
        const file = (req as any).file as Express.Multer.File | undefined
        const { did } = req.body

        if (!file) {
          return res.status(400).json({ error: 'No file uploaded' })
        }

        if (!did) {
          // Clean up the uploaded file
          fs.unlinkSync(file.path)
          return res.status(400).json({ error: 'Missing user DID' })
        }

        // Determine media type
        const isVideo = file.mimetype.startsWith('video/')
        const mediaType: 'image' | 'video' = isVideo ? 'video' : 'image'

        // Process image - resize if too large
        if (mediaType === 'image') {
          const metadata = await sharp(file.path).metadata()
          const maxDimension = 1920

          if (
            (metadata.width && metadata.width > maxDimension) ||
            (metadata.height && metadata.height > maxDimension)
          ) {
            // Resize and overwrite
            const tempPath = `${file.path}.tmp`
            await sharp(file.path)
              .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toFile(tempPath)
            
            fs.unlinkSync(file.path)
            fs.renameSync(tempPath, file.path.replace(path.extname(file.path), '.jpg'))
          }
        }

        // Generate thumbnail
        let thumbnailFilename: string | null = null
        try {
          thumbnailFilename = await generateThumbnail(file.path, mediaType)
        } catch (err) {
          console.error('[Media] Thumbnail generation failed:', err)
          // Continue without thumbnail - not critical
        }

        // Return the media keys
        const mediaKey = file.filename
        const thumbnailKey = thumbnailFilename

        res.json({
          success: true,
          mediaKey,
          mediaType,
          mediaUrl: getMediaUrl(mediaKey, 'story'),
          thumbnailKey,
          thumbnailUrl: thumbnailKey ? getMediaUrl(thumbnailKey, 'thumbnail') : null,
        })
      } catch (error) {
        console.error('[Media] Upload error:', error)
        // Clean up file if it was uploaded
        const uploadedFile = (req as any).file as Express.Multer.File | undefined
        if (uploadedFile) {
          try {
            fs.unlinkSync(uploadedFile.path)
          } catch {}
        }
        return res.status(500).json({ error: 'Upload failed' })
      }
    }
  )

  // Delete media (called when story is deleted)
  app.delete('/media/:mediaKey', async (req: Request, res: Response) => {
    try {
      const { mediaKey } = req.params
      const { did, thumbnailKey } = req.body

      if (!did || !mediaKey) {
        return res.status(400).json({ error: 'Missing required fields' })
      }

      // Delete the media file
      const mediaPath = path.join(STORIES_DIR, mediaKey)
      if (fs.existsSync(mediaPath)) {
        fs.unlinkSync(mediaPath)
      }

      // Delete thumbnail if provided
      if (thumbnailKey) {
        const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailKey)
        if (fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath)
        }
      }

      res.json({ success: true })
    } catch (error) {
      console.error('[Media] Delete error:', error)
      return res.status(500).json({ error: 'Delete failed' })
    }
  })

  // Cleanup job for orphaned media files (files without corresponding stories)
  // This runs daily to clean up any media that wasn't properly deleted
  setInterval(async () => {
    try {
      console.log('[Media] Running orphaned media cleanup...')
      
      // Get all story media keys from the database
      const stories = await ctx.db
        .selectFrom('story')
        .select(['mediaKey', 'thumbnailKey'])
        .execute()

      const validMediaKeys = new Set(stories.map(s => s.mediaKey))
      const validThumbnailKeys = new Set(
        stories.filter(s => s.thumbnailKey).map(s => s.thumbnailKey!)
      )

      // Scan stories directory
      const storyFiles = fs.readdirSync(STORIES_DIR)
      let deletedStories = 0
      for (const file of storyFiles) {
        if (!validMediaKeys.has(file)) {
          const filePath = path.join(STORIES_DIR, file)
          const stats = fs.statSync(filePath)
          // Only delete files older than 1 hour (to avoid deleting in-progress uploads)
          if (Date.now() - stats.mtimeMs > 60 * 60 * 1000) {
            fs.unlinkSync(filePath)
            deletedStories++
          }
        }
      }

      // Scan thumbnails directory
      const thumbnailFiles = fs.readdirSync(THUMBNAILS_DIR)
      let deletedThumbnails = 0
      for (const file of thumbnailFiles) {
        if (!validThumbnailKeys.has(file)) {
          const filePath = path.join(THUMBNAILS_DIR, file)
          const stats = fs.statSync(filePath)
          if (Date.now() - stats.mtimeMs > 60 * 60 * 1000) {
            fs.unlinkSync(filePath)
            deletedThumbnails++
          }
        }
      }

      if (deletedStories > 0 || deletedThumbnails > 0) {
        console.log(`[Media] Cleaned up ${deletedStories} story files and ${deletedThumbnails} thumbnails`)
      }
    } catch (err) {
      console.error('[Media] Cleanup error:', err)
    }
  }, 24 * 60 * 60 * 1000) // Run daily
}
