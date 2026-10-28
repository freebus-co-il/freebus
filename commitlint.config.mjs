/**
 * Conventional Commits, with the scope restricted to things that actually
 * exist in this repo -- an open enum lets "fix(stuff):" through, which makes
 * the history unfilterable and defeats the point of having a convention.
 */
export default {
  extends: ["@commitlint/config-conventional"],

  /**
   * Dependabot's commits are exempt, and have to be.
   *
   * It writes the body itself -- release notes and changelog excerpts pasted
   * verbatim from upstream -- and those lines routinely run past 100
   * characters. Nothing in this repo can shorten them, so `body-max-line-length`
   * rejected every dependency PR it opened: thirteen of them, all red, none
   * for a reason a human could act on.
   *
   * The pattern covers `deps` and `deps-dev`, which are the only scopes
   * Dependabot emits. A human writing `build(deps): ...` by hand is exempted
   * too; that is a fair trade for not having the convention block every
   * automated update.
   */
  ignores: [(message) => /^build\(deps(-dev)?\)!?: /.test(message)],

  rules: {
    "scope-enum": [2, "always", [
      "api", "gtfs", "app", "deploy", "ci", "docs", "deps", "deps-dev",
    ]],
    // Applies to commits written here. Dependabot's are ignored above.
    "body-max-line-length": [2, "always", 100],
  },
};
