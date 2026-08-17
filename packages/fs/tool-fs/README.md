# @deepseek-ai/dsh-tool-fs

English | [中文](README.zh.md)

The **model-facing filesystem tools** — `read`, `read_image`, `write`, `edit` — and their **executor**. This is the consumer layer of the filesystem stack: it owns tool names, JSON schemas, argument validation, prompt sections, **read windowing**, and result formatting. It reads/writes/edits through the `ctx.fs` provider contract ([`@deepseek-ai/dsh-fs`](../fs)) **directly**. The freshness/observation policy is contributed by a separate plugin ([`@deepseek-ai/dsh-fs-observation-policy`](../fs-observation-policy)) through the `fs/*` event gate; the tool is not method-coupled to it. Under a confining provider, the shared sandbox-policy service is required for per-session execution and the tool exposes escalation for filesystem mutations.

```ts ignore-check
// Default deployment: a ctx.fs provider, the policy plugin, then the tools.
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) // @deepseek-ai/dsh-fs-local
await ctx.plugin(FsPolicy)                             // @deepseek-ai/dsh-fs-observation-policy (policy gate)
await ctx.plugin(LocalAttachmentStore, { dshHome })       // optional — enables durable read_image results
await ctx.plugin(ToolFs)                                  // this package — read/write/edit, plus read_image with attachments
```

`@deepseek-ai/dsh-fs-observation-policy` is **optional**: omit it and the tools run against the bare provider (unconditional write/overwrite/edit, no observed-state). A deployment that loads these tools is expected to also load it, so the behavior is read-before-write/edit.

`read_image` registers only while a durable `ctx.attachments` service is mounted — without one the deployment cannot commit image bytes, so the tool never appears. Execution additionally requires the exact routed model to declare `image` input (resolved through `ctx.llm.resolveModelInfo` from the session's latest request header, falling back to agent options); an unknown or text-only route gets a refusal result before any filesystem I/O, so a text route's durable history stays free of image blocks.

## Config

All keys are optional; the defaults are the shipped read caps.

| Key | Default | Meaning |
|---|---|---|
| `readLimit` | `2000` | Default and maximum lines returned by one `read` call (the tool schema advertises it as the `limit` default). |
| `readMaxLineLength` | `2000` | Characters kept per line before truncation (the suffix names the cap). |
| `readMaxBytes` | `51200` | Byte cap on one `read` call's selected lines; overflow ends the window with a "capped" footer. |
| `readStreamMinSize` | `10485760` | Files at or above this size (or with unknown size) stream instead of loading whole into memory. |
| `editMatchMode` | `progressive` | Safe cumulative matching, or `exact` for LF-normalized exact-only edits. |
| `editCandidateLimit` | `3` | Maximum nearby candidates returned after an edit miss. |
| `editCandidateMaxDistance` | `3` | Maximum Unicode-code-point edit distance for candidates. |
| `editCandidatePreviewChars` | `160` | Maximum Unicode code points shown per candidate. |
| `backupBeforeMutation` | `true` | Require provider backup before changing an existing file. |

## Tools (schemas per [the filesystem tool schemas Agent Note](../../../.agents/notes/implemented/feature/2026-06-17-filesystem-tool-schemas.md))

| Tool | Arguments | Behavior |
|---|---|---|
| `read` | `file_path`, `offset?`, `limit?` | Line-numbered UTF-8 content with a pagination footer. `offset` is 1-based; `limit` defaults to and caps at the configured `readLimit` (2000). |
| `read_image` | `file_path` | Reads a PNG/JPEG/WebP/GIF file through the bounded byte seam, persists it through `ctx.attachments.saveImage`, and returns an image block beside a small metadata envelope. It succeeds only when the exact routed model declares image input. |
| `write` | `file_path`, `content`, `content_format?` | Create or fully replace a file. Format defaults to `text`; `escaped` decodes one strict additional escape layer. Existing files are backed up by default. |
| `edit` | `file_path`, non-empty `old_string`, `new_string`, `old_string_format?`, `new_string_format?`, `replace_all?` | Unique safe progressive replacement by default. Formats default to `text`; `escaped` is explicit. Existing files are backed up before publication. |

Field names are snake_case to match Claude Code and existing harness tool schemas.

Canonical successes are `read` → `{ path, offset, lines, totalLines }`, `read_image` → `{ path, image }`, `write` → `{ path, operation, before, after, backup }`, and `edit` → `{ path, before, after, match_strategy, backup }`. `backup` is `null` for creation/disabled backup or `{ path, bytes }` for recovery; provider version tokens stay internal. Native renderers preserve the line-numbered read and mutation acknowledgements below. Only derived presentation metadata is persisted to `tool/result`.

## The tool is the executor; policy is an event gate

The tools do **not** inject a policy service or inspect any cache. Each tool resolves the path via `ctx.fs.resolve(path, { cwd, signal })` — passing the calling agent's session cwd (`exec.agent.session.header.cwd`) so a relative path resolves against the session's workspace, matching `dsh-tool-bash`, and forwarding tool cancellation through resolution (see [the per-session cwd Agent Note](../../../.agents/notes/implemented/architecture/2026-07-02-fs-per-session-cwd.md)) — then:

- **read** — one `ctx.fs.stat` (type + size routing + version), then `readText`/`streamText`, then builds the line window, then emits `fs/observed` with a plain `ctx.emit`. (1 stat.)
- **read_image** — validates the argument, extension, attachment availability, deployment media types, and the image-capable route before any I/O; then one `ctx.fs.stat` (recording an `absent` observation for a missing target, like `read`), a bounded `ctx.fs.readBytes` capped at the smaller of `imageLimits.maxImageBytes` and `imageLimits.maxMessageImageBytes` (the result is one message carrying one image), `attachments.saveImage` (content-addressed, so the image block references a durably committed object by the time `tool/result` is appended), and finally `fs/observed`. (1 stat.)
- **write** — strictly resolves the selected text format, obtains the optional intent, then calls `ctx.fs.writeText(target, content, { intent?, backup, signal, sandboxPolicy? })` and emits `fs/observed`. Invalid escapes fail before resolution or backup. (0 stat.)
- **edit** — strictly resolves both selected text formats, obtains the optional version, then calls `ctx.fs.editText(target, edit, { version?, backup, signal, sandboxPolicy? })` and emits `fs/observed`. Matching and diagnostics stay provider-shared. (0 stat.)

The tool passes `exec` (the tool-execution context) as the opaque `actor` on every dispatch. The default thunks return `undefined` (the unconstrained bare provider). When `@deepseek-ai/dsh-fs-observation-policy` is loaded it occupies the single decision slot — returning `createIfAbsent`/`replaceIfVersion`/`{ version }` or throwing `FS_NOT_OBSERVED` — and records on `fs/observed`. Backend errors (`FsError`) and a thrown `FS_NOT_OBSERVED` flow through `ToolRuntime.execute()` and become `isError` tool results with their `{ name, code }` attached.

When `ctx.fs.sandboxMode` reports confinement, write/edit advertise `sandbox_permissions` and `justification` and resolve approved retries through `ctx.approval`. The policy owner contributes capability-neutral standing policy; the tool results retain operation-specific denial and retry guidance.

## `fs/observed` is fire-and-forget

`fs/observed` fires AFTER the read/read_image/write/edit already succeeded, via a plain `ctx.emit`. A listener is contractually a synchronous, side-effect-only recorder (`@deepseek-ai/dsh-fs-observation-policy`'s is a `WeakMap.set`); the tool does not guard the emit, so a listener that throws would surface as the tool's `isError` result — async or fallible observation does not belong on this event.

`read` opts into concurrent scheduling because its only mutation is the synchronous version recorder. Recorder races fail closed when a later `write` or `edit` re-checks the version under its target lock; both mutation tools remain exclusive. See the [parallel tool-call Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md).

The package root exports only the Cordis plugin contract (`name`, `inject`, `Config`, and `apply`). Read rendering (line windowing + output formatting) lives in `src/read-render.ts` (Cordis-free, independently unit-tested); `src/read.ts`/`read-image.ts`/`write.ts`/`edit.ts` are the tool executors and `src/index.ts` composes them.

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope receives the independently registered read, write, and edit guidance below. Scoped tool restrictions can hide schemas without removing these sections.

##### Read guidance

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.
```

##### Write guidance

```markdown
Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes. content_format defaults to text, which uses the JSON-decoded string unchanged: JSON "\n" is a newline, while "\\n" is a literal backslash plus n. Select escaped only to decode one additional layer of \\, \n, \r, or \t.
```

##### Edit guidance

```markdown
Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must identify exactly one match. Progressive matching may ignore outer search whitespace, per-line trailing whitespace, or full-width ASCII differences, but it never uses approximate candidates for replacement. String formats default to text, which uses JSON-decoded strings unchanged: JSON "\n" is a newline, while "\\n" is a literal backslash plus n. Select escaped only to decode one additional layer. If several matches remain, provide more context or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.
```

#### Token effect

Fixed guidance cost per request while the plugin is active, even when a restriction hides one or more tools.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Tool restrictions do not remove this section, but plugin activation or disposal may invalidate reuse from it.

### Tool schemas

#### What the model sees

The model sees the generated [`read`, `read_image`, `write`, and `edit` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs), with snake_case arguments. `read_image` appears only while a durable attachment store is mounted; the schema itself is route-independent, and the strict gate refuses at execution. Scoped tool restrictions can remove any definition for one agent.

#### Token effect

Fixed schema cost on every request in that tool view.

#### KV Cache effect

Prefix-stable while the visible tool definitions and order are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Read result

#### What the model sees

A successful read is exactly `<path><displayPath></path>`, newline, `<type>file</type>`, newline, `<content>`, numbered lines as `<lineNumber>: <text>`, a blank line, one footer, and `</content>`. The footer is exactly `(Output capped. Showing lines <start>-<end>. Use offset=<next> to continue.)`, `(Showing lines <start>-<end> of <total>. Use offset=<next> to continue.)`, or `(End of file - total <total> lines)`. A long line ends exactly `... (line truncated to <max> chars)`. A missing read still returns `FS_NOT_FOUND`, but it records confirmed absence for the calling session; after an externally deleted file is re-read, a retried `write` can safely recreate it through the provider's no-replace guard.

#### Token effect

Read output is capped by `readLimit`, `readMaxLineLength`, and `readMaxBytes`; the retained call and result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Image read result

#### What the model sees

A successful `read_image` returns `<path><displayPath></path>`, `<type>image</type>`, and a `<content>` envelope naming the media type, dimensions, and byte size, followed by the image itself as a native image block. The session log stores only the durable `sha256:` attachment reference; the routed provider re-reads and digest-verifies the bytes on each request.

#### Token effect

The image is billed on every later request until compaction. Each call is independently bounded by the attachment store's `maxImageBytes`/`maxImagePixels`; repeated successful calls accumulate history, and content addressing deduplicates only the stored bytes, not the per-request token cost.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Write and edit results

#### What the model sees

Write returns its normal envelope and appends `<backup path="<path>" bytes="<n>" />` after an overwrite backup. Edit appends `Backup: <path> (<n> bytes).` when applicable and warns when a non-exact strategy succeeded. The full write or replacement text remains in the assistant tool-call arguments.

#### Token effect

Success text is small, but large mutation arguments and any result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>`. Invalid `escaped` input reports the parameter and rejects unknown sequences or a trailing backslash before any filesystem side effect. `FS_EDIT_NOT_FOUND` and `FS_AMBIGUOUS_EDIT` retain their structured codes and include the path, attempted strategies, and up to the configured candidate count with line number, distance, and bounded preview; no eligible candidate is stated explicitly. Guarded-mutation failures retain their recovery instructions and structured codes.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No model-facing directory listing ships** — `ctx.fs.listDir` serves provider code such as skill discovery, while the sibling [`dsh-tool-fs-search`](../tool-fs-search/) package supplies ripgrep-backed `glob` and `grep` rather than extending the filesystem seam.
- **`read` handles UTF-8 text files only** — images use the separate extension-routed `read_image` tool; PDF, audio, and video remain deferred. A directory target is `FS_NOT_REGULAR_FILE`.
- **The route gate races a concurrent model switch** — `read_image` checks the latest routed model at execution; a switch committed between that check and the next request can leave an image block on a route that rejects image content. The Web host already refuses switching an image-bearing session to a text-only model; other front doors own their equivalent guard.
- **Extension-declared media type** — the extension selects the declared type and the attachment store's magic-byte validation stays authoritative; a correctly formatted image under a wrong extension is refused with the rename remedy rather than sniffed.
- **No inline image preview on the tool-result card** — UI surfaces render the image result generically (the durable reference, not pixels); inline rendering is deferred to the UI packages.
- **No timeout surface** — `read`/`write`/`edit` take no timeout argument and declare no `timeout-policy` budget; cancellation rides `exec.signal` only ([provider rationale](../README.md#no-timeouts-on-file-io)).
