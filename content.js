const IGNORED_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "image",
  "hidden",
  "file",
  "password"
]);

const CONCEPT_KEYWORDS = {
  phone: ["phone", "cell", "mobile", "telephone", "tel", "phonenumber", "cellphone", "mobilephone"],
  email: ["email", "e-mail", "mail"],
  first_name: ["first", "firstname", "given", "forename"],
  last_name: ["last", "lastname", "surname", "familyname"],
  full_name: ["fullname", "full", "name", "legalname"],
  linkedin: ["linkedin", "linked", "linkedinurl"],
  github: ["github", "git"],
  website: ["website", "site", "url", "portfolio", "personal", "homepage"],
  address: ["address", "street", "addr", "line1", "line2"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  zip: ["zip", "zipcode", "postal", "postcode"],
  country: ["country", "nation"]
};

const autofillSessionState = new WeakMap();
const manualLearnState = new WeakMap();
let learningListenersAttached = false;
let cachedAliasModel = {};

function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function normalizeToken(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokenizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => normalizeToken(token))
    .filter((token) => token.length > 1);
}

function normalizeIdentity(value) {
  return cleanText(value).toLowerCase();
}

function getLabelText(element) {
  if (!element) {
    return "";
  }

  if (element.labels && element.labels.length > 0) {
    return cleanText(Array.from(element.labels).map((label) => label.textContent).join(" "));
  }

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    return cleanText(ariaLabel);
  }

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((node) => node.textContent)
      .join(" ");
    if (text) {
      return cleanText(text);
    }
  }

  return "";
}

function cssEscapeIdentifier(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/([#.;?+*~':"!^$\[\]()=>|/@])/g, "\\$1");
}

function buildSelector(element) {
  if (!element) {
    return "";
  }

  if (element.id) {
    return `#${cssEscapeIdentifier(element.id)}`;
  }

  const parts = [];
  let current = element;
  let depth = 0;

  while (current && current.nodeType === Node.ELEMENT_NODE && depth < 4) {
    let part = current.tagName.toLowerCase();
    if (current.name) {
      part += `[name="${cssEscapeIdentifier(current.name)}"]`;
    } else {
      const siblings = Array.from(current.parentElement?.children || []).filter(
        (node) => node.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }
    }
    parts.unshift(part);
    current = current.parentElement;
    depth += 1;
  }

  return parts.join(" > ");
}

function fieldKey(element) {
  const name = cleanText(element.name || "").toLowerCase();
  const id = cleanText(element.id || "").toLowerCase();
  const label = getLabelText(element).toLowerCase();
  const placeholder = cleanText(element.placeholder || "").toLowerCase();
  const autocomplete = cleanText(element.getAttribute("autocomplete") || "").toLowerCase();
  const signature = [name, id, label, placeholder, autocomplete].filter(Boolean).join("|");

  if (signature) {
    return signature;
  }

  return buildSelector(element).toLowerCase();
}

function buildFieldMeta(element) {
  return {
    name: cleanText(element.name || ""),
    id: cleanText(element.id || ""),
    label: getLabelText(element),
    placeholder: cleanText(element.placeholder || ""),
    autocomplete: cleanText(element.getAttribute("autocomplete") || ""),
    type: cleanText(element.type || element.tagName || "")
  };
}

function inferConcept(meta, aliasModel = {}) {
  const tokens = Array.from(
    new Set(
      [meta.name, meta.id, meta.label, meta.placeholder, meta.autocomplete, meta.type]
        .flatMap((part) => tokenizeText(part))
    )
  );

  const scores = new Map();

  for (const [concept, keywords] of Object.entries(CONCEPT_KEYWORDS)) {
    for (const token of tokens) {
      if (keywords.includes(token)) {
        scores.set(concept, (scores.get(concept) || 0) + 3);
      }
      for (const keyword of keywords) {
        if (token.includes(keyword) || keyword.includes(token)) {
          scores.set(concept, (scores.get(concept) || 0) + 1);
        }
      }
    }
  }

  for (const token of tokens) {
    const learned = aliasModel[token];
    if (!learned || typeof learned !== "object") {
      continue;
    }
    for (const [concept, count] of Object.entries(learned)) {
      scores.set(concept, (scores.get(concept) || 0) + Math.min(Number(count) || 0, 5));
    }
  }

  let bestConcept = "";
  let bestScore = 0;
  for (const [concept, score] of scores.entries()) {
    if (score > bestScore) {
      bestConcept = concept;
      bestScore = score;
    }
  }

  return {
    canonicalConcept: bestScore >= 3 ? bestConcept : "",
    tokens
  };
}

function isCandidateField(element) {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    return false;
  }

  if (element instanceof HTMLInputElement && IGNORED_INPUT_TYPES.has(element.type)) {
    return false;
  }

  return !element.disabled && !element.readOnly;
}

function collectFilledFields() {
  const nodes = Array.from(document.querySelectorAll("input, textarea, select"));
  const fields = [];

  for (const element of nodes) {
    if (!isCandidateField(element)) {
      continue;
    }

    const value = element.value;
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }

    const meta = buildFieldMeta(element);
    const learning = inferConcept(meta);

    fields.push({
      key: fieldKey(element),
      name: meta.name,
      id: meta.id,
      selector: buildSelector(element),
      label: meta.label,
      type: meta.type,
      canonicalConcept: learning.canonicalConcept,
      tokens: learning.tokens,
      value
    });
  }

  return fields;
}

function applyValue(element, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

  if (element instanceof HTMLInputElement && nativeInputValueSetter) {
    nativeInputValueSetter.call(element, value);
  } else if (element instanceof HTMLTextAreaElement && nativeTextAreaValueSetter) {
    nativeTextAreaValueSetter.call(element, value);
  } else {
    element.value = value;
  }

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function attachLearningListeners() {
  if (learningListenersAttached) {
    return;
  }

  const maybeLearnFromEdit = (event) => {
    const element = event.target;
    if (!isCandidateField(element)) {
      return;
    }

    const state = autofillSessionState.get(element);
    const currentValue = typeof element.value === "string" ? element.value.trim() : "";
    if (!currentValue) {
      return;
    }

    if (state && !state.learned) {
      const elapsedSinceAutofill = Math.max(0, Date.now() - Number(state.appliedAt || 0));

      if (currentValue === state.autofilledValue) {
        if (!state.feedbackSent && event.type === "blur" && elapsedSinceAutofill >= 1200) {
          sendFillFeedback(true);
          autofillSessionState.set(element, {
            ...state,
            feedbackSent: true
          });
        }
        return;
      }

      const meta = buildFieldMeta(element);
      const learning = inferConcept(meta, state.aliasModel || cachedAliasModel || {});
      const learnedField = {
        key: fieldKey(element),
        name: meta.name,
        id: meta.id,
        selector: buildSelector(element),
        label: meta.label,
        type: meta.type,
        canonicalConcept: learning.canonicalConcept || state.canonicalConcept || "",
        tokens: learning.tokens,
        value: currentValue
      };

      chrome.runtime.sendMessage(
        {
          action: "saveFields",
          fields: [learnedField]
        },
        () => {
          if (!state.feedbackSent) {
            sendFillFeedback(false);
          }
          autofillSessionState.set(element, {
            ...state,
            feedbackSent: true,
            learned: true
          });
          manualLearnState.set(element, currentValue);
        }
      );
      return;
    }

    const lastSavedValue = manualLearnState.get(element);
    if (lastSavedValue === currentValue) {
      return;
    }

    const meta = buildFieldMeta(element);
    const learning = inferConcept(meta, cachedAliasModel || {});
    const learnedField = {
      key: fieldKey(element),
      name: meta.name,
      id: meta.id,
      selector: buildSelector(element),
      label: meta.label,
      type: meta.type,
      canonicalConcept: learning.canonicalConcept,
      tokens: learning.tokens,
      value: currentValue
    };

    chrome.runtime.sendMessage(
      {
        action: "saveFields",
        fields: [learnedField]
      },
      () => {
        manualLearnState.set(element, currentValue);
      }
    );
  };

  document.addEventListener("change", maybeLearnFromEdit, true);
  document.addEventListener("blur", maybeLearnFromEdit, true);
  learningListenersAttached = true;
}

function jaccardSimilarity(tokensA, tokensB) {
  const a = new Set(tokensA || []);
  const b = new Set(tokensB || []);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of a.values()) {
    if (b.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...a.values(), ...b.values()]).size;
  return union > 0 ? intersection / union : 0;
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function computeFillConfidence({
  bestScore,
  secondBestScore,
  strongIdentityMatch,
  exactConceptMatch,
  hasTargetConcept,
  isUrlField,
  isTypedSensitiveField
}) {
  const scoreMargin = Math.max(0, bestScore - secondBestScore);

  let logit = -4.8;
  logit += bestScore * 0.55;
  logit += scoreMargin * 0.9;
  if (strongIdentityMatch) {
    logit += 1.5;
  }
  if (exactConceptMatch) {
    logit += 1.1;
  }
  if (hasTargetConcept) {
    logit += 0.4;
  }
  if (isUrlField) {
    logit -= 0.2;
  }
  if (isTypedSensitiveField) {
    logit += 0.3;
  }

  return sigmoid(logit);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sendFillFeedback(accepted) {
  chrome.runtime.sendMessage({
    action: "recordFillFeedback",
    accepted: Boolean(accepted)
  });
}

function computeMatchScore(target, candidate) {
  if (
    target.canonicalConcept &&
    candidate.canonicalConcept &&
    target.canonicalConcept !== candidate.canonicalConcept
  ) {
    return -1000;
  }

  let score = 0;

  if (target.canonicalConcept && candidate.canonicalConcept && target.canonicalConcept === candidate.canonicalConcept) {
    score += 5;
  }

  const targetName = normalizeIdentity(target.name);
  const candidateName = normalizeIdentity(candidate.name);
  const targetId = normalizeIdentity(target.id);
  const candidateId = normalizeIdentity(candidate.id);

  if (targetName && candidateName) {
    if (targetName === candidateName) {
      score += 4;
    } else if (targetName.length >= 4 && candidateName.length >= 4 && (targetName.includes(candidateName) || candidateName.includes(targetName))) {
      score += 2;
    }
  }

  if (targetId && candidateId) {
    if (targetId === candidateId) {
      score += 4;
    } else if (targetId.length >= 4 && candidateId.length >= 4 && (targetId.includes(candidateId) || candidateId.includes(targetId))) {
      score += 2;
    }
  }

  if (target.key && candidate.key && target.key === candidate.key) {
    score += 3;
  }

  if (target.type && candidate.type && target.type === candidate.type) {
    score += 1;
  }

  score += jaccardSimilarity(target.tokens, candidate.tokens) * 4;
  return score;
}

function isLikelyUrlField(target) {
  const fieldType = normalizeIdentity(target.type);
  return (
    fieldType === "url" ||
    (target.tokens || []).some((token) => ["url", "link", "linkedin", "github", "portfolio", "website"].includes(token))
  );
}

function isLikelyPhoneField(target) {
  const fieldType = normalizeIdentity(target.type);
  return (
    fieldType === "tel" ||
    (target.tokens || []).some((token) => ["phone", "cell", "mobile", "telephone", "tel"].includes(token))
  );
}

function isLikelyEmailField(target) {
  const fieldType = normalizeIdentity(target.type);
  return (
    fieldType === "email" ||
    (target.tokens || []).some((token) => ["email", "mail", "e-mail"].includes(token))
  );
}

function getConceptFamily(concept) {
  if (!concept) {
    return "";
  }

  if (concept === "phone") {
    return "phone";
  }
  if (concept === "email") {
    return "email";
  }
  if (concept === "first_name" || concept === "last_name" || concept === "full_name") {
    return "name";
  }
  if (concept === "address" || concept === "city" || concept === "state" || concept === "zip" || concept === "country") {
    return "location";
  }

  return concept;
}

function looksLikeEmailAddress(value) {
  const text = cleanText(value);
  if (!text) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

let countryValueSet;

function getCountryValueSet() {
  if (countryValueSet) {
    return countryValueSet;
  }

  const values = new Set([
    "us",
    "usa",
    "u.s.",
    "u.s.a.",
    "unitedstates",
    "unitedstatesofamerica",
    "uk",
    "u.k.",
    "unitedkingdom"
  ]);

  if (typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function" && typeof Intl.DisplayNames === "function") {
    try {
      const regionCodes = Intl.supportedValuesOf("region");
      const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

      for (const code of regionCodes) {
        values.add(normalizeIdentity(code));

        const name = displayNames.of(code);
        if (name) {
          values.add(normalizeIdentity(name));
        }
      }
    } catch (_error) {
      // Fallback to the built-in aliases above if the runtime does not expose region names.
    }
  }

  countryValueSet = values;
  return countryValueSet;
}

function looksLikeCountryName(value) {
  const text = normalizeIdentity(value);
  if (!text) {
    return false;
  }

  return getCountryValueSet().has(text);
}

function looksLikePersonName(value) {
  const text = cleanText(value);
  if (!text) {
    return false;
  }

  if (/\d/.test(text)) {
    return false;
  }

  if (looksLikeEmailAddress(text) || looksLikePhoneNumber(text)) {
    return false;
  }

  return /^[A-Za-z][A-Za-z.'-]*(\s+[A-Za-z][A-Za-z.'-]*)+$/.test(text);
}

function resolveFieldConcept(field, aliasModel = {}) {
  if (!field) {
    return "";
  }

  if (field.canonicalConcept) {
    return field.canonicalConcept;
  }

  return inferConcept(field, aliasModel).canonicalConcept;
}

function isConceptMatch(targetConcept, candidateConcept) {
  if (!targetConcept || !candidateConcept) {
    return false;
  }

  return targetConcept === candidateConcept;
}

function looksLikePhoneNumber(value) {
  const text = cleanText(value);
  if (!text) {
    return false;
  }

  if (/^(yes|no|true|false)$/i.test(text)) {
    return false;
  }

  const digitCount = (text.match(/\d/g) || []).length;
  if (digitCount < 7 || digitCount > 15) {
    return false;
  }

  const normalized = text.replace(/(?:ext\.?|extension|x)\s*\d*$/i, "");
  if (!/^[\d\s()+\-./extx]*$/i.test(normalized)) {
    return false;
  }

  return true;
}

function getUrlFamilyFromText(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) {
    return "";
  }

  if (text.includes("linkedin.com")) {
    return "linkedin";
  }

  if (text.includes("github.com")) {
    return "github";
  }

  return "";
}

function getUrlFamilyFromField(target) {
  const tokens = target?.tokens || [];
  if (tokens.includes("linkedin")) {
    return "linkedin";
  }
  if (tokens.includes("github")) {
    return "github";
  }
  return "";
}

function hasStrongIdentityMatch(target, candidate) {
  if (!candidate) {
    return false;
  }

  const targetName = normalizeIdentity(target.name);
  const candidateName = normalizeIdentity(candidate.name);
  const targetId = normalizeIdentity(target.id);
  const candidateId = normalizeIdentity(candidate.id);

  return (
    (target.key && candidate.key && target.key === candidate.key) ||
    (targetName && candidateName && targetName === candidateName) ||
    (targetId && candidateId && targetId === candidateId)
  );
}

function autofillFields(savedFields, aliasModel, adaptiveBaseThreshold = 0.82) {
  attachLearningListeners();
  cachedAliasModel = aliasModel || {};

  const nodes = Array.from(document.querySelectorAll("input, textarea, select"));
  const candidates = Array.isArray(savedFields) ? savedFields : [];
  const now = Date.now();

  let filledCount = 0;

  for (const element of nodes) {
    if (!isCandidateField(element)) {
      continue;
    }

    if (typeof element.value === "string" && element.value.trim()) {
      continue;
    }

    const meta = buildFieldMeta(element);
    const learning = inferConcept(meta, aliasModel || {});
    const target = {
      key: fieldKey(element),
      name: meta.name,
      id: meta.id,
      type: meta.type,
      canonicalConcept: learning.canonicalConcept,
      tokens: learning.tokens
    };
    const targetConcept = resolveFieldConcept(target, aliasModel || {});
    const targetFamily = getConceptFamily(targetConcept);
    const targetIsCountryField = targetConcept === "country" || (target.tokens || []).some((token) => ["country", "nation"].includes(token));
    const targetUrlFamily = isLikelyUrlField(target) ? getUrlFamilyFromField(target) : "";
    const targetIsPhoneField = isLikelyPhoneField(target) || targetFamily === "phone";
    const targetIsEmailField = isLikelyEmailField(target) || targetFamily === "email";

    let bestCandidate = null;
    let bestScore = 0;
    let secondBestScore = 0;

    for (const candidate of candidates) {
      const candidateConcept = resolveFieldConcept(candidate, aliasModel || {});

      if (!hasStrongIdentityMatch(target, candidate) && !isConceptMatch(targetConcept, candidateConcept)) {
        continue;
      }

      if (targetIsPhoneField && !looksLikePhoneNumber(candidate.value)) {
        continue;
      }

      if (targetIsEmailField && !looksLikeEmailAddress(candidate.value)) {
        continue;
      }

      if (targetIsCountryField && !looksLikeCountryName(candidate.value)) {
        continue;
      }

      if (targetFamily === "name" && !looksLikePersonName(candidate.value)) {
        continue;
      }

      const candidateUrlFamily = getUrlFamilyFromText(candidate.value);
      if (targetUrlFamily && candidateUrlFamily && targetUrlFamily !== candidateUrlFamily) {
        continue;
      }

      const candidateForMatch = {
        ...candidate,
        canonicalConcept: candidateConcept
      };

      let score = computeMatchScore(target, candidateForMatch);
      if (hasStrongIdentityMatch(target, candidateForMatch)) {
        score += 6;
      }

      if (score > bestScore) {
        secondBestScore = bestScore;
        bestScore = score;
        bestCandidate = candidateForMatch;
      } else if (score > secondBestScore) {
        secondBestScore = score;
      }
    }

    let minimumScore = 6;
    if (isLikelyUrlField(target)) {
      minimumScore = 7;
    }

    if (targetIsPhoneField || targetIsEmailField) {
      minimumScore = Math.max(minimumScore, 7);
    }

    const strongIdentityMatch = hasStrongIdentityMatch(target, bestCandidate);
    const bestConcept = bestCandidate?.canonicalConcept || "";
    const conceptConflict = Boolean(targetConcept && bestConcept && targetConcept !== bestConcept);
    const conceptWeakForUrl = isLikelyUrlField(target) && !strongIdentityMatch && !targetConcept;

    const exactConceptMatch = isConceptMatch(targetConcept, bestConcept);
    const allowedToFill = strongIdentityMatch || exactConceptMatch;
    const confidence = computeFillConfidence({
      bestScore,
      secondBestScore,
      strongIdentityMatch,
      exactConceptMatch,
      hasTargetConcept: Boolean(targetConcept),
      isUrlField: isLikelyUrlField(target),
      isTypedSensitiveField: targetIsPhoneField || targetIsEmailField || targetIsCountryField
    });

    let minimumConfidence = clampNumber(Number(adaptiveBaseThreshold) || 0.82, 0.75, 0.95);
    if (isLikelyUrlField(target)) {
      minimumConfidence = Math.max(minimumConfidence, clampNumber(minimumConfidence + 0.06, 0.75, 0.95));
    }
    if (targetIsPhoneField || targetIsEmailField || targetIsCountryField) {
      minimumConfidence = Math.max(minimumConfidence, clampNumber(minimumConfidence + 0.04, 0.75, 0.95));
    }

    const value =
      allowedToFill &&
      !conceptConflict &&
      !conceptWeakForUrl &&
      bestScore >= minimumScore &&
      confidence >= minimumConfidence
        ? bestCandidate?.value
        : null;

    if (typeof value === "string" && value.length > 0) {
      autofillSessionState.set(element, {
        autofilledValue: value.trim(),
        canonicalConcept: bestCandidate?.canonicalConcept || target.canonicalConcept || "",
        aliasModel: aliasModel || {},
        appliedAt: now,
        feedbackSent: false,
        learned: false
      });
      applyValue(element, value);
      filledCount += 1;
    }
  }

  return filledCount;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    if (message.action === "collectFilledFields") {
      sendResponse({ ok: true, fields: collectFilledFields(), hostname: location.hostname });
      return;
    }

    if (message.action === "autofillFields") {
      const adaptiveConfidenceThreshold = Number(message.adaptiveConfidenceThreshold);
      const filledCount = autofillFields(
        message.fields || [],
        message.aliasModel || {},
        Number.isFinite(adaptiveConfidenceThreshold) ? adaptiveConfidenceThreshold : 0.82
      );
      sendResponse({ ok: true, filledCount });
      return;
    }

    sendResponse({ ok: false, error: "Unknown action." });
  } catch (error) {
    sendResponse({ ok: false, error: error.message || "Failed to process request." });
  }
});
