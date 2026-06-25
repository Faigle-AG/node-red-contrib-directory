module.exports = function (RED) {
    const fs = require('fs');
    const path = require('path');

    function DirectoryActionNode(config) {
        RED.nodes.createNode(this, config);

        this.dynamic = config.dynamic;
        this.action = config.action;
        this.target = config.target;
        this.targetType = config.targetType || 'str';

        var node = this;

        node.on('input', function (msg, send, done) {
            try {
                const currentAction = node.dynamic ? msg.file && msg.file.action : node.action;
                const targetRaw = node.dynamic
                    ? msg.file && msg.file.path
                    : RED.util.evaluateNodeProperty(node.target, node.targetType, node, msg);

                if (!targetRaw) throw new Error('Target directory path is missing');

                if (!currentAction) throw new Error('Action is missing');

                const targetPath = path.normalize(targetRaw);
                const parsed = path.parse(targetPath);

                var file = {
                    filetype: 'directory',
                    path: targetPath,
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                };

                switch (currentAction) {
                    case 'create':
                        fs.mkdir(targetPath, { recursive: true }, (err) => {
                            if (err) return handleError(err);

                            msg.file = { ...msg.file, ...file };
                            msg.payload = true;
                            finishAction(`Created ${file.base}`);
                        });
                        break;

                    case 'delete':
                        fs.rm(targetPath, { recursive: true, force: true }, (err) => {
                            if (err) return handleError(err);

                            msg.file = { ...msg.file, ...file };
                            msg.payload = true;
                            finishAction(`Deleted ${file.base}`);
                        });
                        break;

                    case 'list':
                        fs.readdir(targetPath, (err, files) => {
                            if (err) return handleError(err);

                            file.contents = files;
                            msg.file = { ...msg.file, ...file };
                            msg.payload = files;
                            finishAction(`Listed ${files.length} items`);
                        });
                        break;

                    default:
                        throw new Error(`Unknown action: ${currentAction}`);
                }

                function finishAction(statusText) {
                    node.status({ fill: 'green', shape: 'dot', text: statusText });
                    send(msg);
                    if (done) done();
                    setTimeout(() => node.status({}), 5000);
                }

                function handleError(err) {
                    node.status({ fill: 'red', shape: 'dot', text: err.code || 'Error' });
                    if (done) done(err);
                    else node.error(err, msg);
                }
            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: 'Configuration error' });
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('directory-action', DirectoryActionNode);
};
