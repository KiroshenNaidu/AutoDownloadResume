/* The Options page. settings.js is loaded first (see options.html), so
   DEFAULT_SETTINGS, SETTING_RULES, SETTINGS_KEY and cleanSettings() are
   available here. */

const form = document.getElementById("settings-form");
const statusText = document.getElementById("status");

// Show a message next to the buttons. kind is "ok", "warn" or "" (plain).
function showStatus(message, kind) {
  statusText.textContent = message;
  statusText.className = kind || "";
}

// Put a settings object into the form boxes.
function fillForm(values) {
  for (const name of Object.keys(DEFAULT_SETTINGS)) {
    const input = document.getElementById(name);
    if (input.type === "checkbox") {
      input.checked = values[name];
    } else {
      input.value = values[name];
    }
  }
}

// Read the form boxes back into an object. Numbers come out as text here;
// cleanSettings() turns them into real numbers and checks them.
function readForm() {
  const values = {};
  for (const name of Object.keys(DEFAULT_SETTINGS)) {
    const input = document.getElementById(name);
    values[name] = input.type === "checkbox" ? input.checked : input.value;
  }
  return values;
}

// Turn a setting name into the wording of its label, for messages.
// e.g. "MAX_ATTEMPTS" -> "Give up after"
function labelFor(name) {
  const label = document.querySelector(`label[for="${name}"]`) ||
    document.getElementById(name).closest("label");
  return label ? label.textContent.trim() : name;
}

// Using the rules from settings.js, give each number box its limits and add
// "Default: 30 · allowed 1 to 1000" under it.
function addLimitsToForm() {
  for (const [name, rule] of Object.entries(SETTING_RULES)) {
    if (rule.type !== "number") continue;

    const input = document.getElementById(name);
    input.min = rule.min;
    input.max = rule.max;
    input.step = rule.whole ? 1 : "any";

    const hint = document.querySelector(`.hint[data-for="${name}"]`);
    if (hint) {
      const limits = `Default: ${DEFAULT_SETTINGS[name]} · allowed ${rule.min} to ${rule.max}.`;
      hint.textContent = (hint.textContent.trim() + " " + limits).trim();
    }
  }
}

async function load() {
  addLimitsToForm();
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  fillForm(cleanSettings(stored[SETTINGS_KEY]).settings);
}

async function save(event) {
  event.preventDefault(); // stop the page reloading, which is what forms do by default

  const { settings, problems } = cleanSettings(readForm());

  try {
    await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch (err) {
    showStatus("Could not save: " + err.message, "warn");
    return;
  }

  // Show what was actually saved — invalid boxes now hold their default.
  fillForm(settings);

  if (problems.length === 0) {
    showStatus("Saved ✓", "ok");
  } else {
    const list = problems.map((name) => `"${labelFor(name)}"`).join(", ");
    const verb = problems.length === 1 ? "wasn't valid and was" : "weren't valid and were";
    showStatus(`Saved, but ${list} ${verb} reset to the default.`, "warn");
  }
}

function restoreDefaults() {
  fillForm(DEFAULT_SETTINGS);
  showStatus("Defaults filled in — press Save to keep them.", "");
}

form.addEventListener("submit", save);
document.getElementById("restore").addEventListener("click", restoreDefaults);

// Any edit clears the old "Saved ✓" so it's clear the change isn't saved yet.
form.addEventListener("input", () => showStatus("Unsaved changes", ""));

load().catch((err) => showStatus("Could not load settings: " + err.message, "warn"));
