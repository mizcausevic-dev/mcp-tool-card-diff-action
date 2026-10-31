import { run } from "./runner.js";
function readInputs() {
    const out = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith("INPUT_")) {
            const name = k.slice("INPUT_".length).toLowerCase().replace(/-/g, "_");
            out[name] = v;
        }
    }
    return out;
}
run({
    inputs: readInputs(),
    GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
    GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
    GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE
}).then((r) => process.exit(r.exitCode), (e) => {
    process.stderr.write(`::error::${e.message}\n`);
    process.exit(1);
});
export { run } from "./runner.js";
export { diffToolCards } from "./diff.js";
export { toMarkdown, toSummary } from "./format.js";
