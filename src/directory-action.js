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

                if (!sourceRaw)
                    throw createError('Source directory path is missing', 'DIRECTORY_PATH_MISSING');
                if (!currentAction) throw createError('Action is missing', 'ACTION_MISSING');

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
                        try {
                            fs.rmSync(targetPath, { recursive: recursive, force: true });
                        } catch (err) {
                            // rmSync cannot remove a directory without recursion; remove it if empty.
                            if (recursive || err.code !== 'ERR_FS_EISDIR') throw err;
                            fs.rmdirSync(targetPath);
                        }
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
                        throw createError(`Unknown action: ${currentAction}`, 'INVALID_ACTION');
                }

                function finishAction(statusText) {
                    node.status.succeeded(statusText);
                    send(msg);
                    if (done) done();
                }
            } catch (err) {
                node.status.failed(
                    err.statusText || err.code || err.message || 'Configuration error',
                );
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('directory-action', DirectoryActionNode);
};
