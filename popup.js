const passphraseInput = document.getElementById("passphrase");
const profileSelect = document.getElementById("profileSelect");
const newProfileNameInput = document.getElementById("newProfileName");
const createProfileBtn = document.getElementById("createProfileBtn");
const switchProfileBtn = document.getElementById("switchProfileBtn");
const unlockBtn = document.getElementById("unlockBtn");
const lockBtn = document.getElementById("lockBtn");
const saveBtn = document.getElementById("saveBtn");
const fillBtn = document.getElementById("fillBtn");
const manualLearnToggle = document.getElementById("manualLearnToggle");
const statusEl = document.getElementById("status");

let isUnlocked = false;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#b42318" : "#5b667a";
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || { ok: false, error: "No response from extension." });
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response from page." });
    });
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function syncManualLearningToActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return;
  }

  await sendTabMessage(tab.id, {
    action: "setManualLearning",
    enabled: Boolean(manualLearnToggle.checked)
  });
}

async function refreshSettings() {
  const response = await sendRuntimeMessage({ action: "getSettings" });
  if (!response.ok) {
    setStatus(response.error || "Failed to load settings.", true);
    return;
  }

  manualLearnToggle.checked = Boolean(response.settings?.learnFromManualInput);
}

function normalizeProfileName(name) {
  const cleaned = String(name || "").trim().toLowerCase();
  if (!cleaned) {
    return "default";
  }
  return cleaned.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "default";
}

function renderProfiles(profiles, activeProfile) {
  const normalized = Array.from(new Set((profiles || []).map((profile) => normalizeProfileName(profile))));
  const options = normalized.length > 0 ? normalized : ["default"];

  profileSelect.innerHTML = "";
  for (const profile of options) {
    const option = document.createElement("option");
    option.value = profile;
    option.textContent = profile;
    profileSelect.appendChild(option);
  }

  const selected = options.includes(activeProfile) ? activeProfile : options[0];
  profileSelect.value = selected;
}

async function refreshProfiles() {
  const response = await sendRuntimeMessage({ action: "listProfiles" });
  if (!response.ok) {
    setStatus(response.error || "Failed to load usernames.", true);
    return;
  }

  renderProfiles(response.profiles || ["default"], normalizeProfileName(response.activeProfile || "default"));
}

async function refreshLockState() {
  const response = await sendRuntimeMessage({ action: "isUnlocked" });
  const unlocked = Boolean(response?.ok && response.unlocked);
  isUnlocked = unlocked;

  passphraseInput.disabled = unlocked;
  unlockBtn.disabled = unlocked;
  lockBtn.disabled = !unlocked;
  saveBtn.disabled = !unlocked;
  fillBtn.disabled = !unlocked;
  createProfileBtn.disabled = !unlocked;
  switchProfileBtn.disabled = !unlocked;

  const activeProfile = normalizeProfileName(response?.activeProfile || profileSelect.value || "default");
  if (unlocked) {
    if (profileSelect.value !== activeProfile) {
      profileSelect.value = activeProfile;
    }
    setStatus(`Vault unlocked as ${activeProfile}.`);
  } else {
    setStatus("Vault locked.");
  }
}

unlockBtn.addEventListener("click", async () => {
  const passphrase = passphraseInput.value;
  const profileName = normalizeProfileName(profileSelect.value || "default");
  const response = await sendRuntimeMessage({ action: "unlock", passphrase, profileName });

  if (!response.ok) {
    setStatus(response.error || "Failed to unlock vault.", true);
    return;
  }

  passphraseInput.value = "";
  await refreshProfiles();
  await refreshLockState();
  await syncManualLearningToActiveTab();
});

lockBtn.addEventListener("click", async () => {
  const response = await sendRuntimeMessage({ action: "lock" });
  if (!response.ok) {
    setStatus(response.error || "Failed to lock vault.", true);
    return;
  }

  passphraseInput.disabled = false;
  passphraseInput.focus();
  await refreshLockState();
});

createProfileBtn.addEventListener("click", async () => {
  if (!isUnlocked) {
    setStatus("Unlock first to create usernames.", true);
    return;
  }

  const rawName = String(newProfileNameInput.value || "").trim();
  if (!rawName) {
    setStatus("Enter a valid username.", true);
    return;
  }
  const requested = normalizeProfileName(rawName);

  const response = await sendRuntimeMessage({
    action: "switchProfile",
    profileName: requested,
    createIfMissing: true
  });

  if (!response.ok) {
    setStatus(response.error || "Failed to create username.", true);
    return;
  }

  newProfileNameInput.value = "";
  renderProfiles(response.profiles || [requested], normalizeProfileName(response.activeProfile || requested));
  await refreshLockState();
  await syncManualLearningToActiveTab();
});

switchProfileBtn.addEventListener("click", async () => {
  if (!isUnlocked) {
    setStatus("Unlock first to switch users.", true);
    return;
  }

  const selected = normalizeProfileName(profileSelect.value || "default");
  const response = await sendRuntimeMessage({
    action: "switchProfile",
    profileName: selected,
    createIfMissing: false
  });

  if (!response.ok) {
    setStatus(response.error || "Failed to switch user.", true);
    return;
  }

  renderProfiles(response.profiles || [selected], normalizeProfileName(response.activeProfile || selected));
  await refreshLockState();
  await syncManualLearningToActiveTab();
});

saveBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    setStatus("No active tab found.", true);
    return;
  }

  const collected = await sendTabMessage(tab.id, { action: "collectFilledFields" });
  if (!collected.ok) {
    setStatus(collected.error || "Unable to read fields from this page.", true);
    return;
  }

  if (!collected.fields || collected.fields.length === 0) {
    setStatus("No filled fields found on this page.", true);
    return;
  }

  const saved = await sendRuntimeMessage({
    action: "saveFields",
    fields: collected.fields
  });

  if (!saved.ok) {
    setStatus(saved.error || "Failed to save fields.", true);
    return;
  }

  setStatus(`Saved ${saved.savedCount} field(s) to your secure profile.`);
});

fillBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    setStatus("No active tab found.", true);
    return;
  }

  const fieldsResp = await sendRuntimeMessage({ action: "getFields" });

  if (!fieldsResp.ok) {
    setStatus(fieldsResp.error || "Failed to load saved fields.", true);
    return;
  }

  if (!fieldsResp.fields || fieldsResp.fields.length === 0) {
    setStatus("No saved profile fields yet.", true);
    return;
  }

  const result = await sendTabMessage(tab.id, {
    action: "autofillFields",
    fields: fieldsResp.fields,
    aliasModel: fieldsResp.aliasModel || {}
  });

  if (!result.ok) {
    setStatus(result.error || "Failed to autofill fields.", true);
    return;
  }

  setStatus(`Autofilled ${result.filledCount} field(s).`);
});

manualLearnToggle.addEventListener("change", async () => {
  const response = await sendRuntimeMessage({
    action: "updateSettings",
    settings: {
      learnFromManualInput: Boolean(manualLearnToggle.checked)
    }
  });

  if (!response.ok) {
    setStatus(response.error || "Failed to update settings.", true);
    return;
  }

  await syncManualLearningToActiveTab();
  setStatus(manualLearnToggle.checked ? "Manual learning enabled." : "Manual learning disabled.");
});

document.addEventListener("DOMContentLoaded", async () => {
  await refreshProfiles();
  await refreshSettings();
  await refreshLockState();
  await syncManualLearningToActiveTab();
});
