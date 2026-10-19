/**
 * ats.mjs — read job postings from applicant tracking systems
 * ---------------------------------------------------------------------------
 * Every adapter uses the ATS's public, unauthenticated job-board API and
 * returns the same shape:
 *
 *     { jobs: [{ id, title, location, url }], truncated }
 *
 * `truncated` is true when the board had more than `max` postings and only
 * the first `max` were kept. The caller must not close postings for a
 * truncated board: a posting missing from a partial list has not lapsed.
 *
 * Any non-2xx response throws. A board that 404s has moved or been taken
 * down — that is a lapsed lead, and it must surface as an error rather than
 * as "0 open roles".
 */

const UA = 'FoundersAndFriendsBot/1.0 (+https://propertyandtechnology.com)';
const TIMEOUT_MS = 20000;

let fetchImpl = (...a) => globalThis.fetch(...a);
/** Swap the fetch implementation (tests). */
export const setFetch = (f) => { fetchImpl = f; };

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

export async function http(url, { method = 'GET', body, accept = 'application/json' } = {}) {
  const res = await fetchImpl(url, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'User-Agent': UA,
      Accept: accept,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res;
}

const getJson = async (url, opts) => (await http(url, opts)).json();

const cap = (jobs, max) => ({ jobs: jobs.slice(0, max), truncated: jobs.length > max });
const joinLoc = (...parts) => parts.filter(Boolean).join(', ');

/* ---------------------------------------------------------------------------
   Adapters. `slug` is the board token stored in Airtable's "ATS Slug".
   --------------------------------------------------------------------------- */
export const ADAPTERS = {
  async greenhouse(slug, { max }) {
    const body = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return cap((body.jobs ?? []).map(j => ({
      id: String(j.id),
      title: j.title,
      location: j.location?.name ?? '',
      url: j.absolute_url,
    })), max);
  },

  async lever(slug, { max }) {
    const body = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return cap(body.map(j => ({
      id: j.id,
      title: j.text,
      location: j.categories?.location ?? '',
      url: j.hostedUrl,
    })), max);
  },

  async ashby(slug, { max }) {
    const body = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    return cap((body.jobs ?? []).filter(j => j.isListed !== false).map(j => ({
      id: j.id ?? j.jobUrl,
      title: j.title,
      location: j.location ?? '',
      url: j.jobUrl,
    })), max);
  },

  async smartrecruiters(slug, { max }) {
    const jobs = [];
    let total = Infinity;
    for (let offset = 0; offset < total && jobs.length <= max; offset += 100) {
      const body = await getJson(
        `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&offset=${offset}`);
      total = body.totalFound ?? 0;
      const page = body.content ?? [];
      for (const p of page) {
        jobs.push({
          id: p.id,
          title: p.name,
          location: joinLoc(p.location?.city, p.location?.region),
          url: `https://jobs.smartrecruiters.com/${slug}/${p.id}`,
        });
      }
      if (page.length === 0) break;
    }
    return { jobs: jobs.slice(0, max), truncated: total > max };
  },

  /** slug is "tenant/wdN/site", e.g. "greystar/wd1/Greystar_Careers". */
  async workday(slug, { max }) {
    const [tenant, wd, site] = slug.split('/');
    if (!tenant || !wd || !site) throw new Error(`bad workday slug "${slug}" (want tenant/wdN/site)`);
    const host = `https://${tenant}.${wd}.myworkdayjobs.com`;
    const jobs = [];
    let total = Infinity;
    // Workday caps `limit` at 20 and only reports `total` on the first page.
    for (let offset = 0; offset < total && jobs.length <= max; offset += 20) {
      const body = await getJson(`${host}/wday/cxs/${tenant}/${site}/jobs`, {
        method: 'POST',
        body: { appliedFacets: {}, limit: 20, offset, searchText: '' },
      });
      if (offset === 0) total = body.total ?? 0;
      const page = body.jobPostings ?? [];
      for (const p of page) {
        jobs.push({
          id: p.bulletFields?.[0] ?? p.externalPath,
          title: p.title,
          location: p.locationsText ?? '',
          url: `${host}/en-US/${site}${p.externalPath}`,
        });
      }
      if (page.length === 0) break;
    }
    return { jobs: jobs.slice(0, max), truncated: total > max };
  },
};

export const METHODS = Object.keys(ADAPTERS);

export async function fetchJobs(method, slug, { max = 250 } = {}) {
  const adapter = ADAPTERS[method];
  if (!adapter) throw new Error(`unknown ATS "${method}"`);
  return adapter(slug, { max });
}

/* ---------------------------------------------------------------------------
   Detection. Each signature finds { method, slug } in a careers page's HTML
   or final URL. Order matters only when a page embeds two boards.
   --------------------------------------------------------------------------- */
const NOT_SLUGS = new Set(['embed', 'js', 'api', 'v1', 'jobs', 'job_board', 'wday', 'en-us']);
const ok = (slug) => slug && !NOT_SLUGS.has(slug.toLowerCase());

const SIGNATURES = [
  ['greenhouse', [
    /boards(?:-api)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=|v1\/boards\/)?([A-Za-z0-9_-]+)/g,
    /job-boards(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([A-Za-z0-9_-]+)/g,
  ]],
  ['lever', [/jobs\.lever\.co\/([A-Za-z0-9_.-]+)/g, /api\.lever\.co\/v0\/postings\/([A-Za-z0-9_.-]+)/g]],
  ['ashby', [/jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/g, /posting-api\/job-board\/([A-Za-z0-9_.%-]+)/g]],
  ['smartrecruiters', [/(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/g]],
  ['workday', [/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/g]],
];

/** Every distinct { method, slug } a page mentions, in signature order. */
export function detectFromHtml(html, finalUrl = '') {
  const text = `${finalUrl}\n${html}`;
  const found = [];
  const seen = new Set();
  for (const [method, patterns] of SIGNATURES) {
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const slug = method === 'workday'
          ? (ok(m[3]) ? `${m[1]}/${m[2]}/${m[3]}` : null)
          : (ok(m[1]) ? decodeURIComponent(m[1]) : null);
        if (!slug) continue;
        const key = `${method}:${slug}`;
        if (!seen.has(key)) { seen.add(key); found.push({ method, slug }); }
      }
    }
  }
  return found;
}

/** Board-token guesses for a company with no ATS link on its page. */
export function slugGuesses(company) {
  const base = company.slug.toLowerCase();
  const name = company.name.toLowerCase().replace(/\(.*?\)/g, '').trim();
  return [...new Set([
    base.replace(/-/g, ''),
    base,
    name.replace(/[^a-z0-9]/g, ''),
    name.split(/\s+/)[0].replace(/[^a-z0-9]/g, ''),
  ])].filter(s => s.length >= 3);
}

/**
 * Greenhouse is the only board API that names its owner, so it is the only
 * one we guess against: the board's name must match the company's, or a
 * generic slug like "point" would attach another company's jobs.
 */
export async function guessGreenhouse(company) {
  const want = normName(company.name);
  for (const slug of slugGuesses(company)) {
    try {
      const board = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
      // Exact match only: "Point" must not claim "Point Blank Studios".
      if (want && normName(board.name ?? '') === want) return { method: 'greenhouse', slug };
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  return null;
}

const normName = (s) => s.toLowerCase()
  .replace(/\(.*?\)/g, '')
  .replace(/\b(inc|llc|corp|corporation|company|group|technologies|the)\b/g, '')
  .replace(/[^a-z0-9]/g, '');
