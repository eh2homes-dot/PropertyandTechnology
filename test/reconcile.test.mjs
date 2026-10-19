import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, inferFunction, dedupeBoards, jobKey } from '../lib/reconcile.mjs';

const company = { id: 'recCo', slug: 'acme', method: 'greenhouse' };
const NOW = '2026-10-19T12:00:00.000Z';
const job = (id, title = `Job ${id}`) => ({ id, title, location: 'Remote', url: `https://g/${id}` });

test('new postings are created open, linked to the company and run', () => {
  const r = reconcile({ company, scrape: { jobs: [job('1', 'Senior Software Engineer')], truncated: false }, existing: [], now: NOW, runId: 'recRun' });
  assert.equal(r.opened, 1);
  assert.deepEqual(r.creates[0], {
    Title: 'Senior Software Engineer', Location: 'Remote', URL: 'https://g/1', Status: 'open',
    'Last Seen': NOW, 'Link Verified': true, 'Job Key': 'acme:greenhouse:1', Company: ['recCo'],
    Function: 'Engineering', 'First Seen': NOW, Run: ['recRun'],
  });
});

test('postings still listed are refreshed; closed ones that return are reopened', () => {
  const existing = [
    { id: 'rec1', key: jobKey('acme', 'greenhouse', '1'), status: 'open' },
    { id: 'rec2', key: jobKey('acme', 'greenhouse', '2'), status: 'closed' },
  ];
  const r = reconcile({ company, scrape: { jobs: [job('1'), job('2')], truncated: false }, existing, now: NOW });
  assert.equal(r.creates.length, 0);
  assert.equal(r.reopened, 1);
  assert.equal(r.closed, 0);
  for (const u of r.updates) {
    assert.equal(u.fields.Status, 'open');
    assert.equal(u.fields['Last Seen'], NOW);
    assert.equal(u.fields['Closed At'], null);
  }
});

test('open postings that left a full board are closed; already-closed ones are untouched', () => {
  const existing = [
    { id: 'rec1', key: jobKey('acme', 'greenhouse', '1'), status: 'open' },
    { id: 'rec9', key: jobKey('acme', 'greenhouse', '9'), status: 'open' },
    { id: 'rec8', key: jobKey('acme', 'greenhouse', '8'), status: 'closed' },
  ];
  const r = reconcile({ company, scrape: { jobs: [job('1')], truncated: false }, existing, now: NOW });
  assert.equal(r.closed, 1);
  assert.deepEqual(r.updates.find(u => u.id === 'rec9').fields, { Status: 'closed', 'Closed At': NOW });
  assert.equal(r.updates.find(u => u.id === 'rec8'), undefined);
});

test('a truncated board never closes anything', () => {
  const existing = [{ id: 'rec9', key: jobKey('acme', 'greenhouse', '9'), status: 'open' }];
  const r = reconcile({ company, scrape: { jobs: [job('1')], truncated: true }, existing, now: NOW });
  assert.equal(r.closed, 0);
  assert.equal(r.updates.length, 0);
});

test('duplicate and malformed jobs from the ATS are collapsed or skipped', () => {
  const r = reconcile({ company, scrape: { jobs: [job('1'), job('1'), { id: '', title: 'x' }, { id: '3' }], truncated: false }, existing: [], now: NOW });
  assert.equal(r.creates.length, 1);
  assert.equal(r.seen, 1);
});

test('inferFunction maps titles onto the four board functions', () => {
  assert.equal(inferFunction('VP of Sales'), 'Executive');
  assert.equal(inferFunction('Chief Technology Officer'), 'Executive');
  assert.equal(inferFunction('Senior Account Executive'), 'Sales');
  assert.equal(inferFunction('Staff Software Engineer, Payments'), 'Engineering');
  assert.equal(inferFunction('Customer Success Manager'), 'GTM');
  assert.equal(inferFunction('Product Marketing Lead'), 'GTM');
  assert.equal(inferFunction('Community Manager'), null);
  assert.equal(inferFunction('Leasing Consultant'), null);
});

test('companies on the same board are scraped once, by the parent', () => {
  const parent = { slug: 'realtorcom', method: 'workday', atsSlug: 'move/wd1/Careers', parent: null };
  const child = { slug: 'avail', method: 'workday', atsSlug: 'move/wd1/Careers', parent: 'realtorcom' };
  const solo = { slug: 'zillow', method: 'workday', atsSlug: 'zillow/wd5/Zillow', parent: null };
  const { scrape, shared } = dedupeBoards([child, parent, solo]);
  assert.deepEqual(scrape, [parent, solo]);
  assert.deepEqual(shared, [{ company: child, sharesWith: parent }]);
});
