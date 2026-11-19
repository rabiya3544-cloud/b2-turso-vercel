// src/tikcdn.js
// Merged: Turso RPC (tiktok_posts) + Vercel Blob cover upload.
// Mount in src/app.js as: app.route('/api/tikcdn', tikcdnApp);

import { Hono } from 'hono';
import { createClient } from '@libsql/client';
import { put } from '@vercel/blob';

const app = new Hono();

/* ------------------------------------------------------------------ */
/*  CLIENTS (lazy singletons — same pattern as app.js)                 */
/* ------------------------------------------------------------------ */

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

let _blobTokenWarned = false;
function blobToken() {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t && !_blobTokenWarned) {
    _blobTokenWarned = true;
    console.warn('BLOB_READ_WRITE_TOKEN is not set — cover uploads will fail');
  }
  return t;
}

/* ------------------------------------------------------------------ */
/*  HELPERS                                                            */
/* ------------------------------------------------------------------ */

function rowsToObjects(result) {
  const cols = result.columns || [];
  return (result.rows || []).map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

// Covers (images) live on TikTok CDNs — same allowlist as app.js.
const ALLOWED_IMAGE_HOSTS =
  /(^|\.)(tiktokv|tiktokcdn|byteoversea|ibytedtos|muscdn|tos-)\.com$/i;

function sanitizeDate(date) {
  if (!date) return null;
  return String(date).replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40);
}

function pickExt(url, contentType) {
  const m = String(url || '').match(/\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  if (contentType) {
    if (contentType.includes('png'))  return 'png';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('gif'))  return 'gif';
    if (contentType.includes('avif')) return 'avif';
    if (contentType.includes('jpeg')) return 'jpg';
  }
  return 'jpg';
}

/* ------------------------------------------------------------------ */
/*  DB FUNCTIONS                                                       */
/* ------------------------------------------------------------------ */

/* ---- WRITE: inserts ---- */

async function insertPosts(post) {
  const sql = `
    INSERT INTO tiktok_posts (
      "Date", "Link", "Likes", "WhoCanView",
      "AllowComments", "AllowStitches", "AllowDuets", "AllowStickers", "AllowSharingToStory",
      "ContentDisclosure", "AIGeneratedContent", "Sound", "Location",
      "Title", "AddYoursText", "AlternateText", "CoverImage", "NumberOfCollections"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const args = [
    post.Date,
    post.Link,
    post.Likes != null ? Number(String(post.Likes).replace(/,/g, '')) : 0,
    post.WhoCanView,
    post.AllowComments ? 1 : 0,
    post.AllowStitches ? 1 : 0,
    post.AllowDuets ? 1 : 0,
    post.AllowStickers ? 1 : 0,
    post.AllowSharingToStory ? 1 : 0,
    post.ContentDisclosure,
    post.AIGeneratedContent,
    post.Sound,
    post.Location,
    post.Title,
    post.AddYoursText,
    post.AlternateText,
    post.CoverImage,
    post.NumberOfCollections,
  ];

  return await turso().execute({ sql, args });
}

async function insertBulkPosts(posts) {
  const sql = `
    INSERT INTO tiktok_posts (
      "Date", "Link", "Likes", "WhoCanView",
      "AllowComments", "AllowStitches", "AllowDuets", "AllowStickers", "AllowSharingToStory",
      "ContentDisclosure", "AIGeneratedContent", "Sound", "Location",
      "Title", "AddYoursText", "AlternateText", "CoverImage", "NumberOfCollections"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const statements = posts.map((post) => ({
    sql,
    args: [
      post.Date,
      post.Link,
      post.Likes != null ? Number(String(post.Likes).replace(/,/g, '')) : 0,
      post.WhoCanView,
      post.AllowComments ? 1 : 0,
      post.AllowStitches ? 1 : 0,
      post.AllowDuets ? 1 : 0,
      post.AllowStickers ? 1 : 0,
      post.AllowSharingToStory ? 1 : 0,
      post.ContentDisclosure,
      post.AIGeneratedContent,
      post.Sound,
      post.Location,
      post.Title,
      post.AddYoursText,
      post.AlternateText,
      post.CoverImage,
      post.NumberOfCollections,
    ],
  }));

  return await turso().batch(statements, 'write');
}

/* ---- WRITE: update Status by Date ---- */

async function updatePostsStatusByDates(dates, status) {
  if (!Array.isArray(dates) || dates.length === 0) {
    return { updated: 0, success: true };
  }
  if (typeof status !== 'string' || status.length === 0) {
    throw new Error('status must be a non-empty string');
  }

  const CHUNK = 500;
  let total = 0;

  for (let i = 0; i < dates.length; i += CHUNK) {
    const slice = dates.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const sql = `UPDATE tiktok_posts SET "Status" = ? WHERE "Date" IN (${placeholders})`;
    const result = await turso().execute({
      sql,
      args: [status, ...slice],
    });
    total += result.rowsAffected ?? 0;
  }

  return { updated: total, success: true };
}

/* ---- WRITE: update blob cover metadata by Date ---- */

async function updateBlobCoverByDates(dates, blobCoverPathname, blobCoverUrl) {
  if (!Array.isArray(dates) || dates.length === 0) {
    return { updated: 0, success: true };
  }
  if (typeof blobCoverPathname !== 'string' || blobCoverPathname.length === 0) {
    throw new Error('blobCoverPathname must be a non-empty string');
  }
  if (typeof blobCoverUrl !== 'string' || blobCoverUrl.length === 0) {
    throw new Error('blobCoverUrl must be a non-empty string');
  }

  const CHUNK = 500;
  let total = 0;

  for (let i = 0; i < dates.length; i += CHUNK) {
    const slice = dates.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const sql = `
      UPDATE tiktok_posts
      SET "blob_cover_pathname" = ?, "blob_cover_url" = ?
      WHERE "Date" IN (${placeholders})
    `;
    const result = await turso().execute({
      sql,
      args: [blobCoverPathname, blobCoverUrl, ...slice],
    });
    total += result.rowsAffected ?? 0;
  }

  return { updated: total, success: true };
}

/* ---- WRITE: clear all ---- */

async function clearAllPosts() {
  const result = await turso().execute('DELETE FROM tiktok_posts');
  return { deleted: result.rowsAffected ?? 0, success: true };
}

/* ---- READ ---- */

async function getPostsSummary({ limit = 50, offset = 0 } = {}) {
  const sql = `
    SELECT "Date", "Likes", "CoverImage", "Link"
    FROM tiktok_posts_summary
    ORDER BY "Likes" DESC
    LIMIT ? OFFSET ?
  `;
  const result = await turso().execute({ sql, args: [limit, offset] });
  return rowsToObjects(result);
}

async function getSummaryByDate(date) {
  const sql = `
    SELECT "Date", "Likes", "CoverImage", "Link"
    FROM tiktok_posts_summary
    WHERE "Date" = ?
    LIMIT 1
  `;
  const result = await turso().execute({ sql, args: [date] });
  const rows = rowsToObjects(result);
  return rows[0] ?? null;
}

async function getTopLikedPosts(n = 10) {
  const sql = `
    SELECT "Date", "Likes", "CoverImage", "Link", "Status",
           "blob_cover_pathname", "blob_cover_url"
    FROM tiktok_posts_summary
    ORDER BY "Likes" DESC
    LIMIT ?
  `;
  const result = await turso().execute({ sql, args: [n] });
  return rowsToObjects(result);
}

async function getFailedForB2(n = 100) {
  const sql = `
    SELECT "Date", "Likes", "CoverImage", "Link", "Status",
           "blob_cover_pathname", "blob_cover_url"
    FROM failed_for_b2
    ORDER BY "Likes" DESC
    LIMIT ?
  `;
  const result = await turso().execute({ sql, args: [n] });
  return rowsToObjects(result);
}

async function countPosts() {
  const r = await turso().execute(`SELECT COUNT(*) AS total FROM tiktok_posts`);
  return Number(r.rows[0].total ?? 0);
}

async function countSummaryRows() {
  const r = await turso().execute(`SELECT COUNT(*) AS total FROM tiktok_posts_summary`);
  return Number(r.rows[0].total ?? 0);
}

async function countPostsWithMinLikes(minLikes = 0) {
  const r = await turso().execute({
    sql: `SELECT COUNT(*) AS total FROM tiktok_posts WHERE "Likes" >= ?`,
    args: [minLikes],
  });
  return Number(r.rows[0].total ?? 0);
}

/* ------------------------------------------------------------------ */
/*  COVER UPLOAD — fetch image from TikTok CDN, stream to Vercel Blob  */
/* ------------------------------------------------------------------ */

async function uploadCoverToBlob({ coverImg, date, likes, userId, sourceLink }) {
  if (!coverImg) {
    throw Object.assign(new Error('coverImg required'), { status: 400 });
  }

  let parsed;
  try { parsed = new URL(coverImg); } catch {
    throw Object.assign(new Error('invalid coverImg URL'), { status: 400 });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw Object.assign(new Error('only http(s) URLs'), { status: 400 });
  }
  if (!ALLOWED_IMAGE_HOSTS.test(parsed.hostname)) {
    throw Object.assign(
      new Error(`host not allowed: ${parsed.hostname}`),
      { status: 400 }
    );
  }

  const upstream = await fetch(coverImg, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' },
    redirect: 'follow',
  });

  if (!upstream.ok || !upstream.body) {
    throw Object.assign(
      new Error(`upstream fetch failed: HTTP ${upstream.status}`),
      { status: 502 }
    );
  }

  const contentType = upstream.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//i.test(contentType)) {
    throw Object.assign(
      new Error(`not an image: ${contentType}`),
      { status: 415 }
    );
  }

  const dateStr  = sanitizeDate(date) || Date.now().toString();
  const ext      = pickExt(coverImg, contentType);
  const pathname = `cover_${dateStr}.${ext}`;

  const blob = await put(pathname, upstream.body, {
    access: 'public',
    token: blobToken(),
    addRandomSuffix: false,
    contentType,
    customMetadata: {
      date:       String(date || ''),
      likes:      String(likes ?? 0),
      sourceLink: String(sourceLink || ''),
      userId:     String(userId || ''),
    },
  });

  return {
    success: true,
    pathname: blob.pathname,
    url: blob.url,
    contentType,
    size: blob.size ?? null,
  };
}

/* ------------------------------------------------------------------ */
/*  MIDDLEWARE — CORS (same shape as app.js)                           */
/* ------------------------------------------------------------------ */

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Cache-Control', 'no-store');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

/* ------------------------------------------------------------------ */
/*  ROUTES                                                             */
/* ------------------------------------------------------------------ */

/* ---- POST actions ---- */

app.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { action, payload = {} } = body;

    switch (action) {
      case 'insertPost': {
        if (!payload.post || typeof payload.post !== 'object') {
          return c.json({ error: 'payload.post is required' }, 400);
        }
        const result = await insertPosts(payload.post);
        return c.json({
          inserted: 1,
          lastInsertRowid: result.lastInsertRowid ?? null,
        });
      }

      case 'insertBulkPosts': {
        if (!Array.isArray(payload.posts)) {
          return c.json({ error: 'payload.posts must be an array' }, 400);
        }
        const result = await insertBulkPosts(payload.posts);
        return c.json({ result, inserted: payload.posts.length });
      }

      case 'updatePostsStatusByDates': {
        const { dates, status } = payload;
        if (!Array.isArray(dates) || dates.length === 0) {
          return c.json({ error: 'payload.dates must be a non-empty array' }, 400);
        }
        if (typeof status !== 'string' || status.length === 0) {
          return c.json({ error: 'payload.status must be a non-empty string' }, 400);
        }
        const result = await updatePostsStatusByDates(dates, status);
        return c.json(result);
      }

      case 'updateBlobCoverByDates': {
        const { dates, blobCoverPathname, blobCoverUrl } = payload;
        if (!Array.isArray(dates) || dates.length === 0) {
          return c.json({ error: 'payload.dates must be a non-empty array' }, 400);
        }
        if (typeof blobCoverPathname !== 'string' || blobCoverPathname.length === 0) {
          return c.json({ error: 'payload.blobCoverPathname must be a non-empty string' }, 400);
        }
        if (typeof blobCoverUrl !== 'string' || blobCoverUrl.length === 0) {
          return c.json({ error: 'payload.blobCoverUrl must be a non-empty string' }, 400);
        }
        const result = await updateBlobCoverByDates(dates, blobCoverPathname, blobCoverUrl);
        return c.json(result);
      }

      default:
        return c.json({ error: `Unknown POST action: ${action}` }, 400);
    }
  } catch (err) {
    console.error('tikcdn POST error:', err);
    return c.json({ error: err.message }, err.status || 500);
  }
});

/* ---- GET actions ---- */

app.get('/', async (c) => {
  try {
    const action = c.req.query('action');

    switch (action) {
      case 'getPostsSummary': {
        const limit  = clamp(Number(c.req.query('limit')  ?? 50), 1, 3000);
        const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
        const result = await getPostsSummary({ limit, offset });
        return c.json({ result });
      }

      case 'getSummaryByDate': {
        const date = c.req.query('date');
        if (!date) return c.json({ error: 'query.date is required' }, 400);
        const result = await getSummaryByDate(date);
        return c.json({ result });
      }

      case 'getTopLikedPosts': {
        const n = clamp(Number(c.req.query('n') ?? 10), 1, 3000);
        const result = await getTopLikedPosts(n);
        return c.json({ result });
      }

      case 'getFailedForB2': {
        const n = clamp(Number(c.req.query('n') ?? 100), 1, 3000);
        const result = await getFailedForB2(n);
        return c.json({ result });
      }

      case 'countPosts': {
        const result = await countPosts();
        return c.json({ result });
      }

      case 'countSummaryRows': {
        const result = await countSummaryRows();
        return c.json({ result });
      }

      case 'countPostsWithMinLikes': {
        const min = Number(c.req.query('minLikes') ?? 0);
        const result = await countPostsWithMinLikes(min);
        return c.json({ result });
      }

      case 'clearAllPosts': {
        const result = await clearAllPosts();
        return c.json({ ok: true, ...result });
      }

      case 'debugViewCols': {
        const r = await turso().execute(`PRAGMA table_info(tiktok_posts_summary)`);
        const v = await turso().execute(
          `SELECT sql FROM sqlite_master WHERE type='view' AND name='tiktok_posts_summary'`
        );
        return c.json({
          columns: r.rows.map(row => row[1]),
          viewSql: v.rows[0]?.[0] || null,
        });
      }

      default:
        return c.json({ error: `Unknown GET action: ${action}` }, 400);
    }
  } catch (err) {
    console.error('tikcdn GET error:', err);
    return c.json({ error: err.message }, 500);
  }
});

/* ---- POST /upload-cover-to-blob ---- */

app.post('/upload-cover-to-blob', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await uploadCoverToBlob(body);
    return c.json(result);
  } catch (err) {
    console.error('tikcdn upload-cover-to-blob error:', err);
    return c.json(
      { success: false, error: err.message || 'Upload failed' },
      err.status || 500
    );
  }
});

export default app;
