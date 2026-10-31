# AT Protocol event signup

A small event page with Bluesky sign-in and private SQLite storage. Originally built for a DC community happy hour; the default config now uses a fictional Back to the Future meetup in Hill Valley. You can run your own copy or ask about free hosting below.

**AT Protocol verifies identity. RSVPs do not become public records on attendees' PDSes.** The organizer stores individual responses, optional profile-picture button artwork and an independent future-contact preference in a private local database. No email collection, public attendee list, automated DMs or automatic posting.

This repository contains the application, tests and public page assets. It contains **no attendee records, signup database, credentials, private correspondence or original workspace history**. MIT licensed.

## Want this for your Bluesky meetup?

If you’d like to use this, I’m happy to set it up and host it for free to get you started. You can move it to your own hosting later if you want—the code is open source, and your event’s data can move with it.

It gives you a meetup page with Bluesky sign-in, private RSVPs, an optional profile-picture button designer, and an opt-in for future meetup updates. No email addresses to collect and no public attendee list.

**Send me:**

- The event name, date, time and timezone, venue, and a short description.
- The Bluesky handle of whoever will manage signups.
- Whether you want the button designer and future-meetup opt-in.
- Your preferred URL. If you own a domain, you keep control of it; I’ll tell you what DNS records to add.

I’ll handle the technical setup. You check the page before sharing it and handle the event itself, including any button printing. We’ll agree on how long to keep the page and signup data. While I’m hosting, I’ll also hold the private data and backups.

Contact [@proptermalone.bsky.social on Bluesky](https://bsky.app/profile/proptermalone.bsky.social) about hosting. Don’t put attendee lists, credentials or other private data in a public GitHub issue. Hosting starts by agreement, not automatically when you clone this repository.

Prefer to run it yourself? Start below.

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

This is a working single-event app, not a generic event platform. The default is a fictional **Hill Valley Bluesky meetup / November 5, 1955 / Doc Brown's house, 1640 Riverside Drive** from Back to the Future. It runs from 6 to 9 p.m. Pacific time. The alternate timezone tests also use October 21, 2015 to retain daylight-saving coverage. Before inviting people to your own deployment, replace all sample event facts and links:

1. `event.json`: event name, community line, invitation, description, public origin, start/end timestamps, IANA timezone, locale, venue name/address/website, calendar UID and branding. The server renders visible copy, accessible labels, social metadata, Google Calendar links, the `.ics` download, web manifest and OAuth display name from this one file. Create a new calendar UID for a different event; keep it stable when correcting the same event.
2. Branding assets: put your mark, favicon and icon PNGs in `public/`, then set their paths, descriptions, dimensions and primary color in `event.json`. Paths must name root-level PNG/SVG files. When `branding.socialImage` is `/social-preview.png`, the build regenerates the SVG source and PNG event card from the config, including the logo, event name, invitation, date/time, venue, address and public hostname. Set a different PNG path to use your own finished social card without regeneration. The build copies only configured assets. Optional `bluesky-avatar`/`bluesky-banner` files are generic logo assets, not runtime features or attendee artwork.
3. `.env`: private storage directories, **ADMIN_DIDS**, artwork deadline and optional cutoffs/print dimensions. These operational/privacy settings remain separate from public event copy. The example deadline is illustrative, not a retention policy chosen for your event.

`public/index.html` is now a template, not a file to customize for each event. Calendar and manifest responses are generated, not separately maintained static files. Dates are displayed using `timeZone` and `locale`; timestamps must include `Z` or an explicit offset. For Manchester use `Europe/London` and `en-GB`. Winter uses GMT, while summer uses BST; enter the correct offset for the intended date. The page, Google Calendar and `.ics` describe the same instants.

The config is validated and loaded once at startup. After changing event details, run `npm run build` to refresh the social image and restart the app to refresh the page. The SVG rasterizer uses installed system fonts; a sans-serif font such as DejaVu Sans should be available on the build host. `EVENT_CONFIG` selects a different JSON file (absolute paths recommended on a server); it defaults to `event.json` in the working directory. The same setting is used by the build and smoke test. Deploy that config alongside `dist/`, dependency manifests and the backup script, or point `EVENT_CONFIG` to your chosen file. Keep credentials and attendee data out of this public-copy config.

The checked-in event details are fictional and the `example.com` URLs are placeholders, not a live event. The social card shows the placeholder event information beside the generic official blue Bluesky butterfly. Logo-only SVGs are the unmodified [official butterfly download](https://bsky.social/about/brand-assets/butterfly/bluesky_media_kit_logo_transparent_1.svg); icon/avatar/banner PNGs are resized from the [official blue-on-white square logo](https://bsky.social/about/brand-assets/logos/bluesky_media_kit_logo_2.png), with white padding for banners. The social-card renderer embeds the configured logo without recoloring or stretching it. No original account artwork is included. Sources: [Bluesky brand assets](https://bsky.social/about/support/icons).

Bluesky's logos remain subject to its [Brand Guidelines](https://bsky.social/about/support/branding) and [Trademark Policy](https://bsky.social/about/support/trademarks), not this repository's MIT license. The current policy requires prior written permission for community meetup branding; contact `trademarks@blueskyweb.xyz` before public use. This independent project is not affiliated with, endorsed by, or officially connected to Bluesky Social PBC. Domain strings in tests are fixtures, not deployment configuration. Generic consent, deletion and operator authorization behavior is not overridden by event text.

## Configuration and HTTPS

`.env.example` lists supported environment settings. Keep actual `.env` files out of source control.

- `EVENT_CONFIG`: path to the public event JSON config, default `event.json` relative to the working directory.
- `APP_ORIGIN`: optional override of the config's exact origin, without trailing slash/path; useful for local development (`http://127.0.0.1:3000`). The override also updates public metadata and calendar URLs. Production requires HTTPS. The server listens only on loopback.
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
