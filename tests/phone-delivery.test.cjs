const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const handlers = { get: {}, post: {} };

function express() {
    return {
        use() {},
        post(route, handler) { handlers.post[route] = handler; },
        get(route, handler) { handlers.get[route] = handler; },
        listen() {},
    };
}
express.json = () => () => {};
express.static = () => () => {};

class FakeAdmZip {
    addLocalFolder() {}
    toBuffer() { return Buffer.from('test-session'); }
}

const baileys = {
    makeWASocket() { throw new Error('The test must not open a WhatsApp socket.'); },
    useMultiFileAuthState: async () => { throw new Error('Not used by this test.'); },
    makeCacheableSignalKeyStore: () => ({}),
    DisconnectReason: { restartRequired: 515 },
    fetchLatestWaWebVersion: async () => ({
        version: [2, 3000, 1045204510],
        isLatest: true,
    }),
    jidNormalizedUser: (jid) => String(jid || '').replace(/:\d+(?=@)/, ''),
};

function fakeRequire(name) {
    if (name === 'express') return express;
    if (name === 'adm-zip') return FakeAdmZip;
    if (name === 'qrcode') return {};
    if (name === '@whiskeysockets/baileys') return baileys;
    if (name === 'pino') return () => ({});
    return require(name);
}

let source = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
assert.match(source, /browser: \['Mac OS', 'Chrome', '120\.0\.0'\]/);
assert.doesNotMatch(source, /requestPairingCode/);
assert.doesNotMatch(source, /mode === 'phone'/);
assert.match(source, /jidNormalizedUser\(entry\.sock\.user\?\.id\)/);
source = source.replace(
    /app\.listen\(PORT, \(\) => \{[\s\S]*?\}\);\s*$/,
    'module.exports = { sendSessionToOwner, sessions, getCurrentWaWebVersion, formatConnectionCloseError };\n',
);

const sandbox = {
    require: fakeRequire,
    module: { exports: {} },
    exports: {},
    __dirname: repoRoot,
    Buffer,
    console,
    process,
    setTimeout,
    clearTimeout,
};
vm.runInNewContext(source, sandbox, { filename: 'index.js' });

const {
    sendSessionToOwner,
    sessions,
    getCurrentWaWebVersion,
    formatConnectionCloseError,
} = sandbox.module.exports;

async function invokeSessionEndpoint(entry) {
    sessions.set(entry.id, entry);
    let response;
    await handlers.get['/session/:sessionId'](
        { params: { sessionId: entry.id } },
        { json(payload) { response = payload; return payload; } },
    );
    return response;
}

async function invokePairEndpoint(body) {
    let statusCode = 200;
    let payload;
    await handlers.post['/pair'](
        { body },
        {
            status(code) { statusCode = code; return this; },
            json(value) { payload = value; return value; },
        },
    );
    return { statusCode, payload };
}

(async () => {
    assert.deepEqual(
        await getCurrentWaWebVersion(),
        [2, 3000, 1045204510],
    );
    assert.match(formatConnectionCloseError(405), /Web handshake \(405\)/);

    const phoneMode = await invokePairEndpoint({ mode: 'phone' });
    assert.strictEqual(phoneMode.statusCode, 400);
    assert.match(phoneMode.payload.error, /disabled/i);

    const outbound = [];
    const delivery = await sendSessionToOwner({
        sessionParts: [
            { name: 'SESSION_ID_PARTS', value: '2' },
            { name: 'SESSION_ID_1', value: 'private-chunk' },
        ],
        sock: {
            user: { id: '201060715493:4@s.whatsapp.net' },
            async sendMessage(jid, content) {
                outbound.push({ jid, content });
            },
        },
    });

    assert.deepEqual(delivery, { status: 'sent', messageCount: 3 });
    assert.deepEqual(outbound.map(({ jid }) => jid), [
        '201060715493@s.whatsapp.net',
        '201060715493@s.whatsapp.net',
        '201060715493@s.whatsapp.net',
    ]);
    assert.match(outbound[0].content.text, /authentication material/);
    assert.strictEqual(outbound[1].content.text, 'SESSION_ID_PARTS=2');
    assert.strictEqual(outbound[2].content.text, 'SESSION_ID_1=private-chunk');

    const sentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-bot-sent-'));
    const sentResponse = await invokeSessionEndpoint({
        id: 'sent-session',
        ready: true,
        delivery: { status: 'sent', messageCount: 3 },
        sessionParts: [{ name: 'SESSION_ID_1', value: 'must-not-be-returned' }],
        sessionDir: sentDir,
    });
    assert.deepEqual(sentResponse, {
        status: 'ready',
        delivery: { status: 'sent', messageCount: 3 },
    });

    const failedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-bot-failed-'));
    const failedResponse = await invokeSessionEndpoint({
        id: 'failed-session',
        ready: true,
        delivery: { status: 'failed', error: 'offline' },
        sessionParts: [{ name: 'SESSION_ID_1', value: 'never-return-this' }],
        sessionDir: failedDir,
    });
    assert.deepEqual(failedResponse, {
        status: 'ready',
        delivery: { status: 'failed', error: 'offline' },
    });

    const page = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
    assert.doesNotMatch(page, /sessionParts|sessionValue|copySession|Copy Railway Variables/);
    assert.doesNotMatch(page, /Use Phone Number|phoneInput|requestPairingCode/);

    console.log('QR delivery tests passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
