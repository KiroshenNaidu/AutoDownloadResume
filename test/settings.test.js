/* Tests for settings.js — the defaults and the value checking.
   Run all tests with:  node --test test/  */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadExtension, plain } = require("./fake-firefox");

const ext = loadExtension();
const DEFAULTS = plain(ext.run("DEFAULT_SETTINGS"));
const RULES = plain(ext.run("SETTING_RULES"));
const clean = (raw) => plain(ext.run("cleanSettings")(raw));

test("defaults are exactly the values version 2.0 used", () => {
  // If this fails, existing users would see a change in behaviour.
  assert.deepEqual(DEFAULTS, {
    FIRST_RETRY_SECONDS: 1,
    BACKOFF_MULTIPLIER: 2,
    MAX_RETRY_DELAY_SECONDS: 60,
    MAX_ATTEMPTS: 30,
    OFFLINE_GRACE_SECONDS: 90,
    ASSUME_USER_CANCELED_IS_REAL: true,
    RESUME_NETWORK_PAUSES: true,
    RESTART_WHEN_CANNOT_RESUME: true,
    MAX_RESTARTS: 3,
    MAX_RESTART_SIZE_MB: 5000,
    RESTART_CONFLICT_ACTION: "uniquify",
    CANCEL_WHEN_GIVING_UP: true,
    SHOW_NOTIFICATIONS: true,
    CHECK_EVERY_MINUTES: 0.5
  });
});

test("every setting has a rule, and every default passes its own rule", () => {
  assert.deepEqual(Object.keys(RULES).sort(), Object.keys(DEFAULTS).sort());
  assert.deepEqual(clean(DEFAULTS), { settings: DEFAULTS, problems: [] });
});

test("the slow-connection preset only uses real settings, all valid", () => {
  const preset = plain(ext.run("SLOW_CONNECTION_PRESET"));
  for (const name of Object.keys(preset)) {
    assert.ok(name in DEFAULTS, `${name} is not a setting`);
  }
  const full = { ...DEFAULTS, ...preset };
  assert.deepEqual(clean(full), { settings: full, problems: [] });
});

test("the slow-connection preset keeps partial files and limits big restarts", () => {
  // The two choices that protect hours of slow downloading.
  const preset = plain(ext.run("SLOW_CONNECTION_PRESET"));
  assert.equal(preset.CANCEL_WHEN_GIVING_UP, false);
  assert.ok(preset.MAX_RESTART_SIZE_MB > 0 && preset.MAX_RESTART_SIZE_MB < DEFAULTS.MAX_RESTART_SIZE_MB);
});

test("nothing saved yet gives the defaults, with no complaints", () => {
  for (const raw of [undefined, null, {}, "rubbish", 42]) {
    assert.deepEqual(clean(raw), { settings: DEFAULTS, problems: [] });
  }
});

test("numbers typed as text in the form are accepted", () => {
  const { settings, problems } = clean({ MAX_ATTEMPTS: "50", BACKOFF_MULTIPLIER: " 1.5 " });
  assert.equal(settings.MAX_ATTEMPTS, 50);
  assert.equal(settings.BACKOFF_MULTIPLIER, 1.5);
  assert.deepEqual(problems, []);
});

test("empty, non-number, too small, too big and decimal values fall back to the default", () => {
  const bad = ["", "   ", null, "abc", "Infinity", NaN, -1, 1001, 2.5, true];
  for (const value of bad) {
    const { settings, problems } = clean({ MAX_ATTEMPTS: value });
    assert.equal(settings.MAX_ATTEMPTS, 30, `value ${JSON.stringify(value)}`);
    assert.deepEqual(problems, ["MAX_ATTEMPTS"], `value ${JSON.stringify(value)}`);
  }
});

test("the smallest and largest allowed numbers are accepted", () => {
  for (const [name, rule] of Object.entries(RULES)) {
    if (rule.type !== "number") continue;
    assert.equal(clean({ [name]: rule.min }).settings[name], rule.min, `${name} min`);
    assert.equal(clean({ [name]: rule.max }).settings[name], rule.max, `${name} max`);
  }
});

test("the check interval can't go below 0.5 minutes", () => {
  assert.equal(clean({ CHECK_EVERY_MINUTES: 0.1 }).settings.CHECK_EVERY_MINUTES, 0.5);
  assert.equal(clean({ CHECK_EVERY_MINUTES: 0 }).settings.CHECK_EVERY_MINUTES, 0.5);
  assert.equal(clean({ CHECK_EVERY_MINUTES: 0.75 }).settings.CHECK_EVERY_MINUTES, 0.75);
});

test("0 is allowed where it means something (no size limit, no restarts)", () => {
  const { settings, problems } = clean({ MAX_RESTART_SIZE_MB: 0, MAX_RESTARTS: 0, OFFLINE_GRACE_SECONDS: 0 });
  assert.equal(settings.MAX_RESTART_SIZE_MB, 0);
  assert.equal(settings.MAX_RESTARTS, 0);
  assert.equal(settings.OFFLINE_GRACE_SECONDS, 0);
  assert.deepEqual(problems, []);
});

test("tick boxes must be real true/false, not text", () => {
  assert.equal(clean({ SHOW_NOTIFICATIONS: false }).settings.SHOW_NOTIFICATIONS, false);
  for (const value of ["false", "yes", 0, 1, null]) {
    const { settings, problems } = clean({ SHOW_NOTIFICATIONS: value });
    assert.equal(settings.SHOW_NOTIFICATIONS, true, `value ${JSON.stringify(value)}`);
    assert.deepEqual(problems, ["SHOW_NOTIFICATIONS"]);
  }
});

test("the filename-clash choice only accepts the two known words", () => {
  assert.equal(clean({ RESTART_CONFLICT_ACTION: "overwrite" }).settings.RESTART_CONFLICT_ACTION, "overwrite");
  for (const value of ["delete", "Overwrite", "", null]) {
    assert.equal(clean({ RESTART_CONFLICT_ACTION: value }).settings.RESTART_CONFLICT_ACTION, "uniquify");
  }
});

test("unknown saved keys are dropped, and several problems are all reported", () => {
  const { settings, problems } = clean({ OLD_SETTING: 5, MAX_ATTEMPTS: "", MAX_RESTARTS: 999 });
  assert.equal("OLD_SETTING" in settings, false);
  assert.deepEqual(problems, ["MAX_ATTEMPTS", "MAX_RESTARTS"]);
});
