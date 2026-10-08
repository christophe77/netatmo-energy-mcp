# Test fixtures

All fixtures are **synthetic** or **sanitized**. They must never contain real
home IDs, device MAC addresses, room names, coordinates, emails or tokens.

- Hand-written synthetic fixtures use `70:ee:50:00:00:xx` device IDs,
  `0000000000000000000000xx` home IDs and `100000000x` room IDs.
- Output of `netatmo-energy-mcp probe` (`responses.json`) is sanitized with
  `00:00:00:00:xx:xx`, `fa4e…` and `9000000000+` placeholders and generic names
  ("Home 1", "Room 2"). Only ever derive fixtures from `responses.json`, never
  from `responses.raw.json`, and review them before committing.

Fixture field sets follow the live observations of 2026-10-08
(docs/api-capabilities.md §11); the values are invented.
