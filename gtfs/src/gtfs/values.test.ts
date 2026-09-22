import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGtfsTime, parseGtfsDate, parseInt0, parseFloat0, parseText,
  fixFlippedGeresh, parseName,
} from "./values.js";

test("parseGtfsTime converts to seconds after midnight", () => {
  assert.equal(parseGtfsTime("00:00:00"), 0);
  assert.equal(parseGtfsTime("05:10:00"), 18600);
  assert.equal(parseGtfsTime("05:12:23"), 18743);
});

test("parseGtfsTime preserves past-midnight values beyond 24h", () => {
  assert.equal(parseGtfsTime("24:00:00"), 86400);
  assert.equal(parseGtfsTime("25:30:00"), 91800);
  assert.equal(parseGtfsTime("27:45:30"), 99930); // 27*3600 + 45*60 + 30
});

test("parseGtfsTime tolerates a single-digit hour", () => {
  assert.equal(parseGtfsTime("5:10:00"), 18600);
});

test("parseGtfsTime returns null for empty or malformed input", () => {
  assert.equal(parseGtfsTime(""), null);
  assert.equal(parseGtfsTime("   "), null);
  assert.equal(parseGtfsTime("not a time"), null);
  assert.equal(parseGtfsTime("05:70:00"), null);
  assert.equal(parseGtfsTime("05:10"), null);
});

test("parseGtfsDate converts to a YYYYMMDD integer", () => {
  assert.equal(parseGtfsDate("20260821"), 20260821);
  assert.equal(parseGtfsDate(""), null);
  assert.equal(parseGtfsDate("2026-08-21"), null);
  assert.equal(parseGtfsDate("20261332"), null);
});

test("numeric and text parsers reject empty values", () => {
  assert.equal(parseInt0("0"), 0);
  assert.equal(parseInt0(""), null);
  assert.equal(parseFloat0("32.164723"), 32.164723);
  assert.equal(parseFloat0(""), null);
  assert.equal(parseText("  x  "), "x");
  assert.equal(parseText(""), null);
});

test("fixFlippedGeresh moves a stop name's leading geresh after its one-letter suffix", () => {
  assert.equal(fixFlippedGeresh("'אידר א"), "אידר א'");
  assert.equal(fixFlippedGeresh("'שדרות נחל קישון ב"), "שדרות נחל קישון ב'");
});

test("fixFlippedGeresh fixes a flipped stop opening either side of a route long name", () => {
  assert.equal(
    fixFlippedGeresh("'הגדוד השלישי ב-צפת<->בית ספר ממלכתי ב-צפת-1#"),
    "הגדוד השלישי ב'-צפת<->בית ספר ממלכתי ב-צפת-1#",
  );
  assert.equal(
    fixFlippedGeresh("מסוף משה ארנס/רציפים-פתח תקווה<->'נחשונים ג-נחשונים-11"),
    "מסוף משה ארנס/רציפים-פתח תקווה<->נחשונים ג'-נחשונים-11",
  );
});

test("fixFlippedGeresh leaves every other apostrophe untouched", () => {
  for (const v of [
    "אידר/ד''ר נחום שימקין",
    "בי''ס בר לב/בן יהודה",
    "ת. מרכזית ראשל''צ-ראשון לציון<->ת. מרכזית אשדוד-אשדוד-2#",
    "אידר ב",
    "'אידר",
    "'",
    "Eder A",
    "إيدِر أ‘",
  ]) {
    assert.equal(fixFlippedGeresh(v), v);
  }
});

test("parseName trims, rejects empty values, and fixes the geresh", () => {
  assert.equal(parseName("  'אידר א  "), "אידר א'");
  assert.equal(parseName("הרצל/צומת בילו"), "הרצל/צומת בילו");
  assert.equal(parseName(""), null);
});
