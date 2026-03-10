# Changelog

## 2026-03-09

- hardened runtime configuration by moving internal access, Supabase, SearXNG, and billing settings onto env-driven config
- added customer vs bot request lanes, in-memory response caching, inflight dedupe, and telemetry headers for `/api/research`
- removed Brave from default engine mixes and added source ranking/diversity policy for stronger result quality
- converted tests to app-level execution and added foundation coverage for lanes, cache/dedupe, and source policy
- fixed the startup guard so PM2 launches the API normally while tests still skip `app.listen()`
- added a dedicated `compliance` intent so permit, license, and regulation queries stop misrouting into troubleshooting
- taught the API to honor explicit `mode: compliance` and `mode: technical` so caller intent wins over ambiguous classifier output
- added a forward Supabase migration for `sym_search_analytics` for future remote mirroring when DB admin access is available
- added durable local analytics persistence with daily JSONL rotation so `/api/analytics` survives PM2 restarts even when Supabase mirroring is unavailable
- moved ad-hoc env backups out of the live repo path and ignored future `.env.*` files so secret snapshots stop showing up as loose files in deployments
