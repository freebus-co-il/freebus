// Fails a PR that changes the app's native code without bumping its version.
//
// Usage: node app-release-check.mjs <base app dir> <head app dir>
//
// The runtime version is the fingerprint, so a native change always reaches
// riders as a new store build (see .github/workflows/deploy-app.yml). The
// stores need a new version for that, and nobody should learn about it from a
// rejected upload after the merge. Comparing the fingerprints here makes the
// release visible in review instead.
//
// Both trees are fingerprinted the same way, without the EAS environment, so
// the Maps key (part of the config) is absent from both and cancels out.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [baseDir, headDir] = process.argv.slice(2);
if (!baseDir || !headDir) {
  console.error("usage: app-release-check.mjs <base app dir> <head app dir>");
  process.exit(2);
}

const PLATFORMS = ["ios", "android"];

function fingerprint(dir, platform) {
  // `--workflow managed`: ios/ and android/ are generated and gitignored, so
  // EAS never has them, but a developer's checkout might.
  const out = execFileSync(
    "npx",
    ["expo-updates", "fingerprint:generate", "--platform", platform, "--workflow", "managed"],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(out);
}

function version(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
}

function isGreater(next, previous) {
  const a = next.split(".").map(Number);
  const b = previous.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** What made the fingerprints differ, by source, for the summary. */
function changedSources(base, head) {
  const key = (source) => `${source.type}:${source.filePath ?? source.id}`;
  const baseHashes = new Map(base.sources.map((s) => [key(s), s.hash]));
  const headHashes = new Map(head.sources.map((s) => [key(s), s.hash]));
  const changed = [];
  for (const [k, hash] of headHashes) {
    if (baseHashes.get(k) !== hash) changed.push(baseHashes.has(k) ? `changed ${k}` : `added ${k}`);
  }
  for (const k of baseHashes.keys()) if (!headHashes.has(k)) changed.push(`removed ${k}`);
  return changed;
}

const baseVersion = version(baseDir);
const headVersion = version(headDir);
const bumped = isGreater(headVersion, baseVersion);

const nativeChanges = [];
for (const platform of PLATFORMS) {
  const base = fingerprint(baseDir, platform);
  const head = fingerprint(headDir, platform);
  if (base.hash !== head.hash) nativeChanges.push({ platform, sources: changedSources(base, head) });
}

const lines = ["## App release", ""];
let failed = false;

if (nativeChanges.length === 0) {
  lines.push(
    bumped
      ? `No native change, but the version goes from ${baseVersion} to ${headVersion}: merging this ships a store build.`
      : "No native change: merging this ships an OTA update to the binaries already in riders' hands.",
  );
} else {
  const platforms = nativeChanges.map((c) => c.platform).join(" and ");
  if (bumped) {
    lines.push(`Native change on ${platforms}, released as ${headVersion}: merging this ships a store build.`);
  } else {
    failed = true;
    lines.push(
      `Native change on ${platforms}, but \`app/package.json\` is still at ${baseVersion}.`,
      "",
      "Merging this ships a store build, and the stores need a new version for it. Bump the version",
      "(`npm --prefix app version patch --no-git-tag-version`) in this PR.",
    );
  }
  for (const { platform, sources } of nativeChanges) {
    lines.push("", `<details><summary>${platform}: what changed</summary>`, "", "```", ...sources, "```", "</details>");
  }
}

const summary = lines.join("\n") + "\n";
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (failed) {
  console.log(`::error::Native change without a version bump: bump app/package.json past ${baseVersion}.`);
  process.exit(1);
}
