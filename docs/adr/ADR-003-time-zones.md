# ADR-003: Time zone names are canonicalised with Intl before they are stored

- **Status:** Accepted (Phase 2 merged 31 Oct 2026, a185e96).
- **Date:** 2026-10-30
- **Deciders:** Moses Oluwole (owner); drafted by Claude Code during Phase 2.
- **Source design:** `docs/architecture.md` §5 (time zones are IANA names; `timestamptz` stored,
  computed in the location's zone); `docs/phases.md`, Phase 2, Phase 1 follow-ups.

## Context

Tenants and locations carry an IANA time zone, and every slot, reminder and DST rule from
Phase 4 on is computed in it. Phase 1 accepted a zone only when it was spelled exactly as
Postgres's `pg_timezone_names` spells it, which made `europe/london` a validation error and left a
gap: a wrong-case letter inside a segment (`America/New_york`) passed the app's shape test and
died in the database as a raw CHECK violation. Phase 1's reviewer also found that
`Intl.DateTimeFormat(...).resolvedOptions().timeZone` on the pinned Node 24.22.2 (ICU 78.3)
canonicalises to tzdata's _older_ spellings: `Asia/Kolkata` resolves to `Asia/Calcutta`,
`Europe/Kyiv` to `Europe/Kiev`, `America/Argentina/Buenos_Aires` to `America/Buenos_Aires`.
Three plausible "canonical" definitions therefore disagreed: the user's spelling, ICU's, and the
current IANA name.

Moses asked for one documented rule, applied in the domain layer with Intl before saving, so that
wrong case and legacy aliases such as `europe/london` and `GB` are converted or rejected and never
stored as typed.

## Decision

`canonicalTimeZone(input)` in `src/modules/tenancy/domain/time-zone.ts` is the rule, and the
Zod `timeZoneSchema` applies it to every tenant and location input. **Intl canonicalises; a small table then maps ICU's legacy ids to the current IANA names, so the stored value is always the modern name.** In order:

| Input                                                                                                                     | Result                                                                                  | Why                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown to Intl (`Mars/Olympus`, `+01:00`, `London`, blank)                                                               | rejected                                                                                | Not a zone.                                                                                                                                                                               |
| Resolves to UTC (`utc`, `GMT`, `Zulu`, `UCT`, `Etc/UTC`, `Etc/GMT`)                                                       | `UTC`                                                                                   | One spelling for the one zone with no place.                                                                                                                                              |
| Abbreviation zone (`EST`, `MST`, `HST`, `CET`, `MET`, `WET`, `EET`, `EST5EDT`, `CST6CDT`, `MST7MDT`, `PST8PDT`), any case | rejected                                                                                | tzdata 2024b links each to a single city with that fixed offset (`EST` → `America/Panama`, no DST). Someone typing "EST" almost always means US Eastern with DST. They must pick a place. |
| Anything else Intl knows                                                                                                  | the resolved zone, if it is `Area/Location`                                             | `europe/london`, `GB`, `GB-Eire` → `Europe/London`; `America/New_york`, `US/Eastern` → `America/New_York`; `Australia/ACT` → `Australia/Sydney`.                                          |
| Resolves to a fixed-offset zone (`Etc/GMT+1`)                                                                             | rejected                                                                                | Not a place; no DST rules; never what a business means.                                                                                                                                   |
| ICU returned a legacy id (`Asia/Calcutta`, `Europe/Kiev`, `America/Buenos_Aires`, …)                                      | the current IANA name (`Asia/Kolkata`, `Europe/Kyiv`, `America/Argentina/Buenos_Aires`) | `ICU_LEGACY_TO_IANA`, built from what ICU 78.3 returns for the modern names; both spellings of a renamed zone store the modern one.                                                       |

Consequences, stated plainly:

- A typed value is never trusted for its case: the output is always ICU's spelling, mapped to
  the modern name, which closes the `America/New_york` gap completely.
- `ICU_LEGACY_TO_IANA` is the one piece of knowledge Node does not have: the ~20 zones where ICU
  still prefers tzdata's backward-link spelling. The unit test asserts that every mapped target is
  known to Intl and that no stored form is a legacy key; the integration test asserts that the
  stored form of every zone Intl supports exists in `pg_timezone_names`. A newer ICU that renames
  something else fails those tests and gets a new row.
- Within one release the output is deterministic (local, CI and production run the same pinned
  Node); across ICU upgrades stored values stay modern because the mapping is applied after ICU.

The database CHECK `rebook.is_time_zone()` (Area/Location or `UTC`, known to `pg_timezone_names`)
stays as the last line of defence. `tests/integration/tenancy/tenant-input-boundary.test.ts`
proves that the stored form of every zone Intl supports, and of every alias the rule converts, is
accepted by the CHECK, and that every rejected input fails as a typed `ValidationError` before a
transaction opens. Onboarding stores the canonical zone on both the tenant and its default
location.

## Alternatives considered

- **Keep exactly-typed valid names, convert only aliases and wrong case** (the first draft).
  Preserves modern spellings but cannot verify case inside a segment without a reference list
  Node does not have; `America/New_york` would have reached the database. Rejected.
- **Store ICU's canonical id as is** (the first implementation). Correct and simpler, but it
  wrote `Asia/Calcutta` for a business that typed `Asia/Kolkata`, and the spelling would have
  drifted between ICU versions. Replaced by the mapping on Moses's request; the list is small,
  tested in both directions, and only ever grows.
- **Accept abbreviations and convert them** (`EST` → `America/Panama`, as tzdata links them).
  Deterministic but semantically misleading for the one group likely to type them. Rejected.
- **Validate in the database only** (`rebook.is_time_zone`). Would make every bad zone a raw
  SQLSTATE 23514 inside a transaction instead of a field error at the boundary. Rejected.

## Consequences

- Positive: one rule, in one function, with the same answer at every boundary; wrong case and
  aliases are repaired rather than refused; the database CHECK can no longer be reached by valid
  app input; the rule is unit-tested case by case and integration-tested against the catalogue.
- Costs: a hand-maintained mapping table (about 20 rows, test-guarded); abbreviations are
  refused, so the UI offers a `<select>` of stored forms rather than free text.
- Revisit when: Node's ICU switches to current IANA canonical ids (the mapping becomes inert and
  can be dropped), or when Temporal ships and offers a better canonicalisation API.
