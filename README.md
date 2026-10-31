# mcp-tool-card-diff-action

[![CI](https://github.com/mizcausevic-dev/mcp-tool-card-diff-action/actions/workflows/ci.yml/badge.svg)](https://github.com/mizcausevic-dev/mcp-tool-card-diff-action/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](LICENSE)

GitHub Action that **gates PRs touching an MCP Tool Card**. Retrieves the previous version of the tool card via `git show <base.sha>:<card-path>`, diffs against HEAD via [`mcp-tool-card-diff`](https://github.com/mizcausevic-dev/mcp-tool-card-diff), posts the structured diff as a PR comment, and **fails the build on breaking changes**.

**Second in the per-protocol diff Action quintet** (agent-card / mcp-tool-card / prompt-provenance / evidence-bundle / otel-genai).

Part of the [Kinetic Gain Suite](https://suite.kineticgain.com/).

---

## Usage

```yaml
name: MCP Tool Card gate
on:
  pull_request:
    paths: ["tool-cards/**/*.json"]

jobs:
  mcp-tool-card-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # needed so the Action can `git show base.sha:path`
      - uses: mizcausevic-dev/mcp-tool-card-diff-action@v0.1-shipped
        with:
          card-path: tool-cards/my-tool.json
          fail-on-breaking: true
```

> **Important:** Your `checkout` step must use `fetch-depth: 0` so the Action can resolve the full base commit SHA. If the commit is unavailable, the gate fails; it does not report a false "new card".

## Inputs

| input               | required | default       | description |
|---|---|---|---|
| `card-path`         | ✓        | —             | Path (relative to repo root) to the MCP Tool Card JSON file being changed. |
| `base-sha`          |          | `pull_request.base.sha` | Override with a full 40-character base commit SHA. Required outside a PR event. |
| `comment-on-pr`     |          | `auto`        | `auto` posts only on `pull_request` events. |
| `fail-on-breaking`  |          | `true`        | Fail when the diff is BREAKING. |
| `fail-on-any-change`|          | `false`       | Fail on ANY diff (frozen-card workflow). |
| `github-token`      |          | `${{ github.token }}` | Token used to post the PR comment. |

## Outputs

| output         | description |
|---|---|
| `breaking`     | `true` iff the diff is BREAKING. |
| `change-count` | Number of changes detected. |
| `new-card`     | `true` iff the file didn't exist at base SHA (newly added card). |

## What it detects

Same change reasons as [`mcp-tool-card-diff`](https://github.com/mizcausevic-dev/mcp-tool-card-diff) — breaking reasons include `side-effect-class-escalated`, `pii-exposure-escalated`, `secrets-exposure-escalated`, `human-approval-removed`, `external-system-added`, `refusal-mode-removed`, `input-schema-changed`, `tested-with-provider-removed`, `audit-log-location-removed`, `audit-retention-reduced`, and more.

## How it handles edge cases

- **New card** (file absent from a verified base commit) → no diff, exits 0, sets `new-card=true`.
- **Malformed previous version, missing base commit, or invalid SHA** → fails closed.
- **Invalid or escaping card path** → fails before reading the file.
- **Card-path doesn't exist on disk** → exits 1 with a clear error.
- **Non-PR context** (push, manual dispatch) → skips PR comment; still emits diff to logs.

## Composes with

- [**`mcp-tool-card-diff`**](https://github.com/mizcausevic-dev/mcp-tool-card-diff) — the library this wraps.
- [**`mcp-tool-card-fleet-summary-action`**](https://github.com/mizcausevic-dev/mcp-tool-card-fleet-summary-action) — fleet-level companion (one card vs. fleet across all tool cards).
- [**`mcp-tool-card-stamp`**](https://github.com/mizcausevic-dev/mcp-tool-card-stamp) · [**`mcp-tool-card-readme-generator`**](https://github.com/mizcausevic-dev/mcp-tool-card-readme-generator) — full MCP Tool Card family.
- Sibling diff actions: [**`agent-card-diff-action`**](https://github.com/mizcausevic-dev/agent-card-diff-action) · prompt-provenance-diff-action · evidence-bundle-diff-action · otel-genai-diff-action (forthcoming).

## License

[AGPL-3.0-or-later](LICENSE)
