/**
 * Conventional Commits, with the scope restricted to things that actually
 * exist in this repo -- an open enum lets "fix(stuff):" through, which makes
 * the history unfilterable and defeats the point of having a convention.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", [
      "api", "gtfs", "app", "deploy", "ci", "docs", "deps",
    ]],
    "body-max-line-length": [2, "always", 100],
  },
};
