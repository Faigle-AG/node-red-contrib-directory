'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { EventEmitter } = require('events');
const helper = require('node-red-node-test-helper');
const directoryWatchNode = require('../src/directory-watch.js');

helper.init(require.resolve('node-red'));

// Phase 2.9: the typed fields of the directory nodes. T1 pins what each editor offers, T2 checks
// that each runtime allows exactly those types, T3 evaluates every offered type, T4 rejects any
// other type before anything starts, T5 pins the defaults of flows saved without the fields, and
// the watcher evaluates its source asynchronously.

const SRC = path.join(__dirname, '../src');
const RUN_ID = process.env.TEST_RUN_ID || `${Date.now()}-${process.pid}`;
const ROOT = path.join(__dirname, 'data', 'typed-inputs', RUN_ID);

const VALUE = ['msg', 'flow', 'global', 'str', 'jsonata', 'env'];
const TARGET = ['msg', 'flow', 'global'];
const EVENT_SOURCE = ['flow', 'global', 'str', 'jsonata', 'env'];

// What each editor offers: the types in order, the selected default type, and the saved defaults
// of the value and of its type field.
const EDITORS = {
    'directory-action.html': {
        'directory-action': {
            source: { types: VALUE, default: 'str', value: '', type: 'str' },
            property: { types: TARGET, default: 'msg', value: 'file.content', type: 'msg' },
        },
    },
    'directory-transfer.html': {
        'directory-transfer': {
            source: { types: VALUE, default: 'str', value: '', type: 'str' },
            destination: { types: VALUE, default: 'str', value: '', type: 'str' },
        },
    },
    'directory-watch.html': {
        'directory-watch': {
            source: { types: EVENT_SOURCE, default: 'str', value: '', type: 'str' },
            target: { types: TARGET, default: 'msg', value: 'file', type: 'msg' },
            ignoredFiles: { types: ['re'], default: 're', value: '', type: 're' },
        },
    },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// Runs an editor's registration script and its oneditprepare against a recording jQuery stub, and
// returns the registered definition and every typedInput it creates, by field.
function loadEditor(file, nodeType) {
    const html = fs.readFileSync(path.join(SRC, file), 'utf8');
    const registered = new Map();
    const inputs = {};
    const element = (selector) =>
        new Proxy(function () {}, {
            get(target, prop) {
                if (prop === 'selector') return selector;
                if (prop === 'typedInput') {
                    return (options) => {
                        inputs[selector.replace('#node-input-', '')] = {
                            // Copied into this realm: the editor script runs in its own.
                            types: Array.from(options.types),
                            default: options.default,
                            typeField: options.typeField && options.typeField.selector,
                        };
                        return element(selector);
                    };
                }
                if (prop === 'val') return () => '';
                if (prop === 'prop' || prop === 'is') return () => false;
                return () => element(selector);
            },
            apply: () => element(selector),
        });
    const anything = () =>
        new Proxy(function () {}, { get: () => anything(), apply: () => anything() });
    const RED = {
        nodes: { registerType: (type, definition) => registered.set(type, definition) },
        validators: anything(),
        _: (key) => key,
    };
    for (const [, source] of html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g))
        vm.runInNewContext(source, { RED, $: (selector) => element(String(selector)) });
    const definition = registered.get(nodeType);
    const self = Object.fromEntries(
        Object.entries(definition.defaults).map(([key, spec]) => [key, spec.value]),
    );
    definition.oneditprepare.call(self);
    return { definition, inputs };
}

// directory-action and directory-transfer get their own `fs`: a facade with only the six functions
// they use, as in close_spec.js. Every facade call is checked against the active test fixture. With
// no fixture (outside a test, or after a test's nodes are unloaded, as for a late continuation) it
// fails. Within one, a call with any path outside the case root is recorded and rejected before
// the real function runs, whether or not the test counts calls.
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

const RUNTIME = {
    'directory-action': directoryActionNode.TYPES,
    'directory-transfer': directoryTransferNode.TYPES,
    'directory-watch': directoryWatchNode.TYPES,
};

// Sends one message and resolves with the output message or the error it completes with.
function run(node, msg) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), 1500);
        helper.getNode('out').once('input', (out) => {
            clearTimeout(timer);
            resolve({ msg: out });
        });
        node.once('call:error', (call) => {
            clearTimeout(timer);
            resolve({ err: call.args[0] });
        });
        node.receive(msg);
    });
}

describe('typed inputs (Phase 2.9)', function () {
    after(function () {
        fs.rmSync(ROOT, { recursive: true, force: true });
    });

    this.timeout(10000);

    describe('T1 editor pins and T2 runtime parity', function () {
        for (const [file, nodes] of Object.entries(EDITORS)) {
            for (const [nodeType, fields] of Object.entries(nodes)) {
                describe(nodeType, function () {
                    const { definition, inputs } = loadEditor(file, nodeType);

                    it('creates exactly the expected typed inputs', function () {
                        assert.deepEqual(Object.keys(inputs).sort(), Object.keys(fields).sort());
                    });

                    for (const [field, expected] of Object.entries(fields)) {
                        it(`${field}: offered types, default type, type field and saved defaults`, function () {
                            assert.deepEqual(inputs[field].types, expected.types);
                            assert.equal(inputs[field].default, expected.default);
                            assert.equal(inputs[field].typeField, `#node-input-${field}Type`);
                            assert.equal(definition.defaults[field].value, expected.value);
                            assert.equal(definition.defaults[`${field}Type`].value, expected.type);
                        });

                        it(`${field}: the runtime allows exactly the offered types`, function () {
                            assert.deepEqual(
                                [...RUNTIME[nodeType][field]].sort(),
                                [...expected.types].sort(),
                            );
                        });
                    }
                });
            }
        }
    });

    describe('directory-action and directory-transfer', function () {
        let root;

        beforeEach(function (done) {
            root = path.join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
            fs.mkdirSync(path.join(root, 'listed'), { recursive: true });
            fs.writeFileSync(path.join(root, 'listed', 'a.txt'), 'a');
            process.env.TYPED_29_PATH = path.join(root, 'listed');
            startFixture(root);
            helper.startServer(done);
        });

        afterEach(function (done) {
            delete process.env.TYPED_29_PATH;
            helper.unload().then(() =>
                helper.stopServer(() => {
                    // Only now, after unload: any later filesystem call of these nodes is refused.
                    const outside = endFixture();
                    fs.rmSync(root, { recursive: true, force: true });
                    done(
                        outside.length
                            ? new Error(`fs outside the test root: ${outside}`)
                            : undefined,
                    );
                }),
            );
        });

        const wired = (node) => [
            { id: 'f1', type: 'tab' },
            { ...node, id: 'n1', z: 'f1', wires: [['out']] },
            { id: 'out', type: 'helper', z: 'f1' },
        ];

        // A value of each offered type that resolves to `value`, given msg.p and flow/global p.
        const representative = (type, value) =>
            ({
                msg: ['p', { p: value }],
                flow: ['p', {}],
                global: ['p', {}],
                str: [value, {}],
                jsonata: ['p', { p: value }],
                env: ['TYPED_29_PATH', {}],
            })[type];

        function preset(node, value) {
            node.context().flow.set('p', value);
            node.context().global.set('p', value);
        }

        describe('T3 every offered type works', function () {
            for (const type of VALUE) {
                it(`directory-action source of type ${type} lists the directory`, async function () {
                    const listed = path.join(root, 'listed');
                    const [source, msg] = representative(type, listed);
                    await helper.load(
                        directoryActionNode,
                        wired({
                            type: 'directory-action',
                            action: 'list',
                            source,
                            sourceType: type,
                            property: 'out',
                            propertyType: 'msg',
                        }),
                    );
                    const n1 = helper.getNode('n1');
                    preset(n1, listed);
                    const result = await run(n1, msg);
                    assert.deepEqual(result.msg.out.contents, ['a.txt']);
                });

                for (const field of ['source', 'destination']) {
                    it(`directory-transfer ${field} of type ${type} copies the directory`, async function () {
                        const from = path.join(root, 'listed');
                        const to = path.join(root, 'copied');
                        const value = field === 'source' ? from : to;
                        const [configured, msg] = representative(type, value);
                        if (type === 'env') process.env.TYPED_29_PATH = value;
                        const other = field === 'source' ? to : from;
                        await helper.load(
                            directoryTransferNode,
                            wired({
                                type: 'directory-transfer',
                                action: 'copy',
                                [field]: configured,
                                [`${field}Type`]: type,
                                [field === 'source' ? 'destination' : 'source']: other,
                                [field === 'source' ? 'destinationType' : 'sourceType']: 'str',
                                recursive: true,
                            }),
                        );
                        const n1 = helper.getNode('n1');
                        preset(n1, value);
                        const result = await run(n1, msg);
                        assert.ok(result.msg, `copied: ${result.err && result.err.message}`);
                        assert.deepEqual(fs.readdirSync(to), ['a.txt']);
                    });
                }
            }

            for (const type of TARGET) {
                it(`directory-action property of type ${type} receives the listing`, async function () {
                    const listed = path.join(root, 'listed');
                    await helper.load(
                        directoryActionNode,
                        wired({
                            type: 'directory-action',
                            action: 'list',
                            source: listed,
                            sourceType: 'str',
                            property: 'out',
                            propertyType: type,
                        }),
                    );
                    const n1 = helper.getNode('n1');
                    const result = await run(n1, {});
                    const written = type === 'msg' ? result.msg.out : n1.context()[type].get('out');
                    assert.deepEqual(written.contents, ['a.txt']);
                });
            }
        });

        describe('T4 any other type fails before the filesystem is touched', function () {
            for (const type of ['num', 'foo']) {
                it(`directory-action source of type ${type}`, async function () {
                    await helper.load(
                        directoryActionNode,
                        wired({
                            type: 'directory-action',
                            action: 'create',
                            source: path.join(root, 'made'),
                            sourceType: type,
                            property: 'out',
                            propertyType: 'msg',
                        }),
                    );
                    fixture.calls = [];
                    const result = await run(helper.getNode('n1'), {});
                    assert.equal(result.err.code, 'INVALID_CONFIGURATION');
                    assert.equal(result.err.message, `Source type '${type}' is not supported`);
                    assert.deepEqual(fixture.calls, []);
                });

                for (const field of ['source', 'destination']) {
                    it(`directory-transfer ${field} of type ${type}`, async function () {
                        await helper.load(
                            directoryTransferNode,
                            wired({
                                type: 'directory-transfer',
                                action: 'copy',
                                source: path.join(root, 'listed'),
                                sourceType: field === 'source' ? type : 'str',
                                destination: path.join(root, 'copied'),
                                destinationType: field === 'destination' ? type : 'str',
                                recursive: true,
                            }),
                        );
                        fixture.calls = [];
                        const result = await run(helper.getNode('n1'), {});
                        const label = field === 'source' ? 'Source' : 'Destination';
                        assert.equal(result.err.code, 'INVALID_CONFIGURATION');
                        assert.equal(
                            result.err.message,
                            `${label} type '${type}' is not supported`,
                        );
                        assert.deepEqual(fixture.calls, []);
                    });
                }
            }

            for (const type of ['str', 'foo']) {
                it(`directory-action property of type ${type} fails with the setter's message, before creating`, async function () {
                    await helper.load(
                        directoryActionNode,
                        wired({
                            type: 'directory-action',
                            action: 'create',
                            source: path.join(root, 'made'),
                            sourceType: 'str',
                            property: 'out',
                            propertyType: type,
                        }),
                    );
                    fixture.calls = [];
                    const result = await run(helper.getNode('n1'), {});
                    assert.equal(result.err.code, undefined);
                    assert.equal(result.err.message, `Unsupported target property type: ${type}`);
                    assert.deepEqual(fixture.calls, []);
                    assert.equal(fs.existsSync(path.join(root, 'made')), false);
                });
            }

            it('the static paths of a dynamic node are not checked', async function () {
                await helper.load(directoryActionNode, [
                    { id: 'f1', type: 'tab' },
                    {
                        id: 'n1',
                        z: 'f1',
                        type: 'directory-action',
                        dynamic: true,
                        sourceType: 'foo',
                        property: 'out',
                        propertyType: 'msg',
                        wires: [['out']],
                    },
                    { id: 'out', type: 'helper', z: 'f1' },
                ]);
                const result = await run(helper.getNode('n1'), {
                    file: { action: 'list', path: path.join(root, 'listed') },
                });
                assert.deepEqual(result.msg.out.contents, ['a.txt']);
            });

            it('the static paths of a dynamic transfer are not checked', async function () {
                await helper.load(directoryTransferNode, [
                    { id: 'f1', type: 'tab' },
                    {
                        id: 'n1',
                        z: 'f1',
                        type: 'directory-transfer',
                        dynamic: true,
                        sourceType: 'foo',
                        destinationType: 'foo',
                        wires: [['out']],
                    },
                    { id: 'out', type: 'helper', z: 'f1' },
                ]);
                const result = await run(helper.getNode('n1'), {
                    file: {
                        action: 'copy',
                        source: path.join(root, 'listed'),
                        destination: path.join(root, 'copied'),
                        recursive: true,
                    },
                });
                assert.ok(result.msg, `copied: ${result.err && result.err.message}`);
                assert.deepEqual(fs.readdirSync(path.join(root, 'copied')), ['a.txt']);
            });
        });

        describe('T5 flows saved without the typed fields', function () {
            it('directory-action defaults to a string source and msg.payload', async function () {
                await helper.load(
                    directoryActionNode,
                    wired({
                        type: 'directory-action',
                        action: 'list',
                        source: path.join(root, 'listed'),
                    }),
                );
                const result = await run(helper.getNode('n1'), {});
                assert.deepEqual(result.msg.payload.contents, ['a.txt']);
            });

            it('directory-transfer defaults to string paths', async function () {
                await helper.load(
                    directoryTransferNode,
                    wired({
                        type: 'directory-transfer',
                        action: 'copy',
                        source: path.join(root, 'listed'),
                        destination: path.join(root, 'copied'),
                        recursive: true,
                    }),
                );
                const result = await run(helper.getNode('n1'), {});
                assert.ok(result.msg, `copied: ${result.err && result.err.message}`);
            });
        });
    });

    describe('directory-watch source (asynchronous evaluation)', function () {
        const chokidarPath = require.resolve('chokidar', { paths: [SRC] });
        let realChokidar;
        let watches;
        let held;

        // A context store whose reads the test can hold: with `held` set, each get waits in it.
        function holdingStore() {
            const data = {};
            return function () {
                return {
                    open: () => Promise.resolve(),
                    close: () => Promise.resolve(),
                    get(scope, key, callback) {
                        if (typeof callback !== 'function')
                            throw new Error('this store needs a callback');
                        const reply = (err) => callback(err || null, (data[scope] || {})[key]);
                        if (held) held.push(reply);
                        else setTimeout(reply, 5);
                    },
                    set(scope, key, value, callback) {
                        (data[scope] = data[scope] || {})[key] = value;
                        if (callback) setTimeout(() => callback(null), 1);
                    },
                    keys: (scope, callback) => callback(null, Object.keys(data[scope] || {})),
                    delete: () => Promise.resolve(),
                    clean: () => Promise.resolve(),
                };
            };
        }

        before(function () {
            helper.settings({
                contextStorage: {
                    default: { module: 'memory' },
                    slow: { module: holdingStore() },
                },
            });
        });

        after(function () {
            helper.settings({ contextStorage: undefined });
        });

        beforeEach(function (done) {
            require(chokidarPath);
            realChokidar = require.cache[chokidarPath].exports;
            watches = [];
            held = null;
            require.cache[chokidarPath].exports = {
                watch: (target) => {
                    watches.push(target);
                    const watcher = new EventEmitter();
                    watcher.close = () => Promise.resolve();
                    return watcher;
                },
            };
            process.env.TYPED_29_WATCH = '/watched/env';
            helper.startServer(done);
        });

        afterEach(function (done) {
            require.cache[chokidarPath].exports = realChokidar;
            delete process.env.TYPED_29_WATCH;
            helper.unload().then(() => helper.stopServer(done));
        });

        // Loads the context stores, presets flow and global values, then deploys the watcher, so
        // its source is evaluated against real stores from construction on.
        async function deploy(watch, values = {}) {
            await helper.load(directoryWatchNode, [{ id: 'f1', type: 'tab' }]);
            await helper._context.load();
            const seed = helper._context.get('seed', 'f1');
            for (const [key, value] of Object.entries(values)) {
                await new Promise((resolve) => seed.flow.set(key, value, 'slow', resolve));
                await new Promise((resolve) => seed.global.set(key, value, 'slow', resolve));
                seed.flow.set(key, value);
                seed.global.set(key, value);
            }
            await helper.setFlows([
                { id: 'f1', type: 'tab' },
                {
                    id: 'n1',
                    z: 'f1',
                    type: 'directory-watch',
                    targetType: 'msg',
                    target: 'file',
                    filterFiles: true,
                    watchAdd: true,
                    ...watch,
                },
            ]);
            return helper.getNode('n1');
        }

        function observe(node) {
            const seen = { statuses: [], errors: [] };
            node.on('call:status', (call) => {
                const status = call.args[0];
                if (status && Object.keys(status).length) seen.statuses.push(status);
            });
            node.on('call:error', (call) => seen.errors.push(call.args[0]));
            return seen;
        }

        describe('T3 every offered type starts the watcher on its value', function () {
            const cases = {
                str: [{ source: '/watched/str' }, '/watched/str'],
                env: [{ source: 'TYPED_29_WATCH' }, '/watched/env'],
                flow: [{ source: 'dir' }, '/watched/flow', { dir: '/watched/flow' }],
                global: [{ source: 'dir' }, '/watched/global', { dir: '/watched/global' }],
                jsonata: [{ source: '"/watched/jsonata"' }, '/watched/jsonata'],
            };
            for (const [type, [watch, expected, values]] of Object.entries(cases)) {
                it(type, async function () {
                    await deploy({ ...watch, sourceType: type }, values);
                    await settle();
                    assert.deepEqual(watches, [path.normalize(expected)]);
                });
            }

            for (const type of ['flow', 'global']) {
                it(`${type} from an asynchronous store`, async function () {
                    await deploy(
                        { source: '#:(slow)::dir', sourceType: type },
                        { dir: '/watched/slow' },
                    );
                    await settle();
                    assert.deepEqual(watches, [path.normalize('/watched/slow')]);
                });
            }

            it('jsonata is evaluated without a message, as before', async function () {
                await deploy({
                    source: '$exists($) ? "/watched/with-message" : "/watched/no-message"',
                    sourceType: 'jsonata',
                });
                await settle();
                assert.deepEqual(watches, [path.normalize('/watched/no-message')]);
            });
        });

        describe('T4 any other type fails at start-up and watches nothing', function () {
            const cases = [
                ['source', 'msg', "Source type 'msg' is not supported", 'INVALID_CONFIGURATION'],
                ['source', 'foo', "Source type 'foo' is not supported", 'INVALID_CONFIGURATION'],
                ['target', 'str', 'Unsupported target property type: str', undefined],
                ['target', 'foo', 'Unsupported target property type: foo', undefined],
                [
                    'ignoredFiles',
                    'str',
                    "Ignored files type 'str' is not supported",
                    'INVALID_CONFIGURATION',
                ],
            ];
            for (const [field, type, message, code] of cases) {
                it(`${field} of type ${type}`, async function () {
                    const n1 = await deploy({
                        source: '/watched/str',
                        [`${field}Type`]: type,
                        // The pattern's type only matters when there is a pattern.
                        ...(field === 'ignoredFiles' && { ignoredFiles: '\\.tmp$' }),
                    });
                    const seen = observe(n1);
                    await settle();
                    assert.deepEqual(watches, []);
                    assert.equal(seen.errors.length, 1);
                    assert.equal(seen.errors[0].message, message);
                    assert.equal(seen.errors[0].code, code);
                    assert.equal(seen.statuses.at(-1).text, `Error : ${message}`);
                });
            }
        });

        describe('T4 an unused pattern is not checked', function () {
            it('a blank ignoredFiles of an unoffered type still watches', async function () {
                const n1 = await deploy({
                    source: '/watched/str',
                    ignoredFiles: '',
                    ignoredFilesType: 'str',
                });
                const seen = observe(n1);
                await settle();
                assert.deepEqual(watches, [path.normalize('/watched/str')]);
                assert.equal(seen.errors.length, 0);
            });
        });

        describe('T5 and path outcomes, pinned as today', function () {
            it('a flow saved without source and target types watches a string source into msg.file', async function () {
                await deploy({
                    source: '/watched/legacy',
                    sourceType: undefined,
                    targetType: undefined,
                    target: undefined,
                });
                await settle();
                assert.deepEqual(watches, [path.normalize('/watched/legacy')]);
            });

            it('a blank source still watches "."', async function () {
                await deploy({ source: '', sourceType: 'str' });
                await settle();
                assert.deepEqual(watches, ['.']);
            });

            for (const [label, expression] of [
                ['null', 'null'],
                ['undefined', '$nothing'],
                ['a number', '5'],
                ['a boolean', 'true'],
            ]) {
                it(`a source that evaluates to ${label} fails at start-up and watches nothing`, async function () {
                    const n1 = await deploy({ source: expression, sourceType: 'jsonata' });
                    const seen = observe(n1);
                    await settle();
                    assert.deepEqual(watches, []);
                    assert.equal(seen.errors.length, 1);
                    assert.equal(seen.errors[0].code, 'ERR_INVALID_ARG_TYPE');
                });
            }

            it('an invalid JSONata expression fails at start-up and watches nothing', async function () {
                const n1 = await deploy({ source: '$$$(', sourceType: 'jsonata' });
                const seen = observe(n1);
                await settle();
                assert.deepEqual(watches, []);
                assert.equal(seen.errors.length, 1);
            });
        });

        describe('a watcher that fails to start', function () {
            for (const [label, watch, values] of [
                [
                    'after an asynchronous evaluation',
                    { source: '#:(slow)::dir', sourceType: 'flow' },
                    { dir: '/watched/slow' },
                ],
                ['after a synchronous evaluation', { source: '/watched/str', sourceType: 'str' }],
            ]) {
                it(`is reported once ${label}`, async function () {
                    require.cache[chokidarPath].exports = {
                        watch: () => {
                            throw new Error('watch failed');
                        },
                    };
                    const n1 = await deploy(watch, values);
                    const seen = observe(n1);
                    await settle();
                    assert.equal(seen.errors.length, 1);
                    assert.equal(seen.errors[0].message, 'watch failed');
                    assert.equal(seen.statuses.at(-1).text, 'Error : watch failed');
                });
            }
        });

        describe('close while the source is being evaluated', function () {
            for (const outcome of ['resolves', 'rejects']) {
                it(`an evaluation that ${outcome} after close starts no watcher and reports nothing`, async function () {
                    held = [];
                    const n1 = await deploy(
                        { source: '#:(slow)::dir', sourceType: 'flow' },
                        { dir: '/watched/slow' },
                    );
                    await settle();
                    assert.equal(held.length, 1);
                    await n1.close();
                    const seen = observe(n1);
                    held[0](outcome === 'rejects' ? new Error('store failed') : null);
                    await settle();
                    assert.deepEqual(watches, []);
                    assert.deepEqual(seen.statuses, []);
                    assert.deepEqual(seen.errors, []);
                });
            }

            it('close with no watcher yet completes through its own callback', async function () {
                held = [];
                const n1 = await deploy(
                    { source: '#:(slow)::dir', sourceType: 'flow' },
                    { dir: '/watched/slow' },
                );
                await settle();
                // The node's own close callback, called directly: it must complete, not throw.
                const close = n1._closeCallbacks.find((callback) => callback.length === 2);
                let completed = 0;
                close.call(n1, false, () => (completed += 1));
                assert.equal(completed, 1);
                held[0](null);
                await settle();
                assert.deepEqual(watches, []);
            });

            it('an evaluation that rejects while open fails at start-up and watches nothing', async function () {
                held = [];
                const n1 = await deploy(
                    { source: '#:(slow)::dir', sourceType: 'flow' },
                    { dir: '/watched/slow' },
                );
                const seen = observe(n1);
                await settle();
                held[0](new Error('store failed'));
                await settle();
                assert.deepEqual(watches, []);
                assert.equal(seen.errors.length, 1);
                assert.equal(seen.errors[0].message, 'store failed');
            });
        });
    });

    describe('fs facade (fixture controls)', function () {
        // Spies stand in for the real functions, so these controls perform no filesystem I/O.
        const root = path.join(ROOT, 'case-a');
        const otherCase = path.join(ROOT, 'case-b', 'x');
        const outsidePath = path.join(__dirname, 'outside');
        const twoPaths = (name) => name === 'cpSync' || name === 'renameSync';
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
                const inside = path.join(root, 'x');
                const args = twoPaths(name) ? [inside, path.join(root, 'y')] : [inside];
                assert.throws(() => nodeFs[name](...args), /outside an active test fixture/);
                assert.equal(spyCalls[name], 0, name);
            }
        });

        it("within a fixture, another case's root and the run outside it are rejected", function () {
            startFixture(root);
            for (const name of FS_OPERATIONS) {
                for (const target of [otherCase, outsidePath]) {
                    const args = twoPaths(name) ? [target, path.join(root, 'y')] : [target];
                    assert.throws(() => nodeFs[name](...args), /outside the test root/);
                }
                assert.equal(spyCalls[name], 0, name);
            }
            nodeFs.mkdirSync(path.join(root, 'inside'));
            assert.equal(spyCalls.mkdirSync, 1);
            assert.equal(endFixture().length, 2 * FS_OPERATIONS.length);
        });

        it('copy and move check both endpoints, and counting keeps confinement', function () {
            startFixture(root);
            fixture.calls = [];
            const inside = path.join(root, 'in');
            for (const name of ['cpSync', 'renameSync']) {
                assert.throws(() => nodeFs[name](inside, otherCase), /outside the test root/);
                assert.throws(() => nodeFs[name](outsidePath, inside), /outside the test root/);
            }
            nodeFs.cpSync(inside, path.join(root, 'out'));
            assert.equal(spyCalls.renameSync, 0);
            assert.equal(spyCalls.cpSync, 1);
            assert.deepEqual(fixture.calls, ['cpSync']);
            assert.equal(endFixture().length, 4);
            assert.throws(() => nodeFs.readdirSync(inside), /outside an active test fixture/);
        });
    });
});
