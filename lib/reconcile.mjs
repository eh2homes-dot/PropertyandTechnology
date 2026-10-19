/**
 * reconcile.mjs — turn one company's fresh scrape into Airtable writes
 * ---------------------------------------------------------------------------
 * Pure functions, no I/O, so the rules that decide when a posting has lapsed
 * can be tested without a network:
 *
 *   - a posting on the board that we have never seen      → create, open
 *   - a posting on the board that we already have         → refresh Last Seen,
 *                                                            reopen if closed
 *   - a posting we have as open that left a FULL board    → close (lapsed)
 *   - a posting we have as open, board was TRUNCATED      → leave alone
 *
 * Closing only ever follows a successful scrape. A scrape that errored never
 * reaches this module, so a dead API can't mass-close a company's postings.
 */
import { F } from './airtable.mjs';

const P = F.posting;

export const jobKey = (companySlug, method, id) => `${companySlug}:${method}:${id}`;

/** Map a title onto the board's Function choices, or null when none fits. */
export function inferFunction(title) {
  const t = ` ${title.toLowerCase()} `;
  if (/\b(chief|c[eotfmrp]o|vp|vice president|svp|evp|president|head of|general manager)\b/.test(t)) return 'Executive';
  if (/\b(engineer|engineering|developer|software|devops|sre|data scientist|machine learning|architect|qa|programmer|platform)\b/.test(t)) return 'Engineering';
  if (/\b(account executive|sales|sdr|bdr|business development|account manager)\b/.test(t)) return 'Sales';
  if (/\b(marketing|growth|demand gen|customer success|partnerships?|revenue operations|revops|brand|product marketing|go-to-market|gtm)\b/.test(t)) return 'GTM';
  return null;
}

/**
 * @param company   { id, slug, method }        Airtable record id + config
 * @param scrape    { jobs, truncated }          from ats.fetchJobs
 * @param existing  [{ id, key, status }]        this company's postings
 * @param now       ISO timestamp for this run
 * @param runId     Scrape Runs record id (or null on a dry run)
 * @returns { creates: [fields], updates: [{ id, fields }], opened, closed, reopened, seen }
 */
export function reconcile({ company, scrape, existing, now, runId }) {
  const byKey = new Map(existing.map(e => [e.key, e]));
  const fresh = new Map();
  for (const j of scrape.jobs) {
    if (!j.id || !j.title) continue;
    fresh.set(jobKey(company.slug, company.method, j.id), j);
  }

  const creates = [];
  const updates = [];
  let reopened = 0;

  for (const [key, j] of fresh) {
    const shared = {
      [P.title]: j.title,
      [P.location]: j.location || '',
      [P.url]: j.url || null,
      [P.status]: 'open',
      [P.lastSeen]: now,
      [P.linkVerified]: true,
    };
    const had = byKey.get(key);
    if (!had) {
      creates.push({
        ...shared,
        [P.key]: key,
        [P.company]: [company.id],
        [P.function]: inferFunction(j.title),
        [P.firstSeen]: now,
        ...(runId ? { [P.run]: [runId] } : {}),
      });
    } else {
      if (had.status === 'closed') reopened++;
      updates.push({ id: had.id, fields: { ...shared, [P.closedAt]: null } });
    }
  }

  let closed = 0;
  if (!scrape.truncated) {
    for (const e of existing) {
      if (e.status !== 'closed' && !fresh.has(e.key)) {
        closed++;
        updates.push({ id: e.id, fields: { [P.status]: 'closed', [P.closedAt]: now } });
      }
    }
  }

  return { creates, updates, opened: creates.length, closed, reopened, seen: fresh.size };
}

/**
 * Companies that point at the same board (a subsidiary listed on its
 * parent's ATS) are scraped once. The board goes to the company with no
 * Parent; the others are reported as sharing it.
 */
export function dedupeBoards(companies) {
  const owner = new Map();
  for (const c of [...companies].sort((a, b) => Number(!!a.parent) - Number(!!b.parent))) {
    const board = `${c.method}:${c.atsSlug}`;
    if (!owner.has(board)) owner.set(board, c);
  }
  const scrape = [];
  const shared = [];
  for (const c of companies) {
    const o = owner.get(`${c.method}:${c.atsSlug}`);
    (o === c ? scrape : shared).push(o === c ? c : { company: c, sharesWith: o });
  }
  return { scrape, shared };
}
