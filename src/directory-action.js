// The types each typed field offers in the editor (Phase 2.9). A configured type outside these
// fails clearly before anything is read or changed.
const TYPES = {
    source: ['msg', 'flow', 'global', 'str', 'jsonata', 'env'],
    property: ['msg', 'flow', 'global'],
};

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
                // Dynamic mode ignores the static source, so its type is not checked there.
                if (!node.dynamic && !TYPES.source.includes(node.sourceType)) {
                    throw createError(
                        `Source type '${node.sourceType}' is not supported`,
                        'INVALID_CONFIGURATION',
                    );
                }
                if (!TYPES.property.includes(node.propertyType)) {
                    throw new Error(`Unsupported target property type: ${node.propertyType}`);
                }

                const currentAction = node.dynamic ? msg.file && msg.file.action : node.action;
                const sourceRaw = node.dynamic
                    ? msg.file && msg.file.path
                    : await node.getTypedProperty(node.source, node.sourceType, msg);
                const recursive = node.dynamic ? msg.file && msg.file.recursive : node.recursive;

                // The node may have closed while the source path was read.
                if (closing) return finishClosed();

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
                    // The node may have closed while the output was written.
                    if (closing) return finishClosed();
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

    RED.nodes.registerType('directory-action', DirectoryActionNode);
};

module.exports.TYPES = TYPES;
