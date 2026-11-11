# Bluesky meetup signup

This is an extremely vibecoded kit I built to support a Bluesky meetup in DC that I then reworked with the intention of making it easier for other people to set up Blue Sky meetups in other cities, or I guess in DC also. It's intended to be run through Claude Code or Codex or whatever agent of your choice.

Feel free to modify this in whatever way you see fit. It's meant as a jumping-off point, although I've tried to make it relatively complete if you want to just try to run it out of the box.

You will need to host a webpage to use this as designed. I'm happy to host temporarily while you get set up if you don't want to set up infrastructure for yourself.

— @proptermalone.bsky.social

A meetup page where people sign in with Bluesky, RSVP, and request a button with their profile picture on it. They can also ask to hear about future meetups. Built for a DC happy hour; free to use under the MIT license.

## For organizers

### What you need

- Your event's name, date, hours, timezone, venue, address and a short description.
- A Bluesky account to manage signups. Attendees use their own Bluesky accounts too.
- A website address and somewhere to run the app. You can use a domain or subdomain; hosting needs HTTPS, Node.js and persistent disk storage. Static hosting alone won't work. You don't need to run a Bluesky server.
- Codex, Claude Code, or someone who knows how to run a web app. Give them this repo and your event details. The setup instructions are below.

If you want buttons, you'll also need a printer, press, cutter and matching button parts, or a shop to make them.

### Want this for your Bluesky meetup?

I can help set it up and host it for free to get you started. You can move it to your own hosting later, including your event's data.

Contact **@proptermalone.bsky.social** with the event details, the organizer's handle, whether you want buttons and future-meetup updates, and your preferred website address. If you have a domain, you keep it; I'll tell you which DNS records to add.

https://bsky.app/profile/proptermalone.bsky.social

You check the page before sharing it and handle the event and printing. We'll agree on how long to keep the data; while I'm hosting, I'll hold the private data and backups. If you self-host, that's your responsibility. Keep attendee data and credentials out of public issues.

## For coding agents: setup and operations

Run one event per instance. Keep its data and credentials separate from other events. Get the owner's approval before deploying, publishing, spending money or contacting anyone. Ask whether they want the free hosting above before setting up a new host.

### Set up

Requires Node.js 22.16+ and npm; tested with Node 22. Run one server process with private persistent disk. It uses Node's built-in SQLite, which is experimental in Node 22; no separate database server is needed.

```sh
npm ci
cp .env.example .env
npm run validate
npm run build
npm run smoke
npm start
```

Open the local page:

http://127.0.0.1:3000

### Replace the sample event

This copy still describes the DC event at Sudhouse on November 10, 2026. Change:

- `public/index.html`: event details, calendar link, social metadata and privacy/retention text.
- `public/happy-hour.ics`: title, date/time, timezone, location, URL and a new event UID.
- Social preview SVG/PNG, icons, `site.webmanifest` and CSS. Regenerate images when their sources change.
- Service names in OAuth metadata and source; deadline formatting needs the event's locale and timezone too. Search for `DC Bluesky`, `dcbsky.com`, `Sudhouse` and `2026`, checking which matches are test fixtures.
- Tests that assert the sample event details. Keep the privacy and security checks.

Check for existing event-configuration work before adding another way to configure events. Never copy production data, credentials or private workspace history into the public repo.

### Configure and launch

See `.env.example` for settings. Never commit `.env`.

| Setting | What to set |
| --- | --- |
| `APP_ORIGIN` | Public HTTPS origin, without a path or trailing slash. Loopback HTTP is for local use. |
| `ADMIN_DIDS` | Organizer DIDs, comma-separated. Blank gives nobody admin access. Authorization uses verified DIDs, not handles supplied by a browser. |
| `DATA_DIR` | Private persistent directory. Keep `app.sqlite` and `oauth-key.json` across restarts. |
| `ARTWORK_DELETE_AT` | Artwork deletion deadline with an explicit timezone. Required for HTTPS and backups; match the page's privacy text. |
| `RESPONSE_CUTOFF`, `BUTTON_CUTOFF` | Optional deadlines for new responses and button requests. People must still be able to withdraw, delete or change contact preferences afterward. |
| `PRINT_FACE_DIAMETER_MM`, `PRINT_CUT_DIAMETER_MM` | Button face and paper-cut diameters. Face defaults to 58 mm; set the cut size explicitly and test at 100% scale against the actual equipment. |

Use an HTTPS reverse proxy in front of the loopback Node listener. Workers/Pages-only hosting won't run this app. Keep `/client-metadata.json`, `/jwks.json` and `/oauth/callback` publicly reachable.

With a Cloudflare tunnel, enable `TRUST_CLOUDFLARE_TUNNEL=true` only when a trusted loopback proxy sets `x-dcbsky-proxy-secret` to `CLOUDFLARE_ORIGIN_SECRET` and strips untrusted forwarding headers. Don't expose the Node port. Without that setup, rate limits use socket peers, so a proxy may group visitors together.

Before inviting people, check the final page and complete a real Bluesky login, save/reload, admin-access check and withdrawal/deletion test. Test a printout too. The repo doesn't install services, DNS records or timers.

### Run the event

- Use the private organizer view for responses, button artwork and future-meetup contacts. One RSVP represents one account, not a party or confirmed arrival.
- Keep new and existing RSVPs private until the attendee chooses an audience. The attendee list includes Coming and Maybe responses only, filtered on the server for the signed-in viewer. Never return hidden records to the browser. Follow checks use Bluesky's public graph; failures or request limits hide affected entries and show an incomplete-results notice. The current request budget checks up to 200 relationship-restricted attendees without caching access across requests.
- The sharing link opens Bluesky's editable composer for a saved Coming response. The attendee chooses whether to publish; changing an RSVP never posts automatically. A public post is separate from attendance visibility on this page.
- Print the saved, approved picture and design. Preserve the label, position, color and renderer version; don't substitute a newer avatar or redesign old requests without approval.
- Re-export just before printing to pick up changes and withdrawals. Omit declined responses and unapproved artwork. Protect downloaded files and physical sheets.
- Keep future-meetup consent separate from attendance and artwork. It defaults off and survives artwork expiry. A contact list doesn't authorize automatic outreach.
- Don't add bulk DM reminders. Permission to open a chat doesn't guarantee the service will allow a batch of messages.
- Agree on backups, failure monitoring and restart/update procedures with the owner. Don't install extra polling or scheduled jobs without approval.

### Backups and deletion

Build first, then run:

```sh
npm run backup
```

This copies the existing SQLite database and OAuth key into `BACKUP_DIR` (default `.backups/`). The app does **not** encrypt its storage or backups. Restrict access and arrange encrypted off-host storage as needed.

Schedule serialized daily backups and a run at the artwork deadline, even if the app is stopped. Monitor failures. The command keeps up to seven snapshots for seven days; at artwork expiry it removes older snapshots and scrubs artwork from new ones. The running app also expires artwork, but stopping it can delay cleanup until a request, restart or backup.

Remove artwork from downloads, print queues, physical sheets and other snapshots by the same deadline. Choose retention for attendance and contact preferences separately; artwork expiry doesn't delete them. Don't promise forensic erasure.

Test a restore into a separate private directory with the matching origin/policy and both database and key. Don't overwrite a running database or mix in old WAL/SHM files. After expiry, restore only backups already scrubbed of artwork. Check access, records and a real login before reopening signups.

### Checks and known risk

```sh
npm run validate
npm run build
npm run smoke
npm audit --omit=dev
```

Validation runs formatting/lint, TypeScript, tests with selected coverage gates, and dead-code checks. Smoke tests don't establish that live OAuth works. Treat attendance and contact choices as personal data, even though account DIDs are public.

The release-preparation audit reported 15 high-severity dependency-chain entries for Zod advisory `GHSA-mrhx-c7xc-m3w5` through the official OAuth SDK. Re-run the audit and check for supported fixes before deployment; that old result isn't a current audit. Network/time/complexity limits reduce exposure but don't patch the dependency. Don't force unsupported major-version overrides or treat passing tests as a clean security audit.
