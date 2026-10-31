import {
  BREAKING_REASONS,
  type ChangeReason,
  type DiffEntry,
  type DiffOptions,
  type PiiExposure,
  type SecretsExposure,
  type SideEffectClass,
  type ToolCard,
  type ToolCardDiff
} from "./types.js";

const SIDE_EFFECT_RANK: Record<SideEffectClass, number> = {
  read: 0,
  mutating: 1,
  external: 2,
  destructive: 3
};
const PII_RANK: Record<PiiExposure, number> = { none: 0, low: 1, medium: 2, high: 3 };
const SECRET_RANK: Record<SecretsExposure, number> = {
  none: 0,
  reads_secret_material: 1,
  writes_secret_material: 2,
  handles_keys: 3
};

function diffSet<T extends string>(prev: T[] | undefined, next: T[] | undefined): { added: T[]; removed: T[] } {
  const a = new Set(prev ?? []);
  const b = new Set(next ?? []);
  return {
    added: [...b].filter((x) => !a.has(x)).sort(),
    removed: [...a].filter((x) => !b.has(x)).sort()
  };
}

function schemaChanged(
  prev: ToolCard["schema"],
  next: ToolCard["schema"],
  key: "input_schema_inline" | "output_schema_inline" | "input_schema_uri" | "output_schema_uri"
): boolean {
  const p = prev[key];
  const n = next[key];
  return JSON.stringify(p ?? null) !== JSON.stringify(n ?? null);
}

interface TestEvidence {
  signature: string;
  passed?: boolean;
}

interface TestResultGroup {
  label: string;
  entries: TestEvidence[];
}

function testedWithMap(entries: ToolCard["tested_with"], side: string): Map<string, TestResultGroup> {
  const result = new Map<string, TestResultGroup>();
  if (entries !== undefined && !Array.isArray(entries)) throw new Error(`${side}.tested_with must be an array`);
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== "object") throw new Error(`${side}.tested_with contains an invalid entry`);
    let key: string;
    let label: string;
    let evidence: TestEvidence;
    if ("llm" in entry) {
      if (typeof entry.llm !== "string" || typeof entry.test_suite_uri !== "string" ||
          typeof entry.tested_at !== "string" || typeof entry.pass_rate !== "number" ||
          !Number.isFinite(entry.pass_rate) || entry.pass_rate < 0 || entry.pass_rate > 1 ||
          (entry.provider !== undefined && typeof entry.provider !== "string") ||
          (entry.sample_size !== undefined && (!Number.isInteger(entry.sample_size) || entry.sample_size < 1))) {
        throw new Error(`${side}.tested_with contains an invalid v0.1 entry`);
      }
      key = JSON.stringify(["v0.1", entry.provider ?? "", entry.llm, entry.test_suite_uri]);
      label = `${entry.provider ? `${entry.provider}/` : ""}${entry.llm} @ ${entry.test_suite_uri}`;
      evidence = { signature: JSON.stringify([entry.pass_rate, entry.tested_at, entry.sample_size ?? null]) };
    } else {
      if (typeof entry.provider !== "string" || typeof entry.model !== "string" || typeof entry.passed !== "boolean") {
        throw new Error(`${side}.tested_with contains an invalid legacy entry`);
      }
      key = JSON.stringify(["legacy", entry.provider, entry.model]);
      label = `${entry.provider}/${entry.model}`;
      evidence = { signature: JSON.stringify([entry.passed]), passed: entry.passed };
    }
    const group = result.get(key) ?? { label, entries: [] };
    group.entries.push(evidence);
    result.set(key, group);
  }
  return result;
}

function unmatchedEvidence(before: TestEvidence[], after: TestEvidence[]): { removed: TestEvidence[]; added: TestEvidence[] } {
  const available = new Map<string, number>();
  for (const entry of after) available.set(entry.signature, (available.get(entry.signature) ?? 0) + 1);
  const removed: TestEvidence[] = [];
  for (const entry of before) {
    const count = available.get(entry.signature) ?? 0;
    if (count > 0) available.set(entry.signature, count - 1);
    else removed.push(entry);
  }
  const added: TestEvidence[] = [];
  for (const entry of after) {
    const count = available.get(entry.signature) ?? 0;
    if (count > 0) {
      added.push(entry);
      available.set(entry.signature, count - 1);
    }
  }
  return { removed, added };
}

function auditLocations(card: ToolCard): string[] {
  return [...(card.audit.log_locations ?? []), ...(card.audit.log_uri ? [card.audit.log_uri] : [])];
}

/** Diff two MCP Tool Card documents and classify each change. */
export function diffToolCards(previous: ToolCard, next: ToolCard, _opts: DiffOptions = {}): ToolCardDiff {
  assertCard(previous, "previous");
  assertCard(next, "next");

  const changes: DiffEntry[] = [];
  const push = (reason: ChangeReason, detail?: string): void => {
    const e: DiffEntry = { reason };
    if (detail !== undefined) e.detail = detail;
    changes.push(e);
  };

  // ─── meta ──────────────────────────────────────────────────────────────
  if (previous.tool_card_version !== next.tool_card_version) {
    push("card-version-changed", `${previous.tool_card_version} → ${next.tool_card_version}`);
  }
  if (previous.tool.version !== next.tool.version) {
    push("tool-version-changed", `${previous.tool.version} → ${next.tool.version}`);
  }
  if (previous.tool.description !== next.tool.description) {
    push("tool-description-changed");
  }
  if (previous.tool.mcp_server_uri !== next.tool.mcp_server_uri) {
    push("mcp-server-uri-changed", `${previous.tool.mcp_server_uri} → ${next.tool.mcp_server_uri}`);
  }

  // ─── safety ────────────────────────────────────────────────────────────
  const sed = SIDE_EFFECT_RANK[next.safety.side_effect_class] - SIDE_EFFECT_RANK[previous.safety.side_effect_class];
  if (sed > 0) push("side-effect-class-escalated", `${previous.safety.side_effect_class} → ${next.safety.side_effect_class}`);
  else if (sed < 0) push("side-effect-class-relaxed", `${previous.safety.side_effect_class} → ${next.safety.side_effect_class}`);

  if (previous.safety.reversible && !next.safety.reversible) push("reversible-flipped-false");
  if (!previous.safety.reversible && next.safety.reversible) push("reversible-flipped-true");

  if (previous.safety.rate_limited && !next.safety.rate_limited) push("rate-limit-removed");
  if (!previous.safety.rate_limited && next.safety.rate_limited) push("rate-limit-added");

  const piiD = PII_RANK[next.safety.pii_exposure] - PII_RANK[previous.safety.pii_exposure];
  if (piiD > 0) push("pii-exposure-escalated", `${previous.safety.pii_exposure} → ${next.safety.pii_exposure}`);
  else if (piiD < 0) push("pii-exposure-relaxed", `${previous.safety.pii_exposure} → ${next.safety.pii_exposure}`);

  const secD = SECRET_RANK[next.safety.secrets_exposure] - SECRET_RANK[previous.safety.secrets_exposure];
  if (secD > 0) push("secrets-exposure-escalated", `${previous.safety.secrets_exposure} → ${next.safety.secrets_exposure}`);
  else if (secD < 0) push("secrets-exposure-relaxed", `${previous.safety.secrets_exposure} → ${next.safety.secrets_exposure}`);

  if (previous.safety.human_approval_required && !next.safety.human_approval_required) push("human-approval-removed");
  if (!previous.safety.human_approval_required && next.safety.human_approval_required) push("human-approval-added");

  // ─── external systems / refusal modes ──────────────────────────────────
  const xs = diffSet(previous.safety.external_systems, next.safety.external_systems);
  for (const s of xs.added) push("external-system-added", s);
  for (const s of xs.removed) push("external-system-removed", s);

  const rm = diffSet(previous.safety.refusal_modes, next.safety.refusal_modes);
  for (const s of rm.added) push("refusal-mode-added", s);
  for (const s of rm.removed) push("refusal-mode-removed", s);

  // ─── schema ────────────────────────────────────────────────────────────
  if (schemaChanged(previous.schema, next.schema, "input_schema_inline") || schemaChanged(previous.schema, next.schema, "input_schema_uri")) {
    push("input-schema-changed");
  }
  if (schemaChanged(previous.schema, next.schema, "output_schema_inline") || schemaChanged(previous.schema, next.schema, "output_schema_uri")) {
    push("output-schema-changed");
  }

  // ─── tested_with ───────────────────────────────────────────────────────
  const prevProviders = testedWithMap(previous.tested_with, "previous");
  const nextProviders = testedWithMap(next.tested_with, "next");
  const testedAdded: string[] = [];
  const testedRemoved: string[] = [];
  for (const key of new Set([...prevProviders.keys(), ...nextProviders.keys()])) {
    const before = prevProviders.get(key);
    const after = nextProviders.get(key);
    const label = before?.label ?? after?.label ?? key;
    const unmatched = unmatchedEvidence(before?.entries ?? [], after?.entries ?? []);
    // Without a run ID, equal-count substitutions are evidence updates. When
    // counts differ, preserve every lost run as a removal rather than pairing
    // it with an unrelated addition and silently weakening the breaking gate.
    const replaced = (before?.entries.length ?? 0) === (after?.entries.length ?? 0)
      ? Math.min(unmatched.removed.length, unmatched.added.length)
      : 0;
    for (let i = 0; i < replaced; i++) {
      const oldEntry = unmatched.removed[i];
      const newEntry = unmatched.added[i];
      if (oldEntry.passed === true && newEntry.passed === false) push("tested-with-newly-failing", label);
      else push("tested-with-evidence-changed", label);
    }
    const removedCount = unmatched.removed.length - replaced;
    if (removedCount > 0) {
      push("tested-with-provider-removed", `${label}${removedCount > 1 ? ` (${removedCount} entries)` : ""}`);
      testedRemoved.push(...Array<string>(removedCount).fill(label));
    }
    const addedCount = unmatched.added.length - replaced;
    if (addedCount > 0) {
      push("tested-with-entry-added", `${label}${addedCount > 1 ? ` (${addedCount} entries)` : ""}`);
      testedAdded.push(...Array<string>(addedCount).fill(label));
    }
  }
  testedAdded.sort();
  testedRemoved.sort();

  // ─── audit ─────────────────────────────────────────────────────────────
  const auditLogs = diffSet(auditLocations(previous), auditLocations(next));
  for (const s of auditLogs.added) push("audit-log-location-added", s);
  for (const s of auditLogs.removed) push("audit-log-location-removed", s);

  if (
    previous.audit?.retention_days !== undefined &&
    next.audit?.retention_days !== undefined &&
    next.audit.retention_days < previous.audit.retention_days
  ) {
    push("audit-retention-reduced", `${previous.audit.retention_days}d → ${next.audit.retention_days}d`);
  }

  const breaking = changes.some((c) => BREAKING_REASONS.has(c.reason));
  return {
    changes,
    breaking,
    added: {
      externalSystems: xs.added,
      refusalModes: rm.added,
      testedProviders: testedAdded,
      auditLogs: auditLogs.added
    },
    removed: {
      externalSystems: xs.removed,
      refusalModes: rm.removed,
      testedProviders: testedRemoved,
      auditLogs: auditLogs.removed
    }
  };
}

function assertCard(card: ToolCard, side: string): void {
  if (!card || typeof card !== "object") throw new Error(`${side} must be a ToolCard object`);
  if (!card.tool) throw new Error(`${side}.tool is required`);
  if (!card.safety) throw new Error(`${side}.safety is required`);
  if (!card.schema) throw new Error(`${side}.schema is required`);
  if (!card.audit) throw new Error(`${side}.audit is required`);
}
