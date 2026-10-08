# ADR-0007: Bounded, chunked history retrieval

Status: Accepted (2026-10-08)
Date: 2026-10-08

## Context

`getroommeasure` and `getmeasure` return at most 1024 points per
request. With `optimize=true`, responses are segments that break at data
gaps. The per-user limits are 50 requests per 10 s and 500 per hour. The
per-app burst limit for single-user apps is unclear. LLM context is
expensive: a year of 30-minute data is 17,520 points.

## Decision

- Ranges are split into windows of `1024 × step` and fetched
  **sequentially** through the rate limiter.
- There is a hard cap of **8 requests per tool call**. Beyond that, the
  tool returns an error that suggests a coarser scale. Data is never
  silently truncated.
- `scale: "auto"` selects the finest scale that fits the request in one
  call where possible.
- Points are deduplicated by timestamp and sorted ascending. Gaps are
  reported and never filled. Interpolation is not offered in v0.1.
- There are three output modes: `summary`, `aggregated` (default,
  48 buckets with min/mean/max) and `detailed` (200 raw points by
  default). `max_points` can raise either to a hard maximum of 1000, and
  a `truncated` flag marks cut output. The defaults were lowered during
  implementation (Phase 4): 48 buckets covers a week at 3.5 h
  resolution, enough for most questions, and keeps a response to a few
  thousand tokens.
- Fully past windows are cached in memory for 1 h. _(Not implemented
  in v0.1. Topology and status caches exist; measure caching is
  deferred until usage shows it is needed.)_
- Client-side limiter defaults: 40 requests per 10 s and 400 per hour
  (80 % of the per-user limits), configurable. They are revisited after
  live testing of the per-app limit.

## Consequences

- No single tool call can exhaust the hourly quota.
- Long ranges at fine resolution need either a coarser scale or several
  calls. Both the tool description and the error message say so.
- Responses stay small enough for routine use in an assistant
  conversation.
