# qr-bot

`qr-bot` is a local WhatsApp pairing server that creates Railway-compatible session variables after you link **your own** WhatsApp account. It supports two pairing methods in one browser page: scanning a QR code or entering an eight-character pairing code on your phone.

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

Open [http://localhost:3000](http://localhost:3000). Keep the terminal running until the page confirms that pairing has completed and, for phone-number pairing, that the session variables were sent to your WhatsApp account.

## Pairing methods

| Method | How to use it |
| --- | --- |
| **Scan QR Code** | Select **Scan QR Code**, click **Generate QR Code**, then open WhatsApp → **Settings** → **Linked Devices** → **Link a Device** and scan the displayed code. |
| **Use Phone Number** | Select **Use Phone Number**, enter your WhatsApp number including country code, click **Get Pairing Code**, then open WhatsApp → **Linked Devices** → **Link a Device** → **Link with phone number** and enter the displayed code. Once linked, the server sends the Railway variables to that same WhatsApp account. |

For the phone-number method, use digits only. For example, an Egyptian number might be entered as:

```text
201060715493
```

Do not include `+`, spaces, parentheses, or hyphens. Use only the newest pairing code, because the codes expire quickly.

## Phone-session delivery

When the **Use Phone Number** flow links successfully, the connected device sends a short notice and every Railway variable to the same WhatsApp account whose number was entered. The page intentionally does not render those credentials again after a successful send. Open your WhatsApp self-chat and copy every complete `NAME=value` message.

If WhatsApp does not accept one of the outgoing messages, the page exposes a one-time recovery display instead. Copy the recovery variables immediately and then close the page. Treat either delivery path as private credential handling; never forward the messages or publish them.

## Deploying the generated session to Railway

For QR pairing, the page displays one small count variable plus one or more authentication-data variables. For phone-number pairing, the same variables arrive as individual WhatsApp messages:

```text
SESSION_ID_PARTS=2
SESSION_ID_1=<first session-data chunk>
SESSION_ID_2=<second session-data chunk>
```

The exact number of `SESSION_ID_N` variables varies by session. Copy **every** line or WhatsApp message. In your bot service on Railway, open **Variables → Raw Editor**, paste the copied lines, save them, and redeploy the service.

> Railway limits a single variable value, so do **not** merge the chunks into one `SESSION_ID` value. Keep the variables private and do not store them in GitHub or share them in screenshots.

## Use a different port on Windows PowerShell

If port `3000` is already in use, run:

```powershell
$env:PORT=3001; npm start
```

Then open [http://localhost:3001](http://localhost:3001).

## Project files

| Path | Purpose |
| --- | --- |
| `index.js` | Express server, Baileys connection, QR generation, phone-code creation, session packaging, and private phone self-message delivery |
| `public/index.html` | Browser interface for selecting and completing either pairing method, with a recovery display only if phone delivery fails |
| `package.json` | Dependencies and start command |

## Responsible use

Use this project only with accounts you own or are authorized to manage. Keep generated session data private, and replace it if you suspect it was exposed.
