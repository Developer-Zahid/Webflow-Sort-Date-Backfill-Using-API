#!/usr/bin/env node
/**
 * One-off Sort Date backfill for a Webflow CMS collection.
 *
 *   node backfill.mjs fields                 List the collection's fields (find the slugs)
 *   node backfill.mjs plan                   Dry run: CSV report + backup, writes nothing
 *   node backfill.mjs apply                  Write Sort Date (staged + live), then verify
 *   node backfill.mjs rollback <backup.json> Restore Sort Date values from a backup
 *
 * Options
 *   --rule later       Sort Date = later of Published / Updated (default)
 *   --rule published   Sort Date = Published Date (keeps today's order)
 *   --staged-only      Skip live copies (use when a full site publish will follow)
 *
 * .env options for date-only fields (no time picker):
 *   SITE_TIMEZONE=America/Los_Angeles   the site's timezone (Site settings > General)
 *   DATE_ONLY_FIELDS=publish-date       fields without a time picker
 *
 * How each item is written (learned from testing on a real site):
 *   A live write (PATCH /items/live) ALSO writes the same field into the staged
 *   copy and moves lastPublished forward.
 *   - clean (published, staged == live, not draft/archived): live write only.
 *     Sets both copies in one go; the item keeps showing "Published".
 *   - live but not clean (pending edits, draft/archived still live):
 *     live write, then staged write, so staged keeps its own value and the
 *     CMS status keeps showing the pending changes truthfully.
 *   - not live: staged write only.
 *
 * Settings come from .env (see .env.example) or environment variables.
 * Needs Node 18+. No dependencies.
 */
import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

loadDotEnv();
const API = process.env.WEBFLOW_API_BASE || "https://api.webflow.com/v2";
const TOKEN = need("WEBFLOW_API_TOKEN");
const CID = need("COLLECTION_ID");
const F_PUB = process.env.PUBLISHED_FIELD || "published-date";
const F_UPD = process.env.UPDATED_FIELD || "updated-date";
const F_SORT = process.env.SORT_FIELD || "sort-date";
// Date-only fields (no time picker) are stored by Webflow as midnight UTC and shown
// without timezone conversion. Sort Date has a time picker, so it is shown in the
// site timezone. Set SITE_TIMEZONE + DATE_ONLY_FIELDS so a date-only value becomes
// midnight in the site timezone, which is what an editor would enter by hand.
const SITE_TZ = process.env.SITE_TIMEZONE || "";
const DATE_ONLY = new Set((process.env.DATE_ONLY_FIELDS || "").split(",").map((x) => x.trim()).filter(Boolean));
const BATCH = 100;

const args = process.argv.slice(2);
const command = args[0];
const RULE = argValue("--rule") || "later";
const STAGED_ONLY = args.includes("--staged-only");
const OUT_DIR = process.env.OUT_DIR || "backfill-output";

if (!["later", "published"].includes(RULE)) fail(`--rule must be "later" or "published"`);

/* ------------------------------------------------------------------ */
/* Pure logic (exported for tests)                                     */
/* ------------------------------------------------------------------ */

const toMs = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

/** Offset (ms) of a timezone at a given instant, e.g. -7h for Los Angeles in summer. */
function tzOffsetMs(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms)).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - ms;
}

/** The calendar date of a stored date-only value, as midnight in the site timezone. */
export function localMidnight(ms, tz) {
  const d = new Date(ms);
  const guess = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let out = guess - tzOffsetMs(guess, tz);
  out = guess - tzOffsetMs(out, tz); // second pass handles DST changes
  return out;
}

function readDate(fieldData, slug) {
  const ms = toMs(fieldData?.[slug]);
  if (ms === null) return null;
  return SITE_TZ && DATE_ONLY.has(slug) ? localMidnight(ms, SITE_TZ) : ms;
}

/** Returns { target, note } for one copy of an item. target = null means "skip". */
export function computeTarget(fieldData, rule = RULE) {
  const pub = readDate(fieldData, F_PUB);
  const upd = readDate(fieldData, F_UPD);
  if (pub === null) return { target: null, note: "NO PUBLISHED DATE - skipped" };
  if (rule === "published") return { target: iso(pub), note: "" };
  if (upd === null) return { target: iso(pub), note: "" };
  if (upd < pub) return { target: iso(pub), note: "Updated earlier than Published - used Published" };
  return { target: iso(upd), note: "" };
}

export const sameInstant = (a, b) => toMs(a) === toMs(b);

/** Stable fingerprint of every field except Sort Date, to prove nothing else changed. */
export function fingerprint(item) {
  const { [F_SORT]: _ignored, ...rest } = item.fieldData || {};
  return JSON.stringify(sortKeys(rest));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

export function statusOf(staged, liveById) {
  const l = liveById.get(staged.id);
  if (staged.isArchived) return l ? "Archived (still live)" : "Archived";
  if (staged.isDraft) return l ? "Draft (still live)" : "Draft";
  if (!l) return "Queued, not published";
  // Compare real content (timestamps can be misleading after live writes)
  const pending = fingerprint(staged) !== fingerprint(l) || !sameInstant(staged.fieldData?.[F_SORT], l.fieldData?.[F_SORT]);
  return pending ? "Published, changes pending" : "Published";
}

/** Builds the full plan from staged + live item lists. */
export function buildPlan(stagedItems, liveItems, rule = RULE) {
  const liveById = new Map(liveItems.map((i) => [i.id, i]));
  return stagedItems.map((s) => {
    const l = liveById.get(s.id);
    const st = computeTarget(s.fieldData, rule);
    const lt = l ? computeTarget(l.fieldData, rule) : { target: null, note: "" };
    const clean = !!l && !s.isDraft && !s.isArchived && fingerprint(s) === fingerprint(l) && sameInstant(st.target, lt.target);
    const stagedNeeds = st.target !== null && !sameInstant(s.fieldData?.[F_SORT], st.target);
    const liveNeeds = !!l && lt.target !== null && !sameInstant(l.fieldData?.[F_SORT], lt.target);
    const mode = !l ? "staged only" : clean ? "live only (clean)" : "live then staged";
    return {
      id: s.id,
      name: s.fieldData?.name ?? "",
      status: statusOf(s, liveById),
      isDraft: !!s.isDraft,
      isArchived: !!s.isArchived,
      published: s.fieldData?.[F_PUB] ?? "",
      updated: s.fieldData?.[F_UPD] ?? "",
      stagedCurrent: s.fieldData?.[F_SORT] ?? null,
      stagedTarget: st.target,
      clean,
      mode,
      stagedWrite: stagedNeeds && !(clean && !STAGED_ONLY),
      stagedViaLive: stagedNeeds && clean && !STAGED_ONLY,
      isLive: !!l,
      liveCurrent: l ? l.fieldData?.[F_SORT] ?? null : null,
      liveTarget: lt.target,
      liveWrite: liveNeeds || (clean && stagedNeeds && !STAGED_ONLY),
      liveDiffers: !!l && !sameInstant(st.target, lt.target),
      note: [st.note, l && lt.note && lt.note !== st.note ? `live: ${lt.note}` : ""].filter(Boolean).join("; "),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Webflow API                                                         */
/* ------------------------------------------------------------------ */

async function api(method, p, body, attempt = 0) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 && attempt < 5) {
    const wait = Math.min(Number(res.headers.get("retry-after")) || 10, 60);
    console.log(`  rate limited, waiting ${wait}s...`);
    await sleep(wait * 1000);
    return api(method, p, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function listAll(p) {
  const all = [];
  for (let offset = 0; ; ) {
    const data = await api("GET", `${p}?limit=${BATCH}&offset=${offset}`);
    const items = data?.items ?? [];
    all.push(...items);
    offset += items.length;
    if (!items.length || offset >= (data?.pagination?.total ?? 0)) return all;
  }
}

async function readBoth() {
  const staged = await listAll(`/collections/${CID}/items`);
  let live = [];
  try {
    live = await listAll(`/collections/${CID}/items/live`);
  } catch (e) {
    if (!String(e.message).includes("-> 404")) throw e; // 404 = nothing live yet
  }
  return { staged, live };
}

/**
 * Writes in batches of 100. If a whole batch is rejected (e.g. one item returns
 * 409 "Item not published"), retries that batch one item at a time so one bad
 * item can't block the rest. Returns the items that could not be written.
 */
async function writeBatches(p, updates, label) {
  const failed = [];
  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH);
    try {
      await api("PATCH", p, { items: chunk });
      console.log(`  ${label}: wrote ${chunk.length} (${i + chunk.length}/${updates.length})`);
    } catch (batchErr) {
      console.log(`  ${label}: batch rejected (${batchErr.message.slice(0, 120)}), retrying one by one...`);
      let ok = 0;
      for (const one of chunk) {
        try {
          await api("PATCH", p, { items: [one] });
          ok++;
        } catch (e) {
          const code = (e.message.match(/-> (\d{3})/) || [])[1] || "?";
          failed.push({ id: one.id, code, message: e.message.slice(0, 200) });
        }
      }
      console.log(`  ${label}: wrote ${ok}/${chunk.length} individually, ${chunk.length - ok} rejected`);
    }
  }
  return failed;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdFields() {
  const c = await api("GET", `/collections/${CID}`);
  console.log(`Collection: ${c.displayName} (${c.id})\n`);
  for (const f of c.fields) {
    console.log(`  ${f.slug.padEnd(28)} ${f.type.padEnd(14)} ${f.displayName}${f.isRequired ? "  (required)" : ""}`);
  }
  const want = [F_PUB, F_UPD, F_SORT];
  const missing = want.filter((s) => !c.fields.some((f) => f.slug === s));
  console.log(missing.length ? `\nMISSING in collection: ${missing.join(", ")} - fix .env` : `\nAll three date fields found: ${want.join(", ")}`);
}

async function cmdPlan({ quiet = false } = {}) {
  const { staged, live } = await readBoth();
  const plan = buildPlan(staged, live);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Backup of current values, for rollback
  const backup = {
    collectionId: CID, sortField: F_SORT, takenAt: new Date().toISOString(),
    staged: staged.map((i) => ({ id: i.id, value: i.fieldData?.[F_SORT] ?? null })),
    live: live.map((i) => ({ id: i.id, value: i.fieldData?.[F_SORT] ?? null })),
  };
  const backupPath = path.join(OUT_DIR, `backup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

  // CSV report
  const cols = ["name", "status", "mode", "published", "updated", "stagedCurrent", "stagedTarget", "stagedWrite",
    "stagedViaLive", "isLive", "liveCurrent", "liveTarget", "liveWrite", "liveDiffers", "note", "id"];
  const csv = [cols.join(","), ...plan.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
  const reportPath = path.join(OUT_DIR, `plan-${RULE}-${stamp}.csv`);
  fs.writeFileSync(reportPath, csv);

  if (!quiet) {
    const count = (fn) => plan.filter(fn).length;
    const locales = new Set(staged.map((i) => i.cmsLocaleId));
    console.log(`Rule: ${RULE === "later" ? "later of Published / Updated" : "Published Date only"}`);
    console.log(`Date-only fields: ${SITE_TZ && DATE_ONLY.size ? `${[...DATE_ONLY].join(", ")} -> midnight in ${SITE_TZ}` : "none (values copied as stored)"}`);
    console.log(`Items: ${staged.length} staged, ${live.length} live${locales.size > 1 ? `  (WARNING: ${locales.size} locales found)` : ""}`);
    console.log(`Live writes:   ${STAGED_ONLY ? "skipped (--staged-only)" : count((r) => r.liveWrite)}  (${count((r) => r.stagedViaLive)} clean items: live write also fills staged)`);
    console.log(`Staged writes: ${count((r) => r.stagedWrite)}`);
    console.log(`\nBy write mode:`);
    for (const [m, n] of Object.entries(groupCount(plan, "mode"))) console.log(`  ${m.padEnd(28)} ${n}`);
    console.log(`Skipped, no Published Date: ${count((r) => r.stagedTarget === null)}`);
    console.log(`Updated earlier than Published: ${count((r) => r.note.includes("earlier"))}`);
    console.log(`Live dates differ from staged (unpublished date edits): ${count((r) => r.liveDiffers)}`);
    console.log(`\nBy status:`);
    for (const [s, n] of Object.entries(groupCount(plan, "status"))) console.log(`  ${s.padEnd(28)} ${n}`);
    console.log(`\nReport: ${reportPath}\nBackup: ${backupPath}`);
  }
  return { plan, staged, live, backupPath };
}

async function cmdApply() {
  console.log("Reading current state...");
  const { plan, staged, live, backupPath } = await cmdPlan({ quiet: true });
  const stagedUpdates = plan.filter((r) => r.stagedWrite).map((r) => ({ id: r.id, fieldData: { [F_SORT]: r.stagedTarget } }));
  const liveUpdates = STAGED_ONLY ? [] : plan.filter((r) => r.liveWrite).map((r) => ({ id: r.id, fieldData: { [F_SORT]: r.liveTarget } }));
  // A clean item whose live write fails still needs its staged value
  const cleanIds = new Set(plan.filter((r) => r.stagedViaLive).map((r) => r.id));
  console.log(`Backup saved: ${backupPath}`);
  console.log(`Writing ${stagedUpdates.length} staged and ${liveUpdates.length} live values...`);

  // Live first. For clean items the live write also fills the staged copy.
  // Then staged writes for items that are not clean (pending edits, draft/archived
  // still live, not live), so their staged copy keeps its own value.
  const liveFailed = liveUpdates.length ? await writeBatches(`/collections/${CID}/items/live`, liveUpdates, "live") : [];
  for (const f of liveFailed) {
    const r = plan.find((x) => x.id === f.id);
    if (cleanIds.has(f.id) && r) stagedUpdates.push({ id: r.id, fieldData: { [F_SORT]: r.stagedTarget } });
  }
  const stagedFailed = stagedUpdates.length ? await writeBatches(`/collections/${CID}/items`, stagedUpdates, "staged") : [];

  const nameOf = new Map(plan.map((r) => [r.id, r.name]));
  for (const [label, list] of [["live", liveFailed], ["staged", stagedFailed]]) {
    if (!list.length) continue;
    console.log(`\n${list.length} ${label} write(s) rejected by Webflow:`);
    for (const f of list) console.log(`  - ${nameOf.get(f.id)} (${f.id}): HTTP ${f.code}`);
  }

  console.log("\nVerifying...");
  await sleep(1500);
  const after = await readBoth();
  const skip = { live: new Set(liveFailed.map((f) => f.id)), staged: new Set(stagedFailed.map((f) => f.id)) };
  const problems = verify(plan, staged, live, after, skip);
  if (problems.length) {
    console.log(`\n${problems.length} PROBLEM(S):`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log(`\nTo undo: node backfill.mjs rollback ${backupPath}`);
    process.exitCode = 1;
  } else {
    console.log("All checks passed: Sort Date correct, statuses unchanged, no other field changed.");
  }
}

export function verify(plan, beforeStaged, beforeLive, after, skip = { live: new Set(), staged: new Set() }) {
  const problems = [];
  const idx = (arr) => new Map(arr.map((i) => [i.id, i]));
  const bS = idx(beforeStaged), bL = idx(beforeLive), aS = idx(after.staged), aL = idx(after.live);
  for (const r of plan) {
    const s0 = bS.get(r.id), s1 = aS.get(r.id);
    if (!s1) { problems.push(`${r.name}: staged item missing after write`); continue; }
    if (r.stagedTarget !== null && !skip.staged.has(r.id) && !sameInstant(s1.fieldData?.[F_SORT], r.stagedTarget))
      problems.push(`${r.name}: staged Sort Date is ${s1.fieldData?.[F_SORT]}, expected ${r.stagedTarget}`);
    if (!!s1.isDraft !== !!s0.isDraft) problems.push(`${r.name}: Draft changed ${s0.isDraft} -> ${s1.isDraft}`);
    if (!!s1.isArchived !== !!s0.isArchived) problems.push(`${r.name}: Archived changed ${s0.isArchived} -> ${s1.isArchived}`);
    if (fingerprint(s0) !== fingerprint(s1)) problems.push(`${r.name}: another STAGED field changed`);

    const l0 = bL.get(r.id), l1 = aL.get(r.id);
    if (!!l0 !== !!l1) problems.push(`${r.name}: live presence changed (${!!l0} -> ${!!l1})`);
    if (l0 && l1) {
      if (!STAGED_ONLY && r.liveTarget !== null && !skip.live.has(r.id) && !sameInstant(l1.fieldData?.[F_SORT], r.liveTarget))
        problems.push(`${r.name}: live Sort Date is ${l1.fieldData?.[F_SORT]}, expected ${r.liveTarget}`);
      if (fingerprint(l0) !== fingerprint(l1)) problems.push(`${r.name}: another LIVE field changed (pending edits published?)`);
    }
    if (r.clean && !skip.live.has(r.id) && s1.lastPublished && toMs(s1.lastUpdated) > toMs(s1.lastPublished))
      problems.push(`${r.name}: was clean but now shows "changes pending" in the CMS`);
  }
  return problems;
}

async function cmdRollback(file) {
  if (!file) fail("Usage: node backfill.mjs rollback <backup.json>");
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  if (b.collectionId !== CID) fail(`Backup is for collection ${b.collectionId}, not ${CID}`);
  const { staged, live } = await readBoth();
  const changed = (list, current) => {
    const cur = new Map(current.map((i) => [i.id, i.fieldData?.[F_SORT] ?? null]));
    return list.filter((x) => cur.has(x.id) && !sameInstant(cur.get(x.id), x.value))
      .map((x) => ({ id: x.id, fieldData: { [b.sortField]: x.value } }));
  };
  const s = changed(b.staged, staged), l = STAGED_ONLY ? [] : changed(b.live, live);
  console.log(`Restoring ${s.length} staged and ${l.length} live values from ${file}`);
  const lf = l.length ? await writeBatches(`/collections/${CID}/items/live`, l, "live") : [];
  const sf = s.length ? await writeBatches(`/collections/${CID}/items`, s, "staged") : [];
  console.log(lf.length || sf.length ? `Rollback done with ${lf.length + sf.length} rejected write(s).` : "Rollback done.");
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function loadDotEnv() {
  const f = path.resolve(".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
function need(k) {
  const v = process.env[k];
  if (!v && process.env.BACKFILL_TEST !== "1") fail(`Missing ${k} (set it in .env)`);
  return v;
}
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function groupCount(rows, key) {
  return rows.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] || 0) + 1), acc), {});
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fail(msg) { console.error(msg); process.exit(1); }

/* ------------------------------------------------------------------ */

if (process.env.BACKFILL_TEST !== "1") {
  const run = { fields: cmdFields, plan: () => cmdPlan(), apply: cmdApply, rollback: () => cmdRollback(args[1]) }[command];
  if (!run) fail("Usage: node backfill.mjs <fields|plan|apply|rollback> [--rule later|published] [--staged-only]");
  run().catch((e) => fail(e.message));
}
