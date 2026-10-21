import assert from "node:assert/strict";
import test from "node:test";
import { portLocalTime } from "../src/lib/portTime";

const utcNoon = new Date("2026-01-15T12:34:56.000Z");

test("known port clocks use IANA daylight-saving rules", () => {
  const rotterdam = { id: "port-rotterdam", timezone: "UTC+1 / +2 DST" };
  assert.equal(portLocalTime(rotterdam, utcNoon), "13:34:56");
  assert.equal(portLocalTime(rotterdam, new Date("2026-07-15T12:34:56Z")), "14:34:56");
  assert.equal(portLocalTime({ id: "port-yokohama", timezone: "" }, utcNoon), "21:34:56");
});

test("explicit port timezone supports countries with more than one local time", () => {
  assert.equal(portLocalTime({ id: "custom", timezone: "Etc/UTC" }, utcNoon), "12:34:56");
  assert.equal(portLocalTime({ id: "custom", timezone: "America/New_York" }, utcNoon), "07:34:56");
  assert.equal(portLocalTime({ id: "custom", timezone: "America/Los_Angeles" }, utcNoon), "04:34:56");
});

test("fixed offsets retain minute offsets and midnight rollover", () => {
  assert.equal(portLocalTime({ id: "custom", timezone: "UTC+5:30" }, utcNoon), "18:04:56");
  assert.equal(portLocalTime({ id: "custom", timezone: "UTC-3:30" }, utcNoon), "09:04:56");
  assert.equal(portLocalTime({ id: "custom", timezone: "UTC+14" }, utcNoon), "02:34:56");
  assert.equal(portLocalTime({ id: "custom", timezone: "UTC" }, utcNoon), "12:34:56");
});

test("unknown and ambiguous port timezones do not silently use browser local time", () => {
  for (const timezone of ["", "UTC+1 / +2 DST", "Not/A_Zone", "UTC+15", "UTC+14:30", "UTC+1:90"]) {
    assert.equal(portLocalTime({ id: "custom", timezone }, utcNoon), undefined);
  }
  assert.equal(portLocalTime({ id: "port-hong-kong", timezone: "UTC+8" }, new Date("invalid")), undefined);
});
