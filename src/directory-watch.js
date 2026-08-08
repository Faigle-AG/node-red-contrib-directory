module.exports = function (RED) {
    const chokidar = require('chokidar');
    const path = require('path');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    function DirectoryWatchNode(config) {
        RED.nodes.createNode(this, config);

        this.sourceType = config.sourceType || 'str';
        this.source = path.normalize(
            RED.util.evaluateNodeProperty(config.source, this.sourceType, this),
        );
        this.target = config.target || 'file';
        this.targetType = config.targetType || 'msg';
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

        this.startListening = () => {
            var node = this;
            extendNode(node);

            var awaitWriteConfig = false;
            if (node.awaitWriteFinish) {
                awaitWriteConfig = {
                    stabilityThreshold: node.stabilityThreshold,
                    pollInterval: 100,
                };
            }

            const ignoreRegex = node.ignoredFiles ? new RegExp(node.ignoredFiles) : null;
            const normalizedTarget = node.source;

            const watcher = chokidar.watch(node.source, {
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
                try {
                    const msg = {};
                    const file = createMsg(filename, stats, eventType, fileType);

                    await node.setTypedProperty(node.target, node.targetType, msg, file);
                    node.send(msg);
                } catch (err) {
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
                node.status.failed('Error : ' + err.message);
                node.error(err);
            });

            node.on('close', () => watcher.close());
        };

        this.startListening();
    }

    RED.nodes.registerType('directory-watch', DirectoryWatchNode);
};
