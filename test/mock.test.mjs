// Runs the real CLI against a fake Webflow API (staged + live copies).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const CID = "projects";
const T = (d) => (d ? `${d}T09:00:00.000Z` : null);
const mk = (id, name, pub, upd, o = {}) => ({
  id, isDraft: false, isArchived: false, lastPublished: "2026-10-26T13:34:57.195Z", lastUpdated: "2026-10-26T13:34:00.000Z",
  cmsLocaleId: "en", fieldData: { name, slug: id, summary: `about ${name}`, "published-date": T(pub), "updated-date": T(upd), "sort-date": null }, ...o,
});

const staged = new Map(), live = new Map();
const add = (item, isLive = true, liveOverrides = {}) => {
  staged.set(item.id, structuredClone(item));
  if (isLive) live.set(item.id, { ...structuredClone(item), fieldData: { ...structuredClone(item.fieldData), ...liveOverrides } });
};
add(mk("A", "A clean", "2024-03-10", null));
add(mk("B", "B updated later", "2023-05-01", "2026-09-15"));
add(mk("C", "C pending edit", "2025-01-20", "2025-06-01", { lastUpdated: "2026-10-26T13:36:02.742Z" }), true, { summary: "OLD live summary" });
add(mk("D", "D unpublished date", "2024-08-05", "2026-10-20", { lastUpdated: "2026-10-26T13:36:02.742Z" }), true, { "updated-date": null });
add(mk("E", "E queued", "2025-11-11", null, { lastPublished: null }), false);
add(mk("F", "F draft", "2026-01-05", "2026-02-01", { lastPublished: null, isDraft: true }), false);
add(mk("G", "G published then draft", "2024-12-12", null, { isDraft: true }), true);
add(mk("H", "H archived", "2023-02-14", "2024-01-01", { isArchived: true }), false);
add(mk("I", "I data error", "2025-07-07", "2025-01-01"));
add(mk("J", "J no date", null, null));
for (let n = 0; n < 240; n++) add(mk(`X${n}`, `bulk ${n}`, `2022-01-${String((n % 28) + 1).padStart(2, "0")}`, n % 3 ? null : "2026-03-01"));

let patchCalls = { staged: 0, live: 0 }, maxBatch = 0;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const isLive = u.pathname.endsWith("/live");
  const store = isLive ? live : staged;
  if (req.method === "GET") {
    const all = [...store.values()];
    const off = +u.searchParams.get("offset"), lim = +u.searchParams.get("limit");
    return res.end(JSON.stringify({ items: all.slice(off, off + lim), pagination: { total: all.length } }));
  }
  if (req.method === "PATCH") {
    let body = ""; for await (const c of req) body += c;
    const { items } = JSON.parse(body);
    maxBatch = Math.max(maxBatch, items.length);
    patchCalls[isLive ? "live" : "staged"]++;
    for (const it of items) {
      const target = store.get(it.id);
      Object.assign(target.fieldData, it.fieldData); // isDraft/isArchived untouched, like Webflow when omitted
    }
    return res.end(JSON.stringify({ items }));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-"));
const run = (...a) => execFileSync("node", [path.resolve("backfill.mjs"), ...a], {
  cwd: dir, encoding: "utf8",
  env: { ...process.env, WEBFLOW_API_BASE: base, WEBFLOW_API_TOKEN: "t", COLLECTION_ID: CID, OUT_DIR: path.join(dir, "out") },
});
const runAsync = (...a) => new Promise((resolve) => {
  import("node:child_process").then(({ execFile }) => execFile("node", [path.resolve("backfill.mjs"), ...a], {
    cwd: dir, env: { ...process.env, WEBFLOW_API_BASE: base, WEBFLOW_API_TOKEN: "t", COLLECTION_ID: CID, OUT_DIR: path.join(dir, "out") },
  }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr })));
});

// PLAN writes nothing
const planOut = (await runAsync("plan")).out;
console.log(planOut);
assert.equal(patchCalls.staged + patchCalls.live, 0, "plan must not write");

// APPLY
const applyOut = (await runAsync("apply")).out;
console.log(applyOut);
assert.match(applyOut, /All checks passed/);
assert.ok(maxBatch <= 100, "batches must be <= 100");

const S = (id) => staged.get(id).fieldData["sort-date"], L = (id) => live.get(id)?.fieldData["sort-date"];
assert.equal(S("A"), T("2024-03-10"));
assert.equal(S("B"), T("2026-09-15"));
assert.equal(S("C"), T("2025-06-01")); assert.equal(live.get("C").fieldData.summary, "OLD live summary", "pending edit not published");
assert.equal(S("D"), T("2026-10-20")); assert.equal(L("D"), T("2024-08-05"), "live uses LIVE dates");
assert.equal(S("E"), T("2025-11-11")); assert.equal(L("E"), undefined);
assert.equal(S("F"), T("2026-02-01")); assert.equal(staged.get("F").isDraft, true);
assert.equal(S("G"), T("2024-12-12")); assert.equal(staged.get("G").isDraft, true); assert.equal(L("G"), T("2024-12-12"));
assert.equal(S("H"), T("2024-01-01")); assert.equal(staged.get("H").isArchived, true);
assert.equal(S("I"), T("2025-07-07"));
assert.equal(S("J"), null); assert.equal(L("J"), null);

// Second apply = nothing to do (idempotent)
const before = { ...patchCalls };
const again = (await runAsync("apply")).out;
assert.match(again, /Writing 0 staged and 0 live/);
assert.deepEqual(patchCalls, before);

// ROLLBACK restores the empty values
const backup = fs.readdirSync(path.join(dir, "out")).filter((f) => f.startsWith("backup-")).sort()[0];
console.log((await runAsync("rollback", path.join(dir, "out", backup))).out);
assert.equal(S("A"), null); assert.equal(L("A"), null); assert.equal(S("X5"), null);

// --rule published
await runAsync("apply", "--rule", "published");
assert.equal(S("B"), T("2023-05-01"));

server.close();
console.log("ALL MOCK TESTS PASSED");
