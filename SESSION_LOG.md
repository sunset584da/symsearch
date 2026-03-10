# Session Log

## 2026-03-09

- verified the live SymSearch stack on `46.225.28.233` and confirmed the real backend is `/root/clawd/sym-research-api`
- copied the live repo locally to `C:\Users\jdani\symsearch` for versioned work instead of VPS-only edits
- implemented the first platform hardening pass: env config, lane policy, cache/dedupe, source policy, telemetry, and in-repo tests
- fixed the PM2 startup regression by replacing the import-meta startup guard with `SYMSEARCH_SKIP_LISTEN`
- fixed live intent routing for permit and license queries by adding an explicit `compliance` intent across classifier, lane policy, and source scoring
- fixed the API/router mismatch by honoring explicit request mode for compliance and technical flows
- added the forward Supabase schema migration for `sym_search_analytics`, but stopped blocking on dead admin SQL paths
- switched SymSearch analytics to durable local JSONL persistence so search history and `/api/analytics` survive PM2 restarts on the VPS today
- cleaned up live secret hygiene by moving the stray `.env.bak-20260309` out of `/root/clawd/sym-research-api` and ignoring future `.env.*` repo clutter
