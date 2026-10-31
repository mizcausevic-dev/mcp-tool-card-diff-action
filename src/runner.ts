import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { diffToolCards } from "./diff.js";
import { toMarkdown } from "./format.js";
import type { ToolCard, ToolCardDiff } from "./types.js";

export interface RunnerEnv {
  inputs: Record<string, string | undefined>;
  GITHUB_OUTPUT?: string;
  GITHUB_EVENT_NAME?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_EVENT_PATH?: string;
  GITHUB_WORKSPACE?: string;
  /** Read a file from disk (current HEAD). Defaults to fs.readFileSync. */
  readFile?: (path: string) => string;
  /** Predicate: does this path exist on disk? Defaults to fs.existsSync. */
  exists?: (path: string) => boolean;
  /**
   * Retrieve a file at a given git commit. Returns the file content if the
   * file existed at that commit, or `null` if it didn't (newly added file).
   * Defaults to argument-array Git calls. Only a path absent from a verified
   * base commit is treated as a new card; other Git failures stop the gate.
   */
  gitShow?: (sha: string, path: string) => string | null;
  /** Stubbed PR-comment poster for tests. */
  postComment?: (args: { token: string; repo: string; issueNumber: number; body: string }) => Promise<void>;
  /** Output stream (defaults to process.stdout). */
  write?: (line: string) => void;
}

export interface RunnerResult {
  exitCode: 0 | 1;
  diff: ToolCardDiff | null;
  /** True when the card path didn't exist in the base SHA (newly added card). */
  newCard: boolean;
  commentPosted: boolean;
  reason?: string;
}

const NULL_DIFF: ToolCardDiff = {
  changes: [],
  breaking: false,
  added: { externalSystems: [], refusalModes: [], testedProviders: [], auditLogs: [] },
  removed: { externalSystems: [], refusalModes: [], testedProviders: [], auditLogs: [] }
};

function defaultGitShow(sha: string, path: string, cwd?: string): string | null {
  const options = { cwd, encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
  execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], options);
  const paths = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", sha, "--", path], options);
  if (!paths.split("\0").includes(path)) return null;
  return execFileSync("git", ["show", `${sha}:${path}`], options);
}

function validCardPath(path: string): boolean {
  return !path.startsWith("/") && !path.includes("\\") && !path.includes(":") &&
    !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Check fields consumed by the diff; this is not a full Tool Card schema validator. */
function isDiffableToolCard(value: unknown): value is ToolCard {
  if (!isRecord(value) || !isRecord(value.tool) || !isRecord(value.schema) ||
      !isRecord(value.safety) || !isRecord(value.audit)) return false;
  const tool = value.tool;
  const safety = value.safety;
  const audit = value.audit;
  if (typeof value.tool_card_version !== "string" ||
      !["server_id", "name", "version", "mcp_server_uri", "description"].every((key) => typeof tool[key] === "string") ||
      !["read", "mutating", "external", "destructive"].includes(String(safety.side_effect_class)) ||
      !["none", "low", "medium", "high"].includes(String(safety.pii_exposure)) ||
      !["none", "reads_secret_material", "writes_secret_material", "handles_keys"].includes(String(safety.secrets_exposure)) ||
      !["reversible", "rate_limited", "human_approval_required"].every((key) => typeof safety[key] === "boolean")) return false;
  if (safety.external_systems !== undefined && !isStringArray(safety.external_systems)) return false;
  if (safety.refusal_modes !== undefined && !isStringArray(safety.refusal_modes)) return false;
  if (audit.log_locations !== undefined && !isStringArray(audit.log_locations)) return false;
  if (audit.retention_days !== undefined && (typeof audit.retention_days !== "number" || !Number.isFinite(audit.retention_days))) return false;
  return value.tested_with === undefined || (Array.isArray(value.tested_with) && value.tested_with.every(isRecord));
}

function cardFileWithinWorkspace(path: string, workspace: string): boolean {
  const root = realpathSync(workspace);
  const file = resolve(root, path);
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) return false;
  const relativePath = relative(root, realpathSync(file));
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith("../") &&
    !relativePath.startsWith("..\\") && !isAbsolute(relativePath);
}

export async function run(env: RunnerEnv): Promise<RunnerResult> {
  const cardPath = required(env.inputs, "card_path");
  const baseShaInput = env.inputs.base_sha ?? "";
  const commentOnPr = env.inputs.comment_on_pr ?? "auto";
  const failOnBreaking = (env.inputs.fail_on_breaking ?? "true").toLowerCase() !== "false";
  const failOnAnyChange = (env.inputs.fail_on_any_change ?? "false").toLowerCase() === "true";
  const token = env.inputs.github_token ?? "";

  const read = env.readFile ?? ((p) => readFileSync(p, "utf8"));
  const exists = env.exists ?? ((p) => existsSync(p));
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const cardLocation = env.readFile || env.exists ? cardPath : resolve(workspace, cardPath);
  const gitShow = env.gitShow ?? ((sha: string, path: string) => defaultGitShow(sha, path, env.GITHUB_WORKSPACE));
  const write = env.write ?? ((line) => process.stdout.write(`${line}\n`));

  if (!validCardPath(cardPath)) {
    write("::error::card-path must be a relative repository path without traversal or control characters.");
    return { exitCode: 1, diff: null, newCard: false, commentPosted: false, reason: "invalid card-path" };
  }

  if (!exists(cardLocation)) {
    write(`::error::card-path "${cardPath}" does not exist on disk.`);
    return { exitCode: 1, diff: null, newCard: false, commentPosted: false, reason: "card-path not found" };
  }

  if (!env.readFile && !env.exists && !cardFileWithinWorkspace(cardPath, workspace)) {
    write("::error::card-path must resolve to a regular file within the workspace.");
    return { exitCode: 1, diff: null, newCard: false, commentPosted: false, reason: "invalid card file" };
  }

  // Resolve base SHA: explicit input wins, otherwise read from event payload.
  let baseSha = baseShaInput;
  if (!baseSha && env.GITHUB_EVENT_PATH && exists(env.GITHUB_EVENT_PATH)) {
    try {
      const event = JSON.parse(read(env.GITHUB_EVENT_PATH)) as { pull_request?: { base?: { sha?: string } } };
      baseSha = event.pull_request?.base?.sha ?? "";
    } catch {
      // ignore — fall through
    }
  }
  if (!/^[0-9a-f]{40}$/iu.test(baseSha)) {
    write("::error::a full 40-character base commit SHA is required to compare a Tool Card.");
    return { exitCode: 1, diff: null, newCard: false, commentPosted: false, reason: "invalid base SHA" };
  }

  let prev: ToolCard | null = null;
  let prevRaw: string | null = null;
  try {
    prevRaw = gitShow(baseSha, cardPath);
  } catch {
    write("::error::could not read the Tool Card at the base commit; verify checkout history and card-path.");
    return { exitCode: 1, diff: null, newCard: false, commentPosted: false, reason: "base card lookup failed" };
  }
  if (prevRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(prevRaw);
      if (!isDiffableToolCard(parsed)) throw new Error("invalid Tool Card shape");
      prev = parsed;
    } catch {
      write("::error::the Tool Card at the base commit is malformed; comparison cannot be trusted.");
      return { exitCode: 1, diff: null, newCard: false, commentPosted: false, reason: "invalid base card" };
    }
  }

  let next: ToolCard;
  try {
    const parsed: unknown = JSON.parse(read(cardLocation));
    if (!isDiffableToolCard(parsed)) throw new Error("invalid Tool Card shape");
    next = parsed;
  } catch {
    write("::error::the current Tool Card is malformed; comparison cannot be trusted.");
    return { exitCode: 1, diff: null, newCard: false, commentPosted: false, reason: "invalid current card" };
  }

  const newCard = prev === null;
  const diff = newCard ? NULL_DIFF : diffToolCards(prev as ToolCard, next);
  const markdown = newCard
    ? `_New MCP Tool Card at \`${cardPath}\` — no previous version found at base SHA ${baseSha || "(no base SHA)"}._`
    : toMarkdown(diff);

  setOutput(env, "breaking", String(diff.breaking));
  setOutput(env, "change-count", String(diff.changes.length));
  setOutput(env, "new-card", String(newCard));

  write(`\n${markdown}\n`);

  // PR comment is posted whether we have a diff or a new-card notice.
  const isPullRequest = env.GITHUB_EVENT_NAME === "pull_request";
  const wantsComment = commentOnPr === "true" || (commentOnPr === "auto" && isPullRequest);
  let commentPosted = false;
  let reason: string | undefined;

  if (wantsComment) {
    if (!token) {
      reason = "no github-token provided";
    } else if (!env.GITHUB_EVENT_PATH) {
      reason = "no GITHUB_EVENT_PATH";
    } else if (!env.GITHUB_REPOSITORY) {
      reason = "no GITHUB_REPOSITORY";
    } else {
      const event = JSON.parse(read(env.GITHUB_EVENT_PATH)) as { number?: number; pull_request?: { number?: number } };
      const issueNumber = event.number ?? event.pull_request?.number;
      if (!issueNumber) {
        reason = "no PR number in event payload";
      } else {
        const body = `### MCP Tool Card diff — \`${cardPath}\`\n\n${markdown}\n\n_Generated by [mcp-tool-card-diff-action](https://github.com/mizcausevic-dev/mcp-tool-card-diff-action)._`;
        const poster = env.postComment ?? defaultPostComment;
        await poster({ token, repo: env.GITHUB_REPOSITORY, issueNumber, body });
        commentPosted = true;
      }
    }
  }

  if (!newCard && failOnBreaking && diff.breaking) {
    write(`::error::MCP Tool Card diff is BREAKING — ${diff.changes.length} change(s) detected.`);
    return { exitCode: 1, diff, newCard, commentPosted, reason };
  }
  if (!newCard && failOnAnyChange && diff.changes.length > 0) {
    write(`::error::MCP Tool Card has ${diff.changes.length} change(s) and fail-on-any-change=true.`);
    return { exitCode: 1, diff, newCard, commentPosted, reason };
  }

  return { exitCode: 0, diff, newCard, commentPosted, reason };
}

function required(inputs: Record<string, string | undefined>, name: string): string {
  const v = inputs[name];
  if (!v || v.length === 0) throw new Error(`input "${name}" is required`);
  return v;
}

function setOutput(env: RunnerEnv, key: string, value: string): void {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function defaultPostComment(args: { token: string; repo: string; issueNumber: number; body: string }): Promise<void> {
  const r = await fetch(`https://api.github.com/repos/${args.repo}/issues/${args.issueNumber}/comments`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${args.token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({ body: args.body })
  });
  if (!r.ok) throw new Error(`GitHub API comment failed: ${r.status} ${await r.text()}`);
}
