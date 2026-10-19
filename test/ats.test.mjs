import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJobs, setFetch, detectFromHtml, slugGuesses, guessGreenhouse, HttpError } from '../lib/ats.mjs';
import { router, json } from './helpers.mjs';

test('greenhouse: maps jobs and truncates past max', async () => {
  setFetch(router([['https://boards-api.greenhouse.io/v1/boards/acme/jobs', () => json({
    jobs: [
      { id: 11, title: 'Account Executive', location: { name: 'Remote' }, absolute_url: 'https://g/11' },
      { id: 12, title: 'Engineer', location: { name: 'NYC' }, absolute_url: 'https://g/12' },
    ],
  })]]));
  const all = await fetchJobs('greenhouse', 'acme', { max: 5 });
  assert.equal(all.truncated, false);
  assert.deepEqual(all.jobs[0], { id: '11', title: 'Account Executive', location: 'Remote', url: 'https://g/11' });
  const one = await fetchJobs('greenhouse', 'acme', { max: 1 });
  assert.equal(one.jobs.length, 1);
  assert.equal(one.truncated, true);
});

test('lever and ashby map their own shapes; ashby drops unlisted jobs', async () => {
  setFetch(router([
    ['https://api.lever.co/v0/postings/acme', () => json([
      { id: 'L1', text: 'Designer', categories: { location: 'Austin' }, hostedUrl: 'https://l/1' },
    ])],
    ['https://api.ashbyhq.com/posting-api/job-board/acme', () => json({ jobs: [
      { id: 'A1', title: 'PM', location: 'SF', jobUrl: 'https://a/1' },
      { id: 'A2', title: 'Hidden', location: 'SF', jobUrl: 'https://a/2', isListed: false },
    ] })],
  ]));
  assert.deepEqual((await fetchJobs('lever', 'acme')).jobs,
    [{ id: 'L1', title: 'Designer', location: 'Austin', url: 'https://l/1' }]);
  assert.deepEqual((await fetchJobs('ashby', 'acme')).jobs.map(j => j.id), ['A1']);
});

test('smartrecruiters pages by 100 until totalFound', async () => {
  const mk = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `S${from + i}`, name: `Job ${from + i}`, location: { city: 'Dallas', region: 'TX' } }));
  setFetch(router([[/smartrecruiters\.com\/v1\/companies\/acme\/postings/, (url) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    return json({ totalFound: 150, content: offset === 0 ? mk(0, 100) : mk(100, 50) });
  }]]));
  const r = await fetchJobs('smartrecruiters', 'acme', { max: 500 });
  assert.equal(r.jobs.length, 150);
  assert.equal(r.truncated, false);
  assert.equal(r.jobs[0].location, 'Dallas, TX');
  assert.equal(r.jobs[149].url, 'https://jobs.smartrecruiters.com/acme/S149');
});

test('workday: POSTs pages of 20, total only on the first page, truncates', async () => {
  const bodies = [];
  setFetch(router([['https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs', (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const page = Array.from({ length: Math.max(0, Math.min(20, 45 - body.offset)) }, (_, i) => ({
      title: `Job ${body.offset + i}`, externalPath: `/job/x/${body.offset + i}`,
      locationsText: 'Charleston', bulletFields: [`R${body.offset + i}`],
    }));
    return json({ total: body.offset === 0 ? 45 : 0, jobPostings: page });
  }]]));
  const r = await fetchJobs('workday', 'acme/wd5/Careers', { max: 30 });
  assert.equal(r.jobs.length, 30);
  assert.equal(r.truncated, true);
  assert.equal(bodies[0].limit, 20);
  assert.equal(r.jobs[0].url, 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/x/0');
  assert.equal(r.jobs[0].id, 'R0');

  const full = await fetchJobs('workday', 'acme/wd5/Careers', { max: 100 });
  assert.equal(full.jobs.length, 45);
  assert.equal(full.truncated, false);
  assert.equal(bodies.filter(b => b.offset === 60).length, 0); // stops at total, no extra page
});

test('a missing board throws HttpError instead of returning zero jobs', async () => {
  setFetch(router([]));
  await assert.rejects(fetchJobs('greenhouse', 'gone'), (e) => e instanceof HttpError && e.status === 404);
  await assert.rejects(fetchJobs('workday', 'bad-slug'), /tenant\/wdN\/site/);
  await assert.rejects(fetchJobs('taleo', 'x'), /unknown ATS/);
});

test('detectFromHtml finds each ATS and skips path words', () => {
  const page = `
    <iframe src="https://boards.greenhouse.io/embed/job_board?for=acmeco"></iframe>
    <script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeco"></script>
    <a href="https://jobs.lever.co/acme-inc/123">x</a>
    <a href="https://jobs.ashbyhq.com/Acme%20Co">x</a>
    <a href="https://careers.smartrecruiters.com/AcmeCo1">x</a>
    <a href="https://acme.wd1.myworkdayjobs.com/en-US/External_Careers/job/1">x</a>
    <a href="https://job-boards.greenhouse.io/other">x</a>`;
  assert.deepEqual(detectFromHtml(page), [
    { method: 'greenhouse', slug: 'acmeco' },
    { method: 'greenhouse', slug: 'other' },
    { method: 'lever', slug: 'acme-inc' },
    { method: 'ashby', slug: 'Acme Co' },
    { method: 'smartrecruiters', slug: 'AcmeCo1' },
    { method: 'workday', slug: 'acme/wd1/External_Careers' },
  ]);
  assert.deepEqual(detectFromHtml('<p>no board here</p>', 'https://acme.com/careers'), []);
  assert.deepEqual(detectFromHtml('', 'https://job-boards.greenhouse.io/acme'), [{ method: 'greenhouse', slug: 'acme' }]);
});

test('greenhouse guesses are accepted only when the board name matches', async () => {
  setFetch(router([
    ['https://boards-api.greenhouse.io/v1/boards/point', () => json({ name: 'Point Blank Studios' })],
    ['https://boards-api.greenhouse.io/v1/boards/cherre', () => json({ name: 'Cherre' })],
    ['https://boards-api.greenhouse.io/v1/boards/zillowgroup', () => json({ name: 'Zillow' })],
  ]));
  assert.deepEqual(await guessGreenhouse({ slug: 'zillow-group', name: 'Zillow Group' }), { method: 'greenhouse', slug: 'zillowgroup' });
  assert.deepEqual(slugGuesses({ slug: 'flock-homes', name: 'Flock Homes' }), ['flockhomes', 'flock-homes', 'flock']);
  assert.equal(await guessGreenhouse({ slug: 'point', name: 'Point' }), null);
  assert.deepEqual(await guessGreenhouse({ slug: 'cherre', name: 'Cherre' }), { method: 'greenhouse', slug: 'cherre' });
});
