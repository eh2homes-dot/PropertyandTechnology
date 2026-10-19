import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main as scrape } from '../run.js';
import { main as detect, careerLinks } from '../scripts/detect-ats.mjs';
import { airtable } from '../lib/airtable.mjs';
import { router, json, html, fakeAirtable } from './helpers.mjs';

const noSleep = async () => {};
const env = { AIRTABLE_TOKEN: 'test', AIRTABLE_BASE_ID: 'appTEST' };
const quiet = () => {};

const companies = () => [
  { id: 'recAcme', Name: 'Acme', Slug: 'acme', Segment: 'PropTech', Active: true, ATS: 'greenhouse', 'ATS Slug': 'acme' },
  { id: 'recGone', Name: 'Gone Co', Slug: 'gone', Segment: 'OpCo', Active: true, ATS: 'lever', 'ATS Slug': 'gone' },
  { id: 'recSub', Name: 'Acme Sub', Slug: 'acme-sub', Segment: 'PropTech', Active: true, ATS: 'greenhouse', 'ATS Slug': 'acme', Parent: 'acme' },
  { id: 'recOld', Name: 'Old Co', Slug: 'old', Segment: 'OpCo', Active: false, ATS: 'greenhouse', 'ATS Slug': 'old' },
  { id: 'recNew', Name: 'New Co', Slug: 'new', Segment: 'OpCo', Active: true },
];

const greenhouse = (ids) => () => json({ jobs: ids.map(id => ({
  id, title: `Role ${id}`, location: { name: 'Remote' }, absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`,
})) });

test('two scrapes: postings are opened, refreshed, and closed when they lapse', async () => {
  const at = fakeAirtable({ Companies: companies(), 'Job Postings': [
    { id: 'recManual', Title: 'Hand-entered', Status: 'open' },
  ] });
  let board = greenhouse([1, 2, 3]);
  const fetch = router([
    ['https://api.airtable.com/', at.handler],
    ['https://boards-api.greenhouse.io/v1/boards/acme/jobs', (...a) => board(...a)],
  ]);

  const first = await scrape({ argv: [], env, fetch, sleep: noSleep, now: '2026-10-19T06:00:00.000Z', log: quiet });
  assert.equal(first.opened, 3);
  assert.deepEqual(first.failed, ['Gone Co: HTTP 404 (board moved or removed)']);
  const postings = at.tables['Job Postings'];
  assert.equal(postings.filter(p => p.fields.Status === 'open').length, 4); // 3 scraped + 1 manual
  assert.deepEqual(postings.find(p => p.fields['Job Key'] === 'acme:greenhouse:1').fields.Company, ['recAcme']);

  const co = Object.fromEntries(at.tables.Companies.map(c => [c.id, c.fields]));
  assert.equal(co.recAcme['Scrape Status'], 'ok');
  assert.equal(co.recAcme['Open Roles'], 3);
  assert.equal(co.recGone['Scrape Status'], 'error: HTTP 404 (board moved or removed)');
  assert.equal(co.recSub['Scrape Status'], 'shares board with Acme');
  assert.equal(co.recOld['Scrape Status'], undefined, 'inactive companies are not touched');
  assert.equal(co.recNew['Scrape Status'], undefined, 'pending companies are left to detect-ats');

  const [run] = at.tables['Scrape Runs'];
  assert.equal(run.fields.Workflow, 'job_search');
  assert.equal(run.fields['Rows Found'], 3);
  assert.match(run.fields.Notes, /1\/2 boards scraped/);
  assert.match(run.fields.Notes, /Gone Co: HTTP 404/);

  // Role 2 is filled, role 4 is posted.
  board = greenhouse([1, 3, 4]);
  const second = await scrape({ argv: [], env, fetch, sleep: noSleep, now: '2026-10-19T18:00:00.000Z', log: quiet });
  assert.equal(second.opened, 1);
  assert.equal(second.closed, 1);
  const byKey = (k) => postings.find(p => p.fields['Job Key'] === `acme:greenhouse:${k}`).fields;
  assert.equal(byKey(2).Status, 'closed');
  assert.equal(byKey(2)['Closed At'], '2026-10-19T18:00:00.000Z');
  assert.equal(byKey(1)['Last Seen'], '2026-10-19T18:00:00.000Z');
  assert.equal(byKey(1)['First Seen'], '2026-10-19T06:00:00.000Z');
  assert.equal(byKey(4).Status, 'open');
  assert.equal(postings.find(p => p.id === 'recManual').fields.Status, 'open', 'manual rows are never closed');
  assert.equal(at.tables['Scrape Runs'].length, 2);
});

test('a board that errors does not close its postings', async () => {
  const at = fakeAirtable({ Companies: companies().slice(0, 1), 'Job Postings': [
    { id: 'recP', 'Job Key': 'acme:greenhouse:1', Company: ['recAcme'], Status: 'open' },
  ] });
  const fetch = router([
    ['https://api.airtable.com/', at.handler],
    ['https://boards-api.greenhouse.io/', () => json({}, 503)],
  ]);
  const r = await scrape({ argv: [], env, fetch, sleep: noSleep, log: quiet });
  assert.equal(r.allFailed, true);
  assert.equal(at.tables['Job Postings'][0].fields.Status, 'open');
  assert.match(at.tables['Scrape Runs'][0].fields.Notes, /0\/1 boards scraped/);
});

test('--dry reads config.js without a token and writes nothing', async () => {
  const calls = [];
  const r = await scrape({ argv: ['--dry'], env: {}, fetch: router([], calls), log: quiet });
  assert.equal(calls.length, 0, 'no company in config.js has an ATS yet, so nothing is fetched');
  assert.equal(r.creates.length, 0);
});

test('a real run refuses to start without a token', async () => {
  await assert.rejects(scrape({ argv: [], env: {}, log: quiet }), /AIRTABLE_TOKEN/);
});

test('detect-ats confirms a board before writing it, and records why others failed', async () => {
  const at = fakeAirtable({ Companies: [
    { id: 'recA', Name: 'Acme', Slug: 'acme', Active: true, 'Careers URL': 'https://acme.com/careers', Website: 'https://acme.com' },
    { id: 'recB', Name: 'Bygone', Slug: 'bygone', Active: true, 'Careers URL': 'https://bygone.com/careers', Website: 'https://bygone.com' },
    { id: 'recC', Name: 'Cherre', Slug: 'cherre', Active: true, 'Careers URL': 'https://cherre.com/careers', Website: 'https://cherre.com' },
    { id: 'recD', Name: 'Deep', Slug: 'deep', Active: true, 'Careers URL': 'https://deep.com/careers', Website: 'https://deep.com' },
    { id: 'recE', Name: 'Done', Slug: 'done', Active: true, ATS: 'lever', 'ATS Slug': 'done' },
  ] });
  const fetch = router([
    ['https://api.airtable.com/', at.handler],
    // Acme links a dead board and a live one; only the live one is kept.
    ['https://acme.com/careers', () => html('<a href="https://jobs.lever.co/acme-old">old</a><a href="https://jobs.lever.co/acme">jobs</a>', 'https://acme.com/careers')],
    ['https://api.lever.co/v0/postings/acme?', () => json([])],
    // Cherre's page is JS-rendered; its board is found by name.
    ['https://cherre.com/', () => html('<div id="root"></div>')],
    ['https://boards-api.greenhouse.io/v1/boards/cherre', (url) => json(url.endsWith('/jobs') ? { jobs: [] } : { name: 'Cherre' })],
    // Deep's board is one click in from its careers page.
    ['https://deep.com/careers/open-positions', () => html('<script src="https://boards.greenhouse.io/embed/job_board/js?for=deepco"></script>')],
    ['https://deep.com/careers', () => html('<a href="/careers/open-positions">See openings</a>', 'https://deep.com/careers')],
    ['https://boards-api.greenhouse.io/v1/boards/deepco/jobs', () => json({ jobs: [] })],
  ]);

  const r = await detect({ argv: [], env, fetch, sleep: noSleep, now: '2026-10-19T00:00:00.000Z', log: quiet });
  const co = Object.fromEntries(at.tables.Companies.map(c => [c.id, c.fields]));
  assert.equal(co.recA.ATS, 'lever');
  assert.equal(co.recA['ATS Slug'], 'acme');
  assert.equal(co.recC['ATS Slug'], 'cherre');
  assert.equal(co.recC['Scrape Status'], 'ats detected via name match');
  assert.equal(co.recD['ATS Slug'], 'deepco');
  assert.equal(co.recB.ATS, undefined);
  assert.equal(co.recB['Scrape Status'], 'pending: careers page HTTP 404');
  assert.equal(co.recE['Scrape Status'], undefined, 'companies with an ATS are skipped without --recheck');
  assert.equal(r.resolved.length, 3);
});

test('careerLinks keeps same-site job links only', () => {
  const page = `<a href="/careers/jobs">a</a><a href="https://other.com/careers">b</a>
    <a href="https://www.acme.com/join-us">c</a><a href="/about">d</a><a href="#careers">e</a>`;
  assert.deepEqual(careerLinks(page, 'https://acme.com/careers'),
    ['https://acme.com/careers/jobs', 'https://www.acme.com/join-us']);
});

test('airtable client pages reads, batches writes by 10, and retries 429', async () => {
  const at = fakeAirtable({ T: Array.from({ length: 250 }, (_, i) => ({ n: i })) });
  let throttled = false;
  const sleeps = [];
  const client = airtable({
    token: 't', baseId: 'appX', sleep: async (ms) => { sleeps.push(ms); },
    fetch: async (url, init) => {
      if (!throttled && init.method === 'POST') { throttled = true; return json({}, 429); }
      return at.handler(url, init);
    },
  });
  assert.equal((await client.list('T')).length, 250);
  const created = await client.create('T', Array.from({ length: 23 }, (_, i) => ({ n: 1000 + i })));
  assert.equal(created.length, 23);
  assert.equal(at.tables.T.length, 273);
  assert.ok(sleeps.includes(30000), 'waits 30s after a 429');
  assert.throws(() => airtable({}), /AIRTABLE_TOKEN/);
});
