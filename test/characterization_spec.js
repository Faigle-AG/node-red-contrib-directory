const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const helper = require('node-red-node-test-helper');
const directoryActionNode = require('../src/directory-action.js');
const directoryTransferNode = require('../src/directory-transfer.js');
const directoryWatchNode = require('../src/directory-watch.js');
const catchNode = require('@node-red/nodes/core/common/25-catch.js');
const { trigger, lastStatusText, collect } = require('./helpers/harness');

helper.init(require.resolve('node-red'));

const DATA_DIR = path.join(__dirname, 'data');

// Characterization of current local directory-node behavior (Phase 2.2a), pinned before
// storage harmonization. Tests titled "legacy:" pin quirks that differ from the Azure
// nodes or the proposed contract; a later change must alter them deliberately.
describe('directory nodes characterization', function () {
    let workDir;

    function load(type, nodeConfig, extraNodes = []) {
        const flow = [
            { id: 'f1', type: 'tab' },
            { id: 'n1', z: 'f1', type, wires: [['out']], ...nodeConfig },
            { id: 'out', z: 'f1', type: 'helper' },
            ...extraNodes.map((node) => ({ z: 'f1', ...node })),
        ];
        return helper.load(
            [directoryActionNode, directoryTransferNode, directoryWatchNode, catchNode],
            flow,
        );
    }

    function work(...segments) {
        return path.join(workDir, ...segments);
    }

    beforeEach(function (done) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        workDir = fs.mkdtempSync(path.join(DATA_DIR, 'characterization-'));
        fs.mkdirSync(work('src', 'sub'), { recursive: true });
        fs.writeFileSync(work('src', 'a.txt'), 'a');
        fs.mkdirSync(work('empty'));
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(function () {
            fs.rmSync(workDir, { recursive: true, force: true });
            done();
        });
    });

    describe('directory-action', function () {
        it('legacy: an omitted result property falls back to msg.payload', async function () {
            await load('directory-action', { action: 'list', source: work('src') });

            const result = await trigger(helper, 'n1', 'out', { file: { keep: 1 } });

            assert.deepEqual(result.msg.payload.contents.sort(), ['a.txt', 'sub']);
            assert.equal(result.msg.payload.keep, 1);
            assert.equal(result.msg.payload.filetype, 'directory');
            assert.deepEqual(result.msg.file, { keep: 1 }, 'list does not assign msg.file');
            assert.equal(lastStatusText(result), 'Listed 2 items');
        });

        it('legacy: list contents are plain names, not metadata objects', async function () {
            await load('directory-action', {
                action: 'list',
                source: work('src'),
                property: 'file.content',
            });

            const result = await trigger(helper, 'n1', 'out', {});

            for (const item of result.msg.file.content.contents) {
                assert.equal(typeof item, 'string');
            }
        });

        it('fails with ENOENT when listing a missing directory', async function () {
            await load('directory-action', { action: 'list', source: work('nope') });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.err.code, 'ENOENT');
            assert.equal(lastStatusText(result), 'ENOENT');
        });

        it('legacy: deleting a missing directory succeeds and sets the result to true', async function () {
            await load('directory-action', {
                action: 'delete',
                source: work('nope'),
                property: 'payload',
            });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.msg.payload, true);
            assert.equal(result.msg.file.deleted, undefined);
            assert.equal(lastStatusText(result), 'Deleted nope');
        });

        it('non-recursive delete removes an empty directory', async function () {
            await load('directory-action', {
                action: 'delete',
                source: work('empty'),
                recursive: false,
                property: 'payload',
            });

            const result = await trigger(helper, 'n1', 'out', {}, { settleMs: 50 });

            assert.equal(result.msg.payload, true);
            assert.equal(fs.existsSync(work('empty')), false);
            assert.equal(lastStatusText(result), 'Deleted empty');
            assert.deepEqual(result.extra, { outputs: 0, errors: 0 });
        });

        it('non-recursive delete of a non-empty directory fails with ENOTEMPTY', async function () {
            await load('directory-action', {
                action: 'delete',
                source: work('src'),
                recursive: false,
            });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.err.code, 'ENOTEMPTY');
            assert.equal(lastStatusText(result), 'ENOTEMPTY');
            assert.equal(fs.existsSync(work('src', 'a.txt')), true);
        });

        it('legacy: non-recursive delete still removes a plain file', async function () {
            await load('directory-action', {
                action: 'delete',
                source: work('src', 'a.txt'),
                recursive: false,
            });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.ok(result.msg);
            assert.equal(fs.existsSync(work('src', 'a.txt')), false);
        });

        it('legacy: dynamic recursive defaults to off, so nested create fails with ENOENT', async function () {
            await load('directory-action', { dynamic: true });

            const result = await trigger(helper, 'n1', 'out', {
                file: { action: 'create', path: work('x', 'y') },
            });

            assert.equal(result.err.code, 'ENOENT');
        });

        it('validation errors carry codes but keep the message as status text', async function () {
            await load('directory-action', { dynamic: true });

            const cases = [
                [
                    { file: { action: 'list' } },
                    'Source directory path is missing',
                    'DIRECTORY_PATH_MISSING',
                ],
                [{ file: { path: work('src') } }, 'Action is missing', 'ACTION_MISSING'],
                [
                    { file: { action: 'rename', path: work('src') } },
                    'Unknown action: rename',
                    'INVALID_ACTION',
                ],
            ];
            for (const [input, message, code] of cases) {
                const result = await trigger(helper, 'n1', 'out', input);
                assert.equal(result.err.message, message);
                assert.equal(result.err.code, code);
                assert.equal(lastStatusText(result), message);
            }
        });

        it('exposes native codes to Catch nodes', async function () {
            await load('directory-action', { action: 'list', source: work('nope') }, [
                { id: 'c1', type: 'catch', scope: null, uncaught: false, wires: [['caught']] },
                { id: 'caught', type: 'helper' },
            ]);

            const caught = new Promise((resolve) => helper.getNode('caught').on('input', resolve));
            helper.getNode('n1').receive({ _marker: 'm1' });
            const msg = await caught;

            assert.equal(msg._marker, 'm1');
            assert.equal(msg.error.code, 'ENOENT');
        });
    });

    describe('directory-transfer', function () {
        it('legacy: same source and destination forwards the message unchanged', async function () {
            await load('directory-transfer', {
                action: 'copy',
                source: work('src'),
                destination: work('src', '.'),
            });

            const result = await trigger(helper, 'n1', 'out', { file: { keep: 1 } });

            assert.deepEqual(result.msg.file, { keep: 1 });
            assert.equal(lastStatusText(result), 'Ignored');
        });

        it('rejects an unknown action before creating the destination parent', async function () {
            await load('directory-transfer', {
                action: 'delete',
                source: work('src'),
                destination: work('newparent', 'dst'),
            });

            const result = await trigger(helper, 'n1', 'out', {}, { settleMs: 50 });

            assert.equal(result.err.message, 'Unknown action type: delete');
            assert.equal(result.err.code, 'INVALID_ACTION');
            assert.equal(lastStatusText(result), 'Unknown action type: delete');
            assert.equal(fs.existsSync(work('newparent')), false);
            assert.deepEqual(result.extra, { outputs: 0, errors: 0 });
        });

        it('fails a non-recursive directory copy with ERR_FS_EISDIR', async function () {
            await load('directory-transfer', {
                action: 'copy',
                source: work('src'),
                destination: work('copy'),
                recursive: false,
            });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.err.code, 'ERR_FS_EISDIR');
            assert.equal(lastStatusText(result), 'ERR_FS_EISDIR');
        });

        it('fails a copy into its own subdirectory with ERR_FS_CP_EINVAL', async function () {
            await load('directory-transfer', {
                action: 'copy',
                source: work('src'),
                destination: work('src', 'sub', 'inner'),
            });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.err.code, 'ERR_FS_CP_EINVAL');
        });

        it('falls back to copy and remove when rename fails with EXDEV', async function () {
            const originalRenameSync = fs.renameSync;
            fs.renameSync = () => {
                const err = new Error('cross-device link not permitted');
                err.code = 'EXDEV';
                throw err;
            };
            try {
                await load('directory-transfer', {
                    action: 'move',
                    source: work('src'),
                    destination: work('moved'),
                });

                const result = await trigger(helper, 'n1', 'out', {});

                assert.equal(fs.existsSync(work('src')), false);
                assert.equal(fs.readFileSync(work('moved', 'a.txt'), 'utf8'), 'a');
                assert.equal(lastStatusText(result), 'Moved src');
            } finally {
                fs.renameSync = originalRenameSync;
            }
        });

        it('fails with ENOENT when moving a missing source', async function () {
            await load('directory-transfer', {
                action: 'move',
                source: work('nope'),
                destination: work('dst'),
            });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.err.code, 'ENOENT');
        });

        it('legacy: validation errors carry no code and show the message as status', async function () {
            await load('directory-transfer', { dynamic: true });

            const cases = [
                [
                    { file: { source: 'a', destination: 'b' } },
                    'Action is missing',
                    'ACTION_MISSING',
                ],
                [
                    { file: { action: 'copy', destination: 'b' } },
                    'Source path is missing',
                    'SOURCE_PATH_MISSING',
                ],
                [
                    { file: { action: 'copy', source: 'a' } },
                    'Destination path is missing',
                    'DESTINATION_PATH_MISSING',
                ],
            ];
            for (const [input, message, code] of cases) {
                const result = await trigger(helper, 'n1', 'out', input);
                assert.equal(result.err.message, message);
                assert.equal(result.err.code, code);
                assert.equal(lastStatusText(result), message);
            }
        });
    });

    describe('directory-watch', function () {
        it('reports an invalid ignoredFiles regex through node.error without watching', async function () {
            await load('directory-watch', {
                source: work('src'),
                ignoredFiles: '(',
                filterFiles: true,
                watchAdd: true,
            });

            const node = helper.getNode('n1');
            assert.ok(node, 'the node is still created');
            const errors = helper
                .log()
                .args.map((args) => args[0])
                .filter((entry) => entry.id === 'n1' && entry.level === helper.log().ERROR);
            assert.equal(errors.length, 1);
            assert.ok(errors[0].msg instanceof SyntaxError);

            const events = await collect(helper, 'out', 300);
            assert.deepEqual(events, [], 'no watcher emits the existing file');
        });
    });
});
