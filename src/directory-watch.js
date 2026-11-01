// The types each typed field offers in the editor (Phase 2.9). A configured type outside these
// fails clearly at start-up instead of being evaluated.
const TYPES = {
    source: ['flow', 'global', 'str', 'jsonata', 'env'],
    target: ['msg', 'flow', 'global'],
    ignoredFiles: ['re'],
};

module.exports = function (RED) {
    const chokidar = require('chokidar');
    const path = require('path');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    function createError(message, code) {
        const err = new Error(message);
        err.code = code;
        return err;
    }

    function DirectoryWatchNode(config) {
        RED.nodes.createNode(this, config);

        this.sourceType = config.sourceType || 'str';
        this.target = config.target || 'file';
        this.targetType = config.targetType || 'msg';
        this.ignoredFilesType = config.ignoredFilesType || 're';
        this.depth = parseInt(config.depth) || 0;
        this.awaitWriteFinish = config.awaitWriteFinish;
        this.stabilityThreshold = parseInt(config.stabilityThreshold) || 2000;
        this.ignoreInitial = config.ignoreInitial;
        this.ignoredFiles = config.ignoredFiles || false;
        this.watchAdd = config.watchAdd;
        this.watchChange = config.watchChange;
        this.watchDelete = config.watchDelete;
        this.filterFiles = config.filterFiles;
        this.filterDirs = config.filterDirs;

        var node = this;
        extendNode(node);

        // Registered before the source is evaluated, so a close while an asynchronous evaluation is
        // pending starts no watcher. chokidar stops emitting once closed; `stopped` also covers
        // output writes still in flight at close, and a watcher that emits late.
        let stopped = false;
        let watcher = null;
        node.on('close', function (removed, done) {
            stopped = true;
            if (!watcher) return done();
            watcher.close().then(
                () => done(),
                (err) => {
                    node.warn(`Could not close the directory watcher: ${err.message}`);
                    done();
                },
            );
        });

        function fail(err) {
            node.status.failed('Error : ' + err.message);
            node.error(err);
        }

        this.startListening = () => {
            var awaitWriteConfig = false;
            if (node.awaitWriteFinish) {
                awaitWriteConfig = {
                    stabilityThreshold: node.stabilityThreshold,
                    pollInterval: 100,
                };
            }

            let ignoreRegex = null;
            try {
                if (node.ignoredFiles) ignoreRegex = new RegExp(node.ignoredFiles);
            } catch (err) {
                node.status.failed('Error : ' + err.message);
                node.error(err);
                return;
            }
            const normalizedTarget = node.source;

            watcher = chokidar.watch(node.source, {
                ignored: (filename) => ignoreRegex?.test(path.basename(filename)),
                persistent: true,
                depth: node.depth,
                ignoreInitial: node.ignoreInitial,
                awaitWriteFinish: awaitWriteConfig,
                usePolling: true,
                alwaysStat: true,
                useFsEvents: true,
                binaryInterval: 1000,
                atomic: true,
            });

            function createMsg(filename, stats, eventType, fileType) {
                node.status.succeeded(`${eventType} ${fileType} ${path.basename(filename)}`, {
                    next: () => node.status.waiting('Listening...'),
                });

                const parsed = path.parse(filename);
                return {
                    action: eventType,
                    filetype: fileType,
                    source: node.source,
                    path: path.normalize(filename),
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                    stats: stats ? stats : null,
                };
            }

            async function sendEvent(filename, stats, eventType, fileType) {
                if (stopped) return;
                try {
                    const msg = {};
                    const file = createMsg(filename, stats, eventType, fileType);

                    await node.setTypedProperty(node.target, node.targetType, msg, file);
                    if (stopped) return;
                    node.send(msg);
                } catch (err) {
                    if (stopped) return;
                    node.status.failed('Error : ' + err.message);
                    node.error(err);
                }
            }

            if (node.filterFiles) {
                if (node.watchAdd) watcher.on('add', (f, s) => void sendEvent(f, s, 'add', 'file'));
                if (node.watchChange)
                    watcher.on('change', (f, s) => void sendEvent(f, s, 'change', 'file'));
                if (node.watchDelete)
                    watcher.on('unlink', (f) => void sendEvent(f, null, 'delete', 'file'));
            }

            if (node.filterDirs) {
                if (node.watchAdd)
                    watcher.on('addDir', (f, s) => {
                        if (path.normalize(f) === normalizedTarget) return;
                        void sendEvent(f, s, 'add', 'directory');
                    });
                if (node.watchDelete)
                    watcher.on('unlinkDir', (f) => {
                        if (path.normalize(f) === normalizedTarget) return;
                        void sendEvent(f, null, 'delete', 'directory');
                    });
            }

            watcher.on('ready', () => node.status.waiting('Listening...'));

            watcher.on('error', (err) => {
                if (stopped) return;
                node.status.failed('Error : ' + err.message);
                node.error(err);
            });
        };

        // Unsupported types fail before anything is evaluated or watched.
        if (!TYPES.source.includes(node.sourceType)) {
            fail(
                createError(
                    `Source type '${node.sourceType}' is not supported`,
                    'INVALID_CONFIGURATION',
                ),
            );
            return;
        }
        if (!TYPES.target.includes(node.targetType)) {
            fail(new Error(`Unsupported target property type: ${node.targetType}`));
            return;
        }
        // A blank pattern is never used, so its type is not checked.
        if (node.ignoredFiles && !TYPES.ignoredFiles.includes(node.ignoredFilesType)) {
            fail(
                createError(
                    `Ignored files type '${node.ignoredFilesType}' is not supported`,
                    'INVALID_CONFIGURATION',
                ),
            );
            return;
        }

        // The callback form also evaluates JSONata and asynchronous context stores. It passes no
        // message, as before, and normalizes the raw result unchanged: a blank source still means
        // '.', and a non-string fails here rather than being treated as a path. A failure to start
        // the watcher is reported here too, since an asynchronous callback has no caller to catch it.
        const started = (err, value) => {
            if (stopped) return;
            if (err) return fail(err);
            try {
                node.source = path.normalize(value);
                node.startListening();
            } catch (startErr) {
                fail(startErr);
            }
        };
        try {
            RED.util.evaluateNodeProperty(config.source, node.sourceType, node, undefined, started);
        } catch (err) {
            started(err);
        }
    }

    RED.nodes.registerType('directory-watch', DirectoryWatchNode);
};

module.exports.TYPES = TYPES;
