# qr-bot

`qr-bot` is a local WhatsApp pairing server that creates a `SESSION_ID` after you link **your own** WhatsApp account. It supports two pairing methods in one browser page: scanning a QR code or entering an eight-character pairing code on your phone.

> **Security notice:** A generated `SESSION_ID` contains WhatsApp authentication material. Treat it like a password. Do not put it in GitHub, screenshots, chat messages, or any public location.

## Requirements

| Requirement | Version |
| --- | --- |
| Node.js | 18 or newer |
| npm | Current stable version |
| WhatsApp | An active account with access to Linked Devices |

## Run locally

Clone the repository, install dependencies, and start the server:

```bash
git clone https://github.com/amrelnahas05-wq/qr-bot.git
cd qr-bot
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Keep the terminal running until the website displays the `SESSION_ID`.

## Pairing methods

| Method | How to use it |
| --- | --- |
| **Scan QR Code** | Select **Scan QR Code**, click **Generate QR Code**, then open WhatsApp → **Settings** → **Linked Devices** → **Link a Device** and scan the displayed code. |
| **Use Phone Number** | Select **Use Phone Number**, enter your WhatsApp number including country code, click **Get Pairing Code**, then open WhatsApp → **Linked Devices** → **Link a Device** → **Link with phone number** and enter the displayed code. |

For the phone-number method, use digits only. For example, an Egyptian number might be entered as:

```text
201060715493
```

Do not include `+`, spaces, parentheses, or hyphens. Use only the newest pairing code, because the codes expire quickly.

After either method links successfully, copy the complete `SESSION_ID` and set it as the `SESSION_ID` environment variable in the bot service that will use the account.

## Use a different port on Windows PowerShell

If port `3000` is already in use, run:

```powershell
$env:PORT=3001; npm start
```

Then open [http://localhost:3001](http://localhost:3001).

## Project files

| Path | Purpose |
| --- | --- |
| `index.js` | Express server, Baileys connection, QR generation, phone-code creation, and session packaging |
| `public/index.html` | Browser interface for selecting and completing either pairing method |
| `package.json` | Dependencies and start command |

## Responsible use

Use this project only with accounts you own or are authorized to manage. Keep generated session data private, and replace it if you suspect it was exposed.
