const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');
const helper = require('node-red-node-test-helper');
const directoryWatchNode = require('../src/directory-watch.js');

helper.init(require.resolve('node-red'));

const DATA_DIR = path.join(__dirname, 'data');

function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}

// Lets awaited continuations and the helper's nextTick call events run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// directory-action and directory-transfer get their own `fs`: a facade with only the six
// functions they use, so their filesystem calls are confined while mocha, the test helper and Node
// keep the real fs. Every facade call is checked against the active test fixture. With no fixture
// (outside a test, or after a test's nodes are unloaded) it fails. Within one, a call with any
// path outside the test root is recorded and rejected before the real function runs, whether or
// not the test counts calls.
const FS_OPERATIONS = ['mkdirSync', 'rmSync', 'rmdirSync', 'readdirSync', 'cpSync', 'renameSync'];
let fixture = null;
const nodeFs = Object.fromEntries(
    FS_OPERATIONS.map((name) => [name, (...args) => facadeCall(name, args)]),
);

function facadeCall(name, args) {
    if (!fixture) throw new Error(`fs.${name} called outside an active test fixture`);
    const { root } = fixture;
    const paths = name === 'cpSync' || name === 'renameSync' ? args.slice(0, 2) : args.slice(0, 1);
    const rejected = paths
        .map((target) => path.resolve(String(target)))
        .filter((resolved) => resolved !== root && !resolved.startsWith(root + path.sep));
    if (rejected.length) {
        fixture.outside.push(`${name} ${rejected.join(' ')}`);
        throw new Error(`fs.${name} outside the test root: ${rejected.join(', ')}`);
    }
    if (fixture.calls) fixture.calls.push(name);
    return fs[name](...args);
}

// Confines the nodes' filesystem calls to root until endFixture(), which returns the outside
// attempts recorded meanwhile.
function startFixture(root) {
    fixture = { root, outside: [], calls: null };
}

function endFixture() {
    const outside = fixture ? fixture.outside : [];
    fixture = null;
    return outside;
}

// Starts counting the filesystem calls the nodes make in the current fixture.
function instrumentFs() {
    fixture.calls = [];
    return { calls: fixture.calls };
}

// Loads a node module whose require('fs') returns the facade.
function loadNodeModule(file) {
    const filename = require.resolve(file);
    const mod = new Module(filename, module);
    mod.filename = filename;
    const load = Module.createRequire(filename);
    mod.require = (id) => (id === 'fs' ? nodeFs : load(id));
    mod._compile(fs.readFileSync(filename, 'utf8'), filename);
    return mod.exports;
}

const directoryActionNode = loadNodeModule('../src/directory-action.js');
const directoryTransferNode = loadNodeModule('../src/directory-transfer.js');

// Records what a node reports from the moment of the call: completions (done/_complete),
// sends (messages reaching the wired output node), statuses, errors and warnings.
function observe(node) {
    const seen = { completions: [], sends: 0, statuses: [], errors: [], warnings: [] };
    const complete = node._complete;
    node._complete = function (msg, err) {
        seen.completions.push(err);
        return complete.call(this, msg, err);
    };
    helper.getNode('out').on('input', () => (seen.sends += 1));
    node.on('call:status', (call) => seen.statuses.push(call.args[0]));
    node.on('call:error', (call) => seen.errors.push(call.args[0]));
    node.on('call:warn', (call) => seen.warnings.push(call.args[0]));
    return seen;
}

// Replaces node.getTypedProperty / setTypedProperty with calls the test releases.
function holdCalls(node, method) {
    const held = [];
    node[method] = () => {
        const call = deferred();
        held.push(call);
        return call.promise;
    };
    return held;
}

// Releases held calls in order, including calls the released ones go on to make.
async function releaseAll(held, value) {
    for (let i = 0; i < held.length; i += 1) {
        held[i].resolve(typeof value === 'function' ? value(i) : value);
        await settle();
    }
}

// Loads the node under test (n1) wired to a helper output node (out).
function load(nodeModule, flow) {
    const wired = [
        { ...flow[0], wires: [['out']] },
        { id: 'out', type: 'helper' },
    ];
    return new Promise((resolve) => helper.load(nodeModule, wired, resolve));
}

describe('close during in-flight work (2.8)', function () {
    this.timeout(10000);
    let root;
    let fsCalls;

    beforeEach(function (done) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        root = fs.mkdtempSync(path.join(DATA_DIR, 'close-'));
        startFixture(root);
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(() =>
            helper.stopServer(() => {
                const outside = endFixture();
                fs.rmSync(root, { recursive: true, force: true });
                done(
                    outside.length ? new Error(`fs outside the test root: ${outside}`) : undefined,
                );
            }),
        );
    });

    describe('directory-action', function () {
        const flow = (action) => [
            { id: 'n1', type: 'directory-action', action, source: 'unused', sourceType: 'str' },
        ];

        for (const action of ['create', 'delete']) {
            it(`closing while the source is read starts no ${action} and completes quietly`, async function () {
                const target = path.join(root, 'target');
                if (action === 'delete') fs.mkdirSync(target);
                await load(directoryActionNode, flow(action));
                const n1 = helper.getNode('n1');
                const reads = holdCalls(n1, 'getTypedProperty');
                fsCalls = instrumentFs();
                n1.receive({});
                await settle();
                assert.equal(reads.length, 1);
                await n1.close();
                const seen = observe(n1);
                reads[0].resolve(target);
                await settle();
                assert.deepEqual(fsCalls.calls, []);
                assert.equal(fs.existsSync(target), action === 'delete');
                assert.deepEqual(seen.completions, [undefined]);
                assert.equal(seen.sends, 0);
                assert.deepEqual(seen.statuses, []);
                assert.deepEqual(seen.errors, []);
            });
        }

        it('a source read rejected after close completes quietly', async function () {
            await load(directoryActionNode, flow('create'));
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            await settle();
            await n1.close();
            const seen = observe(n1);
            reads[0].reject(new Error('context store failed'));
            await settle();
            assert.deepEqual(fsCalls.calls, []);
            assert.deepEqual(seen.completions, [undefined]);
            assert.deepEqual(seen.statuses, []);
            assert.deepEqual(seen.errors, []);
        });

        it('concurrent inputs held at the source read all complete quietly after close', async function () {
            await load(directoryActionNode, flow('create'));
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            n1.receive({});
            await settle();
            assert.equal(reads.length, 2);
            await n1.close();
            const seen = observe(n1);
            reads.forEach((read, i) => read.resolve(path.join(root, `target-${i}`)));
            await settle();
            assert.deepEqual(fsCalls.calls, []);
            assert.deepEqual(seen.completions, [undefined, undefined]);
            assert.equal(seen.sends, 0);
        });

        for (const outcome of ['resolves', 'rejects']) {
            it(`an output write that ${outcome} after close reports nothing`, async function () {
                await load(directoryActionNode, [
                    {
                        id: 'n1',
                        type: 'directory-action',
                        action: 'create',
                        source: path.join(root, 'made'),
                        sourceType: 'str',
                    },
                ]);
                const n1 = helper.getNode('n1');
                const writes = holdCalls(n1, 'setTypedProperty');
                n1.receive({});
                await settle();
                assert.equal(writes.length, 1);
                await n1.close();
                const seen = observe(n1);
                if (outcome === 'resolves') writes[0].resolve();
                else writes[0].reject(new Error('context store failed'));
                await settle();
                assert.deepEqual(seen.completions, [undefined]);
                assert.equal(seen.sends, 0);
                assert.deepEqual(seen.statuses, []);
                assert.deepEqual(seen.errors, []);
            });
        }
    });

    describe('directory-transfer', function () {
        const flow = [
            {
                id: 'n1',
                type: 'directory-transfer',
                action: 'copy',
                recursive: true,
                source: 'unused',
                sourceType: 'str',
                destination: 'unused',
                destinationType: 'str',
            },
        ];

        it('closing while the paths are read starts no copy and completes quietly', async function () {
            const source = path.join(root, 'source');
            fs.mkdirSync(source);
            fs.writeFileSync(path.join(source, 'a.txt'), 'a');
            const destination = path.join(root, 'out', 'copy');
            await load(directoryTransferNode, flow);
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            await settle();
            reads[0].resolve(source);
            await settle();
            assert.equal(reads.length, 2);
            await n1.close();
            const seen = observe(n1);
            reads[1].resolve(destination);
            await settle();
            assert.deepEqual(fsCalls.calls, []);
            assert.equal(fs.existsSync(path.join(root, 'out')), false);
            assert.deepEqual(seen.completions, [undefined]);
            assert.equal(seen.sends, 0);
            assert.deepEqual(seen.statuses, []);
        });

        it('a path read rejected after close completes quietly', async function () {
            await load(directoryTransferNode, flow);
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            await settle();
            await n1.close();
            const seen = observe(n1);
            reads[0].reject(new Error('context store failed'));
            await settle();
            assert.deepEqual(fsCalls.calls, []);
            assert.deepEqual(seen.completions, [undefined]);
            assert.deepEqual(seen.statuses, []);
            assert.deepEqual(seen.errors, []);
        });

        it('concurrent inputs held at the path reads all complete quietly after close', async function () {
            await load(directoryTransferNode, flow);
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            n1.receive({});
            await settle();
            assert.equal(reads.length, 2);
            await n1.close();
            const seen = observe(n1);
            await releaseAll(reads, (i) => path.join(root, `path-${i}`));
            assert.deepEqual(fsCalls.calls, []);
            assert.deepEqual(seen.completions, [undefined, undefined]);
            assert.equal(seen.sends, 0);
        });
    });

    describe('directory-watch', function () {
        // A stand-in for chokidar that the test drives. Unlike chokidar 4, it still emits after
        // close(), which the defensive tests below rely on.
        const chokidarPath = require.resolve('chokidar', {
            paths: [path.join(__dirname, '../src')],
        });
        let watcher;
        let closing;
        let realChokidar;

        beforeEach(function () {
            require(chokidarPath);
            realChokidar = require.cache[chokidarPath].exports;
            closing = deferred();
            watcher = new EventEmitter();
            watcher.closeCalls = 0;
            watcher.close = () => {
                watcher.closeCalls += 1;
                return closing.promise;
            };
            require.cache[chokidarPath].exports = { watch: () => watcher };
        });

        afterEach(function () {
            require.cache[chokidarPath].exports = realChokidar;
            closing.resolve();
        });

        const flow = (source) => [
            {
                id: 'n1',
                type: 'directory-watch',
                source,
                sourceType: 'str',
                watchAdd: true,
                filterFiles: true,
                ignoreInitial: true,
            },
        ];

        it('close waits for the watcher to close', async function () {
            await load(directoryWatchNode, flow(root));
            const n1 = helper.getNode('n1');
            let closed = false;
            const closingNode = n1.close().then(() => (closed = true));
            await settle();
            assert.equal(watcher.closeCalls, 1);
            assert.equal(closed, false);
            closing.resolve();
            await closingNode;
            assert.equal(closed, true);
        });

        it('output writes in flight at close send nothing, for each pending event', async function () {
            await load(directoryWatchNode, flow(root));
            const n1 = helper.getNode('n1');
            const writes = holdCalls(n1, 'setTypedProperty');
            watcher.emit('add', path.join(root, 'a.txt'), null);
            watcher.emit('add', path.join(root, 'b.txt'), null);
            await settle();
            assert.equal(writes.length, 2);
            closing.resolve();
            await n1.close();
            const seen = observe(n1);
            writes.forEach((write) => write.resolve());
            await settle();
            assert.equal(seen.sends, 0);
            assert.deepEqual(seen.statuses, []);
        });

        it('an output write rejected after close reports no status or error', async function () {
            await load(directoryWatchNode, flow(root));
            const n1 = helper.getNode('n1');
            const writes = holdCalls(n1, 'setTypedProperty');
            watcher.emit('add', path.join(root, 'a.txt'), null);
            await settle();
            closing.resolve();
            await n1.close();
            const seen = observe(n1);
            writes[0].reject(new Error('context store failed'));
            await settle();
            assert.deepEqual(seen.statuses, []);
            assert.deepEqual(seen.errors, []);
        });

        describe('defensive: a watcher that still emits after close (not chokidar 4 behaviour)', function () {
            it('a file event after close starts no status and sends nothing', async function () {
                await load(directoryWatchNode, flow(root));
                const n1 = helper.getNode('n1');
                closing.resolve();
                await n1.close();
                const seen = observe(n1);
                watcher.emit('add', path.join(root, 'late.txt'), null);
                await settle();
                assert.equal(seen.sends, 0);
                assert.deepEqual(seen.statuses, []);
            });

            it('a watcher error after close reports no status or error', async function () {
                await load(directoryWatchNode, flow(root));
                const n1 = helper.getNode('n1');
                closing.resolve();
                await n1.close();
                const seen = observe(n1);
                watcher.emit('error', new Error('late watcher error'));
                await settle();
                assert.deepEqual(seen.statuses, []);
                assert.deepEqual(seen.errors, []);
            });
        });

        it('a watcher whose close fails is reported as a warning and close still completes', async function () {
            await load(directoryWatchNode, flow(root));
            const n1 = helper.getNode('n1');
            const seen = observe(n1);
            closing.reject(new Error('close failed'));
            closing.promise.catch(() => {});
            await n1.close();
            await settle();
            assert.equal(seen.warnings.length, 1);
            assert.match(String(seen.warnings[0]), /close failed/);
        });
    });

    describe('chokidar contract (control)', function () {
        it('the installed chokidar stops emitting once closed', async function () {
            const chokidar = require(
                require.resolve('chokidar', { paths: [path.join(__dirname, '../src')] }),
            );
            const watcher = chokidar.watch(root, {
                persistent: true,
                usePolling: true,
                ignoreInitial: true,
            });
            watcher.on('add', () => {});
            watcher.on('error', () => {});
            await watcher.close();
            assert.equal(watcher.closed, true);
            assert.equal(watcher.listenerCount('add'), 0);
            assert.equal(watcher.listenerCount('error'), 0);
        });
    });
});

describe('fs facade (fixture controls)', function () {
    // Spies stand in for the real functions, so these controls perform no filesystem I/O.
    const root = path.join(DATA_DIR, 'guard-root');
    const outsidePath = path.join(DATA_DIR, 'outside');
    const argsFor = (name, target) =>
        name === 'cpSync' || name === 'renameSync' ? [path.join(root, 'in'), target] : [target];
    let real;
    let spyCalls;

    beforeEach(function () {
        real = {};
        spyCalls = {};
        for (const name of FS_OPERATIONS) {
            real[name] = fs[name];
            spyCalls[name] = 0;
            fs[name] = () => (spyCalls[name] += 1);
        }
    });

    afterEach(function () {
        endFixture();
        Object.assign(fs, real);
    });

    it('with no active fixture, a node fs call fails and never reaches the real function', function () {
        for (const name of FS_OPERATIONS) {
            assert.throws(
                () => nodeFs[name](...argsFor(name, path.join(root, 'x'))),
                /outside an active test fixture/,
            );
            assert.equal(spyCalls[name], 0, name);
        }
    });

    it('within a fixture, a call with any path outside the root is rejected before the real function runs', function () {
        startFixture(root);
        for (const name of FS_OPERATIONS) {
            assert.throws(
                () => nodeFs[name](...argsFor(name, outsidePath)),
                /outside the test root/,
            );
            assert.equal(spyCalls[name], 0, name);
        }
        nodeFs.mkdirSync(path.join(root, 'inside'));
        assert.equal(spyCalls.mkdirSync, 1);
        assert.equal(endFixture().length, FS_OPERATIONS.length);
        // The fs that mocha, the test helper and Node use is not confined.
        assert.doesNotThrow(() => fs.mkdirSync(outsidePath));
    });

    it('counting keeps confinement, and the records stay until the fixture ends', function () {
        startFixture(root);
        const counted = instrumentFs();
        assert.throws(() => nodeFs.rmSync(outsidePath), /outside the test root/);
        nodeFs.readdirSync(path.join(root, 'inside'));
        assert.deepEqual(counted.calls, ['readdirSync']);
        assert.throws(
            () => nodeFs.cpSync(path.join(root, 'in'), outsidePath),
            /outside the test root/,
        );
        assert.equal(spyCalls.rmSync + spyCalls.cpSync, 0);
        assert.equal(endFixture().length, 2);
        assert.throws(
            () => nodeFs.readdirSync(path.join(root, 'inside')),
            /outside an active test fixture/,
        );
    });
});
