import type { ChangeReason, ToolCardDiff } from "./types.js";

const REASON_LABEL: Record<ChangeReason, string> = {
  "card-version-changed": "Card schema version changed",
  "tool-version-changed": "Tool version changed",
  "tool-description-changed": "Tool description changed",
  "mcp-server-uri-changed": "MCP server URI changed",
  "side-effect-class-escalated": "Side-effect class escalated",
  "side-effect-class-relaxed": "Side-effect class relaxed",
  "reversible-flipped-false": "Reversible flipped to false",
  "reversible-flipped-true": "Reversible flipped to true",
  "rate-limit-removed": "Rate limit removed",
  "rate-limit-added": "Rate limit added",
  "pii-exposure-escalated": "PII exposure escalated",
  "pii-exposure-relaxed": "PII exposure relaxed",
  "secrets-exposure-escalated": "Secrets exposure escalated",
  "secrets-exposure-relaxed": "Secrets exposure relaxed",
  "human-approval-removed": "Human approval requirement removed",
  "human-approval-added": "Human approval requirement added",
  "external-system-added": "External system added",
  "external-system-removed": "External system removed",
  "refusal-mode-added": "Refusal mode added",
  "refusal-mode-removed": "Refusal mode removed",
  "input-schema-changed": "Input schema changed",
  "output-schema-changed": "Output schema changed",
  "tested-with-provider-removed": "Tested-with model/eval removed",
  "tested-with-entry-added": "Tested-with model/eval added",
  "tested-with-newly-failing": "Tested-with newly failing",
  "tested-with-evidence-changed": "Tested-with evidence changed",
  "audit-log-location-added": "Audit log location added",
  "audit-log-location-removed": "Audit log location removed",
  "audit-retention-reduced": "Audit retention window reduced"
};

function tableCell(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\\", "&#92;").replaceAll("!", "&#33;")
    .replaceAll("[", "&#91;").replaceAll("]", "&#93;")
    .replaceAll("`", "&#96;").replaceAll("*", "&#42;")
    .replaceAll("_", "&#95;").replaceAll("~", "&#126;")
    .replaceAll("@", "&#64;").replaceAll("|", "&#124;")
    .replace(/[\r\n]+/gu, " ");
}

export function toMarkdown(diff: ToolCardDiff): string {
  if (diff.changes.length === 0) return `**No changes.** Tool cards are equivalent.`;
  const lines: string[] = [];
  lines.push(diff.breaking ? `## MCP Tool Card diff (**BREAKING**)` : `## MCP Tool Card diff`);
  lines.push(``);
  lines.push(`| change | detail |`);
  lines.push(`|---|---|`);
  for (const c of diff.changes) {
    lines.push(`| ${tableCell(REASON_LABEL[c.reason] ?? c.reason)} | ${tableCell(c.detail ?? "")} |`);
  }
  return lines.join("\n");
}

export function toSummary(diff: ToolCardDiff): string {
  if (diff.changes.length === 0) return "no changes";
  return `${diff.breaking ? "BREAKING " : ""}${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"}`;
}
