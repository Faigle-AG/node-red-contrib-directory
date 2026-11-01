# @faigle/node-red-contrib-directory

Node-RED nodes for working with filesystem directories.

This package provides three storage nodes for common directory operations:

- **directory-action** — create, delete, or list directories
- **directory-transfer** — move, rename, or copy directories
- **directory-watch** — watch directories for file and directory changes

This package was generated from [node-red-contrib-template](https://github.com/Faigle-AG/node-red-contrib-_template_).

## Nodes

### directory-action

Creates, deletes, or lists directories. The recursive option controls parent creation and descendant removal.

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

For `list`, the configured output property receives a metadata object with a `contents` array of child names. For example, **Output To: msg.payload** puts those names at `msg.payload.contents`; the editor default **msg.file.content** puts them at `msg.file.content.contents`.

For `create` and `delete`, the configured output property is set to `true` on success and metadata is merged into `msg.file`. See the storage protocol below for output defaults and error behavior.

---

### directory-transfer

Moves, renames, or copies directories.

Supported actions:

- `move` (also used to rename)
- `copy`

Dynamic copy example:

```js
msg.file = {
    action: 'copy',
    source: '/tmp/source-folder',
    destination: '/tmp/archive/source-folder',
    recursive: true,
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

> Use `directory-action` to delete directories; directory-transfer has no delete action.

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
    source: '/tmp/watch',
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

## Storage Message Protocol (msg.file)

Directory requests use **`msg.file`**, not `msg.dir`. The `dir` field inside returned metadata is the parent-directory string. Local file nodes and Azure Files directory nodes use the same action vocabulary, but existing list shapes, output defaults and backend behavior differ as documented below.

### Requests and typed fields

Enable **Load from msg.file** on directory-action or directory-transfer to supply the operation fields dynamically. Configured output routing remains active. directory-watch has no input port and therefore has no dynamic request mode.

| Node               | Action                     | Required dynamic fields           | Optional fields               |
| ------------------ | -------------------------- | --------------------------------- | ----------------------------- |
| directory-action   | `create`, `delete`, `list` | `action`, `path`                  | `recursive` for create/delete |
| directory-transfer | `copy`, `move`             | `action`, `source`, `destination` | `recursive`                   |

Use exact lowercase names. `delete` belongs to **directory-action**, not directory-transfer. Send boolean `recursive` explicitly for dynamic requests; omitted dynamic flags do not inherit the editor checkbox. For create, recursive enables parent creation; for delete, descendant removal; for copy, tree copying. For move it also controls creating destination parents, and is used by cross-device copy/delete fallback. Listing remains one level regardless of this flag.

```js
// directory-action, Load from msg.file enabled
msg.file = { action: 'create', path: '/data/archive/2026', recursive: true };
return msg;
```

```js
// directory-action, Load from msg.file enabled; Output To: msg.payload
msg.file = { action: 'list', path: '/data/archive' };
return msg;
// The result object is msg.payload; item names are msg.payload.contents.
```

```js
// directory-transfer, Load from msg.file enabled
msg.file = {
    action: 'copy',
    source: '/data/in',
    destination: '/data/archive/in',
    recursive: true,
};
return msg;
```

Input-driven paths support `msg`, `flow`, `global`, `str`, `jsonata`, and `env`. Configured outputs support `msg`, `flow`, and `global`. Watch sources omit `msg` because they are evaluated at startup without an input message. Ignored-file patterns are regular expressions matched against the basename. An invalid pattern reports a SyntaxError once through `node.error` with failed status. The node is created, but no watcher starts; correct the pattern and redeploy.

#### Typed-input reference

These are the types offered by each field. Defaults below are for newly configured editor nodes; they are not migration rules for older saved flows.

| Node                 | Field                           | Offered types                                    | Editor default         |
| -------------------- | ------------------------------- | ------------------------------------------------ | ---------------------- |
| `directory-action`   | `source`                        | `msg`, `flow`, `global`, `str`, `jsonata`, `env` | `str`, empty           |
| `directory-action`   | `property` (Output To)          | `msg`, `flow`, `global`                          | `msg`, `file.content`  |
| `directory-transfer` | `source`                        | `msg`, `flow`, `global`, `str`, `jsonata`, `env` | `str`, empty           |
| `directory-transfer` | `destination`                   | `msg`, `flow`, `global`, `str`, `jsonata`, `env` | `str`, empty           |
| `directory-watch`    | `source` (Folder)               | `flow`, `global`, `str`, `jsonata`, `env`        | `str`, empty           |
| `directory-watch`    | `target` (Output To)            | `msg`, `flow`, `global`                          | `msg`, `file`          |
| `directory-watch`    | `ignoredFiles` (Ignore pattern) | `re`                                             | `re`, empty (disabled) |

Input selectors read values; output selectors name writable destinations. For `flow` and `global`, a named context store uses Node-RED's encoded key syntax, for example `#:(storeName)::result`. Configure the named store in Node-RED; its availability and persistence remain the context backend's responsibility.

**Watch startup:** Folder is evaluated once, without an incoming message. JSONata and callback-based context reads are supported. The watcher starts only after source evaluation succeeds and the node is still open. A failed evaluation or non-string result reports a startup error without creating a watcher. Failures thrown while starting the watcher use the same error route. A blank string retains the legacy meaning `.`—the Node-RED process's working directory—so configure an explicit folder to avoid watching an unintended location.

**Saved-flow compatibility:** Existing field names, type defaults and value fallbacks are retained. In particular, directory-action still falls back to `msg.payload` when its saved `property` is missing or empty, rather than adopting the editor's `msg.file.content` default.

An active field with an unoffered type now fails before its values are evaluated or filesystem work starts. This can reject hand-edited or imported flows that previously used an unoffered type. Static paths bypassed by **Load from msg.file** remain ignored; configured output routing remains active for create, delete and list. A blank ignore pattern is unused, so its type is not checked. Unsupported value-type tags report `INVALID_CONFIGURATION`; unsupported output-type tags retain the uncoded `Unsupported target property type: ...` error.

This early check validates the **type tag**, not every path or context operation. A supported output type can still fail when its property is written, after a directory mutation has already completed; it does not add rollback or atomicity.

### Outputs and compatibility

Common metadata contains `filetype`, normalized `path`, `dir`, `base`, `name`, and `ext`.

- **Create/delete:** merges directory metadata into `msg.file` and writes boolean `true` into the configured output property on success. Selecting an overlapping output property can overwrite metadata; choose the property deliberately.
- **List:** writes a whole metadata object with `contents: string[]` to the configured output property. Entries are immediate child names, not Azure-style metadata objects; do not rely on listing order. There is no separate assignment of directory metadata to `msg.file` unless the selected output path writes there.
- **Output defaults:** newly configured editor nodes default to `msg.file.content`. The local runtime falls back to `msg.payload` when `property` is missing or empty in an imported/programmatically constructed configuration. Explicit saved output settings are preserved.
- **Copy/move:** merges `action`, `source`, `destination` and destination path metadata into `msg.file`. Same normalized source/destination forwards the original message unchanged without checking whether the source exists.
- **Watch:** creates a new message and writes the event object to the configured target, normally `msg.file`. `source` is the watched root, `path` is the changed entry, `action` is `add`, `change`, or `delete`, and `filetype` is `file` or `directory`. Deletion events have `stats: null`; other events may contain native stats. The field is `source`, not `watchdir`.

With **Output To: msg.payload**, a list result has this shape:

```js
msg.payload = {
    filetype: 'directory',
    path: '/data/archive',
    dir: '/data',
    base: 'archive',
    name: 'archive',
    ext: '',
    contents: ['report.txt', '2026'],
};
```

For compatibility, directory-transfer's same-path no-op precedes action validation. directory-action deletion also removes a plain file if the path points to one; it is not a directory-only safety boundary.

Shallow metadata merges preserve custom fields and may retain earlier results. Do not infer that every retained field was recomputed. Watch events are best-effort notifications, not a durable event log; they do not promise every intermediate write or the same timing as Azure polling.

### Errors and operational boundaries

Input errors use Node-RED's error/Catch mechanism and do not produce normal success output. Watch errors have no triggering input message. Native filesystem errors retain their codes; missing paths/actions and unsupported actions have explicit validation codes, while other evaluation errors may remain uncoded. Newly coded validation errors keep their previous status text. Existing status text is a separate Status-node output contract.

| Condition                                                          | Current result                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing/invalid path, missing action or unsupported action         | `DIRECTORY_PATH_MISSING`, `SOURCE_PATH_MISSING`, `DESTINATION_PATH_MISSING`, `ACTION_MISSING` or `INVALID_ACTION`, as applicable; unknown transfer actions error before parent creation, except the legacy same-path no-op |
| List of a missing directory                                        | Native error, normally `ENOENT`                                                                                                                                                                                            |
| Create nested path without required parents and recursive disabled | Native filesystem error                                                                                                                                                                                                    |
| Delete missing path                                                | Normally succeeds because removal uses `force: true`                                                                                                                                                                       |
| Delete an empty directory with recursive disabled                  | Success; the directory is removed                                                                                                                                                                                          |
| Delete a nonempty directory with recursive disabled                | Native not-empty error, normally `ENOTEMPTY`; descendants are not removed                                                                                                                                                  |
| Unsupported active input-value type                                | `INVALID_CONFIGURATION`; no filesystem operation starts                                                                                                                                                                    |
| Unsupported active output type                                     | Uncoded `Unsupported target property type: ...` error before filesystem work; an invalid watch target prevents watcher startup                                                                                             |
| Watch-source evaluation fails or returns a non-string              | One startup error; no watcher starts; non-string normalization retains `ERR_INVALID_ARG_TYPE`                                                                                                                              |
| Invalid watcher ignore pattern                                     | One SyntaxError reported at startup; no watcher starts                                                                                                                                                                     |
| Copy directory without recursive enabled                           | Native filesystem error                                                                                                                                                                                                    |
| Permission failure                                                 | Native error such as `EACCES` or `EPERM`                                                                                                                                                                                   |
| Configured output/context write fails                              | Error; create/delete may already have completed                                                                                                                                                                            |

Paths use host filesystem rules, including absolute/relative paths and dot segments. They are **not sandboxed**; recursive deletion is destructive within the runtime account's permissions. Validate untrusted inputs, restrict permissions and account for links when designing access restrictions. Path normalization alone does not enforce a containment boundary.

Directory copies/deletes and cross-device moves can partially complete. Move can fall back to recursive copy followed by source deletion. Failures do not roll back the destination or restore deleted entries. Avoid concurrent mutations of the same tree and inspect partial results before retrying.

### Shutdown

If directory-action or directory-transfer closes while resolving configured paths, it starts no filesystem operation after those reads settle. In-flight input continuations then finish quietly, without a new output message, status update or error report. Directory-action also suppresses late output-write results and errors. Pending property/context operations are not cancelled; an already-started output write may still change its target.

Directory mutations use synchronous filesystem calls. A sequence already running cannot be interrupted by a later close event, and its effects are not rolled back. This includes directory-transfer's copy/delete fallback for a cross-device move; it is distinct from the asynchronous local file-transfer fallback.

If directory-watch closes while its startup source evaluation is pending, the eventual success or failure starts no watcher and produces no late status, error or event. This does not cancel the context read itself, and close need not wait for that read when no watcher exists yet.

Directory-watch waits for Chokidar's close promise to settle; if it rejects, the node warns and completes close. Event output writes already in progress are not cancelled, but their late results or errors produce no further event output or status. Late file/error callbacks are ignored defensively; Chokidar's normal close path already removes its listeners. This does not promise durable delivery of events pending at shutdown.

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
