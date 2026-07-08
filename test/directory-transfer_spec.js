const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const helper = require('node-red-node-test-helper');
const directoryTransferNode = require('../src/directory-transfer.js');

helper.init(require.resolve('node-red'));

const DATA_DIR = path.join(__dirname, 'data');
const RUN_ID = process.env.TEST_RUN_ID || `${Date.now()}-${process.pid}`;
const WORK_DIR = path.join(DATA_DIR, 'directory-transfer', RUN_ID);
const INPUT_TEXT = 'this is a test file\n';

function ensureWorkDir() {
    fs.mkdirSync(WORK_DIR, { recursive: true });
}

function makeSourceDir(name) {
    const dir = path.join(WORK_DIR, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'file.txt'), INPUT_TEXT);
    fs.writeFileSync(path.join(dir, 'nested', 'child.txt'), 'child\n');
    return dir;
}

function cleanup() {
    if (!process.env.KEEP_TEST_FILES) {
        fs.rmSync(path.join(DATA_DIR, 'directory-transfer'), {
            recursive: true,
            force: true,
        });
    }
}

describe('directory-transfer node', function () {
    beforeEach(function (done) {
        ensureWorkDir();
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(function () {
            cleanup();
            done();
        });
    });

    it('loads with configured properties', function (done) {
        const source = path.join(WORK_DIR, 'source');
        const destination = path.join(WORK_DIR, 'destination');
        const flow = [
            {
                id: 'n1',
                type: 'directory-transfer',
                name: 'copy test directory',
                dynamic: false,
                action: 'copy',
                source,
                sourceType: 'str',
                destination,
                destinationType: 'str',
            },
        ];

        helper.load(directoryTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            assert.equal(n1.name, 'copy test directory');
            assert.equal(n1.action, 'copy');
            assert.equal(n1.source, source);
            assert.equal(n1.destination, destination);
            done();
        });
    });

    it('copies a configured directory recursively and emits destination metadata', function (done) {
        const source = makeSourceDir('copy-source');
        const destination = path.join(WORK_DIR, 'copy-destination');
        const flow = [
            {
                id: 'n1',
                type: 'directory-transfer',
                action: 'copy',
                source,
                sourceType: 'str',
                destination,
                destinationType: 'str',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                assert.equal(fs.existsSync(source), true);
                assert.equal(
                    fs.readFileSync(path.join(destination, 'file.txt'), 'utf8'),
                    INPUT_TEXT,
                );
                assert.equal(
                    fs.readFileSync(path.join(destination, 'nested', 'child.txt'), 'utf8'),
                    'child\n',
                );
                assert.equal(msg.file.filetype, 'directory');
                assert.equal(msg.file.action, 'copy');
                assert.equal(msg.file.source, path.normalize(source));
                assert.equal(msg.file.destination, path.normalize(destination));
                assert.equal(msg.file.path, path.normalize(destination));
                assert.equal(msg.file.base, 'copy-destination');
                assert.equal(msg.file.name, 'copy-destination');
                done();
            });

            n1.receive({});
        });
    });

    it('moves a configured directory', function (done) {
        const source = makeSourceDir('move-source');
        const destination = path.join(WORK_DIR, 'move-destination');
        const flow = [
            {
                id: 'n1',
                type: 'directory-transfer',
                action: 'move',
                source,
                sourceType: 'str',
                destination,
                destinationType: 'str',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                assert.equal(fs.existsSync(source), false);
                assert.equal(
                    fs.readFileSync(path.join(destination, 'file.txt'), 'utf8'),
                    INPUT_TEXT,
                );
                assert.equal(msg.file.action, 'move');
                assert.equal(msg.file.path, path.normalize(destination));
                done();
            });

            n1.receive({});
        });
    });

    it('copies dynamically from msg.file.source to msg.file.destination', function (done) {
        const source = makeSourceDir('dynamic-source');
        const destination = path.join(WORK_DIR, 'dynamic-destination');
        const flow = [
            {
                id: 'n1',
                type: 'directory-transfer',
                dynamic: true,
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                assert.equal(
                    fs.readFileSync(path.join(destination, 'file.txt'), 'utf8'),
                    INPUT_TEXT,
                );
                assert.equal(msg.file.action, 'copy');
                assert.equal(msg.file.extra, 'preserved');
                done();
            });

            n1.receive({
                file: {
                    action: 'copy',
                    source,
                    destination,
                    extra: 'preserved',
                },
            });
        });
    });

    it('does nothing when source and destination are identical', function (done) {
        const source = makeSourceDir('same-source');
        const flow = [
            {
                id: 'n1',
                type: 'directory-transfer',
                action: 'copy',
                source,
                sourceType: 'str',
                destination: source,
                destinationType: 'str',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                assert.equal(fs.readFileSync(path.join(source, 'file.txt'), 'utf8'), INPUT_TEXT);
                assert.equal(Object.prototype.hasOwnProperty.call(msg, 'file'), false);
                done();
            });

            n1.receive({});
        });
    });
});
