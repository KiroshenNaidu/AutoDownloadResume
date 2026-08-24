/* ============================================================
   SETTINGS — these are the only lines you need to change.
   ============================================================ */

// How long to wait before the FIRST retry after a download breaks, in seconds.
const FIRST_RETRY_SECONDS = 1;

// Each further failure waits this many times longer than the last.
// 2 gives: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s...
// Set this to 1 if you want every retry to be FIRST_RETRY_SECONDS apart.
const BACKOFF_MULTIPLIER = 2;

// The waiting time never grows past this, in seconds.
const MAX_RETRY_DELAY_SECONDS = 60;

// How many failures IN A ROW *while we believe you are online* before giving up.
// Failures that happen while offline are NOT counted.
const MAX_ATTEMPTS = 30;

/* ---- telling "the network died" apart from "you cancelled it" ----

   Firefox reports the error "USER_CANCELED" for BOTH of these. There is no
   field that separates them, so we go by timing instead: if the connection
   dropped recently, we blame the network.                                    */

// If the connection was down within this many seconds of a download breaking,
// treat the break as network-caused even when Firefox blames "USER_CANCELED".
const OFFLINE_GRACE_SECONDS = 90;

// When we genuinely cannot tell, what do we assume?
//   true  = assume YOU cancelled it, leave it alone.
//           Safe. Might ignore a real failure if your router stayed up but
//           your internet didn't (we'd never have seen an "offline" moment).
//   false = assume the NETWORK did it, retry it.
//           Aggressive. Will fight you when you cancel a download by hand.
const ASSUME_USER_CANCELED_IS_REAL = true;

// Resume downloads Firefox has put into a paused state, when the pause looks
// network-caused. A pause you did yourself, while online, is always respected.
const RESUME_NETWORK_PAUSES = true;

/* ---- restarting downloads that cannot be resumed ---- */

// Restart from scratch when a download cannot be resumed?
// (This re-downloads from 0 bytes. See MAX_RESTART_SIZE_MB below.)
const RESTART_WHEN_CANNOT_RESUME = true;

// How many times a single URL may be restarted from scratch before we give up.
const MAX_RESTARTS = 3;

// Refuse to auto-restart files bigger than this, in megabytes.
// 0 means "no limit". 5000 means "don't auto-restart anything over ~5 GB".
// Strongly recommended to keep a real number here — a restarted 20 GB download
// re-downloads all 20 GB.
const MAX_RESTART_SIZE_MB = 5000;

// What to do if the restarted file clashes with an existing filename.
// "uniquify" = save as name(1).zip (never destroys anything)
// "overwrite" = replace the old file
const RESTART_CONFLICT_ACTION = "uniquify";

/* ---- giving up ---- */

// true  = cancel the download once we give up (frees the partial file).
// false = just stop retrying and leave it there so you can retry by hand.
const CANCEL_WHEN_GIVING_UP = true;

// Show a desktop notification when we give up on a download.
const SHOW_NOTIFICATIONS = true;

// How often the extension wakes up to check on stopped downloads, in minutes.
// 0.5 = every 30 seconds. THIS IS THE REAL SAFETY NET — the background page
// gets suspended when idle, and only a real WebExtension event (like this
// alarm) can wake it back up.
const CHECK_EVERY_MINUTES = 0.5;

/* ============================================================
   From here down is the machinery. You shouldn't need to edit it.
   ============================================================ */

const STORAGE_KEY = "autoResumeState";
const ALARM_NAME = "auto-resume-sweep";
const OFFLINE_KEY = "meta:offline";

// Errors that mean "this will fail again in exactly the same way".
// Retrying or restarting these is pointless.
const PERMANENT_ERRORS = new Set([
  "USER_SHUTDOWN",
  "FILE_ACCESS_DENIED",
  "FILE_NO_SPACE",
  "FILE_NAME_TOO_LONG",
  "FILE_TOO_LARGE",
  "FILE_VIRUS_INFECTED",
  "FILE_BLOCKED",
  "FILE_SECURITY_CHECK_FAILED",
  "SERVER_UNAUTHORIZED",
  "SERVER_FORBIDDEN",
  "SERVER_CERT_PROBLEM",
  "SERVER_BAD_CONTENT"
]);

// Errors that clearly mean "the connection or the server dropped it".
const NETWORK_ERRORS = new Set([
  "NETWORK_FAILED",
  "NETWORK_TIMEOUT",
  "NETWORK_DISCONNECTED",
  "NETWORK_SERVER_DOWN",
  "NETWORK_INVALID_REQUEST",
  "SERVER_FAILED",
  "SERVER_NO_RANGE",
  "FILE_TRANSIENT_ERROR",
  "FILE_FAILED",
  "CRASH"
]);

// NOTE: "USER_CANCELED" is deliberately in NEITHER list. Firefox uses it for
// real cancellations AND for some network failures. classify() decides.

const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function log(...args) {
  console.log("[auto-resume]", ...args);
}

/* ---------- saved state --------------------------------------------------- */

let stateLock = Promise.resolve();

function withState(job) {
  const run = stateLock.then(async () => {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    const state = stored[STORAGE_KEY] || {};
    const result = await job(state);
    await browser.storage.local.set({ [STORAGE_KEY]: state });
    return result;
  });
  stateLock = run.catch(() => {});
  return run;
}

function touch(entry) {
  entry.updatedAt = Date.now();
  return entry;
}

/* ---------- connectivity -------------------------------------------------- */

async function isOnline() {
  let online = true;

  if (navigator.onLine === false) {
    online = false;
  } else if (typeof browser.captivePortal !== "undefined") {
    try {
      const portalState = await browser.captivePortal.getState();
      if (portalState === "locked_portal") online = false;
    } catch (err) {
      // Captive portal service may be disabled; assume online.
    }
  }

  if (!online) {
    // Remember WHEN we were last offline. This is how we later decide whether
    // a "USER_CANCELED" was really the network's fault.
    await withState((state) => {
      state[OFFLINE_KEY] = touch({ at: Date.now() });
    });
  }

  return online;
}

async function lastOfflineAt() {
  return withState((state) => (state[OFFLINE_KEY] && state[OFFLINE_KEY].at) || 0);
}

/* ---------- helpers ------------------------------------------------------- */

async function getDownload(id) {
  const results = await browser.downloads.search({ id });
  return results[0];
}

function shortName(item) {
  if (!item || !item.filename) return "";
  const parts = item.filename.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function displayName(item) {
  return shortName(item) || "download";
}

async function notify(title, message) {
  if (!SHOW_NOTIFICATIONS) return;
  try {
    await browser.notifications.create({ type: "basic", title, message });
  } catch (err) {
    log("could not show notification:", err);
  }
}

function delayForAttempt(attemptNumber) {
  const seconds =
    FIRST_RETRY_SECONDS * Math.pow(BACKOFF_MULTIPLIER, Math.max(0, attemptNumber - 1));
  return Math.min(seconds, MAX_RETRY_DELAY_SECONDS) * 1000;
}

// Is this download stopped in a way we might care about?
// Covers both "interrupted" and "paused but still officially in progress".
function isStopped(item) {
  if (!item) return false;
  if (item.state === "complete") return false;
  return item.state === "interrupted" || item.paused === true;
}

/* ---------- the important decision ---------------------------------------- */

/*
  Work out WHY a download stopped. Returns one of:

    "network"        -> the connection or server dropped it. Retry / restart.
    "user-canceled"  -> you cancelled it. Leave it alone, permanently.
    "user-paused"    -> you paused it. Leave it alone, permanently.
    "permanent"      -> will fail identically forever (no disk space, 403...).
    "ignore"         -> not actually stopped.

  The tricky case is "USER_CANCELED", which Firefox reports for BOTH real
  cancellations and some network failures. We use timing to break the tie.
*/
function classify(item, opts) {
  const currentlyOffline = opts.currentlyOffline;
  const offlineRecently = opts.offlineRecently;

  if (!isStopped(item)) return "ignore";

  const error = item.error || "";
  const networkBlamed = currentlyOffline || offlineRecently;

  if (PERMANENT_ERRORS.has(error)) return "permanent";

  if (error === "USER_CANCELED") {
    if (networkBlamed) return "network";
    return ASSUME_USER_CANCELED_IS_REAL ? "user-canceled" : "network";
  }

  if (NETWORK_ERRORS.has(error)) return "network";

  if (item.paused === true) {
    if (RESUME_NETWORK_PAUSES && networkBlamed) return "network";
    return "user-paused";
  }

  // Interrupted with no error we recognise — worth a try.
  return "network";
}

/* ---------- giving up ----------------------------------------------------- */

async function giveUp(item, reason) {
  log(`giving up on #${item.id} (${displayName(item)}): ${reason}`);

  if (CANCEL_WHEN_GIVING_UP) {
    try {
      await browser.downloads.cancel(item.id);
    } catch (err) {
      log(`could not cancel #${item.id}:`, err);
    }
  }

  await notify("Download Auto-Resume gave up", `"${displayName(item)}" — ${reason}`);
}

/* ---------- restarting from scratch --------------------------------------- */

async function restartFromScratch(item, state) {
  if (!RESTART_WHEN_CANNOT_RESUME) {
    await giveUp(item, "this download cannot be resumed");
    return;
  }

  if (!/^https?:\/\//i.test(item.url || "")) {
    await giveUp(item, "cannot be resumed and its link cannot be re-requested");
    return;
  }

  const sizeMB = item.totalBytes > 0 ? Math.round(item.totalBytes / (1024 * 1024)) : -1;

  if (MAX_RESTART_SIZE_MB > 0 && item.totalBytes > MAX_RESTART_SIZE_MB * 1024 * 1024) {
    state[item.id] = touch({ respectUser: true, announced: true, why: "too big to auto-restart" });
    log(
      `#${item.id} (${displayName(item)}) cannot be resumed and is ${sizeMB} MB — ` +
      `over the ${MAX_RESTART_SIZE_MB} MB auto-restart limit. Leaving it for you to decide.`
    );
    await notify(
      "Download needs your attention",
      `"${displayName(item)}" can't be resumed and is too big to restart automatically.`
    );
    return;
  }

  const urlKey = "url:" + item.url;
  const record = state[urlKey] || { restarts: 0 };

  if (record.restarts >= MAX_RESTARTS) {
    delete state[urlKey];
    await giveUp(item, `restarted ${MAX_RESTARTS} times and still failing`);
    return;
  }

  record.restarts += 1;
  state[urlKey] = touch(record);
  state[item.id] = touch({ abandoned: true });

  const options = { url: item.url, conflictAction: RESTART_CONFLICT_ACTION };
  const name = shortName(item);
  if (name) options.filename = name;

  try {
    const newId = await browser.downloads.download(options);
    log(
      `restart ${record.restarts}/${MAX_RESTARTS} of "${displayName(item)}" ` +
      `from scratch — new download #${newId}`
    );
  } catch (err) {
    try {
      const newId = await browser.downloads.download({
        url: item.url,
        conflictAction: RESTART_CONFLICT_ACTION
      });
      log(`restart ${record.restarts}/${MAX_RESTARTS} of "${displayName(item)}" — new download #${newId}`);
    } catch (err2) {
      log(`restart of "${displayName(item)}" failed:`, err2);
      await giveUp(item, "could not be restarted (the link may have expired)");
      return;
    }
  }

  try {
    await browser.downloads.erase({ id: item.id });
  } catch (err) {
    // Not fatal — the abandoned flag stops us retrying it.
  }
}

/* ---------- the core routine ---------------------------------------------- */

async function handleBroken(id, options) {
  const immediate = Boolean(options && options.immediate);
  const item = await getDownload(id);

  const flags = await withState((state) => ({
    abandoned: Boolean(state[id] && state[id].abandoned),
    respectUser: Boolean(state[id] && state[id].respectUser),
    announced: Boolean(state[id] && state[id].announced)
  }));

  if (flags.abandoned || flags.respectUser) return;

  if (!isStopped(item)) {
    await withState((state) => {
      delete state[id];
    });
    return;
  }

  const online = await isOnline();
  const offlineAt = await lastOfflineAt();
  const offlineRecently = Date.now() - offlineAt < OFFLINE_GRACE_SECONDS * 1000;

  const verdict = classify(item, { currentlyOffline: !online, offlineRecently: offlineRecently });

  if (verdict === "ignore") return;

  if (verdict === "permanent" || verdict === "user-canceled" || verdict === "user-paused") {
    const explanations = {
      "permanent": `error "${item.error}" will not fix itself`,
      "user-canceled": `looks like you cancelled it (error "${item.error}", connection was up)`,
      "user-paused": "looks like you paused it deliberately"
    };

    if (!flags.announced) {
      log(`#${id} (${displayName(item)}) left alone — ${explanations[verdict]}`);
      log(`   if that's wrong, run:  forgetDecision(${id})`);
    }
    await withState((state) => {
      state[id] = touch({ respectUser: true, announced: true, why: verdict });
    });
    return;
  }

  // verdict === "network" from here on.

  if (!online) {
    if (!flags.announced) {
      log(`#${id} (${displayName(item)}) is stopped, but we're offline — waiting, no strike counted`);
      await withState((state) => {
        const entry = state[id] || { attempts: 0, nextTryAt: 0, lastBytes: item.bytesReceived };
        entry.announced = true;
        state[id] = touch(entry);
      });
    }
    return;
  }

  await withState(async (state) => {
    const now = Date.now();
    const entry = state[id] || { attempts: 0, nextTryAt: 0, lastBytes: 0 };
    entry.announced = false;

    if (item.bytesReceived > entry.lastBytes) {
      if (entry.attempts > 0) log(`#${id} made progress, resetting strike counter`);
      entry.attempts = 0;
    }
    entry.lastBytes = item.bytesReceived;

    if (now < entry.nextTryAt && !(immediate && entry.attempts === 0)) {
      state[id] = touch(entry);
      return;
    }

    if (entry.attempts >= MAX_ATTEMPTS) {
      delete state[id];
      await giveUp(item, `failed ${MAX_ATTEMPTS} times in a row while online`);
      return;
    }

    if (!item.canResume) {
      log(`#${id} (${displayName(item)}) cannot be resumed (error: ${item.error || "none"})`);
      await restartFromScratch(item, state);
      return;
    }

    entry.attempts += 1;
    const wait = delayForAttempt(entry.attempts);
    entry.nextTryAt = now + wait;
    state[id] = touch(entry);

    try {
      await browser.downloads.resume(id);
      log(
        `attempt ${entry.attempts}/${MAX_ATTEMPTS} on #${id} (${displayName(item)}): accepted` +
        ` — next attempt in ${Math.round(wait / 1000)}s if it breaks again`
      );
    } catch (err) {
      log(`attempt ${entry.attempts}/${MAX_ATTEMPTS} on #${id} (${displayName(item)}): failed —`, err);
    }

    if (wait <= 25000) {
      setTimeout(() => handleBroken(id), wait + 100);
    }
  });
}

/* ---------- finding stopped downloads ------------------------------------- */

async function findStopped() {
  const interrupted = await browser.downloads.search({ state: "interrupted" });
  const paused = await browser.downloads.search({ paused: true });

  const seen = new Set();
  const all = [];
  for (const item of interrupted.concat(paused)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    all.push(item);
  }
  return all;
}

/* ---------- connectivity came back ---------------------------------------- */

async function onConnectivityRestored(why) {
  const stopped = await findStopped();
  if (stopped.length === 0) return;

  log(`connection restored (${why}) — clearing strikes on ${stopped.length} stopped download(s)`);

  await withState((state) => {
    for (const item of stopped) {
      if (state[item.id] && (state[item.id].abandoned || state[item.id].respectUser)) continue;
      state[item.id] = touch({ attempts: 0, nextTryAt: 0, lastBytes: item.bytesReceived });
    }
  });

  for (const item of stopped) {
    handleBroken(item.id, { immediate: true });
  }
}

/* ---------- housekeeping -------------------------------------------------- */

async function pruneOldEntries() {
  await withState((state) => {
    const cutoff = Date.now() - STATE_MAX_AGE_MS;
    for (const key of Object.keys(state)) {
      const entry = state[key];
      if (!entry || !entry.updatedAt || entry.updatedAt < cutoff) delete state[key];
    }
  });
}

/* ---------- manual override ------------------------------------------------
   If the extension wrongly decided "you cancelled this", run this in the
   console to make it forget and start watching that download again:

     forgetDecision(2)      <- where 2 is the download id
     forgetDecision()       <- forget every decision
--------------------------------------------------------------------------- */
async function forgetDecision(id) {
  await withState((state) => {
    if (id === undefined) {
      for (const key of Object.keys(state)) delete state[key];
      log("cleared all remembered decisions");
    } else {
      delete state[id];
      log(`cleared remembered decision for #${id}`);
    }
  });
  if (id !== undefined) handleBroken(id, { immediate: true });
}
self.forgetDecision = forgetDecision;

/* ---------- a look at what Firefox thinks ----------------------------------
   Run  showDownloads()  in the console to dump the real properties.
--------------------------------------------------------------------------- */
async function showDownloads(limit) {
  const items = await browser.downloads.search({});
  const rows = items.slice(0, limit || 8).map((i) => ({
    id: i.id,
    file: shortName(i),
    state: i.state,
    paused: i.paused,
    canResume: i.canResume,
    error: i.error,
    gotMB: Math.round(i.bytesReceived / 1048576),
    totalMB: i.totalBytes > 0 ? Math.round(i.totalBytes / 1048576) : -1
  }));
  console.table(rows);
  return rows;
}
self.showDownloads = showDownloads;

/* ---------- event listeners ----------------------------------------------- */

browser.downloads.onChanged.addListener((delta) => {
  const brokeNow = delta.state && delta.state.current === "interrupted";
  const pausedNow = delta.paused && delta.paused.current === true;

  if (brokeNow || pausedNow) {
    setTimeout(() => {
      handleBroken(delta.id, { immediate: true });
    }, FIRST_RETRY_SECONDS * 1000);
  }

  if (delta.state && delta.state.current === "complete") {
    withState((state) => {
      delete state[delta.id];
    });
  }
});

browser.downloads.onErased.addListener((id) => {
  withState((state) => {
    if (state[id] && state[id].abandoned) return;
    delete state[id];
  });
});

// Works only while the background page happens to be awake. The alarm below
// is the reliable path — a plain DOM event cannot wake a suspended page.
self.addEventListener("online", () => onConnectivityRestored("network interface up"));

if (typeof browser.captivePortal !== "undefined") {
  browser.captivePortal.onConnectivityAvailable.addListener(() =>
    onConnectivityRestored("captive portal service reports connectivity")
  );
}

browser.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_EVERY_MINUTES });

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  await pruneOldEntries();

  const online = await isOnline();
  const stopped = await findStopped();

  if (stopped.length === 0) return;

  // Just came back from being offline? Clear strikes first, then retry.
  if (online) {
    const offlineAt = await lastOfflineAt();
    const gapMs = CHECK_EVERY_MINUTES * 60 * 1000 * 3;
    if (offlineAt > 0 && Date.now() - offlineAt < gapMs) {
      await onConnectivityRestored("sweep noticed we're back online");
      return;
    }
  }

  for (const item of stopped) {
    await handleBroken(item.id);
  }
});

log("loaded (v3) — watching downloads. Online right now:", navigator.onLine);