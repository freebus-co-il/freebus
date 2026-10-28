import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "./connect.js";
import { Translator, parseLang } from "./i18n.js";

const newDir = () => mkdtempSync(join(tmpdir(), "transit-i18n-"));

test("parseLang defaults to Hebrew and normalises case", () => {
  assert.equal(parseLang(undefined), "he");
  assert.equal(parseLang("EN"), "en");
  assert.equal(parseLang("ar"), "ar");
});

test("parseLang rejects an unsupported language by name", () => {
  assert.throws(() => parseLang("fr"), /Unsupported lang: fr/);
});

test("resolves a translated name", () => {
  const dir = newDir();
  buildFixtureDb(dir);
  const h = openTransitDb(dir);
  const tr = Translator.load(h.db);
  assert.equal(tr.resolve("הרצל", "en"), "Herzl");
  assert.equal(tr.resolve("הרצל", "ar"), "هرتسل");
  h.close();
});

// 7.6% of stop names have no translation. Falling back to the Hebrew feed
// text is correct; returning null or an empty string would blank the name.
test("falls back to the feed text when no translation exists", () => {
  const dir = newDir();
  buildFixtureDb(dir);
  const h = openTransitDb(dir);
  const tr = Translator.load(h.db);
  assert.equal(tr.resolve("תחנת השלום", "en"), "תחנת השלום");
  h.close();
});

test("resolve passes null through", () => {
  const dir = newDir();
  buildFixtureDb(dir);
  const h = openTransitDb(dir);
  const tr = Translator.load(h.db);
  assert.equal(tr.resolve(null, "en"), null);
  h.close();
});
