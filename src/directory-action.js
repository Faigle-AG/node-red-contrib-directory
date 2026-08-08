module.exports = function (RED) {
    const fs = require('fs');
    const path = require('path');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    function DirectoryActionNode(config) {
        RED.nodes.createNode(this, config);

        this.dynamic = config.dynamic;
        this.action = config.action;
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';
        this.property = config.property || 'payload';
        this.propertyType = config.propertyType || 'msg';
        this.recursive = config.recursive !== false;

        var node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                const currentAction = node.dynamic ? msg.file && msg.file.action : node.action;
                const sourceRaw = node.dynamic
                    ? msg.file && msg.file.path
                    : await node.getTypedProperty(node.source, node.sourceType, msg);
                const recursive = node.dynamic ? msg.file && msg.file.recursive : node.recursive;

                if (!sourceRaw) throw new Error('Source directory path is missing');
                if (!currentAction) throw new Error('Action is missing');

                const targetPath = path.normalize(sourceRaw);
                const parsed = path.parse(targetPath);

                var file = {
                    filetype: 'directory',
                    path: targetPath,
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                };

                const setOutputData = async (data) => {
                    await node.setTypedProperty(node.property, node.propertyType, msg, data);
                };

                switch (currentAction) {
                    case 'create':
                        fs.mkdirSync(targetPath, {
                            recursive: recursive,
                        });
                        msg.file = { ...msg.file, ...file };
                        await setOutputData(true);
                        finishAction(`Created ${file.base}`);
                        break;

                    case 'delete':
                        fs.rmSync(targetPath, {
                            recursive: recursive,
                            force: true,
                        });
                        msg.file = { ...msg.file, ...file };
                        await setOutputData(true);
                        finishAction(`Deleted ${file.base}`);
                        break;

                    case 'list': {
                        const files = fs.readdirSync(targetPath);
                        file = { ...msg.file, ...file };
                        file.contents = files;
                        await setOutputData(file);
                        finishAction(`Listed ${files.length} items`);
                        break;
                    }

                    default:
                        throw new Error(`Unknown action: ${currentAction}`);
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

    RED.nodes.registerType('directory-action', DirectoryActionNode);
};
