import { Hono } from 'hono';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient } from '@libsql/client';
import { readFile } from 'fs/promises';
import { join } from 'path';

const app = new Hono();

// ---- Lazy clients (built on first use, not at module load) ----
let _s3, _turso, _region;

function s3() {
  if (!_s3) {
    const endpoint = process.env.B2_ENDPOINT_URL;
    if (!endpoint) throw new Error('B2_ENDPOINT_URL is not set');
    _region = new URL(endpoint).hostname.split('.')[1];
    _s3 = new S3Client({
      endpoint,
      region: _region,
      credentials: {
        accessKeyId: process.env.B2_APPLICATION_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
      },
    });
  }
  return _s3;
}

function turso() {
  if (!_turso) {
    _turso = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _turso;
}

// ---- CORS ----
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Cache-Control', 'no-store');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

const authMiddleware = async (c, next) => {
  c.set('userId', 'user_123');
  await next();
};

// ---- Frontend (does NOT touch B2/Turso) ----
app.get('/', async (c) => {
  try {
    const html = await readFile(join(process.cwd(), 'public/index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('index.html not found', 500);
  }
});

// ---- Upload (needs B2 + Turso) ----
const ALLOWED_HOSTS = /(^|\.)(tiktokv|tiktokcdn|byteoversea|ibytedtos|muscdn|tos-)\.com$/i;
const MAX_BYTES = 300 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 90_000;

app.post('/api/upload-from-url', authMiddleware, async (c) => {
  try {
    const client = s3();
    const db = turso();

    const { url, date, likes } = await c.req.json();
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

    const userId = c.get('userId');
    const publicFileUrl = `${process.env.B2_ENDPOINT_URL}/${process.env.B2_BUCKET_NAME}/${filename}`;
    const postedDate = date
  ? new Date(String(date).replace(' ', 'T')).toISOString().slice(0, 10)
  : new Date().toISOString().slice(0, 10);
    const initialLikes = Number.isInteger(likes) && likes >= 0 ? likes : 0;

    await db.execute({
      sql: `INSERT INTO b2_files
              (object_key, file_url, source_cdn_url, user_id, likes, posted_date)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [filename, publicFileUrl, url, userId, initialLikes, postedDate],
    });

    return c.json({
      success: true,
      objectKey: filename,
      publicFileUrl,
      bytes: contentLength || null,
    });
  } catch (error) {
    console.error('Upload Error:', error.message);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ---- Download (needs B2 + Turso) ----
app.get('/api/download-b2-file', authMiddleware, async (c) => {
  try {
    const client = s3();
    const db = turso();

    const objectKey = c.req.query('objectKey');
    const userId = c.get('userId');
    if (!objectKey) throw new Error('objectKey required');

    const check = await db.execute({
      sql: `SELECT object_key FROM b2_files
            WHERE object_key = ? AND user_id = ?`,
      args: [objectKey, userId],
    });
    if (check.rows.length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    const command = new GetObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: objectKey,
    });
    const downloadUrl = await getSignedUrl(client, command, { expiresIn: 300 });

    return c.json({ success: true, downloadUrl });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default app;
