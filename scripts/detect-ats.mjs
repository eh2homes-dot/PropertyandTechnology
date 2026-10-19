#!/usr/bin/env node
/**
 * detect-ats.mjs — work out which ATS each company's careers page runs on
 * ---------------------------------------------------------------------------
 *   node scripts/detect-ats.mjs                  # active companies with no ATS
 *   node scripts/detect-ats.mjs --recheck        # every active company
 *   node scripts/detect-ats.mjs --only=entrata   # a single company (its Slug)
 *   node scripts/detect-ats.mjs --dry            # print, write nothing
 *
 * For each company it fetches the careers page (and, failing that, up to
 * three career-looking links on it, then the homepage), looks for a known
 * ATS board link, and confirms the board answers through its API before
 * writing ATS + ATS Slug to Airtable. Greenhouse boards are also guessed
 * from the company name, but only accepted when the board's own name
 * matches.
 *
 * The rule this script exists to enforce: a company whose ATS cannot be
 * confirmed is left blank and reported, never given a guessed adapter. A
 * wrong adapter returns zero rows that look exactly like "not hiring".
 *
 * Unresolved companies get a Scrape Status saying why. "careers page
 * HTTP 404" there usually means the lead has lapsed (moved, acquired, shut).
 */
import { pathToFileURL } from 'node:url';
import { airtable, F, T, DEFAULT_BASE_ID } from '../lib/airtable.mjs';
import { http, HttpError, detectFromHtml, fetchJobs, guessGreenhouse, setFetch } from '../lib/ats.mjs';
import { parseArgs, fromAirtable, pool } from '../run.js';

const C = F.company;
const CONCURRENCY = 6;
const CAREER_LINK = /(career|jobs?\b|openings|positions|join-us|work-with-us)/i;

async function page(url) {
  const res = await http(url, { accept: 'text/html,application/xhtml+xml' });
  return { html: await res.text(), finalUrl: res.url || url };
}

const reason = (e) => (e instanceof HttpError ? `HTTP ${e.status}`
  : e.name === 'TimeoutError' ? 'timed out' : e.cause?.code ?? e.message);

/** Same-site links on a page that look like they lead to job listings. */
export function careerLinks(html, baseUrl, limit = 3) {
  const base = new URL(baseUrl);
  const out = new Set();
  for (const [, href] of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    if (!CAREER_LINK.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (u.href === base.href) continue;
    out.add(u.href);
    if (out.size >= limit) break;
  }
  return [...out];
}

async function verify(candidates) {
  for (const cand of candidates) {
    try {
      await fetchJobs(cand.method, cand.slug, { max: 1 });
      return cand;
    } catch { /* try the next one */ }
  }
  return null;
}

/** → { method, slug, via } or { error } */
export async function detect(company) {
  let careersError = null;
  const tried = new Set();
  const look = async (url) => {
    if (!url || tried.has(url)) return { found: null, html: '' };
    tried.add(url);
    try {
      const { html, finalUrl } = await page(url);
      return { found: await verify(detectFromHtml(html, finalUrl)), html, finalUrl };
    } catch (e) {
      if (url === company.careersUrl) careersError = reason(e);
      return { found: null, html: '' };
    }
  };

  const first = await look(company.careersUrl);
  if (first.found) return { ...first.found, via: 'careers page' };
  if (first.html) {
    for (const link of careerLinks(first.html, first.finalUrl)) {
      const r = await look(link);
      if (r.found) return { ...r.found, via: link };
    }
  }
  const home = await look(company.website);
  if (home.found) return { ...home.found, via: 'homepage' };

  const guessed = await guessGreenhouse(company).catch(() => null);
  if (guessed) return { ...guessed, via: 'name match' };

  return { error: careersError ? `careers page ${careersError}` : 'no ATS link found (page may be JS-rendered)' };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetch,
  now = new Date().toISOString(),
  log = console.log,
  sleep,
} = {}) {
  const args = parseArgs(argv);
  if (fetch) setFetch(fetch);
  const dry = !!args.dry;
  const at = env.AIRTABLE_TOKEN
    ? airtable({ token: env.AIRTABLE_TOKEN, baseId: env.AIRTABLE_BASE_ID || DEFAULT_BASE_ID, fetch, sleep })
    : null;
  if (!at && !dry) throw new Error('AIRTABLE_TOKEN is not set (use --dry to detect without writing)');

  const companies = at
    ? (await at.list(T.companies, { fields: Object.values(C) })).map(r => ({
        ...fromAirtable(r), careersUrl: r.fields[C.careersUrl], website: r.fields[C.website],
      }))
    : (await import('../config.js')).COMPANIES.map(c => ({
        id: c.id, name: c.name, slug: c.id, hub: c.hub, active: c.active,
        method: c.method, atsSlug: c.atsSlug, careersUrl: c.careersUrl, website: c.website,
      }));

  const targets = companies.filter(c => c.active && c.slug
    && (args.recheck || !(c.method && c.atsSlug))
    && (!args.hub || c.hub === args.hub)
    && (!args.only || c.slug === args.only));
  log(`detecting ATS for ${targets.length} companies`);

  const results = await pool(targets, CONCURRENCY, async c => ({ c, r: await detect(c) }));

  const updates = results.map(({ c, r }) => ({
    id: c.id,
    fields: r.error
      ? { [C.lastScraped]: now, [C.scrapeStatus]: `pending: ${r.error}` }
      : { [C.ats]: r.method, [C.atsSlug]: r.slug, [C.lastScraped]: now, [C.scrapeStatus]: `ats detected via ${r.via}` },
  }));

  const resolved = results.filter(x => !x.r.error);
  const unresolved = results.filter(x => x.r.error);
  for (const { c, r } of resolved) log(`  ✓ ${c.name}: ${r.method} ${r.slug} (${r.via})`);
  for (const { c, r } of unresolved) log(`  ? ${c.name}: ${r.error}`);
  log(`${resolved.length} resolved, ${unresolved.length} unresolved`);

  if (at && !dry) await at.update(T.companies, updates);
  return { resolved, unresolved, updates };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
