# Safely Agent

A multi-channel AI sales development system: it sources prospects, researches and scores them, runs outbound sequences across email, LinkedIn and video, tracks replies, and surfaces a ranked call list to the sales team.

Built during a 2026 internship at Transpoco, a fleet telematics company, and published here with the company's permission. This is a sanitised version: all credentials are removed and no real customer or prospect data appears in this repository.

## The problem

The sales team was working prospects in roughly the order they came out of a list. Cold call to booked demo conversion sat around 8%. The list was not the bottleneck, the ordering was. Nobody knew which prospects were worth calling first, so reps spent their best hours on companies that were never going to buy.

## What it does

1. **Source.** Pulls prospects from Clay and Apollo, with configurable per-campaign search criteria and automatic replenishment when a campaign runs low.
2. **Filter.** Screens against a blacklist, an existing-customer check and a configurable keyword filter, so the pipeline does not spend enrichment budget on records that were never viable.
3. **Verify.** Validates email addresses before anything is sent, to protect sender reputation.
4. **Score.** Sends each lead to Claude against a written ideal customer profile, returning a structured verdict: a 0-100 fit score, a segment classification, a recommendation and a self-assessed data quality rating.
5. **Sequence.** Runs outbound across several channels: email cadences through Instantly, LinkedIn through Aimfox, HeyReach and La Growth Machine, and personalised video through HeyGen.
6. **Handle replies.** Ingests reply webhooks, classifies them, and drafts suggested responses for the rep to review.
7. **Surface.** A React dashboard with a ranked call list, campaign health, funnel view and per-lead detail. Results sync to HubSpot.

Roughly 4,000 prospects were processed across seven live campaigns in the UK, Ireland and the US.

## Stack

Node.js and Express, Postgres with row-level security, React with Vite and Tailwind, Claude API. Eight external integrations: Clay, Apollo, Instantly, Aimfox, HeyReach, La Growth Machine, HeyGen, HubSpot. Deployed on Fly.io via Docker.

## Structure

```
src/
  integrations/   one module per external API
  pipeline/       lead sourcing and CSV import
  services/       scoring, drafting, filtering, verification, cadence
  jobs/           background workers (processing, replenishment, sequencing, polling)
  routes/         REST API
  db/             schema and 22 migrations
client/           React dashboard
```

## The interesting part: what "good fit" actually means

The scoring model is a Claude call against a written ideal customer profile, returning a structured verdict per lead. The hard part was not the code. It was working out what the rubric should say.

The obvious version scored on the things any B2B tool scores on: company size, job seniority, geography, industry. That version kept ranking prospects highly that the sales team never closed, and the pattern took a while to see. Large fleet, senior fleet title, right country, and still dead.

The distinction that actually mattered turned out to be whose goods are on the vehicle. A company that delivers its own products runs vehicles as a tool of its trade, and safety and insurance cost are its problem. A company paid to move other people's freight is in a different business with different buying logic, even though the two look almost identical on paper: same fleet size, same job titles, same industry codes.

So the rubric draws that line explicitly, and treats it as decisive enough to override otherwise strong signals. Getting there meant going back through which accounts had actually closed, rather than reasoning forward from what a good prospect ought to look like.

## Result

Cold call to demo conversion moved from 8% to 20% on a UK fleet campaign over the period the system was in use. That figure comes from the sales team's own pipeline reporting rather than the system's internal metrics, and it reflects the ranking and the outbound sequencing together rather than the scoring model in isolation.

## Engineering notes

- **Prompt caching.** The scoring system prompt is long and identical on every call, so it is sent as a cached block with the per-lead data in the user turn, keeping the cache prefix reusable across thousands of leads. It also means the system prompt has to stay byte-for-byte stable, so nothing dynamic can be interpolated into it.
- **Malformed model output.** Asking for raw JSON mostly works and occasionally does not. The parser tolerates an accidental code fence, validates that the score is a number in range, and throws with the offending response attached rather than passing a malformed record downstream.
- **Deliberately narrow prompt input.** Only the fields relevant to scoring are sent to the model, in a fixed key order. That keeps volatile or irrelevant lead data out of the prompt and keeps the input stable between runs.
- **Missing data is not a low score.** Enrichment frequently comes back incomplete. The rubric distinguishes between a bad signal and an absent one, and pulls uncertain leads toward the middle of the range instead of discarding them.
- **State across async providers.** Leads move through several external systems that report progress by webhook on their own schedule. Reconciling that into one consistent lead status needed background jobs and several corrective migrations.

## Running it

```
cp .env.example .env    # fill in your own API keys
npm install
npm run db:init         # create the schema
npm start               # api only
npm run dev             # api and dashboard together
```

Each integration has a standalone test script, so a single provider can be checked without running the whole pipeline:

```
npm run test:scorer
npm run test:apollo
npm run test:clay-search
```

## What I would do differently

The rubric is written prose evaluated by a model, which makes it easy to change and hard to measure. There is no held-out set, no regression test on scoring changes, and no way to tell whether an edit to the prompt improved things or just moved them. I would build that harness first next time: freeze a set of leads with known outcomes, and re-score against it every time the rubric changes.

Eight integrations is a lot of surface area for one system. Several were added because a channel seemed worth testing, and with hindsight I would have proven a channel converted before building a full integration for it.
