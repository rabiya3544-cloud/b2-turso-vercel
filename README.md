# B2 + Turso on Vercel

Server-side CDN to B2 ingestion. The Hono function fetches the CDN URL and
streams the response body directly into B2 via @aws-sdk/lib-storage. Metadata
(source URL, likes, posted date) is stored in Turso.

CORS is wildcard (*): any frontend origin can call the API — no cookies/sessions
involved, so no allowlist or credentials flag is needed.

## Stack

- Frontend: static HTML in public/
- Backend: Hono (framework mode) at src/app.js
- Storage: Backblaze B2 (S3-compatible)
- Metadata: Turso (SQLite-compatible cloud)

## Env vars (Vercel dashboard)

| Key | Description |
|-----|-------------|
| B2_APPLICATION_KEY_ID | B2 key ID |
| B2_APPLICATION_KEY | B2 application key |
| B2_BUCKET_NAME | B2 bucket name |
| B2_ENDPOINT_URL | e.g. https://s3.us-west-002.backblazeb2.com |
| TURSO_DATABASE_URL | libsql://your-db.turso.io |
| TURSO_AUTH_TOKEN | Turso database token |

No ALLOWED_ORIGIN is needed — the API accepts requests from any origin.

## Database

Run once in the Turso shell:

    CREATE TABLE IF NOT EXISTS b2_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_key TEXT NOT NULL UNIQUE,
        file_url TEXT,
        source_cdn_url TEXT,
        user_id TEXT NOT NULL,
        likes INTEGER NOT NULL DEFAULT 0,
        posted_date TEXT NOT NULL,
        upload_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_b2_files_user_id ON b2_files (user_id);
    CREATE INDEX IF NOT EXISTS idx_b2_files_posted_date ON b2_files (posted_date);

## Endpoints

- POST /api/upload-from-url   { url, date, likes }  -> { success, objectKey, publicFileUrl }
- GET  /api/download-b2-file?objectKey=...          -> { success, downloadUrl }

Both endpoints respond to CORS preflight (OPTIONS) automatically.

## Deploy

1. Push this repo to GitHub.
2. Vercel -> Add New -> Project -> import the repo.
3. Add all env vars above (Production environment).
4. Deploy.

Vercel detects Hono from package.json, finds src/app.js as the entrypoint,
and introspects routes automatically. No vercel.json needed.
