module.exports = function (RED) {
    const fs = require('fs');
    const path = require('path');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    // Codes added to previously uncoded errors keep their message as status text,
    // so Status-node consumers see the same text as before.
    function createError(message, code) {
        const err = new Error(message);
        err.code = code;
        Object.defineProperty(err, 'statusText', { value: message });
        return err;
    }

    function DirectoryTransferNode(config) {
        RED.nodes.createNode(this, config);

        this.dynamic = config.dynamic;
        this.action = config.action;
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';
        this.destination = config.destination;
        this.destinationType = config.destinationType || 'str';
        this.recursive = config.recursive !== false;

        var node = this;
        extendNode(node);

        // After close, input still in progress starts no new filesystem operation and completes
        // without status, output or error.
        let closing = false;
        node.on('close', function () {
            closing = true;
        });

        node.on('input', async function (msg, send, done) {
            const finishClosed = () => {
                if (done) done();
            };
            try {
                const currentAction = node.dynamic ? msg.file && msg.file.action : node.action;
                const srcRaw = node.dynamic
                    ? msg.file && msg.file.source
                    : await node.getTypedProperty(node.source, node.sourceType, msg);
                const destRaw = node.dynamic
                    ? msg.file && msg.file.destination
                    : await node.getTypedProperty(node.destination, node.destinationType, msg);
                const recursive = node.dynamic ? msg.file && msg.file.recursive : node.recursive;

                // The node may have closed while the paths were read.
                if (closing) return finishClosed();

                if (!currentAction) throw createError('Action is missing', 'ACTION_MISSING');
                if (!srcRaw) throw createError('Source path is missing', 'SOURCE_PATH_MISSING');
                if (!destRaw)
                    throw createError('Destination path is missing', 'DESTINATION_PATH_MISSING');

                const srcPath = path.normalize(srcRaw);
                const dstPath = path.normalize(destRaw);

                if (srcPath === dstPath) {
                    node.log('Source and Destination path are the same');
                    finishAction('Ignored', srcPath, dstPath);
                    return;
                }

                if (currentAction !== 'copy' && currentAction !== 'move') {
                    throw createError(`Unknown action type: ${currentAction}`, 'INVALID_ACTION');
                }

                if (recursive) fs.mkdirSync(path.dirname(dstPath), { recursive: true });

                const parsed = path.parse(dstPath);

                var file = {
                    filetype: 'directory',
                    action: currentAction,
                    source: srcPath,
                    destination: dstPath,
                    path: dstPath,
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                };

                switch (currentAction) {
                    case 'copy':
                        fs.cpSync(srcPath, dstPath, { recursive: recursive });
                        msg.file = { ...msg.file, ...file };
                        finishAction(`Copied ${path.basename(srcPath)}`, srcPath, dstPath);
                        break;

                    case 'move':
                        try {
                            fs.renameSync(srcPath, dstPath, { recursive: recursive });
                        } catch (err) {
                            if (err.code === 'EXDEV') {
                                fs.cpSync(srcPath, dstPath, {
                                    recursive: recursive,
                                });
                                fs.rmSync(srcPath, {
                                    recursive: recursive,
                                    force: true,
                                });
                            } else throw err;
                        }
                        msg.file = { ...msg.file, ...file };
                        finishAction(`Moved ${path.basename(srcPath)}`, srcPath, dstPath);
                        break;
                }

                function finishAction(statusText) {
                    node.status.succeeded(statusText);
                    send(msg);
                    if (done) done();
                }
            } catch (err) {
                if (closing) return finishClosed();
                node.status.failed(
                    err.statusText || err.code || err.message || 'Configuration error',
                );
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('directory-transfer', DirectoryTransferNode);
};
