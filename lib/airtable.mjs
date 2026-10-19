/**
 * airtable.mjs — the minimum Airtable REST client run.js needs
 * ---------------------------------------------------------------------------
 * Tables and fields are addressed by name so the scripts work against a
 * duplicate of the base without editing IDs. Rename a field in Airtable and
 * you must rename it in `F` below too.
 *
 * Airtable allows 5 requests per second per base and 10 records per write;
 * the client paces itself and batches accordingly, and backs off on 429.
 */

export const DEFAULT_BASE_ID = 'appnWM0QuCZS3xgYN'; // "Syndeo Job Search (Trial)"

export const T = {
  companies: 'Companies',
  postings: 'Job Postings',
  runs: 'Scrape Runs',
};

export const F = {
  company: {
    name: 'Name',
    slug: 'Slug',
    hub: 'Segment',
    careersUrl: 'Careers URL',
    website: 'Website',
    active: 'Active',
    ats: 'ATS',
    atsSlug: 'ATS Slug',
    parent: 'Parent',
    lastScraped: 'Last Scraped',
    scrapeStatus: 'Scrape Status',
    openRoles: 'Open Roles',
  },
  posting: {
    title: 'Title',
    key: 'Job Key',
    company: 'Company',
    function: 'Function',
    location: 'Location',
    url: 'URL',
    status: 'Status',
    firstSeen: 'First Seen',
    lastSeen: 'Last Seen',
    closedAt: 'Closed At',
    linkVerified: 'Link Verified',
    run: 'Run',
  },
  run: {
    workflow: 'Workflow',
    started: 'Started',
    finished: 'Finished',
    rowsFound: 'Rows Found',
    notes: 'Notes',
  },
};

const API = 'https://api.airtable.com/v0';
const MIN_GAP_MS = 220;   // stays under 5 req/s
const BATCH = 10;

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export function airtable({
  token,
  baseId = DEFAULT_BASE_ID,
  fetch: fetchImpl = (...a) => globalThis.fetch(...a),
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  if (!token) throw new Error('AIRTABLE_TOKEN is not set');
  let last = 0;

  async function req(method, table, { query, body } = {}) {
    const url = `${API}/${baseId}/${encodeURIComponent(table)}${query ? `?${query}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      const wait = last + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.json();
      // Airtable asks for a 30s pause after a 429.
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await sleep(res.status === 429 ? 30000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Airtable ${method} ${table}: HTTP ${res.status} ${await res.text()}`);
    }
  }

  return {
    /** Every record in a table, as { id, fields }. */
    async list(table, { fields = [] } = {}) {
      const out = [];
      let offset;
      do {
        const q = new URLSearchParams({ pageSize: '100' });
        for (const f of fields) q.append('fields[]', f);
        if (offset) q.set('offset', offset);
        const page = await req('GET', table, { query: q.toString() });
        out.push(...page.records);
        offset = page.offset;
      } while (offset);
      return out;
    },

    /** Create records from field objects; returns the created records in order. */
    async create(table, rows) {
      const out = [];
      for (const batch of chunks(rows, BATCH)) {
        const res = await req('POST', table, { body: { records: batch.map(fields => ({ fields })) } });
        out.push(...res.records);
      }
      return out;
    },

    /** Patch records given as { id, fields }; only the named fields change. */
    async update(table, rows) {
      for (const batch of chunks(rows, BATCH)) {
        await req('PATCH', table, { body: { records: batch } });
      }
    },
  };
}
