# @faigle/node-red-contrib-directory

This package provides a suite of Node-RED nodes for managing, transferring, and monitoring file system directories.

This node was generated from [node-red-contrib-template](https://github.com/Faigle-AG/node-red-contrib-_template_).

## 1. directory-action (`dir-action`)

A node to create, delete, or list the contents of directories on the file system.

### Properties

- **Load from msg.file**: If enabled, the node ignores UI properties and expects dynamic input.
- **Action**: The operation to perform (Create, Delete, or List Contents).
- **Target**: The absolute path to the directory.

### Inputs (Dynamic)

If _Load from msg.file_ is enabled:

- `msg.file.action` _(string)_: `create`, `delete`, or `list`.
- `msg.file.path` _(string)_: The destination path.

### Outputs

- `msg.payload` _(array | boolean)_: Array of strings for List; `true` for Create/Delete on success.
- `msg.file` _(object)_: Event details containing `filetype`, `path`, `dir`, `base`, `name`, and `contents` (if listed).

---

## 2. directory-transfer (`dir-transfer`)

A node to move, rename, copy, or delete directories.

### Properties

- **Load from msg.file**: If enabled, the node expects dynamic input.
- **Action**: Move / Rename, Copy, or Delete (Empty Only).
- **Source**: The absolute path to the origin directory.
- **Destination**: The absolute path for the new location (hidden for Delete).

### Inputs (Dynamic)

If _Load from msg.file_ is enabled:

- `msg.file.action` _(string)_: `move`, `copy`, or `delete`.
- `msg.file.source` _(string)_: The original absolute path.
- `msg.file.destination` _(string)_: The destination absolute path.

### Outputs

- `msg.file` _(object)_: Event details containing `filetype`, `action`, `source`, `destination`, `path` (resulting path), `dir`, `base`, and `name`.

---

## 3. directory-watch (`dir-watch`)

A node that watches a directory to detect added, changed, and deleted files or directories using `chokidar`.

### Properties

- **Folder**: Path of the directory to watch.
- **Events**: Trigger events on Add, Change, or Delete.
- **Types**: Filter events for Files, Directories, or both.
- **Ignore pattern**: Regex matching file names to exclude.
- **Depth**: Depth of subdirectories to watch (0 for root only).
- **Await write finish**: Wait until file size stabilizes to prevent triggering on incomplete files.
- **Threshold**: Time (ms) to wait for stability.
- **On start ignore files in folder**: Ignore existing files upon node startup.

### Outputs

- `msg.file` _(object)_: Event details containing `action` (`add`, `change`, `delete`), `filetype`, `watchdir`, `path`, `dir`, `base`, `name`, `ext`, and `stats` (Node.js `fs.Stats` object).
