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
let learningListenersAttached = false;

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
    if (!state || state.learned) {
      return;
    }

    const currentValue = typeof element.value === "string" ? element.value.trim() : "";
    if (!currentValue || currentValue === state.autofilledValue) {
      return;
    }

    const meta = buildFieldMeta(element);
    const learning = inferConcept(meta, state.aliasModel || {});
    const learnedField = {
      key: fieldKey(element),
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
        autofillSessionState.set(element, {
          ...state,
          learned: true
        });
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

function computeMatchScore(target, candidate) {
  let score = 0;

  if (target.canonicalConcept && candidate.canonicalConcept && target.canonicalConcept === candidate.canonicalConcept) {
    score += 5;
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

function autofillFields(savedFields, aliasModel) {
  attachLearningListeners();

  const nodes = Array.from(document.querySelectorAll("input, textarea, select"));
  const candidates = Array.isArray(savedFields) ? savedFields : [];

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
      type: meta.type,
      canonicalConcept: learning.canonicalConcept,
      tokens: learning.tokens
    };

    let bestCandidate = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const score = computeMatchScore(target, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    const value = bestScore >= 3 ? bestCandidate?.value : null;

    if (typeof value === "string" && value.length > 0) {
      applyValue(element, value);
      autofillSessionState.set(element, {
        autofilledValue: value.trim(),
        canonicalConcept: bestCandidate?.canonicalConcept || target.canonicalConcept || "",
        aliasModel: aliasModel || {},
        learned: false
      });
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
      const filledCount = autofillFields(message.fields || [], message.aliasModel || {});
      sendResponse({ ok: true, filledCount });
      return;
    }

    sendResponse({ ok: false, error: "Unknown action." });
  } catch (error) {
    sendResponse({ ok: false, error: error.message || "Failed to process request." });
  }
});
