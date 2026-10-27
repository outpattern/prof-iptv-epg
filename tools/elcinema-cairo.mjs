#!/usr/bin/env node
/**
 * elcinema.com's times, in Cairo's clock wherever the guide is built.
 *
 * elcinema.com localises its TV guide to the visitor: a GitHub runner is shown the same schedule as
 * a viewer in Egypt, in the same Cairo-day sections, but with every clock time moved to the zone the
 * site places the runner in (measured 2026-10-28: 04:30 PM instead of 10:30 PM). The site says
 * nowhere which zone it used and ignores every way of asking for another (docs/FREE-TV.md,
 * "Time zones"); and its offset did not follow Egypt's clock change, so neither a fixed correction
 * nor the runner's own zone would be right.
 *
 * So the offset is measured, per Cairo day, from the pages themselves. In Cairo time each day's
 * programmes run forward from about midnight without wrapping; moved by the visitor's offset, they
 * wrap. For each day the offset is the one (in 30-minute steps, -14 h to +14 h) that lets that day
 * run forward on every page at once, and, if several do, the one that puts the earliest full day's
 * start closest after midnight. The pages are then rewritten to Cairo time and handed, unchanged
 * otherwise, to iptv-org/epg's own elcinema.com parser - which reads them, as always, on Cairo's
 * clock (Africa/Cairo, daylight saving included).
 *
 * In the build (tools/build-free-tv-guide.mjs): `prepare` fetches each elcinema.com page once,
 * measures, checks and installs the parser wrapper; anything that does not check out stops the
 * build, so nothing is published rather than something wrong. On a machine in Egypt every offset
 * measures 0 and the pages are unchanged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const DAY = /(السبت|الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة)\s+(\d{1,2})\s+[^\s<]+/g;
export const TIME = /(\d{1,2}):(\d{2})\s*(صباحًا|مساءً)/g;
/** Every distinct half-hour shift of a 24-hour clock, in minutes (-12 h to +11.5 h): +14 h shows a
 * page exactly as -10 h does, so only one of each is tried. */
const CANDIDATES = Array.from({ length: 48 }, (_, i) => (i - 24) * 30);
/** How far apart two shifts are around the clock, in minutes. */
const apart = (a, b) => {
  const d = (((a - b) % 1440) + 1440) % 1440;
  return Math.min(d, 1440 - d);
};

export function toMinutes(h, m, half) {
  return ((Number(h) % 12) + (half === "مساءً" ? 12 : 0)) * 60 + Number(m);
}

export function formatTime(t) {
  const hh = Math.floor(t / 60);
  const mm = t % 60;
  return `${String(hh % 12 === 0 ? 12 : hh % 12).padStart(2, "0")}:${String(mm).padStart(2, "0")} ${hh < 12 ? "صباحًا" : "مساءً"}`;
}

const moveBack = (t, offset) => (((t - offset) % 1440) + 1440) % 1440;

/** A page's Cairo-day sections, in order: `{ day, first, times }` (the day of the month; whether it
 * is the page's first, partial section; its clock times in minutes). */
export function sections(html) {
  const days = [...html.matchAll(DAY)].map((m) => ({ day: Number(m[2]), at: m.index }));
  return days.map((d, i) => {
    const end = i + 1 < days.length ? days[i + 1].at : html.length;
    const times = [...html.slice(d.at, end).matchAll(TIME)].map((m) => toMinutes(m[1], m[2], m[3]));
    return { day: d.day, first: i === 0, times };
  });
}

const runsForward = (times, offset) => {
  const moved = times.map((t) => moveBack(t, offset));
  return moved.every((t, i) => i === 0 || t >= moved[i - 1]);
};

/**
 * The offset of each Cairo day, measured across pages: `{ offsets: { day: minutes }, fits, earliest }`.
 * Throws, with the reason, when the pages do not agree on one - the build then publishes nothing.
 */
export function calibrate(pages, { minPages = 3 } = {}) {
  const usable = pages.filter((html) => sections(html).some((s) => s.times.length >= 2));
  if (usable.length < minPages) throw new Error(`only ${usable.length} elcinema.com pages with a schedule (at least ${minPages} needed)`);
  const byDay = new Map();
  for (const html of usable) {
    for (const s of sections(html)) {
      if (s.times.length < 2) continue;
      if (!byDay.has(s.day)) byDay.set(s.day, []);
      byDay.get(s.day).push(s);
    }
  }
  const fits = {};
  const startOf = {};
  for (const [day, list] of byDay) {
    const fitting = CANDIDATES.filter((o) => list.every((s) => runsForward(s.times, o)));
    if (!fitting.length) throw new Error(`no single offset makes every page's day ${day} run forward`);
    const full = list.filter((s) => !s.first);
    fits[day] = fitting;
    startOf[day] = (o) => Math.min(...(full.length ? full : list).map((s) => moveBack(s.times[0], o)));
  }
  // A day is measured when the offsets that fit it lie within an hour of each other: a whole Cairo
  // day, midnight to midnight, leaves room for one. A day listed only in part (the last one, cut
  // where the page ends) fits many; it takes the offset of the nearest measured day, provided that
  // fits it too. Without one measured day there is no measurement, and the build stops.
  const days = Object.keys(fits).map(Number).sort((a, b) => a - b);
  const tight = days.filter((d) => fits[d].every((a) => fits[d].every((b) => apart(a, b) <= 60)));
  if (!tight.length) throw new Error("no Cairo day of the elcinema.com pages is complete enough to measure its clock");
  const offsets = {};
  const earliest = {};
  const closestAfterMidnight = (day, among) =>
    [...among].sort((a, b) => startOf[day](a) - startOf[day](b) || Math.abs(a) - Math.abs(b))[0];
  for (const day of tight) offsets[day] = closestAfterMidnight(day, fits[day]);
  for (const day of days.filter((d) => !tight.includes(d))) {
    const nearest = [...tight].sort((a, b) => Math.abs(a - day) - Math.abs(b - day))[0];
    if (!fits[day].includes(offsets[nearest])) {
      throw new Error(`day ${day} does not fit the offset measured for day ${nearest}`);
    }
    offsets[day] = offsets[nearest];
  }
  for (const day of days) {
    earliest[day] = startOf[day](offsets[day]);
    // A Cairo day starts at midnight: the earliest programme of a measured day, in Cairo time,
    // must start within its first hour.
    if (tight.includes(day) && earliest[day] > 60) {
      throw new Error(`day ${day}: the earliest programme would start at ${formatTime(earliest[day])} Cairo time`);
    }
  }
  // Neighbouring days can differ by a clock change, never by more than an hour.
  for (const [a, b] of days.slice(1).map((d, i) => [days[i], d])) {
    if (apart(offsets[a], offsets[b]) > 60) throw new Error(`the offsets of days ${a} and ${b} differ by more than an hour`);
  }
  return { offsets, fits, earliest, measured: tight };
}

/** The page with each Cairo-day section's times moved to Cairo's clock. A section whose day was not
 * measured is emptied of times, so it parses to nothing rather than to wrong times. */
export function toCairo(html, offsets) {
  const days = [...html.matchAll(DAY)].map((m) => ({ day: Number(m[2]), at: m.index }));
  let out = html.slice(0, days[0]?.at ?? html.length);
  days.forEach((d, i) => {
    const end = i + 1 < days.length ? days[i + 1].at : html.length;
    const offset = offsets[d.day];
    const part = html.slice(d.at, end);
    out += offset === undefined ? part.replace(TIME, "") : part.replace(TIME, (_, h, m, half) => formatTime(moveBack(toMinutes(h, m, half), offset)));
  });
  return out;
}

/* ------------------------------------------------------------------- in the build */

const CONFIG = "sites/elcinema.com/elcinema.com.config.js";
const UPSTREAM = "sites/elcinema.com/elcinema.com.upstream.js";
const MARK = "// Installed by PROF IPTV's tools/elcinema-cairo.mjs";

/**
 * Wraps the grabber's elcinema.com parser so it reads every page rewritten to Cairo time, with the
 * offsets in the file named by PROF_ELCINEMA_OFFSETS. Without that variable it refuses to parse,
 * so a grab that skipped the measurement yields no elcinema.com programmes rather than shifted ones.
 * Idempotent: the upstream config is kept once, beside it.
 */
export function install(epg) {
  const config = join(epg, CONFIG);
  const upstream = join(epg, UPSTREAM);
  const current = readFileSync(config, "utf8");
  if (!current.startsWith(MARK)) writeFileSync(upstream, current);
  writeFileSync(
    config,
    `${MARK} (docs/FREE-TV.md, "Time zones"). Do not edit.
const upstream = require("./elcinema.com.upstream.js");
const { readFileSync } = require("node:fs");
const DAY = ${DAY};
const TIME = ${TIME};
const toMinutes = ${toMinutes.toString()};
const formatTime = ${formatTime.toString()};
const moveBack = ${moveBack.toString()};
const toCairo = ${toCairo.toString()};
let offsets = null;
module.exports = {
  ...upstream,
  parser(context) {
    if (!offsets) {
      if (!process.env.PROF_ELCINEMA_OFFSETS) throw new Error("elcinema.com times were not measured (PROF_ELCINEMA_OFFSETS)");
      offsets = JSON.parse(readFileSync(process.env.PROF_ELCINEMA_OFFSETS, "utf8")).offsets;
    }
    return upstream.parser({ ...context, content: toCairo(String(context.content ?? ""), offsets) });
  },
};
`,
  );
}

/** The elcinema.com channels of a grabber channel list. */
export function elcinemaChannels(channelsFile) {
  return [...readFileSync(channelsFile, "utf8").matchAll(/<channel\s([^>]*)>/g)]
    .map(([, attrs]) => ({
      site: (attrs.match(/site="([^"]+)"/) ?? [])[1],
      site_id: (attrs.match(/site_id="([^"]+)"/) ?? [])[1],
      lang: (attrs.match(/lang="([^"]+)"/) ?? [])[1] ?? "ar",
    }))
    .filter((c) => c.site === "elcinema.com" && c.site_id);
}

/**
 * Before the grab: fetch each elcinema.com page once (one a second, the grabber's own request),
 * measure, check, write `<work>/elcinema-offsets.json` and install the wrapper. Answers the
 * measurement, or null when the list has no elcinema.com channel. Throws when it does not check out.
 */
export async function prepare({ epg, channelsFile, work, delay = 1000, fetchImpl = fetch, log = () => {} }) {
  const channels = elcinemaChannels(channelsFile);
  if (!channels.length) return null;
  if (!existsSync(join(epg, CONFIG))) throw new Error(`${CONFIG} is not in ${epg}`);
  const require = createRequire(join(epg, "package.json"));
  const config = require(join(epg, existsSync(join(epg, UPSTREAM)) ? UPSTREAM : CONFIG));
  mkdirSync(work, { recursive: true });
  const pages = [];
  for (const [index, channel] of channels.entries()) {
    if (index) await new Promise((done) => setTimeout(done, delay));
    try {
      const response = await fetchImpl(config.url({ channel }), { headers: config.request?.headers ?? {} });
      if (response.ok) pages.push(await response.text());
      else log(`elcinema.com ${channel.site_id}: HTTP ${response.status}`);
    } catch (error) {
      log(`elcinema.com ${channel.site_id}: ${error.message}`);
    }
  }
  const measured = calibrate(pages, { minPages: Math.min(3, channels.length) });
  const file = join(work, "elcinema-offsets.json");
  writeFileSync(file, JSON.stringify({ measuredAt: new Date().toISOString(), pages: pages.length, ...measured }, null, 2));
  install(epg);
  return { file, pages: pages.length, ...measured };
}
