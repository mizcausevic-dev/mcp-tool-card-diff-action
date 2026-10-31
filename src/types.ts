// Diff two MCP Tool Card documents per
// https://github.com/mizcausevic-dev/mcp-tool-card-spec (v0.1).

export type SideEffectClass = "read" | "mutating" | "external" | "destructive";
export type PiiExposure = "none" | "low" | "medium" | "high";
export type SecretsExposure =
  | "none"
  | "reads_secret_material"
  | "writes_secret_material"
  | "handles_keys";

export interface ToolCardSafety {
  side_effect_class: SideEffectClass;
  external_systems?: string[];
  reversible: boolean;
  rate_limited: boolean;
  pii_exposure: PiiExposure;
  secrets_exposure: SecretsExposure;
  human_approval_required: boolean;
  refusal_modes?: string[];
}

export interface ToolCardPerformance {
  p50_latency_ms?: number;
  p99_latency_ms?: number;
  measurement_window?: string;
  /** Legacy disclosure field retained for existing callers. */
  p95_latency_ms?: number;
  max_concurrency?: number;
}

export interface ToolCardCost {
  per_call_amount?: number;
  per_call_currency?: string;
  notes?: string;
  /** Legacy disclosure fields retained for existing callers. */
  pricing_model?: string;
  per_call_cost_usd?: number;
  monthly_budget_usd?: number;
}

/** Published mcp-tool-card-spec v0.1 tested-with entry. */
export interface ToolCardTestResult {
  llm: string;
  provider?: string;
  test_suite_uri: string;
  pass_rate: number;
  tested_at: string;
  sample_size?: number;
}

/** Legacy entry supported while existing callers migrate to the spec. */
export interface LegacyToolCardTestResult {
  provider: string;
  model: string;
  passed: boolean;
}

export interface ToolCard {
  tool_card_version: string;
  tool: {
    server_id: string;
    name: string;
    version: string;
    mcp_server_uri: string;
    description: string;
  };
  schema: {
    input_schema_uri?: string;
    input_schema_inline?: Record<string, unknown>;
    output_schema_uri?: string;
    output_schema_inline?: Record<string, unknown>;
  };
  safety: ToolCardSafety;
  tested_with?: Array<ToolCardTestResult | LegacyToolCardTestResult>;
  performance?: ToolCardPerformance;
  cost?: ToolCardCost;
  audit: { log_uri?: string; log_locations?: string[]; retention_days?: number; signed_by?: string; incident_response_uri?: string };
}

export type ChangeReason =
  | "card-version-changed"
  | "tool-version-changed"
  | "tool-description-changed"
  | "mcp-server-uri-changed"
  | "side-effect-class-escalated"
  | "side-effect-class-relaxed"
  | "reversible-flipped-false"
  | "reversible-flipped-true"
  | "rate-limit-removed"
  | "rate-limit-added"
  | "pii-exposure-escalated"
  | "pii-exposure-relaxed"
  | "secrets-exposure-escalated"
  | "secrets-exposure-relaxed"
  | "human-approval-removed"
  | "human-approval-added"
  | "external-system-added"
  | "external-system-removed"
  | "refusal-mode-added"
  | "refusal-mode-removed"
  | "input-schema-changed"
  | "output-schema-changed"
  | "tested-with-provider-removed"
  | "tested-with-entry-added"
  | "tested-with-newly-failing"
  | "tested-with-evidence-changed"
  | "audit-log-location-added"
  | "audit-log-location-removed"
  | "audit-retention-reduced";

/**
 * Reasons that invalidate a downstream operator's prior trust assumptions —
 * a procurement / security reviewer needs to re-approve before consumers ship.
 */
export const BREAKING_REASONS: ReadonlySet<ChangeReason> = new Set([
  "side-effect-class-escalated",
  "reversible-flipped-false",
  "rate-limit-removed",
  "pii-exposure-escalated",
  "secrets-exposure-escalated",
  "human-approval-removed",
  "external-system-added",
  "refusal-mode-removed",
  "input-schema-changed",
  "tested-with-provider-removed",
  "tested-with-newly-failing",
  "audit-log-location-removed",
  "audit-retention-reduced"
]);

export interface DiffEntry {
  reason: ChangeReason;
  detail?: string;
}

export interface ToolCardDiff {
  changes: DiffEntry[];
  breaking: boolean;
  added: { externalSystems: string[]; refusalModes: string[]; testedProviders: string[]; auditLogs: string[] };
  removed: { externalSystems: string[]; refusalModes: string[]; testedProviders: string[]; auditLogs: string[] };
}

export interface DiffOptions {
  /** When true, also flag non-breaking changes as failures (CI gate). */
  strict?: boolean;
}
