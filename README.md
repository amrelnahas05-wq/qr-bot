# qr-bot

`qr-bot` is a local WhatsApp QR-pairing server that creates Railway-compatible session variables after you link **your own** WhatsApp account. After the QR code is scanned, it attempts to send the generated variables privately to the WhatsApp account that scanned it and returns a one-time browser view as a practical recovery path. The browser displays each session variable separately, with an independent copy button.

> **Security notice:** A generated `SESSION_ID` contains WhatsApp authentication material. Treat it like a password. Do not put it in GitHub, screenshots, chat messages, or any public location.

## Requirements

| Requirement | Version |
| --- | --- |
| Node.js | 20 or newer |
| npm | Current stable version |
| WhatsApp | An active account with access to Linked Devices |

## Run locally

Clone the repository, install the locked dependencies, and start the server:

```bash
git clone https://github.com/amrelnahas05-wq/qr-bot.git
cd qr-bot
npm ci
npm start
```

Open [http://localhost:3000](http://localhost:3000). Keep the terminal running until the page confirms that pairing has completed.

## QR pairing and private session delivery

Click **Generate QR Code**, then open WhatsApp and go to **Settings → Linked Devices → Link a Device**. Scan the displayed QR code with the WhatsApp account that should receive the session.

Once WhatsApp opens the linked session, `qr-bot` packages the authentication files and attempts to send a private notice plus every Railway variable to that account’s own WhatsApp chat. At the same time, the pairing page presents a **one-time** recovery view: every `SESSION_ID_PARTS` or `SESSION_ID_N` variable appears in its own compact card, with its own copy button.

If WhatsApp delivery fails, use the same individual browser cards. Copy every complete `NAME=value` variable into Railway’s Raw Editor before you leave or refresh the page. The temporary server files and the one-time session response are then removed.

## Deploying the generated session to Railway

The WhatsApp messages and one-time browser cards contain a small count variable followed by one or more authentication-data variables:

```text
SESSION_ID_PARTS=2
SESSION_ID_1=<first session-data chunk>
SESSION_ID_2=<second session-data chunk>
```

The exact number of `SESSION_ID_N` variables varies by session. Copy **every complete message** into your bot service in Railway under **Variables → Raw Editor**, save the variables, and redeploy the bot service.

> Railway limits the size of each variable value. Do **not** merge the chunks into one `SESSION_ID` value. Keep every message private and do not forward it.

## Use a different port on Windows PowerShell

If port `3000` is already in use, run:

```powershell
$env:PORT=3001; npm start
```

Then open [http://localhost:3001](http://localhost:3001).

## Project files

| Path | Purpose |
| --- | --- |
| `index.js` | Express server, QR generation, WhatsApp connection, session packaging, and private self-message delivery |
| `public/index.html` | QR-only browser interface that renders each one-time session variable in a separate copyable card |
| `package.json` | Dependencies, runtime requirement, and start command |

## Responsible use

Use this project only with accounts you own or are authorized to manage. Keep generated session data private, and replace it if you suspect it was exposed.
