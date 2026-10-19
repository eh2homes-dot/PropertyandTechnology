# PropertyandTechnology

The Property + Technology site (`index.html`) and the scraper that feeds the
OpCo and PropTech job boards.

## Job boards

Everything lives in the Airtable base **Syndeo Job Search (Trial)**:

| Table          | What it holds                                                          |
| -------------- | ---------------------------------------------------------------------- |
| Companies      | The lead list. `ATS` + `ATS Slug` say where each company posts jobs.   |
| Job Postings   | One row per posting: First Seen, Last Seen, Status, Closed At.         |
| Scrape Runs    | One row per run, with counts and every board that failed.              |

A GitHub Action (`.github/workflows/scrape.yml`) runs twice a day:

1. `scripts/detect-ats.mjs` looks at the careers page of each company with no
   ATS, finds its Greenhouse, Lever, Ashby, SmartRecruiters or Workday board,
   confirms the board answers, and writes `ATS` + `ATS Slug`.
2. `run.js` reads every board and reconciles it with Job Postings: new
   postings are created, ones still listed get a fresh Last Seen, and ones
   that have left the board are marked `closed` with a Closed At date.

### Spotting lapsed boards and leads

- **Job Postings, Status = closed**: the posting came down. Closed At is when.
- **Companies, Scrape Status starting `error:`**: the board stopped answering.
  `HTTP 404` usually means the company moved ATS, was acquired, or shut down.
- **Companies, Scrape Status `pending: careers page HTTP 404`**: the careers
  page itself is gone. The lead needs checking.
- **Companies, Scrape Status `ok: board is empty`**: the board works but lists
  nothing. A long run of these is worth a look.
- **Companies, Last Scraped** older than a day: the Action isn't running.

A board that errors never has its postings closed, and a board with more than
`MAX_JOBS_PER_COMPANY` postings (default 250) is truncated and never closes
anything either. Postings without a Job Key were entered by hand and are left
alone.

### Setup

1. In Airtable, create a personal access token with scopes
   `data.records:read` and `data.records:write`, limited to the
   *Syndeo Job Search (Trial)* base.
2. In this repo on GitHub: **Settings → Secrets and variables → Actions**, add
   the secret `AIRTABLE_TOKEN`. To use a different base, add the variable
   `AIRTABLE_BASE_ID`.
3. **Actions → Scrape jobs → Run workflow** with *dry* ticked to check the
   output, then once without it.

Airtable's free plan caps a base at 1,000 records. With 100+ companies the
Job Postings table will pass that, so the base needs a paid plan, or a lower
`MAX_JOBS_PER_COMPANY` (a repo variable).

### Running locally

```sh
npm test                                            # offline, no token needed
AIRTABLE_TOKEN=... node scripts/detect-ats.mjs --dry
AIRTABLE_TOKEN=... node run.js --only=appfolio --dry
```

To set a company's ATS by hand, fill in `ATS` (`greenhouse`, `lever`,
`ashby`, `smartrecruiters` or `workday`) and `ATS Slug` on its Companies row.
A Workday slug is `tenant/wdN/site`, taken from the board URL
`https://tenant.wdN.myworkdayjobs.com/site`.
