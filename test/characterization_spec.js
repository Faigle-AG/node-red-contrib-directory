const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const helper = require('node-red-node-test-helper');
const directoryActionNode = require('../src/directory-action.js');
const directoryTransferNode = require('../src/directory-transfer.js');
const directoryWatchNode = require('../src/directory-watch.js');
const catchNode = require('@node-red/nodes/core/common/25-catch.js');
const { trigger, lastStatusText } = require('./helpers/harness');

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

        it('legacy: a non-recursive delete fails with ERR_FS_EISDIR even for an empty directory', async function () {
            await load('directory-action', {
                action: 'delete',
                source: work('empty'),
                recursive: false,
            });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.err.code, 'ERR_FS_EISDIR');
            assert.equal(fs.existsSync(work('empty')), true);
        });

        it('legacy: dynamic recursive defaults to off, so nested create fails with ENOENT', async function () {
            await load('directory-action', { dynamic: true });

            const result = await trigger(helper, 'n1', 'out', {
                file: { action: 'create', path: work('x', 'y') },
            });

            assert.equal(result.err.code, 'ENOENT');
        });

        it('legacy: validation errors carry no code and show the message as status', async function () {
            await load('directory-action', { dynamic: true });

            const cases = [
                [{ file: { action: 'list' } }, 'Source directory path is missing'],
                [{ file: { path: work('src') } }, 'Action is missing'],
                [{ file: { action: 'rename', path: work('src') } }, 'Unknown action: rename'],
            ];
            for (const [input, message] of cases) {
                const result = await trigger(helper, 'n1', 'out', input);
                assert.equal(result.err.message, message);
                assert.equal(result.err.code, undefined);
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

        it('legacy: an unknown action creates the destination parent before failing', async function () {
            await load('directory-transfer', {
                action: 'delete',
                source: work('src'),
                destination: work('newparent', 'dst'),
            });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.err.message, 'Unknown action type: delete');
            assert.equal(result.err.code, undefined);
            assert.equal(fs.existsSync(work('newparent')), true);
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
                [{ file: { source: 'a', destination: 'b' } }, 'Action is missing'],
                [{ file: { action: 'copy', destination: 'b' } }, 'Source path is missing'],
                [{ file: { action: 'copy', source: 'a' } }, 'Destination path is missing'],
            ];
            for (const [input, message] of cases) {
                const result = await trigger(helper, 'n1', 'out', input);
                assert.equal(result.err.message, message);
                assert.equal(result.err.code, undefined);
                assert.equal(lastStatusText(result), message);
            }
        });
    });

    describe('directory-watch', function () {
        it('legacy: an invalid ignoredFiles regex fails node construction', async function () {
            await load('directory-watch', {
                source: work('src'),
                ignoredFiles: '(',
                filterFiles: true,
                watchAdd: true,
            });

            assert.equal(helper.getNode('n1'), null);
            const errors = helper
                .log()
                .args.map((args) => args[0])
                .filter((entry) => entry.level === helper.log().ERROR);
            assert.ok(errors.some((entry) => /Invalid regular expression/.test(String(entry.msg))));
        });
    });
});
