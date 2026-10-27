#!/usr/bin/env node
/**
 * Saves what elcinema.com sends this machine, and what iptv-org/epg's elcinema parser makes of it,
 * so a guide built here can be compared with the site's own page. Run by the `diagnose` workflow
 * (manual only, deploys nothing); its output is the workflow's artifact.
 *
 *   node tools/diagnose-elcinema.mjs --epg <iptv-org/epg checkout> --out <dir>
 *
 * Why: a guide built on a GitHub runner had every elcinema.com time 6 hours early, while the same
 * code run in Egypt matched the site exactly. elcinema.com writes its times without an offset, so
 * what matters is which clock its page is written in for the machine asking.
 *
 * Writes, per channel: the page as received (`<id>.html`), the response headers, and the
 * programmes the site's parser reads from it - once with the grabber's clock set to Cairo (as the
 * build runs it) and once to UTC; plus `machine.json` (this machine's clock and zone).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Egyptian channels whose elcinema.com pages were checked by hand. */
const CHANNELS = [
  { site_id: "1278", xmltv_id: "MBCMasr2.eg@SD", name: "MBC Masr 2" },
  { site_id: "1239", xmltv_id: "MBCMasr.eg@SD", name: "MBC Masr" },
  { site_id: "1119", xmltv_id: "AlMasriyah.eg@SD", name: "Al Masriyah" },
];

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at < 0) return undefined;
  return args[at].includes("=") ? args[at].split("=").slice(1).join("=") : args[at + 1];
};

if (option("parse")) {
  // Child mode: parse saved pages with the site's parser under this process's TZ.
  const epg = resolve(option("epg"));
  const dir = resolve(option("parse"));
  const require = createRequire(join(epg, "package.json"));
  const config = require(join(epg, "sites/elcinema.com/elcinema.com.config.js"));
  const dayjs = require("dayjs");
  dayjs.extend(require("dayjs/plugin/utc"));
  const { readFileSync } = await import("node:fs");
  const result = {};
  for (const channel of CHANNELS) {
    const content = readFileSync(join(dir, `${channel.site_id}.html`), "utf8");
    result[channel.xmltv_id] = {};
    for (const offset of [0, 1, 2]) {
      const date = dayjs.utc().startOf("d").add(offset, "d");
      const programs = config.parser({ content, channel: { ...channel, lang: "ar" }, date });
      result[channel.xmltv_id][date.format("YYYY-MM-DD")] = programs.map((p) => ({
        start: p.start?.toISOString?.() ?? String(p.start),
        stop: p.stop?.toISOString?.() ?? String(p.stop),
        title: p.title,
      }));
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2));
  process.exit(0);
}

const epg = resolve(option("epg") ?? "epg");
const out = resolve(option("out") ?? "diagnose");
mkdirSync(out, { recursive: true });
const require = createRequire(join(epg, "package.json"));
const config = require(join(epg, "sites/elcinema.com/elcinema.com.config.js"));

writeFileSync(
  join(out, "machine.json"),
  JSON.stringify(
    {
      now: new Date().toISOString(),
      local: new Date().toString(),
      envTZ: process.env.TZ ?? null,
      intlZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMinutes: -new Date().getTimezoneOffset(),
      node: process.version,
    },
    null,
    2,
  ),
);

for (const channel of CHANNELS) {
  // The request the grabber makes: the site's own URL and headers.
  const url = config.url({ channel: { ...channel, lang: "ar" } });
  const response = await fetch(url, { headers: config.request?.headers ?? {} });
  const html = await response.text();
  writeFileSync(join(out, `${channel.site_id}.html`), html);
  writeFileSync(
    join(out, `${channel.site_id}.headers.json`),
    JSON.stringify({ url, status: response.status, headers: Object.fromEntries(response.headers) }, null, 2),
  );
  console.error(`${channel.name}: ${url} -> HTTP ${response.status}, ${html.length} characters`);
  await new Promise((done) => setTimeout(done, 1000));
}

// The parser's reading of those pages, under the clock the build uses and under UTC.
for (const zone of ["Africa/Cairo", "UTC"]) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--epg", epg, "--parse", out], {
    encoding: "utf8",
    env: { ...process.env, TZ: zone },
    maxBuffer: 64 * 1024 * 1024,
  });
  const name = zone === "UTC" ? "parsed-utc.json" : "parsed-cairo.json";
  writeFileSync(join(out, name), run.stdout || JSON.stringify({ error: run.stderr }));
  console.error(`parsed with TZ=${zone}: ${run.status === 0 ? "ok" : run.stderr.slice(0, 300)}`);
}
