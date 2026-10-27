# PROF IPTV — Free TV guide

The programme guide that PROF IPTV's built-in Free TV reads, rebuilt every day by GitHub Actions
and published on this repository's GitHub Pages site. It holds no application code: only the
daily build, generated from the PROF IPTV repository by `tools/export-free-tv-guide-repo.mjs`.
Change things there and export again.

## What is published

| Address | What |
| --- | --- |
| `current.json` | the current version: its file, SHA-256 and size (what the app reads) |
| `guides/<version>/guide.xml.gz` | each version, never changed once published; the previous two are kept |
| `guide.xml.gz` | the current guide at an address that never changes (XMLTV, gzip) |
| `status.json` | the last good run: when, coverage, sites that did not answer |

PROF IPTV is free and non-commercial: no subscriptions, purchases, advertising or other
monetisation. Descriptions are left out of the guide: the app shows titles and times only.

## Sources

Programme schedules are grabbed with [iptv-org/epg](https://github.com/iptv-org/epg) (public
domain) from the sites iptv-org's `guides.json` lists for these channels. **The schedules belong
to those sites**, and each site's own terms apply; every published guide credits the sites it
used (`current.json` → `sources`, and the site's front page).

Only sites whose terms allow their schedules to be republished are asked. Today that is
**elcinema.com** alone, which allows non-commercial republishing on condition that the source is
fully credited ([elcinema.com/copyrights](https://elcinema.com/copyrights/)). Every other site,
including any not yet reviewed, is left out; **shahid.mbc.net** is never asked (its terms forbid
scraping and redistributing its content).

The policy is set with repository variables (Settings → Secrets and variables → Actions →
Variables), comma-separated:

| Variable | Meaning | When unset |
| --- | --- | --- |
| `EPG_ONLY_SITES` | the whitelist: the only sites asked. Add a site only once its terms (or its written permission) allow republishing | `elcinema.com` |
| `EPG_SKIP_SITES` | sites never asked, on top of `shahid.mbc.net`, which is always skipped | `shahid.mbc.net` only |
| `EPG_MIN_CHANNELS` | channels that must have something on now, or nothing is published | `25` (suits elcinema.com alone; raise it as sources are added) |
| `EPG_ENABLED` | `true` to build and publish | nothing runs |

A site that objects is removed from `EPG_ONLY_SITES` (or added to `EPG_SKIP_SITES`); its
schedules are gone from the next day's guide. To ask for that, open an issue in this repository.

## Setup (once)

1. This repository must be **public** for GitHub Pages on GitHub Free (private repositories need
   GitHub Pro, Team or Enterprise).
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Settings → Actions → General → Workflow permissions: **Read repository contents** (the default)
   is enough - each job asks for what it needs.
4. Set the source policy variables if the defaults are not the decision (see "Sources").
5. Variable `EPG_ENABLED` = `true`. Until then every job is skipped: pushing this repository
   publishes nothing.
6. Actions → guide → **Run workflow**. About 45 minutes. Then open
   `https://<owner>.github.io/prof-iptv-epg/current.json`.
7. Build PROF IPTV with `PROF_EPG_URL=https://<owner>.github.io/prof-iptv-epg` (or a domain of
   your own pointed at this site - then the address in the app never depends on GitHub).
8. Watch the repository (Watch → Custom → Issues) to be emailed when a run fails.

## When a run fails

Nothing is deployed, so the last good guide stays published and devices keep it. The `report` job
opens an issue titled "Free TV guide: run failed" (or comments on the open one) and closes it on
the next good run. The `check` job fails, and the issue says so, when the published guide is more
than 36 hours old, has fewer than 40 channels with something on now, or does not match its
`current.json`.
