#!/usr/bin/env node
/**
 * run.js — scrape every company's job board into Airtable
 * ---------------------------------------------------------------------------
 *   node run.js                      # every active company with an ATS
 *   node run.js --hub=opco           # one hub only
 *   node run.js --only=appfolio      # one company (its Slug)
 *   node run.js --dry                # fetch and report, write nothing
 *
 * Env:
 *   AIRTABLE_TOKEN          personal access token (data.records:read/write)
 *   AIRTABLE_BASE_ID        defaults to the "Syndeo Job Search (Trial)" base
 *   MAX_JOBS_PER_COMPANY    default 250; larger boards are truncated
 *
 * Companies come from Airtable's Companies table. With --dry and no token,
 * they come from config.js instead, so the scrape can be checked locally.
 *
 * Each run writes one Scrape Runs row, creates postings it has not seen,
 * refreshes Last Seen on the ones still listed, and closes the ones that
 * left their board (see lib/reconcile.mjs for the exact rules). Each
 * company's Last Scraped / Scrape Status / Open Roles is updated so a board
 * that has started erroring or emptied out is visible in Airtable.
 */
import { pathToFileURL } from 'node:url';
import { airtable, F, T, DEFAULT_BASE_ID } from './lib/airtable.mjs';
import { fetchJobs, setFetch, HttpError } from './lib/ats.mjs';
import { reconcile, dedupeBoards } from './lib/reconcile.mjs';

const C = F.company;
const P = F.posting;
const R = F.run;
const CONCURRENCY = 6;

export const parseArgs = (argv) => Object.fromEntries(argv.map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

export const fromAirtable = (r) => ({
  id: r.id,
  name: r.fields[C.name] ?? '',
  slug: r.fields[C.slug] ?? '',
  hub: (r.fields[C.hub] ?? '').toLowerCase(),
  active: !!r.fields[C.active],
  method: (r.fields[C.ats] ?? '').trim().toLowerCase() || null,
  atsSlug: (r.fields[C.atsSlug] ?? '').trim() || null,
  parent: r.fields[C.parent] ?? null,
});

const fromConfig = (c) => ({
  id: c.id, name: c.name, slug: c.id, hub: c.hub, active: c.active,
  method: c.method, atsSlug: c.atsSlug, parent: c.parentId,
});

/** Run fn over items with at most n in flight; results keep input order. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const describe = (e) => (e instanceof HttpError
  ? `HTTP ${e.status}${e.status === 404 ? ' (board moved or removed)' : ''}`
  : e.name === 'TimeoutError' ? 'timed out' : e.message);

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
  const max = Number(env.MAX_JOBS_PER_COMPANY || 250);

  const at = env.AIRTABLE_TOKEN
    ? airtable({ token: env.AIRTABLE_TOKEN, baseId: env.AIRTABLE_BASE_ID || DEFAULT_BASE_ID, fetch, sleep })
    : null;
  if (!at && !dry) throw new Error('AIRTABLE_TOKEN is not set (use --dry to scrape without writing)');

  let companies = at
    ? (await at.list(T.companies, { fields: Object.values(C) })).map(fromAirtable)
    : (await import('./config.js')).COMPANIES.map(fromConfig);
  companies = companies.filter(c => c.active && c.slug
    && (!args.hub || c.hub === args.hub)
    && (!args.only || c.slug === args.only));

  const ready = companies.filter(c => c.method && c.atsSlug);
  const pendingCount = companies.length - ready.length;
  const { scrape, shared } = dedupeBoards(ready);
  log(`${scrape.length} boards to scrape, ${shared.length} shared, ${pendingCount} companies with no ATS yet`);

  let runId = null;
  if (at && !dry) {
    [{ id: runId }] = await at.create(T.runs, [{ [R.workflow]: 'job_search', [R.started]: now }]);
  }

  try {
    // Postings without a Job Key were entered by hand; the scraper leaves them alone.
    const existing = new Map();
    if (at) {
      for (const r of await at.list(T.postings, { fields: [P.key, P.status, P.company] })) {
        const key = r.fields[P.key];
        const cid = r.fields[P.company]?.[0];
        if (!key || !cid) continue;
        if (!existing.has(cid)) existing.set(cid, []);
        existing.get(cid).push({ id: r.id, key, status: r.fields[P.status] ?? 'open' });
      }
    }

    const results = await pool(scrape, CONCURRENCY, async (c) => {
      try {
        return { c, scrape: await fetchJobs(c.method, c.atsSlug, { max }) };
      } catch (e) {
        return { c, error: describe(e) };
      }
    });

    const creates = [];
    const updates = [];
    const companyUpdates = [];
    const failed = [];
    const truncated = [];
    const totals = { seen: 0, opened: 0, closed: 0, reopened: 0 };

    for (const { c, scrape: s, error } of results) {
      if (error) {
        failed.push(`${c.name}: ${error}`);
        companyUpdates.push({ id: c.id, fields: { [C.lastScraped]: now, [C.scrapeStatus]: `error: ${error}` } });
        log(`  ✗ ${c.name} (${c.method}/${c.atsSlug}) ${error}`);
        continue;
      }
      const r = reconcile({ company: c, scrape: s, existing: existing.get(c.id) ?? [], now, runId });
      creates.push(...r.creates);
      updates.push(...r.updates);
      for (const k of Object.keys(totals)) totals[k] += r[k];
      if (s.truncated) truncated.push(c.name);
      const status = s.truncated ? `ok (first ${max} postings only)`
        : r.seen === 0 ? 'ok: board is empty' : 'ok';
      companyUpdates.push({ id: c.id, fields: { [C.lastScraped]: now, [C.scrapeStatus]: status, [C.openRoles]: r.seen } });
      log(`  ✓ ${c.name}: ${r.seen} open, +${r.opened} new, −${r.closed} closed${s.truncated ? ', truncated' : ''}`);
    }
    for (const { company, sharesWith } of shared) {
      companyUpdates.push({ id: company.id, fields: { [C.lastScraped]: now, [C.scrapeStatus]: `shares board with ${sharesWith.name}` } });
    }

    const notes = [
      `${results.length - failed.length}/${results.length} boards scraped, ${pendingCount} companies awaiting ATS detection.`,
      `${totals.seen} open postings: ${totals.opened} new, ${totals.reopened} reopened, ${totals.closed} closed.`,
      truncated.length ? `Truncated at ${max}: ${truncated.join(', ')}.` : '',
      failed.length ? `Failed:\n${failed.map(f => `- ${f}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    log(notes);

    if (at && !dry) {
      await at.create(T.postings, creates);
      await at.update(T.postings, updates);
      await at.update(T.companies, companyUpdates);
      await at.update(T.runs, [{ id: runId, fields: {
        [R.finished]: new Date().toISOString(), [R.rowsFound]: totals.seen, [R.notes]: notes,
      } }]);
    } else {
      log(`dry run: would create ${creates.length}, update ${updates.length} postings and ${companyUpdates.length} companies`);
    }

    // Every board failing points at the network or the runner, not at lapsed leads.
    const allFailed = results.length > 0 && failed.length === results.length;
    return { ...totals, creates, updates, companyUpdates, failed, truncated, runId, allFailed };
  } catch (e) {
    if (runId) {
      await at.update(T.runs, [{ id: runId, fields: {
        [R.finished]: new Date().toISOString(), [R.notes]: `FAILED: ${e.message}`,
      } }]).catch(() => {});
    }
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((r) => {
    if (r.allFailed) {
      console.error('every board failed — likely a network or ATS outage, not lapsed leads');
      process.exitCode = 1;
    }
  }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
