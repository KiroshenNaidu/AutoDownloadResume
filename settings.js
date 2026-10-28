/* ============================================================
   SETTINGS — the defaults, and the rules for checking them.

   This file is loaded by BOTH the background script and the options page,
   so the default values only ever live in one place.

   Users change settings on the Options tab (about:addons → Download
   Auto-Resume → Options). What they choose is saved in
   browser.storage.local under SETTINGS_KEY. Anything missing or invalid
   falls back to the default below.
   ============================================================ */

// Where the user's chosen settings are saved. Kept separate from the
// extension's own bookkeeping ("autoResumeState") so clearing one never
// touches the other.
const SETTINGS_KEY = "settings";

const DEFAULT_SETTINGS = {
  // How long to wait before the FIRST retry after a download breaks, in seconds.
  FIRST_RETRY_SECONDS: 1,

  // Each further failure waits this many times longer than the last.
  // 2 gives: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s...
  // 1 means every retry is FIRST_RETRY_SECONDS apart.
  BACKOFF_MULTIPLIER: 2,

  // The waiting time never grows past this, in seconds.
  MAX_RETRY_DELAY_SECONDS: 60,

  // How many failures IN A ROW *while we believe you are online* before giving up.
  // Failures that happen while offline are NOT counted.
  MAX_ATTEMPTS: 30,

  /* ---- telling "the network died" apart from "you cancelled it" ----

     Firefox reports the error "USER_CANCELED" for BOTH of these. There is no
     field that separates them, so we go by timing instead: if the connection
     dropped recently, we blame the network.                                  */

  // If the connection was down within this many seconds of a download breaking,
  // treat the break as network-caused even when Firefox blames "USER_CANCELED".
  OFFLINE_GRACE_SECONDS: 90,

  // When we genuinely cannot tell, what do we assume?
  //   true  = assume YOU cancelled it, leave it alone. (Safe.)
  //   false = assume the NETWORK did it, retry it. (Will fight manual cancels.)
  ASSUME_USER_CANCELED_IS_REAL: true,

  // Resume downloads Firefox has put into a paused state, when the pause looks
  // network-caused. A pause you did yourself, while online, is always respected.
  RESUME_NETWORK_PAUSES: true,

  /* ---- restarting downloads that cannot be resumed ---- */

  // Restart from scratch (from 0 bytes) when a download cannot be resumed?
  RESTART_WHEN_CANNOT_RESUME: true,

  // How many times a single URL may be restarted from scratch before we give up.
  MAX_RESTARTS: 3,

  // Refuse to auto-restart files bigger than this, in megabytes. 0 = no limit.
  MAX_RESTART_SIZE_MB: 5000,

  // What to do if the restarted file clashes with an existing filename.
  // "uniquify"  = save as name(1).zip (never destroys anything)
  // "overwrite" = replace the old file
  RESTART_CONFLICT_ACTION: "uniquify",

  /* ---- giving up ---- */

  // true  = cancel the download once we give up (frees the partial file).
  // false = just stop retrying and leave it so you can retry by hand.
  CANCEL_WHEN_GIVING_UP: true,

  // Show desktop notifications (giving up, or a download needing attention).
  SHOW_NOTIFICATIONS: true,

  // How often the extension wakes up to check on stopped downloads, in minutes.
  // Firefox won't run an alarm more often than every 0.5 minutes (30 seconds).
  CHECK_EVERY_MINUTES: 0.5
};

// The "Slow / unstable connection" button on the Options page. Only the
// settings listed here change; everything else goes back to its default.
// Made for very slow lines (think dial-up: a 38 MB file takes hours) that drop often.
const SLOW_CONNECTION_PRESET = {
  // A redial takes a while — retrying after 1 second just wastes an attempt.
  FIRST_RETRY_SECONDS: 5,
  // Grow the wait more gently: 5s, 7.5s, 11s, 17s, 25s...
  BACKOFF_MULTIPLIER: 1.5,
  // ...up to 5 minutes between tries.
  MAX_RETRY_DELAY_SECONDS: 300,
  // The count resets whenever the download makes progress, so 100 in a row
  // means roughly 7-8 hours of NO progress at all before giving up.
  MAX_ATTEMPTS: 100,
  // Catch more "USER_CANCELED" errors that were really the line dropping.
  OFFLINE_GRACE_SECONDS: 300,
  // Small files are cheap to restart a few more times...
  MAX_RESTARTS: 5,
  // ...but restarting a big file from 0 bytes on a slow line takes days.
  MAX_RESTART_SIZE_MB: 100,
  // Keep the partial file when giving up — it may hold hours of downloading,
  // and you can still press retry on it later.
  CANCEL_WHEN_GIVING_UP: false
};

// What counts as a valid value for each setting.
//   number:  must be between min and max. whole: true = no decimals allowed.
//   boolean: must be true or false (a tick box).
//   choice:  must be one of the listed words.
const SETTING_RULES = {
  FIRST_RETRY_SECONDS:          { type: "number", min: 1,   max: 3600,    whole: true },
  BACKOFF_MULTIPLIER:           { type: "number", min: 1,   max: 10 },
  MAX_RETRY_DELAY_SECONDS:      { type: "number", min: 1,   max: 86400,   whole: true },
  MAX_ATTEMPTS:                 { type: "number", min: 1,   max: 1000,    whole: true },
  OFFLINE_GRACE_SECONDS:        { type: "number", min: 0,   max: 3600,    whole: true },
  ASSUME_USER_CANCELED_IS_REAL: { type: "boolean" },
  RESUME_NETWORK_PAUSES:        { type: "boolean" },
  RESTART_WHEN_CANNOT_RESUME:   { type: "boolean" },
  MAX_RESTARTS:                 { type: "number", min: 0,   max: 100,     whole: true },
  MAX_RESTART_SIZE_MB:          { type: "number", min: 0,   max: 1000000, whole: true },
  RESTART_CONFLICT_ACTION:      { type: "choice", choices: ["uniquify", "overwrite"] },
  CANCEL_WHEN_GIVING_UP:        { type: "boolean" },
  SHOW_NOTIFICATIONS:           { type: "boolean" },
  CHECK_EVERY_MINUTES:          { type: "number", min: 0.5, max: 60 }
};

// Check ONE value against its rule. Returns the value to use, and whether the
// value we were given was bad (so the options page can tell the user).
function cleanOne(name, value) {
  const rule = SETTING_RULES[name];
  const fallback = DEFAULT_SETTINGS[name];

  // Never set at all (e.g. a setting added in a newer version) — quietly
  // use the default. That's not the user's mistake.
  if (value === undefined) return { value: fallback, bad: false };

  if (rule.type === "boolean") {
    if (typeof value === "boolean") return { value, bad: false };
    return { value: fallback, bad: true };
  }

  if (rule.type === "choice") {
    if (rule.choices.includes(value)) return { value, bad: false };
    return { value: fallback, bad: true };
  }

  // rule.type === "number". The options page hands us text from the boxes,
  // so accept "30" as well as 30. An empty box counts as invalid.
  // Anything else (true, null, a list...) is not a number, even though
  // JavaScript would happily turn true into 1.
  if (typeof value !== "number" && typeof value !== "string") return { value: fallback, bad: true };
  if (String(value).trim() === "") return { value: fallback, bad: true };
  const n = Number(value);
  if (!Number.isFinite(n)) return { value: fallback, bad: true };
  if (rule.whole && !Number.isInteger(n)) return { value: fallback, bad: true };
  if (n < rule.min || n > rule.max) return { value: fallback, bad: true };
  return { value: n, bad: false };
}

// Check a whole settings object (as loaded from storage, or read from the
// form). Returns:
//   settings: a complete, safe settings object — every key present and valid
//   problems: names of the settings that were invalid and got reset
function cleanSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const settings = {};
  const problems = [];

  for (const name of Object.keys(DEFAULT_SETTINGS)) {
    const result = cleanOne(name, source[name]);
    settings[name] = result.value;
    if (result.bad) problems.push(name);
  }

  return { settings, problems };
}
