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
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;
const sessions = new Map();
const PAIRING_TIMEOUT_MS = 30000;
const SESSION_LIFETIME_MS = 5 * 60 * 1000;
const MAX_RESTART_ATTEMPTS = 3;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function cleanPhone(phone) {
    return String(phone || '').replace(/[^0-9]/g, '');
}

function packSessionDir(sessionDir) {
    const zip = new AdmZip();
    zip.addLocalFolder(sessionDir);
    return zip.toBuffer().toString('base64');
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

function startSocket(entry) {
    if (!sessions.has(entry.id) || entry.ready) return;

    const sock = makeWASocket({
        auth: {
            creds: entry.state.creds,
            keys: makeCacheableSignalKeyStore(entry.state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        browser: ['qr-bot', 'Chrome', '1.0.0'],
    });

    entry.sock = sock;
    sock.ev.on('creds.update', entry.saveCreds);

    sock.ev.on('connection.update', async (update) => {
        // Events from a socket that was replaced after a restart are ignored.
        if (entry.sock !== sock) return;

        const { connection, qr, lastDisconnect } = update;

        // Both modes wait for this QR/handshake update before producing their
        // first credential. Phone pairing needs this delay before requesting a
        // code; a premature request can cause the socket to close.
        if (qr) {
            if (entry.mode === 'qr') {
                try {
                    entry.qr = await QRCode.toDataURL(qr, { margin: 2, width: 360 });
                    clearTimeout(entry.initialTimeout);
                    entry.initialResult.resolve({ type: 'qr', qr: entry.qr });
                } catch (err) {
                    failSession(entry, `Unable to render WhatsApp QR code: ${err.message}`);
                }
            } else if (!entry.pairingCodeRequested) {
                entry.pairingCodeRequested = true;
                try {
                    const code = await sock.requestPairingCode(entry.phone);
                    entry.pairingCode = code.match(/.{1,4}/g).join('-');
                    clearTimeout(entry.initialTimeout);
                    entry.initialResult.resolve({ type: 'phone', code: entry.pairingCode });
                } catch (err) {
                    failSession(entry, `Unable to request WhatsApp pairing code: ${err.message}`);
                }
            }
        }

        if (connection === 'open') {
            await entry.saveCreds();
            await new Promise((resolve) => setTimeout(resolve, 1500));
            entry.ready = true;
            entry.status = 'ready';
            entry.sessionData = packSessionDir(entry.sessionDir);
            sock.end();
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
                entry.pairingCode = null;
                entry.pairingCodeRequested = false;
                entry.restartTimer = setTimeout(() => startSocket(entry), 500);
                return;
            }

            const suffix = reason ? ` (${reason})` : '';
            const exhausted = reason === DisconnectReason.restartRequired
                ? ` after ${MAX_RESTART_ATTEMPTS} restart attempts`
                : '';
            failSession(entry, `WhatsApp connection closed${suffix}${exhausted}`);
        }
    });
}

app.post('/pair', async (req, res) => {
    const mode = req.body?.mode;
    const phone = cleanPhone(req.body?.phone);

    if (!['qr', 'phone'].includes(mode)) {
        return res.status(400).json({ error: 'Choose either QR code or phone-number pairing.' });
    }
    if (mode === 'phone' && phone.length < 7) {
        return res.status(400).json({ error: 'Enter your WhatsApp number with country code, using digits only.' });
    }

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
            phone,
            sock: null,
            ready: false,
            status: 'pending',
            error: null,
            sessionData: null,
            qr: null,
            pairingCode: null,
            pairingCodeRequested: false,
            restartAttempts: 0,
            initialResult,
            initialTimeout: null,
            restartTimer: null,
            expiryTimer: null,
        };

        sessions.set(sessionId, entry);
        entry.initialTimeout = setTimeout(() => {
            failSession(entry, `Timed out waiting for WhatsApp ${mode === 'qr' ? 'QR code' : 'pairing code'}`);
        }, PAIRING_TIMEOUT_MS);
        entry.expiryTimer = setTimeout(() => disposeSession(sessionId), SESSION_LIFETIME_MS);

        startSocket(entry);
        const result = await initialResult.promise;
        return res.json({ sessionId, mode, ...result });
    } catch (err) {
        disposeSession(sessionId);
        return res.status(500).json({ error: `Failed to generate ${mode === 'qr' ? 'QR' : 'pairing'} code: ${err.message}` });
    }
});

app.get('/session/:sessionId', (req, res) => {
    const entry = sessions.get(req.params.sessionId);
    if (!entry) return res.status(404).json({ status: 'not_found' });
    if (entry.status === 'failed') return res.json({ status: 'failed', error: entry.error });
    if (!entry.ready) {
        return res.json({
            status: 'pending',
            qr: entry.mode === 'qr' ? entry.qr : null,
            code: entry.mode === 'phone' ? entry.pairingCode : null,
        });
    }

    const sessionId = entry.sessionData;
    clearTimeout(entry.expiryTimer);
    fs.rmSync(entry.sessionDir, { recursive: true, force: true });
    sessions.delete(req.params.sessionId);
    return res.json({ status: 'ready', sessionId });
});

app.listen(PORT, () => {
    console.log(`qr-bot pairing server running on port ${PORT}`);
});
