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
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;
const sessions = new Map();
const PAIRING_TIMEOUT_MS = 30000;
const SESSION_LIFETIME_MS = 5 * 60 * 1000;

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

    clearTimeout(entry.expiryTimer);
    try {
        entry.sock?.end();
    } catch (_) {
        // The socket may already be closed.
    }
    fs.rmSync(entry.sessionDir, { recursive: true, force: true });
    sessions.delete(sessionId);
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
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            logger: pino({ level: 'silent' }),
            browser: ['qr-bot', 'Chrome', '1.0.0'],
        });

        if (state.creds.registered) {
            sock.end();
            fs.rmSync(sessionDir, { recursive: true, force: true });
            return res.status(400).json({ error: 'This temporary session is already registered. Start a new session.' });
        }

        const initialResult = createDeferred();
        const entry = {
            sock,
            saveCreds,
            sessionDir,
            mode,
            ready: false,
            status: 'pending',
            error: null,
            sessionData: null,
            qr: null,
            pairingCodeRequested: false,
            expiryTimer: null,
        };
        sessions.set(sessionId, entry);
        sock.ev.on('creds.update', saveCreds);

        const initialTimeout = setTimeout(() => {
            initialResult.reject(new Error(`Timed out waiting for WhatsApp ${mode === 'qr' ? 'QR code' : 'pairing code'}`));
        }, PAIRING_TIMEOUT_MS);

        entry.expiryTimer = setTimeout(() => {
            disposeSession(sessionId);
        }, SESSION_LIFETIME_MS);

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            // Baileys emits qr when its initial connection handshake is ready.
            // For phone pairing, waiting for this event prevents requesting a
            // code before the socket is ready, which otherwise can close it.
            if (qr) {
                if (mode === 'qr') {
                    try {
                        entry.qr = await QRCode.toDataURL(qr, { margin: 2, width: 360 });
                        clearTimeout(initialTimeout);
                        initialResult.resolve({ type: 'qr', qr: entry.qr });
                    } catch (err) {
                        clearTimeout(initialTimeout);
                        initialResult.reject(err);
                    }
                } else if (!entry.pairingCodeRequested) {
                    entry.pairingCodeRequested = true;
                    try {
                        const code = await sock.requestPairingCode(phone);
                        clearTimeout(initialTimeout);
                        initialResult.resolve({
                            type: 'phone',
                            code: code.match(/.{1,4}/g).join('-'),
                        });
                    } catch (err) {
                        clearTimeout(initialTimeout);
                        initialResult.reject(err);
                    }
                }
            }

            if (connection === 'open') {
                await saveCreds();
                await new Promise((resolve) => setTimeout(resolve, 1500));
                entry.ready = true;
                entry.status = 'ready';
                entry.sessionData = packSessionDir(sessionDir);
                sock.end();
            }

            if (connection === 'close' && !entry.ready) {
                const reason = lastDisconnect?.error?.output?.statusCode;
                const error = `WhatsApp connection closed${reason ? ` (${reason})` : ''}`;
                entry.status = 'failed';
                entry.error = error;
                clearTimeout(initialTimeout);
                initialResult.reject(new Error(error));
            }
        });

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
    if (!entry.ready) return res.json({ status: 'pending', qr: entry.mode === 'qr' ? entry.qr : null });

    const sessionId = entry.sessionData;
    clearTimeout(entry.expiryTimer);
    fs.rmSync(entry.sessionDir, { recursive: true, force: true });
    sessions.delete(req.params.sessionId);
    return res.json({ status: 'ready', sessionId });
});

app.listen(PORT, () => {
    console.log(`qr-bot pairing server running on port ${PORT}`);
});
