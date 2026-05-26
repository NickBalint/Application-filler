# Application Filler (Chrome Extension)

Application Filler is a Chrome extension that helps you speed up job applications by:

- Saving form values you already typed on a site.
- Reusing those values later to autofill matching fields.
- Storing data locally in encrypted form.

## What It Does

1. You unlock the vault with a passphrase.
2. Click **Save Filled Fields** to capture non-empty fields from the current page.
3. Later, click **Autofill This Page** on the same site to fill matching fields.

Saved data is grouped by domain (for example, `greenhouse.io` vs `lever.co`).

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
6. On a future application page on the same domain, click **Autofill This Page**.

## Current Scope and Limits

- Captures `input`, `textarea`, and `select` values (excluding password/hidden/button types).
- Uses field metadata (name/id/label/placeholder/autocomplete + selector) to match fields.
- Some highly dynamic forms may need manual touch-ups after autofill.

## Files

- `manifest.json` - Chrome Extension Manifest V3 config.
- `background.js` - Encryption, vault storage, lock/unlock, and message handling.
- `content.js` - Field collection and autofill logic on pages.
- `popup.html` - Popup UI.
- `popup.css` - Popup styles.
- `popup.js` - Popup interactions and command flow.
