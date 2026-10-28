/* Tests for background.js — what the extension does with broken downloads,
   and whether it picks up settings changes.
   Run all tests with:  node --test test/  */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadExtension, makeDownload, plain, flush } = require("./fake-firefox");

const MB = 1024 * 1024;

// Load the extension with some saved settings and downloads, and wait for it
// to be ready.
async function start(options = {}) {
  const ext = loadExtension(options);
  await ext.ready();
  return ext;
}

// The extension's own bookkeeping, as saved in storage.
function stateOf(ext) {
  return ext.store.autoResumeState || {};
}

/* ---------- starting up and settings ---------------------------------------- */

test("listeners are registered straight away, before settings finish loading", () => {
  // Firefox can wake the background page just to deliver one event; a
  // listener added after an await would miss it.
  const ext = loadExtension();
  assert.equal(ext.events.downloadsChanged.listeners.length, 1);
  assert.equal(ext.events.downloadsErased.listeners.length, 1);
  assert.equal(ext.events.alarm.listeners.length, 1);
  assert.equal(ext.events.storageChanged.listeners.length, 1);
  assert.equal(ext.events.connectivity.listeners.length, 1);
  assert.equal(typeof ext.domListeners.online, "function");
});

test("with nothing saved, it uses the defaults and a 30-second alarm", async () => {
  const ext = await start();
  assert.deepEqual(plain(ext.run("settings")), plain(ext.run("DEFAULT_SETTINGS")));
  assert.deepEqual(ext.calls.alarms, [{ name: "auto-resume-sweep", periodInMinutes: 0.5 }]);
});

test("saved settings are used, and invalid saved values fall back to defaults", async () => {
  const ext = await start({
    stored: { settings: { MAX_ATTEMPTS: 50, CHECK_EVERY_MINUTES: 2, MAX_RESTARTS: -4 } }
  });
  assert.equal(ext.run("settings.MAX_ATTEMPTS"), 50);
  assert.equal(ext.run("settings.MAX_RESTARTS"), 3);
  assert.deepEqual(ext.calls.alarms, [{ name: "auto-resume-sweep", periodInMinutes: 2 }]);
});

test("pressing Save applies new settings immediately", async () => {
  const ext = await start();
  await ext.browser.storage.local.set({ settings: { MAX_ATTEMPTS: 99 } });
  await flush();
  assert.equal(ext.run("settings.MAX_ATTEMPTS"), 99);
  // Interval didn't change, so the alarm is left alone.
  assert.equal(ext.calls.alarms.length, 1);
});

test("changing the check interval recreates the alarm", async () => {
  const ext = await start();
  await ext.browser.storage.local.set({ settings: { CHECK_EVERY_MINUTES: 5 } });
  await flush();
  assert.deepEqual(ext.calls.alarms.at(-1), { name: "auto-resume-sweep", periodInMinutes: 5 });
});

test("the extension's own bookkeeping writes don't touch the settings", async () => {
  const ext = await start({ stored: { settings: { MAX_ATTEMPTS: 7 } } });
  await ext.browser.storage.local.set({ autoResumeState: {} });
  await flush();
  assert.equal(ext.run("settings.MAX_ATTEMPTS"), 7);
  assert.equal(ext.calls.alarms.length, 1);
});

test("forgetDecision() clears decisions but never the settings", async () => {
  const ext = await start({
    stored: { settings: { MAX_ATTEMPTS: 7 }, autoResumeState: { 5: { respectUser: true } } }
  });
  await ext.run("forgetDecision()");
  assert.deepEqual(plain(ext.store.autoResumeState), {});
  assert.deepEqual(plain(ext.store.settings), { MAX_ATTEMPTS: 7 });
});

/* ---------- waiting times ---------------------------------------------------- */

test("waiting time doubles each attempt and stops at the maximum (defaults)", async () => {
  const ext = await start();
  const waits = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ext.run(`delayForAttempt(${n})`) / 1000);
  assert.deepEqual(waits, [1, 2, 4, 8, 16, 32, 60, 60]);
});

test("waiting time follows custom settings", async () => {
  const ext = await start({
    stored: { settings: { FIRST_RETRY_SECONDS: 5, BACKOFF_MULTIPLIER: 3, MAX_RETRY_DELAY_SECONDS: 100 } }
  });
  const waits = [1, 2, 3, 4].map((n) => ext.run(`delayForAttempt(${n})`) / 1000);
  assert.deepEqual(waits, [5, 15, 45, 100]);
});

test("a multiplier of 1 keeps every wait the same", async () => {
  const ext = await start({ stored: { settings: { FIRST_RETRY_SECONDS: 10, BACKOFF_MULTIPLIER: 1 } } });
  const waits = [1, 2, 5].map((n) => ext.run(`delayForAttempt(${n})`) / 1000);
  assert.deepEqual(waits, [10, 10, 10]);
});

/* ---------- deciding what to do with a stopped download ---------------------- */

test("a network failure while online is resumed and counted as attempt 1", async () => {
  const ext = await start({ downloads: [makeDownload()] });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, [1]);
  assert.equal(stateOf(ext)[1].attempts, 1);
});

test("while offline it waits: no resume, no strike counted", async () => {
  const ext = await start({ downloads: [makeDownload()], online: false });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, []);
  assert.equal(stateOf(ext)[1].attempts, 0);
});

test("USER_CANCELED while online is treated as you cancelling it", async () => {
  const ext = await start({ downloads: [makeDownload({ error: "USER_CANCELED" })] });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, []);
  assert.equal(stateOf(ext)[1].respectUser, true);
});

test("USER_CANCELED soon after being offline is treated as a network failure", async () => {
  const ext = await start({
    downloads: [makeDownload({ error: "USER_CANCELED" })],
    stored: { autoResumeState: { "meta:offline": { at: Date.now() - 30 * 1000, updatedAt: Date.now() } } }
  });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, [1]);
});

test("USER_CANCELED after the offline grace period has passed is left alone", async () => {
  const ext = await start({
    downloads: [makeDownload({ error: "USER_CANCELED" })],
    stored: {
      settings: { OFFLINE_GRACE_SECONDS: 10 },
      autoResumeState: { "meta:offline": { at: Date.now() - 30 * 1000, updatedAt: Date.now() } }
    }
  });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, []);
});

test("unticking 'assume I cancelled it' retries USER_CANCELED downloads", async () => {
  const ext = await start({
    downloads: [makeDownload({ error: "USER_CANCELED" })],
    stored: { settings: { ASSUME_USER_CANCELED_IS_REAL: false } }
  });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, [1]);
});

test("errors that can't fix themselves (e.g. disk full) are left alone", async () => {
  const ext = await start({ downloads: [makeDownload({ error: "FILE_NO_SPACE" })] });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, []);
  assert.equal(stateOf(ext)[1].why, "permanent");
});

test("a download you paused yourself (while online) is left alone", async () => {
  const ext = await start({
    downloads: [makeDownload({ state: "in_progress", paused: true, error: undefined })]
  });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, []);
  assert.equal(stateOf(ext)[1].why, "user-paused");
});

test("a download that already finished is ignored", async () => {
  const ext = await start({ downloads: [makeDownload({ state: "complete", error: undefined })] });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, []);
});

/* ---------- giving up -------------------------------------------------------- */

const failedThreeTimes = {
  autoResumeState: { 1: { attempts: 3, nextTryAt: 0, lastBytes: 100 * MB, updatedAt: Date.now() } }
};

test("after MAX_ATTEMPTS failures in a row it cancels and notifies", async () => {
  const ext = await start({
    downloads: [makeDownload()],
    stored: { ...failedThreeTimes, settings: { MAX_ATTEMPTS: 3 } }
  });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, []);
  assert.deepEqual(ext.calls.cancel, [1]);
  assert.equal(ext.calls.notify.length, 1);
  assert.match(ext.calls.notify[0].title, /gave up/);
});

test("making progress resets the failure count instead of giving up", async () => {
  const ext = await start({
    downloads: [makeDownload({ bytesReceived: 150 * MB })],
    stored: { ...failedThreeTimes, settings: { MAX_ATTEMPTS: 3 } }
  });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.resume, [1]);
  assert.equal(stateOf(ext)[1].attempts, 1);
});

test("'Cancel the download' unticked: gives up without cancelling", async () => {
  const ext = await start({
    downloads: [makeDownload()],
    stored: { ...failedThreeTimes, settings: { MAX_ATTEMPTS: 3, CANCEL_WHEN_GIVING_UP: false } }
  });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.cancel, []);
  assert.equal(ext.calls.notify.length, 1);
});

test("'Show desktop notifications' unticked: no notification", async () => {
  const ext = await start({
    downloads: [makeDownload()],
    stored: { ...failedThreeTimes, settings: { MAX_ATTEMPTS: 3, SHOW_NOTIFICATIONS: false } }
  });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.cancel, [1]);
  assert.deepEqual(ext.calls.notify, []);
});

/* ---------- downloads that can't be resumed ---------------------------------- */

test("a small download that can't resume is restarted under its old name", async () => {
  const ext = await start({ downloads: [makeDownload({ canResume: false })] });
  await ext.run("handleBroken(1)");
  assert.deepEqual(plain(ext.calls.download), [
    { url: "https://example.com/files/big.zip", conflictAction: "uniquify", filename: "big.zip" }
  ]);
  assert.deepEqual(plain(ext.calls.erase), [{ id: 1 }]);
});

test("the filename-clash setting is passed to Firefox", async () => {
  const ext = await start({
    downloads: [makeDownload({ canResume: false })],
    stored: { settings: { RESTART_CONFLICT_ACTION: "overwrite" } }
  });
  await ext.run("handleBroken(1)");
  assert.equal(ext.calls.download[0].conflictAction, "overwrite");
});

test("files over the size limit are not restarted; you get a notification", async () => {
  const ext = await start({ downloads: [makeDownload({ canResume: false, totalBytes: 6000 * MB })] });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.download, []);
  assert.match(ext.calls.notify[0].title, /attention/);
  assert.equal(stateOf(ext)[1].respectUser, true);
});

test("raising the size limit allows the big restart", async () => {
  const ext = await start({
    downloads: [makeDownload({ canResume: false, totalBytes: 6000 * MB })],
    stored: { settings: { MAX_RESTART_SIZE_MB: 10000 } }
  });
  await ext.run("handleBroken(1)");
  assert.equal(ext.calls.download.length, 1);
});

test("a size limit of 0 means no limit", async () => {
  const ext = await start({
    downloads: [makeDownload({ canResume: false, totalBytes: 50000 * MB })],
    stored: { settings: { MAX_RESTART_SIZE_MB: 0 } }
  });
  await ext.run("handleBroken(1)");
  assert.equal(ext.calls.download.length, 1);
});

test("'Restart them from the beginning' unticked: gives up instead", async () => {
  const ext = await start({
    downloads: [makeDownload({ canResume: false })],
    stored: { settings: { RESTART_WHEN_CANNOT_RESUME: false } }
  });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.download, []);
  assert.deepEqual(ext.calls.cancel, [1]);
});

test("after MAX_RESTARTS restarts of the same link it gives up", async () => {
  const ext = await start({
    downloads: [makeDownload({ canResume: false })],
    stored: {
      settings: { MAX_RESTARTS: 2 },
      autoResumeState: { "url:https://example.com/files/big.zip": { restarts: 2, updatedAt: Date.now() } }
    }
  });
  await ext.run("handleBroken(1)");
  assert.deepEqual(ext.calls.download, []);
  assert.match(ext.calls.notify[0].message, /restarted 2 times/);
});

/* ---------- several downloads at once ----------------------------------------
   Real Firefox's downloads.resume() doesn't answer until the download
   FINISHES or breaks again. Version 2.1 and earlier waited for that answer
   while holding the state lock, so only one download was rescued at a time. */

// Like real Firefox: resume() never answers while the download is running.
const resumeThatKeepsRunning = () => new Promise(() => {});

test("a running resumed download doesn't block other downloads from being rescued", async () => {
  const ext = await start({
    downloads: [makeDownload({ id: 1 }), makeDownload({ id: 2, url: "https://example.com/other.zip" })],
    resume: resumeThatKeepsRunning
  });
  await ext.run("handleBroken(1)");
  await ext.run("handleBroken(2)");
  assert.deepEqual(ext.calls.resume, [1, 2]);
});

test("when the internet comes back, ALL broken downloads are resumed, not just one", async () => {
  const ext = await start({
    downloads: [
      makeDownload({ id: 1 }),
      makeDownload({ id: 2, url: "https://example.com/b.zip" }),
      makeDownload({ id: 3, url: "https://example.com/c.zip" })
    ],
    resume: resumeThatKeepsRunning
  });
  await ext.events.connectivity.fire();
  await flush();
  assert.deepEqual(ext.calls.resume.slice().sort(), [1, 2, 3]);
});

test("a resume that breaks again is logged, not crashed on", async () => {
  const ext = await start({
    downloads: [makeDownload()],
    resume: async () => {
      throw new Error("A transfer was only partially done");
    }
  });
  await ext.run("handleBroken(1)");
  await flush();
  assert.ok(ext.logs.some((line) => line.includes("stopped again or was refused")));
  assert.equal(stateOf(ext)[1].attempts, 1);
});
