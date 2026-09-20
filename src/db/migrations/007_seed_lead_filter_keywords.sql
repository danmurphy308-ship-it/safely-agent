-- Migration 007: seed the configurable pre-score lead filters.
-- Two settings rows hold JSON arrays of bad-fit keywords, editable from the
-- Settings page (Lead Filters). processLead checks a lead's company name and
-- contact title against them (case-insensitive substring) BEFORE scoring —
-- matches are deprioritised without spending a Claude call. Re-runnable.

INSERT INTO settings (key, value) VALUES
  ('filter_company_keywords',
   '["marine","shipping","yacht","vessel","maritime","logistics","courier","haulage","freight","trucking","taxi","chauffeur","removals"]'),
  ('filter_title_keywords',
   '["marine","vessel","shipping","warehouse"]')
ON CONFLICT (key) DO NOTHING;
