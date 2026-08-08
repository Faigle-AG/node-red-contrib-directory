const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const helper = require('node-red-node-test-helper');
const directoryActionNode = require('../src/directory-action.js');

helper.init(require.resolve('node-red'));

const DATA_DIR = path.join(__dirname, 'data');
const RUN_ID = process.env.TEST_RUN_ID || `${Date.now()}-${process.pid}`;
const WORK_DIR = path.join(DATA_DIR, 'directory-action', RUN_ID);

function ensureWorkDir() {
    fs.mkdirSync(WORK_DIR, { recursive: true });
}

function resetTestDir(name) {
    const dir = path.join(WORK_DIR, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanup() {
    if (!process.env.KEEP_TEST_FILES) {
        fs.rmSync(path.join(DATA_DIR, 'directory-action'), {
            recursive: true,
            force: true,
        });
    }
}

describe('directory-action node', function () {
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
        const target = path.join(WORK_DIR, 'load-target');
        const flow = [
            {
                id: 'n1',
                type: 'directory-action',
                name: 'list test directory',
                dynamic: false,
                action: 'list',
                source: target,
                sourceType: 'str',
                property: 'payload',
                propertyType: 'msg',
            },
        ];

        helper.load(directoryActionNode, flow, function () {
            const n1 = helper.getNode('n1');
            assert.equal(n1.name, 'list test directory');
            assert.equal(n1.action, 'list');
            assert.equal(n1.source, target);
            assert.equal(n1.sourceType, 'str');
            done();
        });
    });

    it('creates a configured directory recursively and emits metadata', function (done) {
        const target = path.join(WORK_DIR, 'create', 'nested');
        const flow = [
            {
                id: 'n1',
                type: 'directory-action',
                action: 'create',
                source: target,
                sourceType: 'str',
                property: 'payload',
                propertyType: 'msg',
                recursive: true,
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryActionNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                assert.equal(fs.existsSync(target), true);
                assert.equal(fs.statSync(target).isDirectory(), true);
                assert.equal(msg.payload, true);
                assert.equal(msg.file.filetype, 'directory');
                assert.equal(msg.file.path, path.normalize(target));
                assert.equal(msg.file.dir, path.dirname(target));
                assert.equal(msg.file.base, 'nested');
                assert.equal(msg.file.name, 'nested');
                done();
            });

            n1.receive({});
        });
    });

    it('lists configured directory contents', function (done) {
        const target = resetTestDir('list');
        fs.writeFileSync(path.join(target, 'b.txt'), 'b');
        fs.writeFileSync(path.join(target, 'a.txt'), 'a');
        fs.mkdirSync(path.join(target, 'subdir'));

        const flow = [
            {
                id: 'n1',
                type: 'directory-action',
                action: 'list',
                source: target,
                sourceType: 'str',
                property: 'payload',
                propertyType: 'msg',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryActionNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                try {
                    assert.deepEqual([...msg.payload.contents].sort(), [
                        'a.txt',
                        'b.txt',
                        'subdir',
                    ]);
                    assert.equal(msg.payload.filetype, 'directory');
                    assert.equal(msg.payload.path, path.normalize(target));
                    assert.equal(msg.payload.dir, path.dirname(target));
                    assert.equal(msg.payload.base, 'list');
                    assert.equal(msg.payload.name, 'list');
                    assert.equal(msg.file, undefined);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({});
        });
    });

    it('deletes a configured directory recursively', function (done) {
        const target = resetTestDir('delete');
        fs.writeFileSync(path.join(target, 'file.txt'), 'content');
        fs.mkdirSync(path.join(target, 'nested'));
        fs.writeFileSync(path.join(target, 'nested', 'child.txt'), 'content');

        const flow = [
            {
                id: 'n1',
                type: 'directory-action',
                action: 'delete',
                source: target,
                sourceType: 'str',
                property: 'payload',
                propertyType: 'msg',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryActionNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                assert.equal(fs.existsSync(target), false);
                assert.equal(msg.payload, true);
                assert.equal(msg.file.filetype, 'directory');
                assert.equal(msg.file.path, path.normalize(target));
                done();
            });

            n1.receive({});
        });
    });

    it('runs dynamically from msg.file.action and msg.file.path', function (done) {
        const target = path.join(WORK_DIR, 'dynamic', 'created');
        const flow = [
            {
                id: 'n1',
                type: 'directory-action',
                dynamic: true,
                property: 'payload',
                propertyType: 'msg',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryActionNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                try {
                    assert.equal(fs.existsSync(target), true);
                    assert.equal(msg.payload, true);
                    assert.equal(msg.file.action, 'create');
                    assert.equal(msg.file.path, path.normalize(target));
                    assert.equal(msg.file.recursive, true);
                    assert.equal(msg.file.extra, 'preserved');
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({
                file: {
                    action: 'create',
                    path: target,
                    extra: 'preserved',
                    recursive: true,
                },
            });
        });
    });

    it('emits error if source path is missing', function (done) {
        const flow = [
            {
                id: 'n1',
                type: 'directory-action',
                action: 'list',
                source: '',
                sourceType: 'str',
            },
        ];

        helper.load(directoryActionNode, flow, function () {
            const n1 = helper.getNode('n1');
            n1.on('call:error', function (call) {
                assert.equal(call.args[0].message, 'Source directory path is missing');
                done();
            });
            n1.receive({});
        });
    });

    it('emits error if unknown action is provided', function (done) {
        const target = resetTestDir('unknown-action');
        const flow = [
            {
                id: 'n1',
                type: 'directory-action',
                action: 'invalid_action',
                source: target,
                sourceType: 'str',
            },
        ];

        helper.load(directoryActionNode, flow, function () {
            const n1 = helper.getNode('n1');
            n1.on('call:error', function (call) {
                assert.equal(call.args[0].message, 'Unknown action: invalid_action');
                done();
            });
            n1.receive({});
        });
    });

    it('fails to create nested directories if recursive is false', function (done) {
        const target = path.join(WORK_DIR, 'no-parent', 'nested');
        const flow = [
            {
                id: 'n1',
                type: 'directory-action',
                action: 'create',
                source: target,
                sourceType: 'str',
                recursive: false,
            },
        ];

        helper.load(directoryActionNode, flow, function () {
            const n1 = helper.getNode('n1');
            n1.on('call:error', function (call) {
                try {
                    assert.equal(fs.existsSync(target), false);
                    assert.equal(call.args[0].code, 'ENOENT');
                    done();
                } catch (err) {
                    done(err);
                }
            });
            n1.receive({});
        });
    });

    it('saves output to flow context', function (done) {
        const target = resetTestDir('flow-output');
        const flow = [
            {
                id: 'n1',
                z: 'flow1',
                type: 'directory-action',
                action: 'list',
                source: target,
                sourceType: 'str',
                property: 'testOutput',
                propertyType: 'flow',
                wires: [['h1']],
            },
            { id: 'h1', z: 'flow1', type: 'helper' },
        ];

        helper.load(directoryActionNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function () {
                try {
                    const output = n1.context().flow.get('testOutput');
                    assert.equal(output.filetype, 'directory');
                    assert.equal(output.path, path.normalize(target));
                    assert.equal(output.dir, path.dirname(target));
                    assert.equal(output.base, 'flow-output');
                    assert.deepEqual(output.contents, []);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({});
        });
    });

    it('saves output to global context', function (done) {
        const target = resetTestDir('global-output');
        const flow = [
            {
                id: 'n1',
                type: 'directory-action',
                action: 'list',
                source: target,
                sourceType: 'str',
                property: 'testOutput',
                propertyType: 'global',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryActionNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function () {
                try {
                    const output = n1.context().global.get('testOutput');
                    assert.equal(output.filetype, 'directory');
                    assert.equal(output.path, path.normalize(target));
                    assert.equal(output.dir, path.dirname(target));
                    assert.equal(output.base, 'global-output');
                    assert.deepEqual(output.contents, []);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({});
        });
    });
});
