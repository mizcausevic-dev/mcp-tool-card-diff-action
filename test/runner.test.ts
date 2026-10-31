import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { run, type RunnerEnv } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const V1 = `${here}/../fixtures/card-v1.json`;
const V2_BREAKING = `${here}/../fixtures/card-v2-breaking.json`;
const V2_NONBREAKING = `${here}/../fixtures/card-v2-nonbreaking.json`;

const V1_CONTENT = readFileSync(V1, "utf8");
const V2_BREAKING_CONTENT = readFileSync(V2_BREAKING, "utf8");
const V2_NONBREAKING_CONTENT = readFileSync(V2_NONBREAKING, "utf8");
const BASE_SHA = "a".repeat(40);
const OVERRIDE_SHA = "b".repeat(40);

function removeTestDir(path: string): void {
  const root = resolve(tmpdir());
  const target = resolve(path);
  if (!target.startsWith(root + "\\") && !target.startsWith(root + "/")) throw new Error("unsafe test cleanup path");
  rmSync(target, { recursive: true, force: true });
}

function makeEnv(opts: {
  cardPath?: string;
  cardContent?: string;
  prevContent?: string | null;
  isPullRequest?: boolean;
  hasToken?: boolean;
  failOnBreaking?: string;
  failOnAnyChange?: string;
  baseSha?: string;
  omitBaseSha?: boolean;
}): RunnerEnv {
  const cardPath = opts.cardPath ?? "tool-cards/my-tool.json";
  const cardContent = opts.cardContent ?? V1_CONTENT;
  const prevContent = opts.prevContent;

  const inputs: Record<string, string | undefined> = {
    card_path: cardPath,
    comment_on_pr: "false"
  };
  if (opts.failOnBreaking !== undefined) inputs.fail_on_breaking = opts.failOnBreaking;
  if (opts.failOnAnyChange !== undefined) inputs.fail_on_any_change = opts.failOnAnyChange;
  if (opts.baseSha !== undefined) inputs.base_sha = opts.baseSha;
  else if (!opts.omitBaseSha && !opts.isPullRequest) inputs.base_sha = BASE_SHA;
  if (opts.hasToken) inputs.github_token = "ghs_test";

  const env: RunnerEnv = {
    inputs,
    readFile: (p) => (p === cardPath ? cardContent : "{}"),
    exists: (p) => p === cardPath,
    gitShow: () => prevContent ?? null,
    write: () => undefined
  };
  if (opts.isPullRequest) {
    env.GITHUB_EVENT_NAME = "pull_request";
    env.GITHUB_REPOSITORY = "x/y";
    env.GITHUB_EVENT_PATH = `${here}/event.json`;
    env.readFile = (p) => {
      if (p === cardPath) return cardContent;
      if (p.endsWith("event.json")) return JSON.stringify({ number: 42, pull_request: { number: 42, base: { sha: BASE_SHA } } });
      return "{}";
    };
    env.exists = (p) => p === cardPath || p.endsWith("event.json");
  }
  return env;
}

describe("runner.run", () => {
  it("exits 1 when diff is breaking and fail-on-breaking is true (default)", async () => {
    const r = await run(makeEnv({ cardContent: V2_BREAKING_CONTENT, prevContent: V1_CONTENT }));
    expect(r.exitCode).toBe(1);
    expect(r.diff?.breaking).toBe(true);
    expect(r.newCard).toBe(false);
  });

  it("exits 0 when diff is non-breaking", async () => {
    const r = await run(makeEnv({ cardContent: V2_NONBREAKING_CONTENT, prevContent: V1_CONTENT }));
    expect(r.exitCode).toBe(0);
    expect(r.diff?.breaking).toBe(false);
  });

  it("exits 0 when fail-on-breaking is false even on breaking diff", async () => {
    const r = await run(makeEnv({ cardContent: V2_BREAKING_CONTENT, prevContent: V1_CONTENT, failOnBreaking: "false" }));
    expect(r.exitCode).toBe(0);
  });

  it("exits 1 when fail-on-any-change is true and any change exists", async () => {
    const r = await run(makeEnv({ cardContent: V2_NONBREAKING_CONTENT, prevContent: V1_CONTENT, failOnAnyChange: "true", failOnBreaking: "false" }));
    expect(r.exitCode).toBe(1);
  });

  it("treats a card absent from a verified base commit as new", async () => {
    const r = await run(makeEnv({ cardContent: V1_CONTENT, prevContent: null }));
    expect(r.exitCode).toBe(0);
    expect(r.newCard).toBe(true);
  });

  it("fails closed when the previous card is malformed", async () => {
    const r = await run(makeEnv({ cardContent: V1_CONTENT, prevContent: "not-json" }));
    expect(r.exitCode).toBe(1);
    expect(r.newCard).toBe(false);
    expect(r.reason).toBe("invalid base card");
  });

  it("does not mistake JSON null at the base commit for a new card", async () => {
    const r = await run(makeEnv({ cardContent: V1_CONTENT, prevContent: "null" }));
    expect(r.exitCode).toBe(1);
    expect(r.newCard).toBe(false);
    expect(r.reason).toBe("invalid base card");
  });

  it("does not pass a newly added card whose JSON is null or lacks safety fields", async () => {
    for (const current of ["null", "{}", JSON.stringify({ tool_card_version: "0.1", tool: {}, schema: {}, safety: {}, audit: {} })]) {
      const r = await run(makeEnv({ cardContent: current, prevContent: null }));
      expect(r.exitCode).toBe(1);
      expect(r.newCard).toBe(false);
      expect(r.reason).toBe("invalid current card");
    }
  });

  it("fails closed when the base SHA is missing or contains command syntax", async () => {
    const missing = await run(makeEnv({ cardContent: V1_CONTENT, omitBaseSha: true }));
    const injected = await run(makeEnv({ cardContent: V1_CONTENT, baseSha: `${BASE_SHA}&echo unsafe` }));
    expect(missing.exitCode).toBe(1);
    expect(injected.exitCode).toBe(1);
    expect(injected.reason).toBe("invalid base SHA");
  });

  it("rejects a card path that could escape the checked-out repository", async () => {
    const env = makeEnv({ cardPath: "../outside.json", cardContent: V1_CONTENT });
    let readAttempted = false;
    env.exists = () => { readAttempted = true; return true; };
    const r = await run(env);
    expect(r.exitCode).toBe(1);
    expect(r.reason).toBe("invalid card-path");
    expect(readAttempted).toBe(false);
  });

  it("rejects a directory as the card input before reading", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kg-tool-card-dir-"));
    try {
      mkdirSync(join(repo, "cards"));
      const result = await run({
        inputs: { card_path: "cards", base_sha: BASE_SHA },
        GITHUB_WORKSPACE: repo,
        write: () => undefined
      });
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe("invalid card file");
    } finally {
      removeTestDir(repo);
    }
  });

  it.skipIf(process.platform === "win32")("rejects a card symlink that points outside the workspace", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kg-tool-card-link-"));
    const outside = mkdtempSync(join(tmpdir(), "kg-tool-card-outside-"));
    try {
      writeFileSync(join(outside, "secret.json"), V1_CONTENT);
      symlinkSync(join(outside, "secret.json"), join(repo, "card.json"));
      const result = await run({
        inputs: { card_path: "card.json", base_sha: BASE_SHA },
        GITHUB_WORKSPACE: repo,
        write: () => undefined
      });
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe("invalid card file");
    } finally {
      removeTestDir(repo);
      removeTestDir(outside);
    }
  });

  it("rejects when card-path input is missing", async () => {
    await expect(run({ inputs: {} })).rejects.toThrow(/card_path/);
  });

  it("exits 1 when card-path doesn't exist on disk", async () => {
    const env: RunnerEnv = {
      inputs: { card_path: "nonexistent.json", comment_on_pr: "false" },
      readFile: () => "{}",
      exists: () => false,
      write: () => undefined
    };
    const r = await run(env);
    expect(r.exitCode).toBe(1);
    expect(r.reason).toBe("card-path not found");
  });

  it("posts a PR comment in pull_request context", async () => {
    const calls: Array<{ body: string }> = [];
    const env = makeEnv({ cardContent: V2_BREAKING_CONTENT, prevContent: V1_CONTENT, isPullRequest: true, hasToken: true, failOnBreaking: "false" });
    env.inputs.comment_on_pr = "auto";
    env.postComment = async (args) => { calls.push({ body: args.body }); };
    const r = await run(env);
    expect(r.commentPosted).toBe(true);
    expect(calls[0].body).toContain("MCP Tool Card diff");
  });

  it("uses base-sha input override when provided", async () => {
    let observedSha = "";
    const env = makeEnv({ cardContent: V1_CONTENT, prevContent: V1_CONTENT, baseSha: OVERRIDE_SHA });
    env.gitShow = (sha) => { observedSha = sha; return V1_CONTENT; };
    await run(env);
    expect(observedSha).toBe(OVERRIDE_SHA);
  });

  it("reads base.sha from pull_request event payload when no input override", async () => {
    let observedSha = "";
    const env = makeEnv({ cardContent: V1_CONTENT, prevContent: V1_CONTENT, isPullRequest: true });
    env.gitShow = (sha) => { observedSha = sha; return V1_CONTENT; };
    await run(env);
    expect(observedSha).toBe(BASE_SHA);
  });

  it("skips PR comment when token is missing", async () => {
    const env = makeEnv({ cardContent: V2_NONBREAKING_CONTENT, prevContent: V1_CONTENT, isPullRequest: true });
    env.inputs.comment_on_pr = "true";
    const r = await run(env);
    expect(r.commentPosted).toBe(false);
    expect(r.reason).toBe("no github-token provided");
  });

  it("skips PR comment when GITHUB_EVENT_PATH missing", async () => {
    const env: RunnerEnv = {
      inputs: { card_path: "x.json", base_sha: BASE_SHA, comment_on_pr: "true", github_token: "ghs", fail_on_breaking: "false" },
      GITHUB_REPOSITORY: "x/y",
      readFile: () => V1_CONTENT,
      exists: (p) => p === "x.json",
      gitShow: () => V1_CONTENT,
      write: () => undefined
    };
    const r = await run(env);
    expect(r.commentPosted).toBe(false);
    expect(r.reason).toBe("no GITHUB_EVENT_PATH");
  });

  it("does not comment on non-PR events with comment_on_pr=auto", async () => {
    const env: RunnerEnv = {
      inputs: { card_path: "x.json", base_sha: BASE_SHA, comment_on_pr: "auto", github_token: "ghs", fail_on_breaking: "false" },
      GITHUB_EVENT_NAME: "push",
      readFile: () => V1_CONTENT,
      exists: (p) => p === "x.json",
      gitShow: () => V1_CONTENT,
      write: () => undefined
    };
    const r = await run(env);
    expect(r.commentPosted).toBe(false);
  });

  it("reads a literal ampersand path without a shell and fails closed on an unavailable base commit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kg-tool-card-diff-"));
    const cardPath = "cards/card&echo unsafe.json";
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, "cards"));
      writeFileSync(join(repo, cardPath), V1_CONTENT);
      execFileSync("git", ["add", "--", cardPath], { cwd: repo });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base card"], { cwd: repo });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
      const env: RunnerEnv = {
        inputs: { card_path: cardPath, base_sha: sha, comment_on_pr: "false" },
        GITHUB_WORKSPACE: repo,
        readFile: () => V2_BREAKING_CONTENT,
        exists: (path) => path === cardPath,
        write: () => undefined
      };
      const result = await run(env);
      expect(result.exitCode).toBe(1);
      expect(result.newCard).toBe(false);
      expect(result.diff?.breaking).toBe(true);
      expect(existsSync(join(repo, "unsafe.json"))).toBe(false);

      env.inputs.base_sha = "f".repeat(40);
      const missingCommit = await run(env);
      expect(missingCommit.exitCode).toBe(1);
      expect(missingCommit.newCard).toBe(false);
      expect(missingCommit.reason).toBe("base card lookup failed");
    } finally {
      removeTestDir(repo);
    }
  });
});
