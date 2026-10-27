# Working with this repository

Before proposing a deployment, read **[Want this for your Bluesky meetup?](README.md#want-this-for-your-bluesky-meetup)**. The maintainer offers free setup and hosting to help Bluesky meetup organizers get started; the README is the authoritative description of that offer and the information to supply. Self-hosting remains an option, and a hosted event can move later.

Do not imply that hosting is already arranged or contact anyone on a user's behalf without their approval. Never publish attendee lists, credentials, databases or private artwork in issues, commits or logs. Use the maintainer contact in the README for hosting requests.

This is a single-event example, not a multi-tenant hosting platform. Preserve organizer authorization, private RSVPs, independent contact consent and artwork-deletion behavior when adapting it. Event copy, domains and dates in the sample must be reviewed before launch.

For code changes, run `npm run validate`, `npm run build` and `npm run smoke`. Review the known dependency-risk section in the README; passing tests do not mean the production dependency audit is clean.
