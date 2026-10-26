# AT Protocol event signup

A small self-hosted event page with Bluesky sign-in and private SQLite storage. Built for a DC community happy hour; the public page in this repository is the worked example, not a hosted signup service for other events.

**AT Protocol verifies identity. RSVPs do not become public records on attendees' PDSes.** The organizer stores individual responses, optional profile-picture button artwork and an independent future-contact preference in a private local database. No email collection, public attendee list, automated DMs or automatic posting.

This repository contains the application, tests and public page assets. It contains **no attendee records, signup database, credentials, private correspondence or original workspace history**. MIT licensed.

## Quick start

Requires Node22.16+ and npm. Tested with Node22; its built-in SQLite API is experimental. One server process with private persistent disk; no separate database server required.

```sh
npm ci
npm run validate
npm run build
npm run smoke
cp .env.example .env
npm start
```

Open http://127.0.0.1:3000 . Local OAuth follows the AT Protocol loopback convention. For a real deployment, configure your own HTTPS origin, operator DID and retention deadline as described below. Never copy a production database into a public directory or this repository.

## What it does

- Sign in with a bare Bluesky username, full handle or custom domain using the official OAuth SDK. Account ownership is verified; attendance remains self-reported.
- One individual response per DID: Coming, Maybe or Not this time. No party-size field.
- Optional, separate profile-picture button request, with preview, editable short label, top/bottom text and white/black lettering. Artwork approval is versioned; attendance is not implied by a button request.
- Independent, default-off future-meetup contact preference. It can be managed without attendance; withdrawing event artwork does not silently unsubscribe the account. No automatic contact is sent.
- Private operator attendance/button views, future-contact list and print-sheet export. No operator access is granted by default.
- Editable choices, stale-write protection, explicit deletion and configured artwork expiry. Artwork expiry does not erase attendance/contact preferences; decide their retention separately.
- Encrypted storage is **not** provided by the app. Protect the host and disk, database, OAuth signing key, backups and exported print sheets.

## Adapt the example

This is a working single-event app, not a generic event platform. The sample retains public **DC Bluesky / November10,2026 / Sudhouse** branding so you can see the actual page that inspired it. Before inviting people to your own deployment, replace all sample event facts and links:

1. `public/index.html`: visible text, date/time, venue, address, Google Calendar URL, social metadata, privacy and retention copy.
2. `public/happy-hour.ics`: event UID, title, timezone-aware date/time, location and URL. Create a new UID for a different event.
3. `public/social-preview.svg` and `.png`: social card. SVG is editable source; regenerate the PNG after changing it. An installed SVG renderer such as `rsvg-convert` works; it is not needed to run the app.
4. `public/favicon.svg`, icon PNGs, `site.webmanifest` and CSS: branding. Optional `bluesky-avatar`/`bluesky-banner` sources are account artwork from the example, not runtime features.
5. `.env`: your origin, private storage directories, **ADMIN_DIDS**, artwork deadline and optional cutoffs/print dimensions. The example deadline is illustrative, not a retention policy chosen for your event. Tests intentionally check sample copy and artwork; update their expectations when customizing.

The app's OAuth metadata, public-profile fetching and labels also contain the sample service name; search the source for `DC Bluesky`, `dcbsky.com`, `Sudhouse` and `2026` when adapting it. Domain strings in tests are fixtures, not deployment configuration. Do not send attendees to the sample event accidentally.

## Configuration and HTTPS

`.env.example` lists supported environment settings. Keep actual `.env` files out of source control.

- `APP_ORIGIN`: exact public origin without trailing slash/path. Local default is `http://127.0.0.1:3000`; production requires HTTPS. The server listens only on loopback.
- `ADMIN_DIDS`: comma-separated verified account DIDs allowed into operator APIs. Blank means nobody has operator access. Configure your own DID; no original organizer identity is privileged in this export. Handles can change; authorization uses the verified DID, never a browser-provided identity.
- `DATA_DIR`: private persistent directory; defaults to ignored `.data/`. One process only. Keep `app.sqlite` and `oauth-key.json` stable across restarts.
- `ARTWORK_DELETE_AT`: required for HTTPS and backups; ISO timestamp with explicit timezone. Choose it deliberately and make the public copy match. `RESPONSE_CUTOFF` and `BUTTON_CUTOFF` are optional. Withdrawal, deletion and contact-preference management remain available after cutoffs.
- `PRINT_FACE_DIAMETER_MM`: provisional visible circle, default58mm. `PRINT_CUT_DIAMETER_MM` must be explicitly configured for print export; test the actual cutter/press at100% scale. There is no promise that58mm is the paper-cut diameter.

Use a Node-capable host with durable disk and an HTTPS reverse proxy. This is not a Cloudflare Workers/Pages-only deployment. Preserve public reachability of `/client-metadata.json`, `/jwks.json` and `/oauth/callback`. Do a real provider authorization round trip before collecting responses; unit tests and HTTP smoke do not establish that.

When using a Cloudflare tunnel, the app can trust `CF-Connecting-IP` only if explicitly enabled with `TRUST_CLOUDFLARE_TUNNEL=true` and a private `CLOUDFLARE_ORIGIN_SECRET`. A loopback proxy must overwrite/inject `x-dcbsky-proxy-secret` and strip untrusted forwarding headers. Do not expose the Node port directly or enable header trust merely because Cloudflare is in front. The default socket-peer rate limits may group all proxied visitors otherwise. Deployment configuration and DNS credentials are intentionally not included.

You do **not** need to host a PDS to run this app. Users can sign in from their existing interoperable provider. Creating a community bot or moving an account to a self-hosted PDS is separate.

## Security and known dependency risk

This is a small application, not an independently certified security product. It stores personal attendance and contact preferences even though a DID itself is public. Obtain appropriate consent, restrict operator access and define retention before collecting data.

Server-side OAuth tokens are discarded after identity establishment. Random browser sessions are hashed at rest; HttpOnly/SameSite cookies, Origin+CSRF checks, one-use OAuth browser binding, request limits, safe DOM text output and private operator authorization protect application boundaries. Avatar fetches are restricted to validated raster images on fixed Bluesky CDN hosts. SDK identity/auth networking uses the official SSRF guard and additional bounds.

**The production dependency audit is not clean.** The release preparation audit reports15high-severity dependency-chain entries from Zod advisory `GHSA-mrhx-c7xc-m3w5` through the official OAuth SDK. These are dependency entries, not15independent application flaws. No unsupported forced major-version override was applied. Re-run `npm audit --omit=dev` and check compatible vendor fixes before deploying.

Application safeguards cap decoded SDK responses at128KiB, enforce a10second deadline and JSON complexity budgets, and allow at most four concurrent authorization/callback operations without an unbounded queue. They reduce exposure; they do **not** patch Zod or establish comprehensive denial-of-service resistance. Legitimate complex provider documents may be rejected. Review this residual risk for your deployment rather than treating the passing tests as a clean audit.

## Backups and deletion

Build first, then run with your configured environment:

```sh
npm run backup
```

The command creates a consistent SQLite online backup plus the unchanged OAuth key in `BACKUP_DIR` (ignored `.backups/` by default). It fails if no existing database/key is present. **These snapshots are not encrypted.** Use private/encrypted storage and independent off-host protection as appropriate; test restoration to a separate private directory before relying on it.

The command caps snapshots at seven and expires them after seven days. At/after the artwork deadline, pre-deadline snapshots are removed; newer snapshots retain attendance/contact data without artwork. Each backup also runs expiry cleanup and compacts its database copy. Schedule a serialized daily backup **and a run at the artwork deadline**, even if the web app stops, and monitor failures. This repository installs no timer or hosting service.

The app scrubs artwork while running; stopping it delays cleanup until restart/request/backup. Downloads, browser folders, print queues, physical prints and host snapshots are outside the app's control. You must apply the same artwork deadline to those copies. Deletion is not a claim of forensic secure erasure.

Restore while the app is stopped into a new private directory, with matching policy/origin and both database and key. Never overlay a running database or mix old WAL/SHM files. After the artwork deadline, restore only sanitized post-deadline backups. Verify operator authorization, private records and a real OAuth login before reopening collection.

## Development checks

```sh
npm run validate
npm run build
npm run smoke
npm audit --omit=dev
```

Validation includes Biome, strict TypeScript, Vitest/happy-dom, selected core business-logic coverage gates, Knip and ts-prune. Socket/database workflows use real local resources; third-party OAuth/profile networking is an unmanaged boundary. Coverage numbers are not whole-app security coverage. The audit is separate and currently nonzero as disclosed above.

No hosted support, moderation service, email list, payments, recurring-event platform, automatic messaging or migration service is included.
