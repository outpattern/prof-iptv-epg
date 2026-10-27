#!/usr/bin/env node
/**
 * Prepares Free TV's guide for GitHub Pages, and checks what devices are being served. Runs in the
 * guide repository's workflow (tools/free-tv-guide-repo/) after `build-free-tv-guide.mjs`; nothing
 * here runs on a viewer's device.
 *
 *   node tools/publish-free-tv-guide.mjs stage --site <build dir> --out <pages dir> [--live <url>]
 *   node tools/publish-free-tv-guide.mjs check --url <guide site>
 *
 * `stage` writes the whole site that the workflow then deploys to Pages:
 *
 *   guides/<version>/guide.xml.gz   a version, never changed once published
 *   guides/<version>/report.json    what that build covered
 *   current.json                    what the app reads: the current version, its file, sha256, bytes
 *   guide.xml.gz                    the current guide again, at an address that never changes
 *   status.json                     the last good run, for people and monitors
 *
 * Atomic for devices. A Pages deployment replaces the whole site in one step, so a device never
 * sees half of one. The site also carries the previous version(s), fetched from the live site and
 * checked against their hashes, because Pages and its CDN cache `current.json` for up to ten
 * minutes: a device holding the old pointer still finds the file it names. The app checks the
 * bytes and the hash the pointer states before it replaces anything. A run that fails anywhere
 * deploys nothing, so the last good site - and guide - stays published.
 *
 * Options: `--keep=2` previous versions carried, `--min-channels=40` channels with something on
 * now, `--max-age-hours=36` for `check`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export const POINTER = "current.json";
export const STATUS = "status.json";
export const STABLE = "guide.xml.gz";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** What a guide file holds; throws when it is not a complete guide. */
export function inspect(bytes) {
  const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
  if (!/^\s*(<\?xml[^>]*>\s*)?(<!DOCTYPE[^>]*>\s*)?<tv[\s>]/.test(text) || !/<\/tv>\s*$/.test(text)) {
    throw new Error("not a complete XMLTV document");
  }
  return { programmes: [...text.matchAll(/<programme\b/g)].length };
}

/** `20261028T031500Z-<12 hex>`: sorts by time, and names the content. */
export function versionOf(bytes, at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${sha256(bytes).slice(0, 12)}`;
}

const VERSION = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** One file of the live site, or null when it is not there (a first run) or unreachable. */
async function fetchLive(fetchImpl, base, path) {
  try {
    const response = await fetchImpl(`${base.replace(/\/+$/, "")}/${path}`, { headers: { "cache-control": "no-cache" } });
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/**
 * Writes the site into `out` (emptied first). Throws, writing nothing, when the guide is not
 * complete or too thin. Answers the pointer.
 */
export async function stage({ guide, report, out, live = null, keep = 2, minChannels = 40, now = new Date(), fetchImpl = fetch, log = () => {} }) {
  const { programmes } = inspect(guide);
  if ((report?.onNow ?? 0) < minChannels) {
    throw new Error(`only ${report?.onNow ?? 0} channels have something on now (at least ${minChannels} wanted)`);
  }
  const version = versionOf(guide, now);
  const entry = (v, bytes) => ({ version: v, guide: `guides/${v}/guide.xml.gz`, sha256: sha256(bytes), bytes: bytes.length });

  // The versions to carry: the live pointer's current one and its own previous ones, newest first,
  // each only if it is still there and still matches its hash.
  const carried = [];
  if (live) {
    const pointerBytes = await fetchLive(fetchImpl, live, POINTER);
    let livePointer = null;
    try {
      livePointer = pointerBytes && JSON.parse(pointerBytes.toString("utf8"));
    } catch {
      log("the live current.json is not JSON; nothing carried");
    }
    const candidates = livePointer ? [livePointer, ...(livePointer.previous ?? [])] : [];
    for (const old of candidates) {
      if (carried.length >= keep) break;
      if (!VERSION.test(old?.version ?? "") || old.version === version || carried.some((c) => c.version === old.version)) continue;
      const bytes = await fetchLive(fetchImpl, live, `guides/${old.version}/guide.xml.gz`);
      if (!bytes || sha256(bytes) !== old.sha256 || bytes.length !== old.bytes) {
        log(`previous version ${old.version} is not available intact; not carried`);
        continue;
      }
      carried.push({ ...entry(old.version, bytes), data: bytes });
    }
  }

  const pointer = {
    schema: 1,
    ...entry(version, guide),
    builtAt: report?.builtAt ?? now.toISOString(),
    publishedAt: now.toISOString(),
    programmes,
    channels: report?.channelsWithProgrammes ?? null,
    onNow: report?.onNow ?? null,
    // Credit where the schedules came from (elcinema.com, for one, allows republishing for
    // non-commercial use on condition the source is fully credited).
    sources: sourcesOf(report),
    previous: carried.map(({ data, ...rest }) => rest),
  };

  rmSync(out, { recursive: true, force: true });
  const put = (path, data) => {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), data);
  };
  put(pointer.guide, guide);
  put(`guides/${version}/report.json`, json(report ?? {}));
  for (const old of carried) put(old.guide, old.data);
  put(STABLE, guide);
  put(POINTER, json(pointer));
  put(STATUS, json({ ok: true, at: now.toISOString(), version, ...summary(report) }));
  // Served as files, not run through Jekyll; and a page for anyone who opens the address.
  put(".nojekyll", "");
  put("index.html", indexPage(pointer));

  // What was written is what the pointer says.
  for (const file of [pointer, ...pointer.previous]) {
    const written = readFileSync(join(out, file.guide));
    if (sha256(written) !== file.sha256 || written.length !== file.bytes) throw new Error(`${file.guide} was not written intact`);
  }
  return pointer;
}

/** The sites that supplied programmes to this guide, most channels first: `[{site, channels}]`. */
export function sourcesOf(report) {
  return Object.entries(report?.sites ?? {})
    .filter(([site, counts]) => site !== "?" && counts.got > 0)
    .sort((a, b) => b[1].got - a[1].got || a[0].localeCompare(b[0]))
    .map(([site, counts]) => ({ site, channels: counts.got }));
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function summary(report) {
  return {
    channels: report?.channelsWithProgrammes ?? null,
    asked: report?.asked ?? null,
    onNow: report?.onNow ?? null,
    silentSites: report?.silentSites ?? [],
    placeholders: report?.placeholders ?? null,
  };
}

function indexPage(pointer) {
  const sources = pointer.sources
    .map(({ site, channels }) => `<li><a href="https://${escapeHtml(site)}/">${escapeHtml(site)}</a> - ${channels} channels</li>`)
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>PROF IPTV Free TV guide</title>
<p>The programme guide of PROF IPTV's Free TV, a free, non-commercial application. Rebuilt daily
with <a href="https://github.com/iptv-org/epg">iptv-org/epg</a>.</p>
<ul><li><a href="${POINTER}">${POINTER}</a> - the current version (${pointer.version})</li>
<li><a href="${STABLE}">${STABLE}</a> - the current guide (XMLTV, gzip)</li>
<li><a href="${STATUS}">${STATUS}</a> - the last run</li></ul>
<h2>Sources</h2>
<p>Programme schedules in this guide come from these sites, which own them:</p>
<ul>
${sources || "<li>(none listed)</li>"}
</ul>
`;
}

/** What a device gets from the live site, read as a device reads it: problems, empty when all is well. */
export async function check(url, { maxAgeHours = 36, minChannels = 40, now = new Date(), fetchImpl = fetch } = {}) {
  const problems = [];
  const pointerBytes = await fetchLive(fetchImpl, url, POINTER);
  let pointer;
  try {
    pointer = JSON.parse(pointerBytes?.toString("utf8") ?? "");
  } catch {
    return ["no guide is published (current.json is missing or not JSON)"];
  }
  const age = (now - new Date(pointer.publishedAt ?? pointer.builtAt)) / 3_600_000;
  if (!(age <= maxAgeHours)) problems.push(`the guide is ${age.toFixed(1)} h old (at most ${maxAgeHours})`);
  if ((pointer.onNow ?? 0) < minChannels) problems.push(`${pointer.onNow} channels have something on now (at least ${minChannels})`);
  const guide = await fetchLive(fetchImpl, url, pointer.guide ?? "");
  if (!guide) problems.push(`${pointer.guide} cannot be downloaded`);
  else if (guide.length !== pointer.bytes || sha256(guide) !== pointer.sha256) problems.push(`${pointer.guide} does not match ${POINTER}`);
  else {
    try {
      inspect(guide);
    } catch (error) {
      problems.push(`${pointer.guide}: ${error.message}`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------------- command line */

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (at < 0) return fallback;
    return rest[at].includes("=") ? rest[at].split("=").slice(1).join("=") : rest[at + 1];
  };
  const minChannels = Number(option("min-channels", 40));

  if (command === "stage") {
    const site = resolve(option("site", "build"));
    const guidePath = join(site, "guide.xml.gz");
    if (!existsSync(guidePath)) throw new Error(`${guidePath} does not exist`);
    const reportPath = join(site, "report.json");
    const pointer = await stage({
      guide: readFileSync(guidePath),
      report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null,
      out: resolve(option("out", "site")),
      live: option("live", null) || null,
      keep: Number(option("keep", 2)),
      minChannels,
      log: (line) => console.error(line),
    });
    console.error(
      `staged ${pointer.version}: ${pointer.bytes} bytes, ${pointer.channels} channels, ${pointer.onNow} on now; ` +
        `${pointer.previous.length} previous version(s) carried`,
    );
  } else if (command === "check") {
    const url = option("url");
    if (!url) throw new Error("--url is required");
    const problems = await check(url, { maxAgeHours: Number(option("max-age-hours", 36)), minChannels });
    for (const problem of problems) console.error(`::error::${problem}`);
    if (problems.length) process.exit(1);
    console.error("the published guide is fresh, complete and covered");
  } else {
    throw new Error("usage: stage --site <dir> --out <dir> [--live <url>] | check --url <url>");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
