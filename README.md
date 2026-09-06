# CONEFIX — Vercel-ready Website

CONEFIX is a two-page Minecraft website with an Express backend for status, website statistics, Discord logging, and the Creator API.

## Deploy on Vercel

This version is prepared for Vercel's current Express deployment flow. Vercel can detect an Express app automatically, so you do not need to enter a build command or output directory. The app is exported from `server.js`, while files in `public/` are served as static assets.

### 1. GitHub

Upload the contents of this project to your GitHub repository. The root should contain:

- `server.js`
- `package.json`
- `public/`
- `data/`
- `.env.example`

Do **not** upload a real `.env` file.

### 2. Vercel

Import the GitHub repository into Vercel.

Use these project settings:

- Application Preset: **Other** (Vercel may also detect Express automatically)
- Root Directory: `./`
- Build Command: leave blank/default
- Output Directory: leave blank/default

Then deploy.

### 3. Environment variables

After deployment, add these in Vercel Project Settings → Environment Variables:

- `DISCORD_WEBHOOK_URL` — Discord webhook for the web-status message
- `DISCORD_LOG_WEBHOOK_URL` — optional Discord webhook for activity logs
- `DISCORD_STATUS_MESSAGE_ID` — optional; set this after you have a status message you want the app to edit instead of creating a new one
- `SITE_URL` — optional on Vercel; if blank, `/api/status` automatically uses the deployed request URL
- `STATUS_INTERVAL_MS` — local-server setting; Vercel does not keep a background `setInterval` alive between requests

Never put Discord webhook URLs in browser HTML or JavaScript.

## Important Vercel differences

### Website statistics

The statistics API works on Vercel, but this package intentionally uses runtime memory there instead of pretending that JSON files are durable. Vercel deployments are immutable and runtime file writes are not a reliable persistent database. As a result, stats can reset when the function restarts.

For permanent production statistics, connect a real database/storage service later.

### Creator uploads

The Creator API works as an Express API, but uploaded creator files are stored in the Vercel runtime's temporary storage in this Vercel-ready build. They are not guaranteed to survive a new instance or deployment.

For permanent creator uploads, connect Vercel Blob or another object-storage service. Vercel recommends Blob for durable file storage.

Vercel Functions also have a 4.5 MB request-payload limit, so this build limits creator uploads to 4 MB when running on Vercel. Large Minecraft files should be uploaded directly to durable object storage instead.

### Discord status

On a normal local Node server, the existing background interval can refresh the Discord status automatically. On Vercel, the serverless function is request-driven, so the old always-running interval is disabled. Calling `GET /api/status` performs the status check and Discord update.

If you later want automatic scheduled status updates, add a Vercel Cron job or an external scheduler. Vercel Hobby Cron jobs are limited to once per day; Pro/Enterprise support more frequent schedules.

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

For local development, `.env.example` can be copied to `.env` and filled with your Discord settings.

## Main files

- `public/index.html` — Home page
- `public/site.html` — full Site page with catalog, search, downloads and version selectors
- `server.js` — Express application and API
- `data/website-stats.json` — local development statistics storage
- `package.json` — Node/Express dependencies

## CONEFIX Authentication

The Creator Dashboard now includes Sign Up, Log In, Log Out, secure server-side password hashing, and protected creator actions.

### Vercel setup (required for persistent accounts)

1. Create a Supabase project.
2. Open Supabase SQL Editor and run `supabase-auth.sql` from this project.
3. In Vercel Project Settings → Environment Variables, add:
   - `AUTH_JWT_SECRET` — a long random secret (32+ characters).
   - `SUPABASE_URL` — your Supabase project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — your Supabase service-role key. Keep this server-only and never put it in HTML.
4. Redeploy the Vercel project.

The browser only receives an HttpOnly session cookie. Passwords are hashed with Node's built-in `scrypt` and are never returned by the API.

### Local development

If `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are not set locally, the included backend stores local development accounts in `data/auth-users.json`. This is for local testing only; use Supabase for Vercel/production.
