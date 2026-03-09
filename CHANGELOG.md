# Changelog

## 2026-03-09

- hardened runtime configuration by moving internal access, Supabase, SearXNG, and billing settings onto env-driven config
- added customer vs bot request lanes, in-memory response caching, inflight dedupe, and telemetry headers for `/api/research`
- removed Brave from default engine mixes and added source ranking/diversity policy for stronger result quality
- converted tests to app-level execution and added foundation coverage for lanes, cache/dedupe, and source policy
