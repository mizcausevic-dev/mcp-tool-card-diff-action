import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { diffToolCards } from "./diff.js";
import { toMarkdown } from "./format.js";
const NULL_DIFF = {
    changes: [],
    breaking: false,
    added: { externalSystems: [], refusalModes: [], testedProviders: [], auditLogs: [] },
    removed: { externalSystems: [], refusalModes: [], testedProviders: [], auditLogs: [] }
};
function defaultGitShow(sha, path, cwd) {
    const options = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], options);
    const paths = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", sha, "--", path], options);
    if (!paths.split("\0").includes(path))
        return null;
    return execFileSync("git", ["show", `${sha}:${path}`], options);
}
function validCardPath(path) {
    return !path.startsWith("/") && !path.includes("\\") && !path.includes(":") &&
        !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
        path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function cardFileWithinWorkspace(path, workspace) {
    const root = realpathSync(workspace);
    const file = resolve(root, path);
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile())
        return false;
    const relativePath = relative(root, realpathSync(file));
    return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith("../") &&
        !relativePath.startsWith("..\\") && !isAbsolute(relativePath);
}
export async function run(env) {
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
    const gitShow = env.gitShow ?? ((sha, path) => defaultGitShow(sha, path, env.GITHUB_WORKSPACE));
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
            const event = JSON.parse(read(env.GITHUB_EVENT_PATH));
            baseSha = event.pull_request?.base?.sha ?? "";
        }
        catch {
            // ignore — fall through
        }
    }
    if (!/^[0-9a-f]{40}$/iu.test(baseSha)) {
        write("::error::a full 40-character base commit SHA is required to compare a Tool Card.");
        return { exitCode: 1, diff: null, newCard: false, commentPosted: false, reason: "invalid base SHA" };
    }
    let prev = null;
    let prevRaw = null;
    try {
        prevRaw = gitShow(baseSha, cardPath);
    }
    catch {
        write("::error::could not read the Tool Card at the base commit; verify checkout history and card-path.");
        return { exitCode: 1, diff: null, newCard: false, commentPosted: false, reason: "base card lookup failed" };
    }
    if (prevRaw !== null) {
        try {
            prev = JSON.parse(prevRaw);
        }
        catch {
            write("::error::the Tool Card at the base commit is malformed; comparison cannot be trusted.");
            return { exitCode: 1, diff: null, newCard: false, commentPosted: false, reason: "invalid base card" };
        }
    }
    const nextRaw = read(cardLocation);
    const next = JSON.parse(nextRaw);
    const newCard = prev === null;
    const diff = newCard ? NULL_DIFF : diffToolCards(prev, next);
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
    let reason;
    if (wantsComment) {
        if (!token) {
            reason = "no github-token provided";
        }
        else if (!env.GITHUB_EVENT_PATH) {
            reason = "no GITHUB_EVENT_PATH";
        }
        else if (!env.GITHUB_REPOSITORY) {
            reason = "no GITHUB_REPOSITORY";
        }
        else {
            const event = JSON.parse(read(env.GITHUB_EVENT_PATH));
            const issueNumber = event.number ?? event.pull_request?.number;
            if (!issueNumber) {
                reason = "no PR number in event payload";
            }
            else {
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
function required(inputs, name) {
    const v = inputs[name];
    if (!v || v.length === 0)
        throw new Error(`input "${name}" is required`);
    return v;
}
function setOutput(env, key, value) {
    if (env.GITHUB_OUTPUT)
        appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
async function defaultPostComment(args) {
    const r = await fetch(`https://api.github.com/repos/${args.repo}/issues/${args.issueNumber}/comments`, {
        method: "POST",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${args.token}`,
            "X-GitHub-Api-Version": "2022-11-28"
        },
        body: JSON.stringify({ body: args.body })
    });
    if (!r.ok)
        throw new Error(`GitHub API comment failed: ${r.status} ${await r.text()}`);
}
