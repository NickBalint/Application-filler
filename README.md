# Application Filler (Chrome Extension)

Application Filler is a Chrome extension that helps you speed up job applications by:

- Saving form values you already typed.
- Reusing those values later to autofill semantically similar fields across different sites.
- Storing data locally in encrypted form.

## What It Does

1. You unlock the vault with a passphrase.
2. Click **Save Filled Fields** to capture non-empty fields from the current page.
3. Later, click **Autofill This Page** on any application page to fill matching fields.

Saved data is stored as a global encrypted profile, not split per domain.

## Smart Matching Model

The extension uses a lightweight local learning model (no cloud calls):

- It tokenizes field metadata (name, id, label, placeholder, autocomplete, type).
- It maps tokens to canonical concepts (for example `phone`, `email`, `first_name`).
- It treats common variants as equivalent (for example `phone`, `cell`, `mobile`, `telephone`).
- It learns token-to-concept associations over time from fields you save.
- After autofill, if you edit a filled field, it learns from your correction and saves that field/value mapping for future forms.
- You can enable **Learn from manual typing** in the popup to also learn from fields you type yourself (even if they were not autofilled first).
- Autofill picks the best candidate using concept + token similarity scoring.

This gives you practical cross-site behavior, such as matching a saved phone value to fields labeled differently on another ATS.

## Local Security Model

- Data is saved in `chrome.storage.local` on your machine only.
- Vault data is encrypted with `AES-GCM`.
- Encryption keys are derived from your passphrase using `PBKDF2-SHA256`.
- Your passphrase is kept only in `chrome.storage.session` while unlocked (session-scoped, not intended for long-term persistence).

Important:

- If you forget your passphrase, encrypted data cannot be recovered.
- This is a practical local-security approach for a personal tool, not a replacement for enterprise password managers.

## Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:

	`/Users/nickbalint/Documents/GitHub/Comp484-hw9/Application-filler`

## Usage

1. Open a job application page.
2. Fill some fields manually.
3. Click the extension icon.
4. Enter a passphrase (8+ chars) and click **Unlock**.
5. Click **Save Filled Fields**.
6. On future application pages, click **Autofill This Page**.

## Demo Starter Page

Use this local page to quickly create starter data for your profile:

- [demo/fake-job-application.html](demo/fake-job-application.html)

How to use it:

1. Open [demo/fake-job-application.html](demo/fake-job-application.html) in Chrome.
2. Click **Fill Demo Data** (or type your own values).
3. Open the extension popup and click **Save Filled Fields**.
4. Visit another form and click **Autofill This Page**.

If Chrome does not inject the extension on local files, go to extension details in `chrome://extensions` and enable **Allow access to file URLs**.

## Current Scope and Limits

- Captures `input`, `textarea`, and `select` values (excluding password/hidden/button types).
- Uses semantic field matching with local learned alias weights.
- Some highly dynamic forms may need manual touch-ups after autofill.

## Files

- `manifest.json` - Chrome Extension Manifest V3 config.
- `background.js` - Encryption, vault storage, lock/unlock, and message handling.
- `content.js` - Field collection and autofill logic on pages.
- `popup.html` - Popup UI.
- `popup.css` - Popup styles.
- `popup.js` - Popup interactions and command flow.
