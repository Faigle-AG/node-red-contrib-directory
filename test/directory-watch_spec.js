const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const helper = require('node-red-node-test-helper');
const directoryWatchNode = require('../src/directory-watch.js');

helper.init(require.resolve('node-red'));

const DATA_DIR = path.join(__dirname, 'data');
const RUN_ID = process.env.TEST_RUN_ID || `${Date.now()}-${process.pid}`;
const WORK_DIR = path.join(DATA_DIR, 'directory-watch', RUN_ID);

function resetWatchDir(name) {
    const dir = path.join(WORK_DIR, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanup() {
    if (!process.env.KEEP_TEST_FILES) {
        fs.rmSync(path.join(DATA_DIR, 'directory-watch'), { recursive: true, force: true });
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('directory-watch node', function () {
    this.timeout(10000);

    beforeEach(function (done) {
        fs.mkdirSync(WORK_DIR, { recursive: true });
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
        const folder = resetWatchDir('load');
        const flow = [
            {
                id: 'n1',
                type: 'directory-watch',
                name: 'watch test directory',
                folder,
                folderType: 'str',
                depth: 0,
                watchAdd: true,
                watchChange: false,
                watchDelete: false,
                filterFiles: true,
                filterDirs: false,
                awaitWriteFinish: false,
                stabilityThreshold: 200,
                ignoreInitial: true,
                ignoredFiles: '',
                ignoredFilesType: 're',
            },
        ];

        helper.load(directoryWatchNode, flow, function () {
            const n1 = helper.getNode('n1');
            assert.equal(n1.name, 'watch test directory');
            assert.equal(n1.folder, path.normalize(folder));
            assert.equal(n1.depth, 0);
            assert.equal(n1.watchAdd, true);
            assert.equal(n1.filterFiles, true);
            done();
        });
    });

    it('emits an add event for a new file', function (done) {
        const folder = resetWatchDir('add-file');
        const target = path.join(folder, 'added.txt');
        const flow = [
            {
                id: 'n1',
                type: 'directory-watch',
                folder,
                folderType: 'str',
                depth: 0,
                watchAdd: true,
                watchChange: false,
                watchDelete: false,
                filterFiles: true,
                filterDirs: false,
                awaitWriteFinish: false,
                stabilityThreshold: 200,
                ignoreInitial: true,
                ignoredFiles: '',
                ignoredFilesType: 're',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryWatchNode, flow, async function () {
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                assert.equal(msg.file.action, 'add');
                assert.equal(msg.file.filetype, 'file');
                assert.equal(msg.file.watchdir, path.normalize(folder));
                assert.equal(msg.file.path, path.normalize(target));
                assert.equal(msg.file.base, 'added.txt');
                assert.equal(msg.file.name, 'added');
                assert.equal(msg.file.ext, '.txt');
                assert.notEqual(msg.file.stats, null);
                done();
            });

            await delay(500);
            fs.writeFileSync(target, 'added\n');
        });
    });

    it('emits a delete event for a removed file', function (done) {
        const folder = resetWatchDir('delete-file');
        const target = path.join(folder, 'deleted.txt');
        fs.writeFileSync(target, 'delete me\n');

        const flow = [
            {
                id: 'n1',
                type: 'directory-watch',
                folder,
                folderType: 'str',
                depth: 0,
                watchAdd: false,
                watchChange: false,
                watchDelete: true,
                filterFiles: true,
                filterDirs: false,
                awaitWriteFinish: false,
                stabilityThreshold: 200,
                ignoreInitial: true,
                ignoredFiles: '',
                ignoredFilesType: 're',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryWatchNode, flow, async function () {
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                assert.equal(msg.file.action, 'delete');
                assert.equal(msg.file.filetype, 'file');
                assert.equal(msg.file.path, path.normalize(target));
                assert.equal(msg.file.stats, null);
                done();
            });

            await delay(500);
            fs.unlinkSync(target);
        });
    });

    it('emits an add event for a new directory when directory filtering is enabled', function (done) {
        const folder = resetWatchDir('add-directory');
        const target = path.join(folder, 'child-dir');
        const flow = [
            {
                id: 'n1',
                type: 'directory-watch',
                folder,
                folderType: 'str',
                depth: 1,
                watchAdd: true,
                watchChange: false,
                watchDelete: false,
                filterFiles: false,
                filterDirs: true,
                awaitWriteFinish: false,
                stabilityThreshold: 200,
                ignoreInitial: true,
                ignoredFiles: '',
                ignoredFilesType: 're',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryWatchNode, flow, async function () {
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                assert.equal(msg.file.action, 'add');
                assert.equal(msg.file.filetype, 'directory');
                assert.equal(msg.file.path, path.normalize(target));
                assert.equal(msg.file.base, 'child-dir');
                done();
            });

            await delay(500);
            fs.mkdirSync(target);
        });
    });

    it('ignores files matching the ignoredFiles regex', function (done) {
        const folder = resetWatchDir('ignored-file');
        const ignored = path.join(folder, 'ignored.tmp');
        const accepted = path.join(folder, 'accepted.txt');
        const flow = [
            {
                id: 'n1',
                type: 'directory-watch',
                folder,
                folderType: 'str',
                depth: 0,
                watchAdd: true,
                watchChange: false,
                watchDelete: false,
                filterFiles: true,
                filterDirs: false,
                awaitWriteFinish: false,
                stabilityThreshold: 200,
                ignoreInitial: true,
                ignoredFiles: '\\.tmp$',
                ignoredFilesType: 're',
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(directoryWatchNode, flow, async function () {
            const h1 = helper.getNode('h1');
            const seen = [];

            h1.on('input', function (msg) {
                seen.push(msg.file.base);
                assert.equal(msg.file.base, 'accepted.txt');
                assert.deepEqual(seen, ['accepted.txt']);
                done();
            });

            await delay(500);
            fs.writeFileSync(ignored, 'ignored\n');
            await delay(300);
            fs.writeFileSync(accepted, 'accepted\n');
        });
    });
});
