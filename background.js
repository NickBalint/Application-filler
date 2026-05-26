const VAULT_KEY = "secureVault";
const VAULT_META_KEY = "secureVaultMeta";
const PASSPHRASE_SESSION_KEY = "vaultPassphrase";
const PBKDF2_ITERATIONS = 250000;

async function getOrCreateMeta() {
  const data = await chrome.storage.local.get(VAULT_META_KEY);
  if (data[VAULT_META_KEY]) {
    return data[VAULT_META_KEY];
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const meta = {
    version: 1,
    iterations: PBKDF2_ITERATIONS,
    salt: arrayBufferToBase64(salt.buffer)
  };

  await chrome.storage.local.set({ [VAULT_META_KEY]: meta });
  return meta;
}

async function setPassphrase(passphrase) {
  await chrome.storage.session.set({ [PASSPHRASE_SESSION_KEY]: passphrase });
}

async function clearPassphrase() {
  await chrome.storage.session.remove(PASSPHRASE_SESSION_KEY);
}

async function getPassphrase() {
  const data = await chrome.storage.session.get(PASSPHRASE_SESSION_KEY);
  return data[PASSPHRASE_SESSION_KEY] || null;
}

async function deriveAesKey(passphrase, meta) {
  const enc = new TextEncoder();
  const passphraseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: base64ToArrayBuffer(meta.salt),
      iterations: meta.iterations,
      hash: "SHA-256"
    },
    passphraseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function defaultVault() {
  return {
    version: 1,
    domains: {}
  };
}

async function loadVault(passphrase) {
  const meta = await getOrCreateMeta();
  const key = await deriveAesKey(passphrase, meta);
  const data = await chrome.storage.local.get(VAULT_KEY);
  const blob = data[VAULT_KEY];

  if (!blob) {
    return defaultVault();
  }

  try {
    const iv = base64ToArrayBuffer(blob.iv);
    const ciphertext = base64ToArrayBuffer(blob.ciphertext);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv) },
      key,
      ciphertext
    );

    const json = new TextDecoder().decode(plaintext);
    return JSON.parse(json);
  } catch (error) {
    throw new Error("Unable to unlock vault. Check your passphrase.");
  }
}

async function saveVault(passphrase, vaultData) {
  const meta = await getOrCreateMeta();
  const key = await deriveAesKey(passphrase, meta);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(vaultData));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  await chrome.storage.local.set({
    [VAULT_KEY]: {
      iv: arrayBufferToBase64(iv.buffer),
      ciphertext: arrayBufferToBase64(ciphertext)
    }
  });
}

function normalizeDomain(hostname) {
  return hostname.replace(/^www\./, "").toLowerCase();
}

function mergeDomainFields(existingFields, incomingFields) {
  const byKey = new Map();

  for (const field of existingFields) {
    byKey.set(field.key, field);
  }

  for (const field of incomingFields) {
    byKey.set(field.key, {
      key: field.key,
      selector: field.selector,
      label: field.label,
      value: field.value,
      updatedAt: Date.now()
    });
  }

  return Array.from(byKey.values());
}

async function saveFieldsToVault(hostname, fields) {
  const passphrase = await getPassphrase();
  if (!passphrase) {
    throw new Error("Vault is locked. Unlock first.");
  }

  const vault = await loadVault(passphrase);
  const domain = normalizeDomain(hostname);
  const current = vault.domains[domain] || { fields: [] };
  const sanitizedFields = fields
    .filter((field) => field && field.key && typeof field.value === "string")
    .map((field) => ({
      key: field.key,
      selector: field.selector || "",
      label: field.label || "",
      value: field.value
    }));

  vault.domains[domain] = {
    fields: mergeDomainFields(current.fields, sanitizedFields)
  };

  await saveVault(passphrase, vault);
  return { savedCount: sanitizedFields.length };
}

async function getFieldsForDomain(hostname) {
  const passphrase = await getPassphrase();
  if (!passphrase) {
    throw new Error("Vault is locked. Unlock first.");
  }

  const vault = await loadVault(passphrase);
  const domain = normalizeDomain(hostname);
  return vault.domains[domain]?.fields || [];
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case "unlock": {
          if (!message.passphrase || message.passphrase.length < 8) {
            throw new Error("Passphrase must be at least 8 characters.");
          }
          await getOrCreateMeta();
          await setPassphrase(message.passphrase);

          const existingVault = await chrome.storage.local.get(VAULT_KEY);
          if (existingVault[VAULT_KEY]) {
            await loadVault(message.passphrase);
          } else {
            await saveVault(message.passphrase, defaultVault());
          }

          sendResponse({ ok: true });
          break;
        }
        case "lock": {
          await clearPassphrase();
          sendResponse({ ok: true });
          break;
        }
        case "isUnlocked": {
          const passphrase = await getPassphrase();
          sendResponse({ ok: true, unlocked: Boolean(passphrase) });
          break;
        }
        case "saveFields": {
          const result = await saveFieldsToVault(message.hostname, message.fields || []);
          sendResponse({ ok: true, ...result });
          break;
        }
        case "getFields": {
          const fields = await getFieldsForDomain(message.hostname);
          sendResponse({ ok: true, fields });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown action." });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "Unexpected error." });
    }
  })();

  return true;
});
