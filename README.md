# qr-bot

`qr-bot` is a small local web server that displays a WhatsApp QR code and creates a `SESSION_ID` after you scan it. It is intended for connecting **your own** WhatsApp account to a compatible bot deployment.

> **Security notice:** A generated `SESSION_ID` contains WhatsApp authentication material. Treat it like a password. Do not post it in GitHub issues, chat messages, screenshots, or public repositories.

## Requirements

| Requirement | Version |
| --- | --- |
| Node.js | 18 or newer |
| npm | Current stable version |
| WhatsApp | An active account with access to Linked Devices |

## Run locally

Clone the repository and install dependencies:

```bash
git clone https://github.com/amrelnahas05-wq/qr-bot.git
cd qr-bot
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000), click **Generate QR Code**, then scan it from WhatsApp:

1. Open WhatsApp on your phone.
2. Go to **Settings → Linked Devices**.
3. Select **Link a Device**.
4. Scan the QR code in your browser.
5. Wait for the `SESSION_ID` to appear, then copy it into your bot's `SESSION_ID` environment variable.

Keep the terminal running until the session ID is displayed. Stop the local server with `Ctrl+C` when you are finished.

## Use a different port on Windows PowerShell

If port `3000` is already in use, run:

```powershell
$env:PORT=3001; npm start
```

Then browse to [http://localhost:3001](http://localhost:3001).

## Project files

| Path | Purpose |
| --- | --- |
| `index.js` | Express server, Baileys connection, QR generation, and session packaging |
| `public/index.html` | Browser interface for displaying and scanning the QR code |
| `package.json` | Dependencies and start command |

## Responsible use

Use this project only with accounts you own or are authorized to manage. Keep the generated session data private and revoke or replace it if you suspect it has been exposed.
