public/index.html     the site (OpCo + PropTech hubs). Deployed to GitHub Pages.
public/jobs.json      the job feed. run.js writes it, the Action commits it.
db/                   optional SQL, if you ever move to a real database
config.js             scrape targets for run.js
scripts/detect-ats.mjs works out which ATS each careers page runs on
run.js                your scraper — copy it into the repo root
.github/workflows/    scrape on a schedule, deploy on push
