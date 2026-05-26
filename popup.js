const passphraseInput = document.getElementById("passphrase");
const unlockBtn = document.getElementById("unlockBtn");
const lockBtn = document.getElementById("lockBtn");
const saveBtn = document.getElementById("saveBtn");
const fillBtn = document.getElementById("fillBtn");
const statusEl = document.getElementById("status");

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

async function refreshLockState() {
  const response = await sendRuntimeMessage({ action: "isUnlocked" });
  const unlocked = Boolean(response?.ok && response.unlocked);

  passphraseInput.disabled = unlocked;
  unlockBtn.disabled = unlocked;
  lockBtn.disabled = !unlocked;
  saveBtn.disabled = !unlocked;
  fillBtn.disabled = !unlocked;

  setStatus(unlocked ? "Vault unlocked." : "Vault locked.");
}

unlockBtn.addEventListener("click", async () => {
  const passphrase = passphraseInput.value;
  const response = await sendRuntimeMessage({ action: "unlock", passphrase });

  if (!response.ok) {
    setStatus(response.error || "Failed to unlock vault.", true);
    return;
  }

  passphraseInput.value = "";
  await refreshLockState();
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

document.addEventListener("DOMContentLoaded", refreshLockState);
