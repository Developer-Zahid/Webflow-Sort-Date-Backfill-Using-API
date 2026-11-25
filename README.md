# Sort Date backfill

One-off script that fills a Webflow CMS "Sort Date" field for every item in a collection.
Only the Sort Date field is written. Everything else is left untouched and checked afterwards.

## Setup

1. Node 18+. No `npm install` needed.
2. Copy `.env.example` to `.env` and fill in the token and collection ID.

## Run

| Step | Command | Writes to Webflow? |
|---|---|---|
| 1. Check field slugs | `node backfill.mjs fields` | No |
| 2. Dry run | `node backfill.mjs plan` | No. Creates a CSV report and a backup in `backfill-output/` |
| 3. Write | `node backfill.mjs apply` | Yes. Staged + live, 100 items per request, then verifies |
| Undo | `node backfill.mjs rollback backfill-output/backup-....json` | Yes. Restores previous values |

Options: `--rule later` (default: later of Published / Updated), `--rule published`
(Published Date only, keeps today's order), `--staged-only` (skip live copies).

## What it does per item

- Staged copy: target computed from the **staged** dates.
- Live copy: target computed from the **live** dates, so unpublished date edits never leak live,
  and pending edits on other fields are not published.
- No Published Date: skipped and listed in the report.
- Updated earlier than Published: uses Published, flagged in the report.
- Drafts and archived items are filled too. Their status is not changed.

## Verify step (automatic after apply)

Re-reads everything and fails loudly if any item's Sort Date is wrong, its Draft/Archived status
changed, its live presence changed, or **any other field** changed (staged or live).
