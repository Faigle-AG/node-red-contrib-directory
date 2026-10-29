'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Topic colours from the shared palette: Directory Operations (Warm Amber).
const EDITORS = [
    { file: 'directory-action.html', type: 'directory-action', color: '#E6B86A' },
    { file: 'directory-transfer.html', type: 'directory-transfer', color: '#E6B86A' },
    { file: 'directory-watch.html', type: 'directory-watch', color: '#E6B86A' },
];

// Evaluates the editor's registration scripts against a minimal RED stub and returns
// the registered definitions by type.
function loadDefinitions(html) {
    const registered = new Map();
    const anything = () =>
        new Proxy(function () {}, { get: () => anything(), apply: () => anything() });
    const RED = {
        nodes: { registerType: (type, definition) => registered.set(type, definition) },
        validators: anything(),
        _: (key) => key,
    };
    const scripts = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)];
    for (const [, source] of scripts) vm.runInNewContext(source, { RED, $: anything() });
    return registered;
}

describe('directory editors', function () {
    for (const editor of EDITORS) {
        describe(editor.file, function () {
            const html = fs.readFileSync(path.join(__dirname, '../src', editor.file), 'utf8');

            it(`registers ${editor.type} with the Directory Operations colour`, function () {
                const definition = loadDefinitions(html).get(editor.type);
                assert.ok(definition, `${editor.type} is registered`);
                assert.equal(definition.color, editor.color);
                assert.equal(definition.category, 'storage');
            });

            it('uses the shared editor.css and .faigle-node-editor wrapper', function () {
                assert.match(
                    html,
                    /href="resources\/@faigle\/node-red-runtime-utils\/editor\.css"/,
                );
                assert.match(html, /class="faigle-node-editor"/);
            });
        });
    }
});
