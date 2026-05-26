const VAULT_KEY = "secureVault";
const VAULT_META_KEY = "secureVaultMeta";
const PASSPHRASE_SESSION_KEY = "vaultPassphrase";
const ACTIVE_PROFILE_SESSION_KEY = "activeProfileName";
const PROFILE_INDEX_KEY = "profileIndex";
const SETTINGS_KEY = "extensionSettings";
const PBKDF2_ITERATIONS = 250000;

function defaultSettings() {
  return {
    learnFromManualInput: false
  };
}

function defaultProfileData() {
  return {
    profileFields: [],
    aliasModel: {}
  };
}

function defaultVault() {
  return {
    version: 3,
    profiles: {
      default: defaultProfileData()
    }
  };
}

function normalizeProfileName(name) {
  const cleaned = String(name || "").trim().toLowerCase();
  if (!cleaned) {
    return "default";
  }
  return cleaned.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "default";
}

async function getProfileIndex() {
  const data = await chrome.storage.local.get(PROFILE_INDEX_KEY);
  const index = Array.isArray(data[PROFILE_INDEX_KEY]) ? data[PROFILE_INDEX_KEY] : ["default"];
  return Array.from(new Set(index.map((item) => normalizeProfileName(item))));
}

async function setProfileIndex(profileNames) {
  const normalized = Array.from(new Set((profileNames || []).map((name) => normalizeProfileName(name))));
  await chrome.storage.local.set({ [PROFILE_INDEX_KEY]: normalized.length > 0 ? normalized : ["default"] });
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = data[SETTINGS_KEY] && typeof data[SETTINGS_KEY] === "object"
    ? data[SETTINGS_KEY]
    : {};
  return {
    ...defaultSettings(),
    ...saved
  };
}

async function updateSettings(partialSettings) {
  const current = await getSettings();
  const next = {
    ...current,
    ...(partialSettings && typeof partialSettings === "object" ? partialSettings : {})
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

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

async function setActiveProfileName(profileName) {
  await chrome.storage.session.set({ [ACTIVE_PROFILE_SESSION_KEY]: normalizeProfileName(profileName) });
}

async function clearPassphrase() {
  await chrome.storage.session.remove(PASSPHRASE_SESSION_KEY);
}

async function clearActiveProfileName() {
  await chrome.storage.session.remove(ACTIVE_PROFILE_SESSION_KEY);
}

async function getPassphrase() {
  const data = await chrome.storage.session.get(PASSPHRASE_SESSION_KEY);
  return data[PASSPHRASE_SESSION_KEY] || null;
}

async function getActiveProfileName() {
  const data = await chrome.storage.session.get(ACTIVE_PROFILE_SESSION_KEY);
  return normalizeProfileName(data[ACTIVE_PROFILE_SESSION_KEY] || "default");
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

function sanitizeField(field) {
  const tokens = Array.isArray(field.tokens)
    ? field.tokens.filter((token) => typeof token === "string" && token.length > 1)
    : [];

  return {
    key: field.key,
    name: field.name || "",
    id: field.id || "",
    selector: field.selector || "",
    label: field.label || "",
    type: field.type || "",
    canonicalConcept: field.canonicalConcept || "",
    tokens: Array.from(new Set(tokens)),
    value: field.value,
    updatedAt: Date.now()
  };
}

function ensureVaultShape(vault) {
  if (!vault || typeof vault !== "object") {
    return defaultVault();
  }

  if (vault.version === 3 && vault.profiles && typeof vault.profiles === "object") {
    const normalizedProfiles = {};
    for (const [profileName, profileData] of Object.entries(vault.profiles)) {
      const profileKey = normalizeProfileName(profileName);
      normalizedProfiles[profileKey] = {
        profileFields: Array.isArray(profileData?.profileFields) ? profileData.profileFields : [],
        aliasModel: profileData?.aliasModel && typeof profileData.aliasModel === "object" ? profileData.aliasModel : {}
      };
    }

    if (!normalizedProfiles.default) {
      normalizedProfiles.default = defaultProfileData();
    }

    return {
      version: 3,
      profiles: normalizedProfiles
    };
  }

  const migratedFields = [];

  if (Array.isArray(vault.profileFields)) {
    for (const field of vault.profileFields) {
      if (field && field.key && typeof field.value === "string") {
        migratedFields.push(sanitizeField(field));
      }
    }
  }

  if (migratedFields.length === 0 && vault.domains && typeof vault.domains === "object") {
    for (const domainData of Object.values(vault.domains)) {
      const fields = Array.isArray(domainData?.fields) ? domainData.fields : [];
      for (const field of fields) {
        if (field && field.key && typeof field.value === "string") {
          migratedFields.push(sanitizeField(field));
        }
      }
    }
  }

  return {
    version: 3,
    profiles: {
      default: {
        profileFields: migratedFields,
        aliasModel: vault.aliasModel && typeof vault.aliasModel === "object" ? vault.aliasModel : {}
      }
    }
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

function mergeProfileFields(existingFields, incomingFields) {
  const byKey = new Map();

  for (const field of existingFields) {
    const modelKey = field.canonicalConcept
      ? `concept:${field.canonicalConcept}`
      : `field:${field.key}`;
    byKey.set(modelKey, field);
  }

  for (const field of incomingFields) {
    const modelKey = field.canonicalConcept
      ? `concept:${field.canonicalConcept}`
      : `field:${field.key}`;
    byKey.set(modelKey, field);
  }

  return Array.from(byKey.values());
}

function updateAliasModel(aliasModel, fields) {
  const model = aliasModel && typeof aliasModel === "object" ? aliasModel : {};

  for (const field of fields) {
    if (!field.canonicalConcept) {
      continue;
    }

    for (const token of field.tokens || []) {
      if (!model[token]) {
        model[token] = {};
      }
      model[token][field.canonicalConcept] = (model[token][field.canonicalConcept] || 0) + 1;
    }
  }

  return model;
}

function ensureProfile(vault, profileName) {
  const normalizedName = normalizeProfileName(profileName);
  if (!vault.profiles[normalizedName]) {
    vault.profiles[normalizedName] = defaultProfileData();
  }
  return normalizedName;
}

async function saveProfileIndexFromVault(vault) {
  await setProfileIndex(Object.keys(vault.profiles || {}));
}

async function saveFieldsToVault(fields) {
  const passphrase = await getPassphrase();
  if (!passphrase) {
    throw new Error("Vault is locked. Unlock first.");
  }

  const activeProfile = await getActiveProfileName();

  const vault = ensureVaultShape(await loadVault(passphrase));
  const profileName = ensureProfile(vault, activeProfile);
  const sanitizedFields = fields
    .filter((field) => field && field.key && typeof field.value === "string")
    .map((field) => sanitizeField(field));

  const profile = vault.profiles[profileName];
  profile.profileFields = mergeProfileFields(profile.profileFields, sanitizedFields);
  profile.aliasModel = updateAliasModel(profile.aliasModel, sanitizedFields);

  await saveVault(passphrase, vault);
  await saveProfileIndexFromVault(vault);
  return { savedCount: sanitizedFields.length };
}

async function getGlobalFields() {
  const passphrase = await getPassphrase();
  if (!passphrase) {
    throw new Error("Vault is locked. Unlock first.");
  }

  const activeProfile = await getActiveProfileName();
  const vault = ensureVaultShape(await loadVault(passphrase));
  const profileName = ensureProfile(vault, activeProfile);
  const profile = vault.profiles[profileName];

  await saveProfileIndexFromVault(vault);

  return {
    fields: profile.profileFields || [],
    aliasModel: profile.aliasModel || {},
    activeProfile: profileName
  };
}

async function listProfiles() {
  const activeProfile = await getActiveProfileName();
  const profiles = await getProfileIndex();
  return {
    profiles,
    activeProfile
  };
}

async function unlockVault(passphrase, requestedProfileName) {
  if (!passphrase || passphrase.length < 8) {
    throw new Error("Passphrase must be at least 8 characters.");
  }

  const profileName = normalizeProfileName(requestedProfileName || "default");

  await getOrCreateMeta();
  await setPassphrase(passphrase);

  const existingVault = await chrome.storage.local.get(VAULT_KEY);
  let vault;
  if (existingVault[VAULT_KEY]) {
    vault = ensureVaultShape(await loadVault(passphrase));
  } else {
    vault = defaultVault();
  }

  ensureProfile(vault, profileName);
  await saveVault(passphrase, vault);
  await saveProfileIndexFromVault(vault);
  await setActiveProfileName(profileName);

  return {
    activeProfile: profileName,
    profiles: Object.keys(vault.profiles)
  };
}

async function switchProfile(profileName, createIfMissing = false) {
  const passphrase = await getPassphrase();
  if (!passphrase) {
    throw new Error("Vault is locked. Unlock first.");
  }

  const normalizedName = normalizeProfileName(profileName);
  const vault = ensureVaultShape(await loadVault(passphrase));

  if (!vault.profiles[normalizedName]) {
    if (!createIfMissing) {
      throw new Error("Profile not found.");
    }
    vault.profiles[normalizedName] = defaultProfileData();
    await saveVault(passphrase, vault);
  }

  await setActiveProfileName(normalizedName);
  await saveProfileIndexFromVault(vault);

  return {
    activeProfile: normalizedName,
    profiles: Object.keys(vault.profiles)
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case "unlock": {
          const result = await unlockVault(message.passphrase, message.profileName);
          sendResponse({ ok: true, ...result });
          break;
        }
        case "lock": {
          await clearPassphrase();
          await clearActiveProfileName();
          sendResponse({ ok: true });
          break;
        }
        case "isUnlocked": {
          const passphrase = await getPassphrase();
          const activeProfile = await getActiveProfileName();
          sendResponse({ ok: true, unlocked: Boolean(passphrase), activeProfile });
          break;
        }
        case "saveFields": {
          const result = await saveFieldsToVault(message.fields || []);
          sendResponse({ ok: true, ...result });
          break;
        }
        case "getFields": {
          const result = await getGlobalFields();
          sendResponse({ ok: true, ...result });
          break;
        }
        case "getSettings": {
          const settings = await getSettings();
          sendResponse({ ok: true, settings });
          break;
        }
        case "updateSettings": {
          const settings = await updateSettings(message.settings || {});
          sendResponse({ ok: true, settings });
          break;
        }
        case "listProfiles": {
          const result = await listProfiles();
          sendResponse({ ok: true, ...result });
          break;
        }
        case "switchProfile": {
          const result = await switchProfile(message.profileName, Boolean(message.createIfMissing));
          sendResponse({ ok: true, ...result });
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
