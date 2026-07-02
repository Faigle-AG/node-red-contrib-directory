module.exports = function (RED) {
    const fs = require('fs');
    const path = require('path');

    function DirectoryActionNode(config) {
        RED.nodes.createNode(this, config);

        this.dynamic = config.dynamic;
        this.action = config.action;
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';
        this.property = config.property || 'payload';
        this.propertyType = config.propertyType || 'msg';
        this.createParent = config.createParent !== false;

        var node = this;

        node.on('input', function (msg, send, done) {
            try {
                const currentAction = node.dynamic ? msg.file && msg.file.action : node.action;
                const sourceRaw = node.dynamic
                    ? msg.file && msg.file.path
                    : RED.util.evaluateNodeProperty(node.source, node.sourceType, node, msg);

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

                const setOutputData = (data) => {
                    if (node.propertyType === 'msg')
                        RED.util.setMessageProperty(msg, node.property, data, true);
                    else if (node.propertyType === 'flow')
                        node.context().flow.set(node.property, data);
                    else if (node.propertyType === 'global')
                        node.context().global.set(node.property, data);
                };

                switch (currentAction) {
                    case 'create':
                        fs.mkdirSync(targetPath, { recursive: node.createParent });
                        msg.file = { ...msg.file, ...file };
                        setOutputData(true);
                        finishAction(`Created ${file.base}`);
                        break;

                    case 'delete':
                        fs.rmSync(targetPath, { recursive: true, force: true });
                        msg.file = { ...msg.file, ...file };
                        setOutputData(true);
                        finishAction(`Deleted ${file.base}`);
                        break;

                    case 'list': {
                        const files = fs.readdirSync(targetPath);
                        file.contents = files;
                        msg.file = { ...msg.file, ...file };
                        setOutputData(files);
                        finishAction(`Listed ${files.length} items`);
                        break;
                    }

                    default:
                        throw new Error(`Unknown action: ${currentAction}`);
                }

                function finishAction(statusText) {
                    node.status({ fill: 'green', shape: 'dot', text: statusText });
                    send(msg);
                    if (done) done();
                    setTimeout(() => node.status({}), 5000);
                }
            } catch (err) {
                node.status({
                    fill: 'red',
                    shape: 'dot',
                    text: err.code || err.message || 'Configuration error',
                });
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('directory-action', DirectoryActionNode);
};
