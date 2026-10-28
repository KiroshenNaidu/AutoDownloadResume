/* A pretend Firefox, so the extension's real code can run under Node.

   loadExtension() reads settings.js and background.js from the project folder
   and runs them in a sandbox where `browser` is a fake we control. Tests then
   create pretend downloads, call the extension's functions, and check what it
   tried to do (resume, cancel, notify...).

   Nothing here is shipped with the extension — it's only for `node --test`. */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

// Storage in real Firefox saves a COPY of what you give it. Do the same, so
// the extension can't accidentally change "saved" data without saving it.
function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Values made inside the sandbox belong to a different "realm", which upsets
// assert.deepStrictEqual. Running them through copy() makes them plain again.
const plain = copy;

// Let any pending promises and event handlers finish.
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Make a fake event, e.g. browser.downloads.onChanged.
function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    listeners,
    fire: (...args) => Promise.all(listeners.map((fn) => fn(...args)))
  };
}

/*
  options:
    stored     what browser.storage.local already holds, e.g. { settings: {...} }
    downloads  the pretend download list (objects shaped like Firefox's DownloadItem)
    online     what navigator.onLine says (default true)
    resume     optional function(id) to control what downloads.resume() does
*/
function loadExtension(options = {}) {
  const store = copy(options.stored || {});
  const downloads = options.downloads || [];

  // Every call the extension makes that we care about ends up in here.
  const calls = { resume: [], cancel: [], download: [], erase: [], notify: [], alarms: [] };
  const logs = [];
  const timers = [];
  const domListeners = {};

  const events = {
    storageChanged: makeEvent(),
    downloadsChanged: makeEvent(),
    downloadsErased: makeEvent(),
    alarm: makeEvent(),
    connectivity: makeEvent()
  };

  const browser = {
    storage: {
      local: {
        async get(key) {
          return key in store ? { [key]: copy(store[key]) } : {};
        },
        async set(items) {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: copy(store[key]), newValue: copy(value) };
            store[key] = copy(value);
          }
          // Like Firefox, tell storage.onChanged listeners after saving.
          setImmediate(() => events.storageChanged.fire(changes, "local"));
        }
      },
      onChanged: events.storageChanged
    },

    downloads: {
      // Supports the searches the extension uses: {id}, {state}, {paused}, {}.
      async search(query) {
        return downloads.filter((item) =>
          Object.entries(query).every(([key, value]) => item[key] === value)
        );
      },
      async resume(id) {
        calls.resume.push(id);
        if (options.resume) return options.resume(id);
      },
      async cancel(id) {
        calls.cancel.push(id);
      },
      async download(opts) {
        calls.download.push(opts);
        return 1000 + calls.download.length;
      },
      async erase(query) {
        calls.erase.push(query);
      },
      onChanged: events.downloadsChanged,
      onErased: events.downloadsErased
    },

    alarms: {
      create(name, info) {
        calls.alarms.push({ name, ...info });
      },
      onAlarm: events.alarm
    },

    notifications: {
      async create(opts) {
        calls.notify.push(opts);
      }
    },

    captivePortal: {
      async getState() {
        return "not_captive";
      },
      onConnectivityAvailable: events.connectivity
    },

    runtime: {
      getManifest: () => ({ version: "test" })
    }
  };

  const sandbox = {
    browser,
    navigator: { onLine: options.online !== false },
    console: { log: (...args) => logs.push(args.join(" ")), table() {} },
    // Timers are recorded but NOT run, so tests stay instant and predictable.
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    addEventListener: (type, fn) => {
      domListeners[type] = fn;
    }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  // Load the files in the same order as manifest.json does.
  for (const file of ["settings.js", "background.js"]) {
    const code = fs.readFileSync(path.join(ROOT, file), "utf8");
    vm.runInContext(code, sandbox, { filename: file });
  }

  return {
    browser,
    calls,
    logs,
    timers,
    events,
    domListeners,
    store,
    downloads,
    // Run a bit of code inside the extension, e.g. run("settings.MAX_ATTEMPTS").
    run: (code) => vm.runInContext(code, sandbox),
    // Wait until the extension has finished loading its settings.
    ready: () => vm.runInContext("settingsReady", sandbox)
  };
}

// A pretend download that broke because of the network. Pass in whatever
// should be different, e.g. makeDownload({ id: 2, canResume: false }).
function makeDownload(overrides = {}) {
  return {
    id: 1,
    url: "https://example.com/files/big.zip",
    filename: "C:\\Users\\me\\Downloads\\big.zip",
    state: "interrupted",
    paused: false,
    canResume: true,
    error: "NETWORK_FAILED",
    bytesReceived: 100 * 1024 * 1024,
    totalBytes: 1000 * 1024 * 1024,
    ...overrides
  };
}

module.exports = { loadExtension, makeDownload, plain, flush };
