#!/usr/bin/env node
/**
 * Writes the channel list for a run of iptv-org/epg that covers Free TV's lists.
 *
 * Free TV matches a guide to its channels by iptv-org identifier first (`AlGhadTV.eg@SD`), and
 * the only guide that uses those identifiers is the one iptv-org's own grabber produces - every
 * other public XMLTV feed spells its channels its own way, and measured against the real lists
 * (docs/FREE-TV.md) they cover a handful of the channels at best. iptv-org publishes no guide
 * file itself; it publishes the grabber (public domain) and `guides.json`, which says which site
 * carries each channel's schedule. This turns that into the grabber's `channels.xml`:
 *
 *   node tools/free-tv-guide-channels.mjs > free-tv.channels.xml
 *   # then, in a checkout of https://github.com/iptv-org/epg (npm ci):
 *   npm run grab -- --channels=free-tv.channels.xml --output=guide.xml.gz --days=3
 *
 * and the address the result is published at goes in `PROF_FREE_TV_EPG`. Each channel is asked
 * of one site only - the first of `SITES` that has it, in Arabic where the site offers Arabic -
 * and is written with Free TV's own identity, so it matches at the first and strictest step.
 *
 * Options: `--lists=eg,ara,mideast` (the default; `int` adds the worldwide list), `--stats`
 * (a summary on stderr of what each list gets), `--skip-sites=a,b` (never ask these sites),
 * `--only-sites=a,b` (ask only these) and `--only=<file>` (only the identities in that file, one
 * per line). The site lists are the guide's source policy - which sites' terms allow their
 * schedules to be republished (docs/CHANGE-SHEET-CS04-FREE-TV-GUIDE-PAGES.md, step 0); with
 * `--only`, they are also the fallback pass of `tools/build-free-tv-guide.mjs`: channels whose site
 * answered nothing are asked again of the next site that carries them.
 */
const LISTS = {
  eg: "https://iptv-org.github.io/iptv/countries/eg.m3u",
  ara: "https://iptv-org.github.io/iptv/languages/ara.m3u",
  mideast: "https://iptv-org.github.io/iptv/regions/mideast.m3u",
  int: "https://iptv-org.github.io/iptv/index.m3u",
};
const GUIDES = "https://iptv-org.github.io/api/guides.json";

/** Sites in the order they are preferred: the Egyptian and Arabic schedules first, then the
 * broad aggregators, then anything else `guides.json` offers. */
const SITES = ["elcinema.com", "shahid.mbc.net", "osn.com", "rotana.net", "bein.com", "beinsports.com", "sat.tv"];
const LANGUAGES = ["ar", "en"];

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const lists = (option("lists") ?? "eg,ara,mideast").split(",").filter((id) => LISTS[id]);
const skipSites = new Set((option("skip-sites") ?? "").split(",").filter(Boolean));
const onlySites = new Set((option("only-sites") ?? "").split(",").filter(Boolean));
const only = option("only")
  ? new Set(
      (await import("node:fs"))
        .readFileSync(option("only"), "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    )
  : null;

async function text(url) {
  const response = await fetch(url, { headers: { "user-agent": "PROF IPTV guide-channels" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

/** The identities a list carries, as Free TV keys them: `Channel.cc@Feed`. */
function identities(m3u) {
  return [...m3u.matchAll(/tvg-id="([^"@]+\.[a-z]{2})(?:@([^"]+))?"/gi)].map((m) => ({
    key: m[2] ? `${m[1]}@${m[2]}` : m[1],
    channel: m[1],
    feed: m[2] ?? null,
  }));
}

const escape = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The best `guides.json` row for one identity, or none. */
function choose(rows) {
  const siteRank = (row) => {
    const at = SITES.indexOf(row.site);
    return at < 0 ? SITES.length : at;
  };
  const languageRank = (row) => {
    const at = LANGUAGES.indexOf(row.lang);
    return at < 0 ? LANGUAGES.length : at;
  };
  return [...rows].sort((a, b) => siteRank(a) - siteRank(b) || languageRank(a) - languageRank(b))[0];
}

const guides = JSON.parse(await text(GUIDES));
const byChannel = new Map();
for (const row of guides) {
  if (!row.channel || !row.site || !row.site_id || skipSites.has(row.site)) continue;
  if (onlySites.size && !onlySites.has(row.site)) continue;
  if (!byChannel.has(row.channel)) byChannel.set(row.channel, []);
  byChannel.get(row.channel).push(row);
}

const chosen = new Map();
const stats = [];
for (const list of lists) {
  const found = identities(await text(LISTS[list]));
  const unique = new Map(found.map((id) => [id.key, id]));
  let covered = 0;
  for (const id of unique.values()) {
    if (only && !only.has(id.key)) continue;
    // A row for this feed, or one that names no feed (the channel's schedule, whatever the feed).
    const rows = (byChannel.get(id.channel) ?? []).filter((row) => !row.feed || !id.feed || row.feed === id.feed);
    const row = choose(rows);
    if (!row) continue;
    covered++;
    if (!chosen.has(id.key)) chosen.set(id.key, row);
  }
  stats.push(`${list}: ${covered} of ${unique.size} channels have a site`);
}

const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<channels>"];
for (const [key, row] of [...chosen].sort(([a], [b]) => a.localeCompare(b))) {
  lines.push(
    `  <channel site="${escape(row.site)}" lang="${escape(row.lang ?? "en")}" xmltv_id="${escape(key)}" site_id="${escape(row.site_id)}">${escape(row.site_name ?? key)}</channel>`,
  );
}
lines.push("</channels>", "");
process.stdout.write(lines.join("\n"));
if (args.includes("--stats")) {
  const sites = new Map();
  for (const row of chosen.values()) sites.set(row.site, (sites.get(row.site) ?? 0) + 1);
  process.stderr.write(`${stats.join("\n")}\n${chosen.size} channels in all: ${[...sites].map(([s, n]) => `${s} ${n}`).join(", ")}\n`);
}
