import { Hono } from 'hono';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';

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

const MAX_BYTES = 300 * 1024 * 1024;

// ---- Upload a single local file (multipart form) ----
app.post('/upload', async (c) => {
  try {
    const client = s3();
    const db = turso();

    const body = await c.req.parseBody();
    const file = body.file;
    const userId = String(body.userId || 'user_123').trim().slice(0, 100) || 'user_123';
    const dateModified = body.dateModified ? String(body.dateModified).slice(0, 40) : null;

    if (!file || typeof file === 'string') {
      return c.json({ success: false, error: 'file field required' }, 400);
    }

    const size = file.size || 0;
    if (size > MAX_BYTES) {
      return c.json({ success: false, error: 'file too large', bytes: size, max: MAX_BYTES }, 413);
    }

    const originalName = String(file.name || 'file').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 120);
    const fileType = file.type || 'application/octet-stream';
    const ext = (originalName.match(/\.([a-z0-9]{1,8})$/i) || [, ''])[1].toLowerCase();
    const fileKey = `local_${randomUUID()}${ext ? '.' + ext : ''}`;

    const upload = new Upload({
      client,
      params: {
        Bucket: process.env.B2_BUCKET_NAME,
        Key: fileKey,
        Body: file.stream(),
        ContentType: fileType,
        ContentLength: size || undefined,
      },
    });

    await upload.done();

    await db.execute({
      sql: `INSERT INTO local_files
              (file_key, original_name, file_type, file_size, user_id, date_modified)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [fileKey, originalName, fileType, size || null, userId, dateModified],
    });

    return c.json({
      success: true,
      fileKey,
      originalName,
      fileType,
      fileSize: size || null,
      userId,
      dateModified,
    });
  } catch (error) {
    console.error('Local upload error:', error.message);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ---- List files for a user ----
app.get('/list', async (c) => {
  try {
    const db = turso();
    const userId = c.req.query('userId') || 'user_123';

    const rows = await db.execute({
      sql: `SELECT file_key, original_name, file_type, file_size, user_id, date_modified, uploaded_at
            FROM local_files
            WHERE user_id = ?
            ORDER BY uploaded_at DESC, id DESC`,
      args: [userId],
    });

    return c.json({
      success: true,
      items: rows.rows.map(r => ({
        fileKey: r.file_key,
        originalName: r.original_name,
        fileType: r.file_type,
        fileSize: r.file_size,
        userId: r.user_id,
        dateModified: r.date_modified,
        uploadedAt: r.uploaded_at,
      })),
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ---- Sign a download URL for a file ----
app.get('/download', async (c) => {
  try {
    const client = s3();
    const db = turso();
    const fileKey = c.req.query('fileKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!fileKey) throw new Error('fileKey required');

    const check = await db.execute({
      sql: `SELECT file_key, original_name FROM local_files
            WHERE file_key = ? AND user_id = ?`,
      args: [fileKey, userId],
    });
    if (check.rows.length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    const command = new GetObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: fileKey,
    });
    const downloadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });

    return c.json({
      success: true,
      downloadUrl,
      originalName: check.rows[0].original_name,
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ---- Delete a file (B2 object + Turso row) ----
app.delete('/delete', async (c) => {
  try {
    const client = s3();
    const db = turso();
    const fileKey = c.req.query('fileKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!fileKey) throw new Error('fileKey required');

    const check = await db.execute({
      sql: `SELECT file_key FROM local_files WHERE file_key = ? AND user_id = ?`,
      args: [fileKey, userId],
    });
    if (check.rows.length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    await client.send(new DeleteObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: fileKey,
    }));

    await db.execute({
      sql: `DELETE FROM local_files WHERE file_key = ? AND user_id = ?`,
      args: [fileKey, userId],
    });

    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default app;
