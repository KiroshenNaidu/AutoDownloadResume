/* ============================================================
   SETTINGS live in settings.js (defaults) and on the Options tab
   (about:addons → Download Auto-Resume → Options).

   This file reads them through the `settings` object below, e.g.
   settings.MAX_ATTEMPTS. You shouldn't need to change anything here.
   ============================================================ */

// Start with the defaults; loadSettings() swaps in the user's saved choices.
let settings = Object.assign({}, DEFAULT_SETTINGS);

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

/* ---------- loading settings ----------------------------------------------- */

// (Re)create the wake-up alarm using the current check interval. Creating an
// alarm with the same name replaces the old one.
function startAlarm() {
  browser.alarms.create(ALARM_NAME, {
    periodInMinutes: Math.max(0.5, settings.CHECK_EVERY_MINUTES)
  });
}

async function loadSettings() {
  try {
    const stored = await browser.storage.local.get(SETTINGS_KEY);
    settings = cleanSettings(stored[SETTINGS_KEY]).settings;
  } catch (err) {
    log("could not load settings, using defaults:", err);
  }
  startAlarm();
}

// Reading storage takes a moment, but the background page is an "event page":
// Firefox may wake it up JUST to deliver one event, and the listeners must be
// registered straight away (not after an await) or that event is lost.
// So listeners are registered at the bottom of this file as usual, and each one
// waits for this promise before it looks at any setting.
const settingsReady = loadSettings();

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
  if (!settings.SHOW_NOTIFICATIONS) return;
  try {
    await browser.notifications.create({ type: "basic", title, message });
  } catch (err) {
    log("could not show notification:", err);
  }
}

function delayForAttempt(attemptNumber) {
  const seconds =
    settings.FIRST_RETRY_SECONDS * Math.pow(settings.BACKOFF_MULTIPLIER, Math.max(0, attemptNumber - 1));
  return Math.min(seconds, settings.MAX_RETRY_DELAY_SECONDS) * 1000;
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
    return settings.ASSUME_USER_CANCELED_IS_REAL ? "user-canceled" : "network";
  }

  if (NETWORK_ERRORS.has(error)) return "network";

  if (item.paused === true) {
    if (settings.RESUME_NETWORK_PAUSES && networkBlamed) return "network";
    return "user-paused";
  }

  // Interrupted with no error we recognise — worth a try.
  return "network";
}

/* ---------- giving up ----------------------------------------------------- */

async function giveUp(item, reason) {
  log(`giving up on #${item.id} (${displayName(item)}): ${reason}`);

  if (settings.CANCEL_WHEN_GIVING_UP) {
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
  if (!settings.RESTART_WHEN_CANNOT_RESUME) {
    await giveUp(item, "this download cannot be resumed");
    return;
  }

  if (!/^https?:\/\//i.test(item.url || "")) {
    await giveUp(item, "cannot be resumed and its link cannot be re-requested");
    return;
  }

  const sizeMB = item.totalBytes > 0 ? Math.round(item.totalBytes / (1024 * 1024)) : -1;

  if (settings.MAX_RESTART_SIZE_MB > 0 && item.totalBytes > settings.MAX_RESTART_SIZE_MB * 1024 * 1024) {
    state[item.id] = touch({ respectUser: true, announced: true, why: "too big to auto-restart" });
    log(
      `#${item.id} (${displayName(item)}) cannot be resumed and is ${sizeMB} MB — ` +
      `over the ${settings.MAX_RESTART_SIZE_MB} MB auto-restart limit. Leaving it for you to decide.`
    );
    await notify(
      "Download needs your attention",
      `"${displayName(item)}" can't be resumed and is too big to restart automatically.`
    );
    return;
  }

  const urlKey = "url:" + item.url;
  const record = state[urlKey] || { restarts: 0 };

  if (record.restarts >= settings.MAX_RESTARTS) {
    delete state[urlKey];
    await giveUp(item, `restarted ${settings.MAX_RESTARTS} times and still failing`);
    return;
  }

  record.restarts += 1;
  state[urlKey] = touch(record);
  state[item.id] = touch({ abandoned: true });

  const options = { url: item.url, conflictAction: settings.RESTART_CONFLICT_ACTION };
  const name = shortName(item);
  if (name) options.filename = name;

  try {
    const newId = await browser.downloads.download(options);
    log(
      `restart ${record.restarts}/${settings.MAX_RESTARTS} of "${displayName(item)}" ` +
      `from scratch — new download #${newId}`
    );
  } catch (err) {
    try {
      const newId = await browser.downloads.download({
        url: item.url,
        conflictAction: settings.RESTART_CONFLICT_ACTION
      });
      log(`restart ${record.restarts}/${settings.MAX_RESTARTS} of "${displayName(item)}" — new download #${newId}`);
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
  await settingsReady;
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
  const offlineRecently = Date.now() - offlineAt < settings.OFFLINE_GRACE_SECONDS * 1000;

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

    if (entry.attempts >= settings.MAX_ATTEMPTS) {
      delete state[id];
      await giveUp(item, `failed ${settings.MAX_ATTEMPTS} times in a row while online`);
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

    // Do NOT wait for resume() to answer. Firefox only answers when the download
    // FINISHES or breaks again — possibly hours later. Waiting here would keep
    // the state lock that whole time, and every other broken download would sit
    // there un-rescued until this one was done.
    const label = `attempt ${entry.attempts}/${settings.MAX_ATTEMPTS} on #${id} (${displayName(item)})`;
    log(`${label}: resuming — next attempt in ${Math.round(wait / 1000)}s if it breaks again`);
    browser.downloads.resume(id).catch((err) => {
      log(`${label}: stopped again or was refused —`, err);
    });

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

browser.downloads.onChanged.addListener(async (delta) => {
  await settingsReady;
  const brokeNow = delta.state && delta.state.current === "interrupted";
  const pausedNow = delta.paused && delta.paused.current === true;

  if (brokeNow || pausedNow) {
    setTimeout(() => {
      handleBroken(delta.id, { immediate: true });
    }, settings.FIRST_RETRY_SECONDS * 1000);
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

// The alarm itself is created by loadSettings() above, once we know the interval.

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await settingsReady;

  await pruneOldEntries();

  const online = await isOnline();
  const stopped = await findStopped();

  if (stopped.length === 0) return;

  // Just came back from being offline? Clear strikes first, then retry.
  if (online) {
    const offlineAt = await lastOfflineAt();
    const gapMs = settings.CHECK_EVERY_MINUTES * 60 * 1000 * 3;
    if (offlineAt > 0 && Date.now() - offlineAt < gapMs) {
      await onConnectivityRestored("sweep noticed we're back online");
      return;
    }
  }

  for (const item of stopped) {
    await handleBroken(item.id);
  }
});

// The user pressed Save on the Options tab — use the new settings right away,
// no reload needed. (This also fires for our own "autoResumeState" writes,
// which we skip.)
browser.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local" || !changes[SETTINGS_KEY]) return;
  await settingsReady;

  const oldInterval = settings.CHECK_EVERY_MINUTES;
  settings = cleanSettings(changes[SETTINGS_KEY].newValue).settings;
  log("settings updated:", settings);

  if (settings.CHECK_EVERY_MINUTES !== oldInterval) startAlarm();
});

log(
  `loaded (v${browser.runtime.getManifest().version}) — watching downloads. Online right now:`,
  navigator.onLine
);