module.exports = function(RED) {
    const fs   = require("fs");
    const path = require("path");

    function DirectoryTransferNode(config) {
        RED.nodes.createNode(this, config);

        this.dynamic         = config.dynamic;
        this.action          = config.action;
        this.source          = config.source;
        this.sourceType      = config.sourceType || "str";
        this.destination     = config.destination;
        this.destinationType = config.destinationType || "str";

        var node = this;

        node.on("input", function(msg, send, done) {
            try {
                const currentAction = node.dynamic ? (msg.file && msg.file.action) : node.action;
                const srcRaw        = node.dynamic ? (msg.file && msg.file.source) : RED.util.evaluateNodeProperty(node.source, node.sourceType, node, msg);
                const destRaw       = node.dynamic ? (msg.file && msg.file.destination) : RED.util.evaluateNodeProperty(node.destination, node.destinationType, node, msg);

                if (!currentAction)
                    throw new Error("Action is missing");

                if (!srcRaw)
                    throw new Error("Source path is missing");

                const srcPath = path.normalize(srcRaw);
                let dstPath   = null;
                let parsed    = null;

                if (currentAction !== "delete") {
                    if (!destRaw) throw new Error("Destination path is missing");

                    dstPath = path.normalize(destRaw);

                    if (srcPath === dstPath) {
                        node.log("Source and Destination path are the same");
                        finishAction("Ignored", srcPath, dstPath);
                        return;
                    }

                    parsed = path.parse(dstPath);
                } else {
                    parsed = path.parse(srcPath);
                }

                var file = {
                    filetype    : "directory",
                    action      : currentAction,
                    source      : srcPath,
                    destination : dstPath,
                    path        : dstPath || srcPath,
                    dir         : parsed.dir,
                    name        : parsed.name,
                    base        : parsed.base,
                    ext         : parsed.ext
                };

                switch(currentAction) {
                    case "copy":
                        fs.cp(srcPath, dstPath, {recursive: true}, (err) => {
                            if (err) return handleError(err);

                            msg.file = { ...msg.file, ...file };
                            finishAction(`Copied ${path.basename(srcPath)}`, srcPath, dstPath);
                        });
                        break;

                    case "move":
                        fs.rename(srcPath, dstPath, (err) => {
                            if (err && err.code === 'EXDEV') {
                                fs.cp(srcPath, dstPath, {recursive: true}, (copyErr) => {
                                    if (copyErr) return handleError(copyErr);
                                    fs.rm(srcPath, {recursive: true, force: true}, (unlinkErr) => {
                                        if (unlinkErr) return handleError(unlinkErr);

                                        msg.file = { ...msg.file, ...file };
                                        finishAction(`Moved ${path.basename(srcPath)}`, srcPath, dstPath);
                                    });
                                });
                            } else if (err) {
                                return handleError(err);
                            } else {
                                msg.file = { ...msg.file, ...file };
                                finishAction(`Moved ${path.basename(srcPath)}`, srcPath, dstPath);
                            }
                        });
                        break;

                    case "delete":
                        if (destRaw) node.log(`Destination Path ${dstPath} will be ignored`);

                        fs.rmdir(srcPath, (err) => {
                            if (err) return handleError(err);

                            msg.file = { ...msg.file, ...file };
                            msg.payload = true;
                            finishAction(`Deleted ${file.base}`, srcPath, null);
                        });
                        break;

                    default:
                        throw new Error(`Unknown action type: ${currentAction}`);
                }

                function finishAction(statusText, sPath, dPath) {
                    node.status({fill: "green", shape: "dot", text: statusText});
                    send(msg);
                    if (done) done();
                    setTimeout(() => node.status({}), 5000);
                }

                function handleError(err) {
                    node.status({fill: "red", shape: "dot", text: err.code || "Error"});
                    if (done) done(err);
                    else node.error(err, msg);
                }

            } catch (err) {
                node.status({fill: "red", shape: "dot", text: "Configuration error"});
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType("directory-transfer", DirectoryTransferNode);
}