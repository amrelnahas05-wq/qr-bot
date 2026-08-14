const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const QRCode = require('qrcode');
const {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestWaWebVersion,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;
const sessions = new Map();
const PAIRING_TIMEOUT_MS = 30000;
const SESSION_LIFETIME_MS = 5 * 60 * 1000;
const MAX_RESTART_ATTEMPTS = 3;
const DELIVERY_SETTLE_MS = 750;
const DELIVERY_MAX_ATTEMPTS = 3;
// Railway accepts environment-variable values up to 32,768 characters.
// Keep chunks below that limit to leave a safety margin.
const SESSION_CHUNK_SIZE = 28000;
let cachedWaWebVersion = null;
let waWebVersionRequest = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function packSessionDir(sessionDir) {
    const zip = new AdmZip();
    zip.addLocalFolder(sessionDir);
    const encoded = zip.toBuffer().toString('base64');
    const parts = [];

    for (let offset = 0, index = 1; offset < encoded.length; offset += SESSION_CHUNK_SIZE, index += 1) {
        parts.push({
            name: `SESSION_ID_${index}`,
            value: encoded.slice(offset, offset + SESSION_CHUNK_SIZE),
        });
    }

    return [
        { name: 'SESSION_ID_PARTS', value: String(parts.length) },
        ...parts,
    ];
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCurrentWaWebVersion() {
    if (cachedWaWebVersion) return cachedWaWebVersion;
    if (!waWebVersionRequest) {
        waWebVersionRequest = (async () => {
            const result = await fetchLatestWaWebVersion();
            if (result.isLatest && Array.isArray(result.version) && result.version.length === 3) {
                cachedWaWebVersion = result.version;
                return cachedWaWebVersion;
            }

            // Do not force an undefined version into makeWASocket. Its built-in
            // default remains a safe fallback if WhatsApp's version endpoint is unavailable.
            console.warn('[qr-bot] Could not retrieve the current WhatsApp Web version:', result.error?.message || 'unknown error');
            return null;
        })().finally(() => {
            waWebVersionRequest = null;
        });
    }

    return waWebVersionRequest;
}

function formatConnectionCloseError(reason) {
    if (reason === 405) {
        return 'WhatsApp rejected the Web handshake (405) even after refreshing its current Web version. Wait a few minutes, confirm Linked Devices can add a device, then request a new code.';
    }

    return `WhatsApp connection closed${reason ? ` (${reason})` : ''}`;
}

async function sendSessionToOwner(entry) {
    // sock.user.id includes a device suffix after QR pairing. Baileys' helper
    // removes that suffix without guessing the phone number, leaving the
    // linked account's private WhatsApp JID.
    const recipient = jidNormalizedUser(entry.sock.user?.id);
    if (!recipient) {
        throw new Error('WhatsApp did not provide the linked account identity.');
    }

    const messages = [
        [
            'qr-bot: your Railway session variables follow in separate messages.',
            'They are WhatsApp authentication material. Keep them private, copy every complete NAME=value line, and do not forward them.',
        ].join('\n'),
        ...entry.sessionParts.map((part) => `${part.name}=${part.value}`),
    ];

    for (const text of messages) {
        let sent = false;
        let lastError;
        for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt += 1) {
            try {
                await entry.sock.sendMessage(recipient, { text });
                sent = true;
                break;
            } catch (error) {
                lastError = error;
                if (attempt < DELIVERY_MAX_ATTEMPTS) await sleep(500 * attempt);
            }
        }
        if (!sent) throw lastError || new Error('WhatsApp did not accept the session message.');
    }

    return {
        status: 'sent',
        messageCount: messages.length,
    };
}

function createDeferred() {
    let resolve;
    let reject;
    let settled = false;

    const promise = new Promise((promiseResolve, promiseReject) => {
        resolve = (value) => {
            if (!settled) {
                settled = true;
                promiseResolve(value);
            }
        };
        reject = (error) => {
            if (!settled) {
                settled = true;
                promiseReject(error);
            }
        };
    });

    return { promise, resolve, reject };
}

function disposeSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return;

    clearTimeout(entry.initialTimeout);
    clearTimeout(entry.expiryTimer);
    clearTimeout(entry.restartTimer);
    try {
        entry.sock?.end();
    } catch (_) {
        // The socket may already be closed.
    }
    fs.rmSync(entry.sessionDir, { recursive: true, force: true });
    sessions.delete(sessionId);
}

function failSession(entry, error) {
    if (!sessions.has(entry.id) || entry.ready) return;

    clearTimeout(entry.initialTimeout);
    entry.status = 'failed';
    entry.error = error;
    entry.initialResult.reject(new Error(error));
}

async function startSocket(entry) {
    if (!sessions.has(entry.id) || entry.ready) return;

    let latestWaWebVersion;
    try {
        latestWaWebVersion = await getCurrentWaWebVersion();
    } catch (err) {
        failSession(entry, `Unable to verify the current WhatsApp Web version: ${err.message}`);
        return;
    }
    if (!sessions.has(entry.id) || entry.ready) return;

    const socketConfig = {
        auth: {
            creds: entry.state.creds,
            keys: makeCacheableSignalKeyStore(entry.state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        // Keep the linked phone available to receive the self-message.
        markOnlineOnConnect: false,
        // Use WhatsApp's canonical browser/OS tuple rather than an application
        // label in browser[0].
        browser: ['Mac OS', 'Chrome', '120.0.0'],
    };
    if (latestWaWebVersion) socketConfig.version = latestWaWebVersion;

    const sock = makeWASocket(socketConfig);

    entry.sock = sock;
    sock.ev.on('creds.update', entry.saveCreds);

    sock.ev.on('connection.update', async (update) => {
        // Events from a socket that was replaced after a restart are ignored.
        if (entry.sock !== sock) return;

        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            try {
                entry.qr = await QRCode.toDataURL(qr, { margin: 2, width: 360 });
                clearTimeout(entry.initialTimeout);
                entry.initialResult.resolve({ type: 'qr', qr: entry.qr });
            } catch (err) {
                failSession(entry, `Unable to render WhatsApp QR code: ${err.message}`);
            }
        }

        if (connection === 'open') {
            try {
                await entry.saveCreds();
                await sleep(1500);
                entry.sessionParts = packSessionDir(entry.sessionDir);
                entry.delivery = await sendSessionToOwner(entry);
                // Give WhatsApp a moment to accept all outbound messages before ending.
                await sleep(DELIVERY_SETTLE_MS);

                entry.ready = true;
                entry.status = 'ready';
            } catch (err) {
                failSession(entry, `Linked successfully, but could not prepare the session: ${err.message}`);
            } finally {
                sock.end();
            }
            return;
        }

        if (connection === 'close' && !entry.ready) {
            const reason = lastDisconnect?.error?.output?.statusCode;

            // WhatsApp/Baileys code 515 explicitly asks the client to create a
            // fresh socket. Keep the same temporary auth state and renew the
            // QR or phone pairing code so the browser can continue pairing.
            if (reason === DisconnectReason.restartRequired && entry.restartAttempts < MAX_RESTART_ATTEMPTS) {
                entry.restartAttempts += 1;
                entry.status = 'pending';
                entry.error = null;
                entry.qr = null;
                entry.restartTimer = setTimeout(() => startSocket(entry), 500);
                return;
            }

            // A 405 usually means WhatsApp rejected an expired Web build before
            // pairing starts. Refresh the version once, then surface a specific
            // message rather than repeatedly creating dead pairing attempts.
            if (reason === 405 && entry.versionRefreshAttempts < 1) {
                entry.versionRefreshAttempts += 1;
                cachedWaWebVersion = null;
                entry.status = 'pending';
                entry.error = null;
                entry.restartTimer = setTimeout(() => {
                    void startSocket(entry);
                }, 1500);
                return;
            }

            const exhausted = reason === DisconnectReason.restartRequired
                ? ` after ${MAX_RESTART_ATTEMPTS} restart attempts`
                : '';
            failSession(entry, `${formatConnectionCloseError(reason)}${exhausted}`);
        }
    });
}

app.post('/pair', async (req, res) => {
    const requestedMode = req.body?.mode;

    if (requestedMode && requestedMode !== 'qr') {
        return res.status(400).json({ error: 'Phone-number pairing is disabled. Scan the QR code with WhatsApp.' });
    }
    const mode = 'qr';

    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(__dirname, 'temp_sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const initialResult = createDeferred();
        const entry = {
            id: sessionId,
            state,
            saveCreds,
            sessionDir,
            mode,
            sock: null,
            ready: false,
            status: 'pending',
            error: null,
            sessionParts: null,
            qr: null,
            restartAttempts: 0,
            versionRefreshAttempts: 0,
            delivery: null,
            initialResult,
            initialTimeout: null,
            restartTimer: null,
            expiryTimer: null,
        };

        sessions.set(sessionId, entry);
        entry.initialTimeout = setTimeout(() => {
            failSession(entry, 'Timed out waiting for a WhatsApp QR code.');
        }, PAIRING_TIMEOUT_MS);
        entry.expiryTimer = setTimeout(() => disposeSession(sessionId), SESSION_LIFETIME_MS);

        startSocket(entry);
        const result = await initialResult.promise;
        return res.json({ sessionId, mode, ...result });
    } catch (err) {
        disposeSession(sessionId);
        return res.status(500).json({ error: `Failed to generate QR code: ${err.message}` });
    }
});

app.get('/session/:sessionId', (req, res) => {
    const entry = sessions.get(req.params.sessionId);
    if (!entry) return res.status(404).json({ status: 'not_found' });
    if (entry.status === 'failed') return res.json({ status: 'failed', error: entry.error });
    if (!entry.ready) {
        return res.json({
            status: 'pending',
            qr: entry.qr || null,
        });
    }

    const response = {
        status: 'ready',
        delivery: entry.delivery,
    };

    // Credentials are delivered only to the linked account in WhatsApp and
    // are never returned to, stored in, or rendered by the browser response.
    clearTimeout(entry.expiryTimer);
    fs.rmSync(entry.sessionDir, { recursive: true, force: true });
    sessions.delete(req.params.sessionId);
    return res.json(response);
});

app.listen(PORT, () => {
    console.log(`qr-bot pairing server running on port ${PORT}`);
});
