const IGNORED_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "image",
  "hidden",
  "file",
  "password"
]);

function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
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

    fields.push({
      key: fieldKey(element),
      selector: buildSelector(element),
      label: getLabelText(element),
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

function autofillFields(savedFields) {
  const nodes = Array.from(document.querySelectorAll("input, textarea, select"));
  const byKey = new Map();
  const bySelector = new Map();

  for (const field of savedFields || []) {
    if (field.key) {
      byKey.set(field.key, field.value);
    }
    if (field.selector) {
      bySelector.set(field.selector, field.value);
    }
  }

  let filledCount = 0;

  for (const element of nodes) {
    if (!isCandidateField(element)) {
      continue;
    }

    const selector = buildSelector(element);
    const key = fieldKey(element);
    const value = bySelector.get(selector) ?? byKey.get(key);

    if (typeof value === "string" && value.length > 0) {
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
      const filledCount = autofillFields(message.fields || []);
      sendResponse({ ok: true, filledCount });
      return;
    }

    sendResponse({ ok: false, error: "Unknown action." });
  } catch (error) {
    sendResponse({ ok: false, error: error.message || "Failed to process request." });
  }
});
