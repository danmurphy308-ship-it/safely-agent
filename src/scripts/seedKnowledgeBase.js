//// Seeds the knowledge_base table with product content the drafting and
// scoring prompts read from: product description, key stats, case studies,
// and value props per segment.
//
// The entries below are placeholders. The real content is internal sales
// collateral and is not published in this repository — swap in your own.
//
// Idempotent — re-running deletes the rows it previously seeded (matched by
// title) and re-inserts them, so it won't create duplicates and won't touch
// manually-added entries.
//
// Run with:
//   node src/scripts/seedKnowledgeBase.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const db = require('../config/db');

// category: product | case_study | value_prop | pain_point | competitor
// vertical: fleet | broker | underwriter | general
const ENTRIES = [
  {
    title: 'Product Overview',
    category: 'product',
    vertical: 'general',
    content: `A fleet safety product. It helps organisations that operate vehicle fleets reduce accidents, insurance costs, and risk through telematics, driver behaviour monitoring, and safety reporting.

Built for service companies that use vehicles as a tool to deliver their core service — utilities, telecoms, construction, facilities management, healthcare, local government, and security — typically operating 100+ vehicles.

Replace this entry with your own product description.`,
  },
  {
    title: 'Key Performance Stats',
    category: 'value_prop',
    vertical: 'general',
    content: `Verified outcomes (use only these figures — never fabricate numbers):
- <incident reduction rate>
- <reduction in crashes>
- <reduction in insurance premiums>
- <reduction in fuel consumption>
- <reduction in maintenance costs>

Replace these placeholders with your own verified figures. The "never
fabricate" instruction matters: the drafting prompt reads this entry
directly, so anything added here can appear in outbound email.`,
  },
  {
    title: 'Case Study — Example Sector',
    category: 'case_study',
    vertical: 'fleet',
    content: `A 1,000+ vehicle infrastructure services company reduced fleet accidents substantially after implementation.

This is a strong reference for large service-company fleets (construction,
utilities, infrastructure) weighing the safety and cost impact of telematics
and driver behaviour monitoring.

Replace with your own case study. Keep the "strong reference for" line:
drafter.js matches case studies to a prospect's industry using it.`,
  },
  {
    title: 'Value Proposition — Fleet Operators',
    category: 'value_prop',
    vertical: 'fleet',
    content: `For fleet operators (Fleet Managers, Transport Managers, Heads of Operations, Operations Directors, Facilities Managers, Health & Safety Managers, COOs):

Reduces accidents and the cost that follows them. Driver behaviour monitoring
and automated safety reporting give operations and H&S leaders early
visibility of risk and a defensible duty-of-care record.

Replace with your own positioning for this segment.`,
  },
  {
    title: 'Value Proposition — Insurance Brokers',
    category: 'value_prop',
    vertical: 'broker',
    content: `For insurance brokers placing fleet risk:

Improves the risk profile of the fleets you place, making them easier to
underwrite and cheaper to insure through measurable safety improvement.
Telematics and driver behaviour data give you evidence to negotiate better
terms, win and retain fleet clients, and differentiate beyond price.

Replace with your own positioning for this segment.`,
  },
  {
    title: 'Value Proposition — Underwriters',
    category: 'value_prop',
    vertical: 'underwriter',
    content: `For underwriters pricing fleet risk:

Drives real reductions in claims frequency and severity. Continuous
telematics and driver behaviour data support better risk selection, pricing
accuracy, and portfolio monitoring.

Replace with your own positioning for this segment.`,
  },
];
