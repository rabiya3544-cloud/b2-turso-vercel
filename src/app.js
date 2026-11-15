import { Hono } from 'hono';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient } from '@libsql/client';
import { readFile } from 'fs/promises';
import { join } from 'path';

const app = new Hono();

let _s3;

function s3() {
  if (!_s3) {
    let endpoint = process.env.B2_ENDPOINT_URL;
    if (!endpoint) throw new Error('B2_ENDPOINT_URL is not set');
    endpoint = endpoint.replace(/\/+$/, '');
    const region = new URL(endpoint).hostname.split('.')[1];
    _s3 = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.B2_APPLICATION_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
      },
    });
  }
  return _s3;
}

let _turso;

function turso() {
  if (!_turso) {
    _turso = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _turso;
}

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Cache-Control', 'no-store');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

app.get('/', async (c) => {
  try {
    const html = await readFile(join(process.cwd(), 'public/index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('index.html not found', 500);
  }
});

const ALLOWED_HOSTS = /(^|\.)(tiktokv|tiktokcdn|byteoversea|ibytedtos|muscdn|tos-)\.com$/i;
const MAX_BYTES = 300 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 90_000;

async function uploadImageFromUrl(client, imageUrl) {
  if (!imageUrl) return null;

  let parsed;
  try { parsed = new URL(imageUrl); } catch { return null; }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (!ALLOWED_HOSTS.test(parsed.hostname)) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);

  try {
    const upstream = await fetch(imageUrl, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' },
    });
    clearTimeout(timer);

    if (!upstream.ok) return null;

    const contentType = upstream.headers.get('content-type') || '';
    if (contentType && !/^image\//i.test(contentType)) return null;

    const ext = (contentType.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5);
    const coverKey = `cover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const imageUpload = new Upload({
      client,
      params: {
        Bucket: process.env.B2_BUCKET_NAME,
        Key: coverKey,
        Body: upstream.body,
        ContentType: contentType || 'image/jpeg',
      },
    });

    await imageUpload.done();
    return coverKey;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

app.post('/api/upload-from-url', async (c) => {
  try {
    const client = s3();
    const db = turso();

    const { url, userId, date, likes, coverImg } = await c.req.json();
    if (!url) throw new Error('url required');

    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('only http(s) URLs');
    if (!ALLOWED_HOSTS.test(parsed.hostname)) throw new Error('host not allowed: ' + parsed.hostname);

    const dateStr = date
      ? String(date).replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
      : Date.now().toString();
    const filename = `video_${dateStr}.mp4`;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e.name === 'AbortError';
      return c.json({ success: false, error: aborted ? 'upstream timeout' : 'upstream fetch failed' }, 502);
    }

    if (!upstream.ok) {
      clearTimeout(timer);
      return c.json({ success: false, error: `upstream HTTP ${upstream.status}` }, 502);
    }

    const contentLength = Number(upstream.headers.get('content-length')) || 0;
    if (contentLength && contentLength > MAX_BYTES) {
      clearTimeout(timer);
      try { await upstream.body?.cancel(); } catch {}
      return c.json({ success: false, error: 'file too large' }, 413);
    }

    const upload = new Upload({
      client,
      params: {
        Bucket: process.env.B2_BUCKET_NAME,
        Key: filename,
        Body: upstream.body,
        ContentType: 'video/mp4',
        ContentLength: contentLength || undefined,
      },
    });

    await upload.done();
    clearTimeout(timer);

    const coverKey = await uploadImageFromUrl(client, coverImg);

    const resolvedUserId = String(userId || 'user_123').trim().slice(0, 100) || 'user_123';

    const parsedDate = date ? new Date(String(date).replace(' ', 'T')) : new Date();
    const postedDate = (isNaN(parsedDate.getTime()) ? new Date() : parsedDate)
      .toISOString()
      .slice(0, 10);

    const initialLikes = Number.isInteger(likes) && likes >= 0 ? likes : 0;

    await db.execute({
      sql: `INSERT INTO b2_files
              (video_key, cover_key, user_id, likes, posted_date, file_size)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        filename,
        coverKey,
        resolvedUserId,
        initialLikes,
        postedDate,
        contentLength || null,
      ],
    });

    return c.json({
      success: true,
      videoKey: filename,
      coverKey: coverKey || null,
      bytes: contentLength || null,
    });
  } catch (error) {
    console.error('Upload Error:', error.message);
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/download-b2-file', async (c) => {
  try {
    const client = s3();
    const db = turso();

    const videoKey = c.req.query('videoKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!videoKey) throw new Error('videoKey required');

    const check = await db.execute({
      sql: `SELECT video_key FROM b2_files
            WHERE video_key = ? AND user_id = ?`,
      args: [videoKey, userId],
    });
    if (check.rows.length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    const command = new GetObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: videoKey,
    });
    const downloadUrl = await getSignedUrl(client, command, { expiresIn: 259200 });

    return c.json({ success: true, downloadUrl });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/download-b2-cover', async (c) => {
  try {
    const client = s3();
    const db = turso();

    const coverKey = c.req.query('coverKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!coverKey) throw new Error('coverKey required');

    const check = await db.execute({
      sql: `SELECT cover_key FROM b2_files
            WHERE cover_key = ? AND user_id = ?`,
      args: [coverKey, userId],
    });
    if (check.rows.length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    const command = new GetObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: coverKey,
    });
    const downloadUrl = await getSignedUrl(client, command, { expiresIn: 259200 });

    return c.json({ success: true, downloadUrl });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/known-video-keys', async (c) => {
  try {
    const db = turso();
    const userId = c.req.query('userId') || 'user_123';

    const rows = await db.execute({
      sql: `SELECT video_key, file_size, posted_date
            FROM b2_files
            WHERE user_id = ?
            ORDER BY posted_date DESC, id DESC`,
      args: [userId],
    });

    return c.json({
      success: true,
      items: rows.rows.map(r => ({
        videoKey: r.video_key,
        fileSize: r.file_size,
        postedDate: r.posted_date,
      })),
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ============ download_links feature (self-contained) ============

const STALE_HOURS = 48; // refresh URLs older than this; 3-day URLs get 1 day of buffer

app.post('/api/download-links/sync', async (c) => {
  try {
    const client = s3();
    const db = turso();
    const { userId } = await c.req.json();
    const resolvedUserId = String(userId || 'user_123').trim().slice(0, 100) || 'user_123';

    // All videos the user owns in b2_files
    const allVideos = await db.execute({
      sql: `SELECT video_key, cover_key, file_size
            FROM b2_files WHERE user_id = ?`,
      args: [resolvedUserId],
    });

    // Rows in download_links that are still fresh (created within STALE_HOURS)
    const fresh = await db.execute({
      sql: `SELECT video_key FROM download_links
            WHERE user_id = ?
              AND created_at > datetime('now', ?)`,
      args: [resolvedUserId, `-${STALE_HOURS} hours`],
    });
    const freshKeys = new Set(fresh.rows.map(r => r.video_key));

    // Process = anything not currently fresh (either missing entirely, or stale)
    const toProcess = allVideos.rows.filter(r => !freshKeys.has(r.video_key));
    const skipped = allVideos.rows.length - toProcess.length;

    let added = 0, refreshed = 0;
    for (const r of toProcess) {
      const videoCmd = new GetObjectCommand({
        Bucket: process.env.B2_BUCKET_NAME,
        Key: r.video_key,
      });
      const videoUrl = await getSignedUrl(client, videoCmd, { expiresIn: 259200 });

      let coverUrl = null;
      if (r.cover_key) {
        const coverCmd = new GetObjectCommand({
          Bucket: process.env.B2_BUCKET_NAME,
          Key: r.cover_key,
        });
        coverUrl = await getSignedUrl(client, coverCmd, { expiresIn: 259200 });
      }

      // Detect whether this is a first insert or a refresh by checking existence
      const exists = await db.execute({
        sql: `SELECT 1 FROM download_links WHERE video_key = ? AND user_id = ?`,
        args: [r.video_key, resolvedUserId],
      });

      await db.execute({
        sql: `INSERT INTO download_links
                (video_key, user_id, cover_key, video_url, cover_url, file_size)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (video_key, user_id) DO UPDATE SET
                cover_key = excluded.cover_key,
                video_url = excluded.video_url,
                cover_url = excluded.cover_url,
                file_size = excluded.file_size,
                created_at = CURRENT_TIMESTAMP`,
        args: [r.video_key, resolvedUserId, r.cover_key, videoUrl, coverUrl, r.file_size],
      });

      if (exists.rows.length > 0) refreshed++;
      else added++;
    }

    return c.json({
      success: true,
      added,
      refreshed,
      skipped,
      total: allVideos.rows.length,
      staleHours: STALE_HOURS,
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/download-links', async (c) => {
  try {
    const db = turso();
    const userId = c.req.query('userId') || 'user_123';

    const rows = await db.execute({
      sql: `SELECT video_key, user_id, cover_key, video_url, cover_url, file_size, created_at
            FROM download_links
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC`,
      args: [userId],
    });

    return c.json({
      success: true,
      items: rows.rows.map(r => ({
        videoKey: r.video_key,
        userId: r.user_id,
        coverKey: r.cover_key,
        videoUrl: r.video_url,
        coverUrl: r.cover_url,
        fileSize: r.file_size,
        createdAt: r.created_at,
      })),
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.delete('/api/download-links', async (c) => {
  try {
    const db = turso();
    const videoKey = c.req.query('videoKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!videoKey) throw new Error('videoKey required');

    await db.execute({
      sql: `DELETE FROM download_links WHERE video_key = ? AND user_id = ?`,
      args: [videoKey, userId],
    });

    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ============ end download_links feature ============

export default app;
