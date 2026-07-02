# @faigle/node-red-contrib-directory

Node-RED nodes for working with filesystem directories.

This package provides three storage nodes for common directory operations:

- **directory-action** — create, delete, or list directories
- **directory-transfer** — move, rename, copy, or delete directories
- **directory-watch** — watch directories for file and directory changes

This package was generated from [node-red-contrib-template](https://github.com/Faigle-AG/node-red-contrib-_template_).

## Nodes

### directory-action

Creates a directory, deletes a directory recursively, or lists directory contents.

Supported actions:

- `create`
- `delete`
- `list`

Dynamic input example:

```js
msg.file = {
    action: 'list',
    path: '/tmp/example',
};
return msg;
```

For `list`, the directory contents are returned as:

```js
msg.payload;
msg.file.contents;
```

For `create` and `delete`, `msg.payload` is set to `true` on success.

Output metadata is written to `msg.file`:

```js
msg.file = {
    filetype: 'directory',
    path: '/tmp/example',
    dir: '/tmp',
    base: 'example',
    name: 'example',
    ext: '',
    contents: ['file.txt', 'subfolder'],
};
```

> `directory-action` delete uses recursive removal.

---

### directory-transfer

Moves, renames, copies, or deletes directories.

Supported actions:

- `move/rename`
- `copy`

Dynamic copy example:

```js
msg.file = {
    action: 'copy',
    source: '/tmp/source-folder',
    destination: '/tmp/archive/source-folder',
};
return msg;
```

Dynamic move / rename example:

```js
msg.file = {
    action: 'move',
    source: '/tmp/source-folder',
    destination: '/tmp/renamed-folder',
};
return msg;
```

Output metadata is written to `msg.file`:

```js
msg.file = {
    filetype: 'directory',
    action: 'copy',
    source: '/tmp/source-folder',
    destination: '/tmp/archive/source-folder',
    path: '/tmp/archive/source-folder',
    dir: '/tmp/archive',
    base: 'source-folder',
    name: 'source-folder',
    ext: '',
};
```

> `directory-transfer` delete removes empty directories only.

---

### directory-watch

Watches a directory and emits messages when files or directories are added, changed, or deleted.

Supported event types:

- `add`
- `change`
- `delete`

Supported item filters:

- files
- directories

The node has no input and one output.

Example output:

```js
msg.file = {
    action: 'add',
    filetype: 'file',
    watchdir: '/tmp/watch',
    path: '/tmp/watch/example.txt',
    dir: '/tmp/watch',
    base: 'example.txt',
    name: 'example',
    ext: '.txt',
    stats: {},
};
```

## Watch Options

### Folder

Directory path to watch.

### Events

Select which events emit messages:

- Add
- Change
- Delete

### Types

Select which filesystem item types emit messages:

- Files
- Directories

### Ignore pattern

Optional regular expression for file names to ignore.

Only the base file name is checked, not the full path.

### Depth

Maximum subdirectory depth to watch.

Use `0` to watch only the configured root directory.

### Await write finish

Waits until a file size stabilizes before emitting an event.

This is useful when files are copied or written slowly.

### Threshold

Stability threshold in milliseconds for `awaitWriteFinish`.

Default:

```text
2000
```

### On start ignore files in folder

When enabled, existing files are ignored when the watcher starts.

## Dynamic Mode

`directory-action` and `directory-transfer` support **Load from `msg.file`** mode.

When enabled, the node ignores the configured editor fields and reads operation details from `msg.file`.

`directory-watch` does not use dynamic input because it is an event source node with no input.

## Output Fields

Directory nodes write normalized metadata to `msg.file`.

Common fields:

- `filetype`
- `path`
- `dir`
- `base`
- `name`
- `ext`

Additional fields depend on the node and action:

- `directory-action`: `contents`
- `directory-transfer`: `action`, `source`, `destination`
- `directory-watch`: `action`, `watchdir`, `stats`

## Status Indicators

The nodes display runtime status in the Node-RED editor:

- green dot — operation or event completed
- grey ring — watcher is listening
- red dot — error or invalid configuration

## Notes

- Paths are normalized using Node.js path handling.
- Directory copy uses recursive copy.
- Directory move falls back to copy-and-delete when moving across devices.
- Directory watch uses `chokidar`.
