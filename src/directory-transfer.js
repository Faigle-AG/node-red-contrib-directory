module.exports = function (RED) {
    const fs = require('fs');
    const path = require('path');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    function DirectoryTransferNode(config) {
        RED.nodes.createNode(this, config);

        this.dynamic = config.dynamic;
        this.action = config.action;
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';
        this.destination = config.destination;
        this.destinationType = config.destinationType || 'str';
        this.createParent = config.createParent !== false;

        var node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                const currentAction = node.dynamic ? msg.file && msg.file.action : node.action;
                const srcRaw = node.dynamic
                    ? msg.file && msg.file.source
                    : await node.getTypedProperty(node.source, node.sourceType, msg);
                const destRaw = node.dynamic
                    ? msg.file && msg.file.destination
                    : await node.getTypedProperty(node.destination, node.destinationType, msg);

                if (!currentAction) throw new Error('Action is missing');
                if (!srcRaw) throw new Error('Source path is missing');
                if (!destRaw) throw new Error('Destination path is missing');

                const srcPath = path.normalize(srcRaw);
                const dstPath = path.normalize(destRaw);

                if (srcPath === dstPath) {
                    node.log('Source and Destination path are the same');
                    finishAction('Ignored', srcPath, dstPath);
                    return;
                }

                if (node.createParent) fs.mkdirSync(path.dirname(dstPath), { recursive: true });

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
                        fs.cpSync(srcPath, dstPath, { recursive: true });
                        msg.file = { ...msg.file, ...file };
                        finishAction(`Copied ${path.basename(srcPath)}`, srcPath, dstPath);
                        break;

                    case 'move':
                        try {
                            fs.renameSync(srcPath, dstPath);
                        } catch (err) {
                            if (err.code === 'EXDEV') {
                                fs.cpSync(srcPath, dstPath, {
                                    recursive: true,
                                });
                                fs.rmSync(srcPath, {
                                    recursive: true,
                                    force: true,
                                });
                            } else throw err;
                        }
                        msg.file = { ...msg.file, ...file };
                        finishAction(`Moved ${path.basename(srcPath)}`, srcPath, dstPath);
                        break;

                    default:
                        throw new Error(`Unknown action type: ${currentAction}`);
                }

                function finishAction(statusText) {
                    node.status.succeeded(statusText);
                    send(msg);
                    if (done) done();
                }
            } catch (err) {
                node.status.failed(err.code || err.message || 'Configuration error');
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('directory-transfer', DirectoryTransferNode);
};
