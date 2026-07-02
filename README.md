# AI Relationship Community Flag Vote

A static, data-driven site for choosing a shared community flag through open
submission and voting. **Connection is where the meaning lives.**

## What's in the box

```
index.html            The whole site (home/voting, results, thank-you, admin views)
css/styles.css        Warm off-white / navy / teal theme with circuit details
js/app.js             All behaviour: rendering, modals, compare, voting, admin, CSV
data/entries.json     The published flag entries (this is the file you maintain)
images/               Flag images referenced by filename (or use full URLs)
functions/api/vote.js Optional serverless vote endpoint (Cloudflare Pages)
```

No build step, no framework, no dependencies. Any static host works.

## Quick start

1. Serve the folder locally (needed so `data/entries.json` can load):
   ```
   npx serve .
   # or: python3 -m http.server
   ```
2. Open the site. Sample entries load from `data/entries.json`.
3. Visit `#/admin` (link in the footer) to import your real CSV, preview,
   approve entries, and export the updated `entries.json`.
4. Replace `data/entries.json` with the exported file and drop flag images
   into `/images` (or use full external image URLs).

Out of the box the site runs in **demo mode**: votes are stored in each
visitor's browser (localStorage). That is perfect for previewing the whole
flow, but votes are not shared between visitors until you add a backend.

## Maintaining entries (no code required)

Moderators keep a spreadsheet with these columns and export it as CSV:

```
entry_id, design_title, reddit_username, reddit_profile_url,
image_filename_or_url, flag_details, submitted_post_url, approved
```

- `entry_id` is the primary identifier everywhere (cards, dropdowns, results,
  exports). Zero-padded strings like `01` sort correctly.
- Only rows where `approved` is `TRUE` appear on the public site.
- `design_title` and `flag_details` may be blank. Blank details display as
  "No explanation provided."
- Images may be local (`images/entry-01.png`) or full URLs.

Import the CSV on the admin page, tidy anything up inline, then use
**Export entries (JSON)** and commit the file as `data/entries.json`.

> The admin page edits a *local draft* in your own browser. Nothing is
> published until you export and commit the JSON. On a public deployment you
> may want to remove the footer link or protect `#/admin` — it can't damage
> anything (it only edits the visitor's own local copy), but it's tidier.

## Recommended backend

**Simplest path that actually shares votes: Cloudflare Pages + KV.**

1. Push this folder to a Git repo and connect it to Cloudflare Pages.
2. In the Pages project, create a KV namespace and bind it as `VOTES`.
3. Add environment variables: `SALT` (a long random string) and `ADMIN_KEY`
   (for the CSV export endpoint).
4. In `js/app.js`, set `VOTE_API_URL: "/api/vote"`.

The included function (`functions/api/vote.js`) then handles:

- Recording votes
- **Hashed-IP duplicate limiting** — a salted SHA-256 hash of the caller's
  IP is stored, never the raw IP; repeat hashes get a friendly 409
- Public tallies for the results page
- A key-protected CSV export for moderator review

Netlify users can port the function to Netlify Functions + Blobs with minor
changes. GitHub Pages alone cannot run server code; pair it with the free
tier of Cloudflare Workers if you want to stay on Pages.

**Upgrade path if the project grows:** swap KV for Supabase (Postgres) or
Cloudflare D1. Only `VoteStore` in `js/app.js` and the function need to
change; the UI never touches storage directly.

## Fairness notes

- IP limiting is a **deterrent, not a perfect anti-abuse system**. Shared
  households and VPNs share IPs, and determined users can rotate them.
- The client also sets a cookie + localStorage flag to prevent accidental
  repeat submissions, with a friendly message if a vote already exists.
- Duplicate submissions may be filtered or removed during moderator review
  using the vote export.

## Accessibility checklist (already handled)

- Semantic landmarks, skip link, and keyboard-visible focus rings
- Modals with focus trapping, Escape to close, and focus restoration
- Alt text generated for every flag image
- `prefers-reduced-motion` respected
- Strong text contrast on the warm off-white palette
- Live regions for search results, vote status, and results updates
