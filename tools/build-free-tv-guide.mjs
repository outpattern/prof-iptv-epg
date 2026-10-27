#!/usr/bin/env node
/**
 * Builds Free TV's guide: the XMLTV every device downloads instead of grabbing schedules itself.
 *
 *   node tools/build-free-tv-guide.mjs --epg <checkout of iptv-org/epg> --out <dir>
 *
 * It runs on a schedule somewhere that is not a viewer's device (docs/FREE-TV.md, "The guide":
 * the hosting choice and what it needs), once a day:
 *
 *   1. writes the channel list for Free TV's lists (tools/free-tv-guide-channels.mjs);
 *   2. runs iptv-org/epg's grabber over it - politely, one request at a time with a pause,
 *      because the sites answer 429 to anything faster - and then once more for the channels of
 *      sites that answered nothing at all, each asked of the next site that carries it;
 *   3. checks the result before anything is published: an XMLTV document with a minimum number
 *      of channels that have something on now (programmes with odd times are listed in the
 *      report, not fatal). A run that fails the check
 *      exits non-zero and publishes nothing, so a bad day never replaces the last good guide -
 *      devices keep what they hold (they refetch with `If-None-Match`, and the last good file
 *      is still what the host serves);
 *   4. writes `<out>/guide.xml.gz` and `<out>/report.json` (what was covered, per list and site).
 *
 * Options: `--days=3`, `--delay=1000` (ms between requests), `--min-channels=40` (channels that
 * must have a programme on now), `--lists=eg,ara,mideast`, `--channels=<file>` to skip step 1,
 * `--drop-descriptions` (no screen shows them; they are over half the download), and the source
 * policy `--skip-sites=a,b` / `--only-sites=a,b` (sites never asked / the only ones asked).
 * Needs Node 22 and, in the iptv-org/epg checkout, `npm ci` and `npm run api:load` done.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepare as prepareElcinema } from "./elcinema-cairo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at < 0) return fallback;
  return args[at].includes("=") ? args[at].split("=").slice(1).join("=") : args[at + 1];
};
const epg = option("epg") && resolve(option("epg"));
const out = resolve(option("out", "free-tv-guide"));
const days = Number(option("days", 3));
const delay = Number(option("delay", 1000));
const minChannels = Number(option("min-channels", 40));
const lists = option("lists", "eg,ara,mideast");
const dropDescriptions = args.includes("--drop-descriptions");
// The source policy: sites whose schedules may not be republished, or the only ones that may
// (docs/CHANGE-SHEET-CS04-FREE-TV-GUIDE-PAGES.md, step 0). Applied to both passes.
const skipSites = String(option("skip-sites", "")).split(",").filter(Boolean);
const onlySites = String(option("only-sites", "")).split(",").filter(Boolean);
const sitePolicy = [
  ...(skipSites.length ? [`--skip-sites=${skipSites.join(",")}`] : []),
  ...(onlySites.length ? [`--only-sites=${onlySites.join(",")}`] : []),
];
/** Titles a site writes where it has no schedule (shahid.mbc.net: "programme schedule not
 * available", hour after hour). Shown, they would read as a programme; dropped, the channel says
 * "No guide available" as the app does for any channel without a guide. */
const PLACEHOLDER_TITLES = new Set(["جدول البرامج غير متاح"]);
if (!epg || !existsSync(join(epg, "package.json"))) {
  console.error("--epg must be a checkout of https://github.com/iptv-org/epg with npm ci done");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const work = join(out, ".work");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/* 1. The channel list. */
let channelsFile = option("channels");
if (!channelsFile) {
  channelsFile = join(work, "free-tv.channels.xml");
  const made = spawnSync(process.execPath, [join(here, "free-tv-guide-channels.mjs"), `--lists=${lists}`, "--stats", ...sitePolicy], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (made.status !== 0) {
    console.error(made.stderr);
    process.exit(1);
  }
  writeFileSync(channelsFile, made.stdout);
  process.stderr.write(made.stderr);
}
const wanted = [...readFileSync(channelsFile, "utf8").matchAll(/xmltv_id="([^"]+)"/g)].map((m) => m[1]);

/* elcinema.com's clock: measured from its pages before the grab (tools/elcinema-cairo.mjs). A
 * measurement that does not check out stops the build here, before anything is grabbed. */
let elcinema = null;
try {
  elcinema = await prepareElcinema({ epg, channelsFile, work: join(work, "elcinema"), delay, log: (line) => console.error(line) });
} catch (error) {
  console.error(`elcinema.com times could not be measured: ${error.message}`);
  console.error("not published: the last good guide stays");
  process.exit(1);
}
if (elcinema) {
  const shown = Object.entries(elcinema.offsets).map(([day, minutes]) => `${day}: ${minutes / 60} h`).join(", ");
  console.error(`elcinema.com, ${elcinema.pages} pages: its clock is Cairo's ${shown}`);
}

/* 2. The grab, then one fallback pass. */
const raw = join(work, "guide.xml");
runGrab(channelsFile, raw, "grab.log");
if (!existsSync(raw)) {
  console.error(`the grabber wrote no guide; see ${join(work, "grab.log")}`);
  process.exit(1);
}
let placeholders = withoutPlaceholders(raw);
// A site that answered nothing for any channel is down, blocked or limiting this address (sat.tv
// answers 429, digiturk.com.tr 403 outside Turkey). Its channels are asked again of the next site
// `guides.json` gives them; a channel that came back empty from a site that answered for others is
// left alone (that site simply has nothing for it), so the second pass stays small.
const siteOf = sitesIn(channelsFile);
const first = check(readFileSync(raw), wanted, siteOf);
const deadSites = Object.entries(first.sites)
  .filter(([, site]) => site.got === 0)
  .map(([name]) => name);
const retry = first.empty.filter((id) => deadSites.includes(siteOf.get(id)));
if (retry.length && !option("channels")) {
  const onlyFile = join(work, "fallback.ids");
  writeFileSync(onlyFile, `${retry.join("\n")}\n`);
  const fallbackChannels = join(work, "fallback.channels.xml");
  const made = spawnSync(
    process.execPath,
    [
      join(here, "free-tv-guide-channels.mjs"),
      `--lists=${lists}`,
      `--skip-sites=${[...deadSites, ...skipSites].join(",")}`,
      ...(onlySites.length ? [`--only-sites=${onlySites.join(",")}`] : []),
      `--only=${onlyFile}`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (made.status === 0 && made.stdout.includes("<channel ")) {
    writeFileSync(fallbackChannels, made.stdout);
    const fallbackRaw = join(work, "fallback.xml");
    runGrab(fallbackChannels, fallbackRaw, "fallback.log");
    for (const [id, site] of sitesIn(fallbackChannels)) siteOf.set(id, site);
    if (existsSync(fallbackRaw)) {
      placeholders += withoutPlaceholders(fallbackRaw);
      writeFileSync(raw, merge(readFileSync(raw, "utf8"), readFileSync(fallbackRaw, "utf8")));
    }
    console.error(`fallback: ${retry.length} channels of ${deadSites.length} silent sites asked again elsewhere`);
  }
}

/* 3. The check. */
const report = {
  ...check(readFileSync(raw), wanted, siteOf),
  silentSites: deadSites,
  placeholders,
  dropDescriptions,
  sitePolicy: { skip: skipSites, only: onlySites },
  // elcinema.com's clock against Cairo's, per Cairo day, as measured for this build (minutes).
  elcinema: elcinema && { pages: elcinema.pages, offsets: elcinema.offsets, earliest: elcinema.earliest },
};
writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 2));
console.error(
  `${report.channelsWithProgrammes} of ${wanted.length} channels have programmes, ${report.onNow} on now, ` +
    `${report.programmes} programmes; ${report.problems.length} odd programmes (reported, not fatal)`,
);
// Only what makes the whole guide wrong stops it. An odd programme is reported, not fatal: the
// app drops one that ends before it starts and cuts one longer than a day (`prof_app::free_tv`).
if (!report.xmltv || report.onNow < minChannels) {
  console.error(report.xmltv ? `fewer than ${minChannels} channels have something on now` : "not an XMLTV document");
  console.error("not published: the last good guide stays");
  process.exit(1);
}

/* 4. Publish into <out>. */
writeFileSync(join(out, "guide.xml.gz"), gzipSync(readFileSync(raw), { level: 9 }));
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
rmSync(work, { recursive: true, force: true });
console.error(`wrote ${join(out, "guide.xml.gz")}`);

/** Runs iptv-org/epg's grabber over one channel list. `npm run grab` is this same command;
 * running node directly needs no shell, so paths with spaces reach the grabber whole on Windows.
 *
 * Always on Cairo's clock: elcinema.com writes its times in Cairo time without an offset, and its
 * parser reads them in the zone of the machine it runs on (`dayjs.tz.guess()`), so on a UTC
 * runner every Egyptian schedule would be two or three hours late. Measured with the site's own
 * test: the same programme parses to 02:25Z with TZ=UTC and 00:25Z with TZ=Africa/Cairo. The only
 * other parser of these sites that asks for the machine's zone, osn.com's, reads absolute times
 * and uses the zone for its day window alone. */
function runGrab(channels, output, logName) {
  const grab = spawnSync(
    process.execPath,
    [
      "-r",
      "@swc-node/register",
      "scripts/commands/epg/grab.ts",
      `--channels=${channels}`,
      `--output=${output}`,
      `--days=${days}`,
      "--maxConnections=1",
      `--delay=${delay}`,
    ],
    { cwd: epg, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: {
        ...process.env,
        TZ: "Africa/Cairo",
        ...(elcinema ? { PROF_ELCINEMA_OFFSETS: elcinema.file } : {}),
      },
    },
  );
  writeFileSync(join(work, logName), `${grab.stdout ?? ""}${grab.stderr ?? ""}`);
}

/** Removes placeholder programmes from a grabbed guide in place, and descriptions with
 * `--drop-descriptions`; answers how many programmes were removed. */
function withoutPlaceholders(file) {
  let removed = 0;
  const text = readFileSync(file, "utf8").replace(/[ \t]*<programme\b[\s\S]*?<\/programme>\r?\n?/g, (programme) => {
    const titles = [...programme.matchAll(/<title\b[^>]*>([^<]*)<\/title>/g)].map((m) => m[1].trim());
    if (!titles.length || !titles.every((title) => PLACEHOLDER_TITLES.has(title))) {
      // No screen of the app shows a programme's description (now/next and the guide show titles
      // and times), and descriptions are over half of a compressed guide: every device would
      // download them daily for nothing.
      return dropDescriptions ? programme.replace(/\s*<desc\b[^>]*>[\s\S]*?<\/desc>/g, "") : programme;
    }
    removed++;
    return "";
  });
  writeFileSync(file, text);
  return removed;
}

/** Which site each identity of a channel list is asked of. */
function sitesIn(file) {
  const sites = new Map();
  for (const match of readFileSync(file, "utf8").matchAll(/<channel\b([^>]*)>/g)) {
    const id = (match[1].match(/xmltv_id="([^"]+)"/) ?? [])[1];
    const site = (match[1].match(/site="([^"]+)"/) ?? [])[1];
    if (id && site) sites.set(id, site);
  }
  return sites;
}

/** The first guide with the fallback's channels and programmes added: its `<channel>` elements
 * among the first's (XMLTV wants every channel before any programme), its programmes at the end.
 * Only channels the first guide had no programmes for are taken, so nothing is doubled. */
function merge(firstXml, fallbackXml) {
  const had = new Set([...firstXml.matchAll(/<programme\b[^>]*\schannel="([^"]+)"/g)].map((m) => m[1]));
  const channels = [...fallbackXml.matchAll(/<channel\b[^>]*\sid="([^"]+)"[\s\S]*?<\/channel>/g)]
    .filter((m) => !had.has(m[1]) && !firstXml.includes(`id="${m[1]}"`))
    .map((m) => m[0]);
  const programmes = [...fallbackXml.matchAll(/<programme\b[^>]*\schannel="([^"]+)"[\s\S]*?<\/programme>/g)]
    .filter((m) => !had.has(m[1]))
    .map((m) => m[0]);
  const firstProgramme = firstXml.search(/<programme\b/);
  const close = firstXml.lastIndexOf("</tv>");
  const head = firstProgramme < 0 ? firstXml.slice(0, close) : firstXml.slice(0, firstProgramme);
  const body = firstProgramme < 0 ? "" : firstXml.slice(firstProgramme, close);
  return `${head}${channels.join("\n")}\n${body}${programmes.join("\n")}\n</tv>\n`;
}

/** What a guide holds, and what looks wrong in it: `report.json`. */
function check(bytes, wanted, siteOf = new Map()) {
  const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
  const problems = [];
  const xmltv = /^\s*(<\?xml[^>]*>\s*)?(<!DOCTYPE[^>]*>\s*)?<tv[\s>]/.test(text);
  const known = new Set(wanted);
  const time = (value) => {
    const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-]\d{4})?$/.exec(value.trim());
    if (!m) return NaN;
    const utc = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
    const zone = m[7] ? (m[7][0] === "-" ? -1 : 1) * (+m[7].slice(1, 3) * 3600 + +m[7].slice(3) * 60) : 0;
    return utc - zone;
  };
  const now = Date.now() / 1000;
  const perChannel = new Map();
  let programmes = 0;
  for (const match of text.matchAll(/<programme\b([^>]*)>/g)) {
    const attr = (name) => (match[1].match(new RegExp(`\\s${name}="([^"]*)"`)) ?? [])[1] ?? "";
    const channel = attr("channel");
    const start = time(attr("start"));
    const stop = time(attr("stop"));
    programmes++;
    if (!known.has(channel)) {
      problems.push(`a programme for a channel that was not asked for: ${channel}`);
      continue;
    }
    if (!(stop > start) || stop - start > 24 * 3600) {
      problems.push(`${channel}: a programme from ${attr("start")} to ${attr("stop")}`);
      continue;
    }
    const held = perChannel.get(channel) ?? { programmes: 0, onNow: false, until: 0 };
    held.programmes++;
    held.onNow ||= start <= now && now < stop;
    held.until = Math.max(held.until, stop);
    perChannel.set(channel, held);
  }
  const onNow = [...perChannel.values()].filter((c) => c.onNow).length;
  const sites = {};
  for (const id of wanted) {
    const site = (sites[siteOf.get(id) ?? "?"] ??= { asked: 0, got: 0 });
    site.asked++;
    if (perChannel.has(id)) site.got++;
  }
  return {
    builtAt: new Date().toISOString(),
    xmltv,
    asked: wanted.length,
    channelsWithProgrammes: perChannel.size,
    onNow,
    programmes,
    // Channels that were asked for and came back empty: the page says "No guide available".
    empty: wanted.filter((id) => !perChannel.has(id)),
    // Per site, the channels asked of it (after the fallback, of the site that answered last).
    sites,
    channels: Object.fromEntries([...perChannel].map(([id, c]) => [id, { ...c, until: new Date(c.until * 1000).toISOString() }])),
    problems: [...new Set(problems)],
  };
}
