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
source = source.replace(
    /app\.listen\(PORT, \(\) => \{[\s\S]*?\}\);\s*$/,
    'module.exports = { sendSessionToOwner, sessions };\n',
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

const { sendSessionToOwner, sessions } = sandbox.module.exports;

async function invokeSessionEndpoint(entry) {
    sessions.set(entry.id, entry);
    let response;
    await handlers.get['/session/:sessionId'](
        { params: { sessionId: entry.id } },
        { json(payload) { response = payload; return payload; } },
    );
    return response;
}

(async () => {
    const outbound = [];
    const delivery = await sendSessionToOwner({
        phone: '201060715493',
        sessionParts: [
            { name: 'SESSION_ID_PARTS', value: '2' },
            { name: 'SESSION_ID_1', value: 'private-chunk' },
        ],
        sock: {
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

    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-bot-fallback-'));
    const fallbackParts = [{ name: 'SESSION_ID_1', value: 'recovery-value' }];
    const fallbackResponse = await invokeSessionEndpoint({
        id: 'fallback-session',
        ready: true,
        delivery: { status: 'failed', error: 'offline' },
        sessionParts: fallbackParts,
        sessionDir: fallbackDir,
    });
    assert.deepEqual(fallbackResponse, {
        status: 'ready',
        delivery: { status: 'failed', error: 'offline' },
        sessionParts: fallbackParts,
    });

    console.log('phone-delivery tests passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
