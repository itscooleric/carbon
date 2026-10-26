/**
 * Carbon type definitions. This module has no runtime code; it exists so view and
 * controller modules can reference shared shapes with `@typedef {import("./types.js").X}`.
 */

/** @typedef {import("../core/stack.js").Stack} Stack */
/** @typedef {import("../core/stack.js").History} History */
/** @typedef {import("./local-files.js").LocalFolder} LocalFolder */
/** @typedef {Stack|LocalFolder} Documents */

/**
 * A Stack serialized for IndexedDB (plain arrays, structured-clonable).
 * @typedef {Object} PackedStack
 * @property {[string, Uint8Array][]} files
 * @property {string[]} directories
 * @property {"folder"} [kind] ordinary-copy cache discriminator; never exported
 * @property {{id: string, revision: number, title: string}} [metadata] ordinary-copy cache identity
 */

/**
 * Prior snapshot retained by `History`.
 * @typedef {Object} HistoryItem
 * @property {Documents} stack
 * @property {string} label
 * @property {string} time ISO timestamp
 */

/**
 * Legacy v0.2 Needlecast dispatch retained locally as the trusted baseline for a Return.
 * Produced by `dispatch()` / `registerDispatch()` in `core/handoff.js`.
 * @typedef {Object} LegacyDispatch
 * @property {string} text exact `.handoff.md` packet text
 * @property {Stack} base exact Stack the packet was built from
 * @property {string[]} included Entry paths whose bodies may change
 * @property {string[]} omitted paths preserved locally
 * @property {string} dispatchId
 */

/** @typedef {"pending"|"requested"|"confirmed"|"imported"|"folder"} CopyState */

/**
 * The single mutable workspace object. Every module receives it through `deps`;
 * nothing else holds shared mutable state.
 * @typedef {Object} WorkspaceState
 * @property {Documents} stack active Stack or ordinary local copy (immutable; replaced on every revision)
 * @property {History} history bounded prior snapshots
 * @property {ReturnType<typeof import("./workspace.js").workspaceState>|null} documents local Editor/Viewer tabs and arrangement
 * @property {string|null} current open Entry path
 * @property {Map<string,string>} drafts unsaved editor text per path
 * @property {Set<string>} selected sidebar checks (seed for Dispatch context + legacy Needlecast scope)
 * @property {LegacyDispatch|null} trusted legacy v0.2 dispatch
 * @property {boolean} unexported true while the current revision has no confirmed user-owned copy
 * @property {CopyState} copyState
 * @property {DispatchRecord[]} dispatches newest last; the dispatch controller owns mutations
 * @property {number} lastArchiveRevision -1 when none
 * @property {LinkState|null} link linked source folder; null for Stacks and imported copies
 */

/**
 * Consent to modify the files of a linked folder.
 * @typedef {Object} LinkConsent
 * @property {boolean} granted the user confirmed that Save modifies the original files
 * @property {boolean} remember persisted per folder (IndexedDB `folders`); never implies browser permission
 * @property {boolean} history keep local file history on disk (.carbon-history/) before overwriting
 */

/**
 * A folder opened with the native picker: the source Carbon's copy was imported from and the target
 * Sync file to folder… writes to. Persisted: `handle`, `consent`, `lastSync`, `baseline`, `observed`.
 * Session-only: `status`, `op`, `lastError`, `historyOk`. See source.js for the source records.
 * @typedef {Object} LinkState
 * @property {FileSystemDirectoryHandle} handle
 * @property {LinkConsent} consent
 * @property {"linked"|"permission"|"unavailable"} status browser access to the folder
 * @property {{kind: "saving"|"conflict"|"syncFailed", path: string}|null} op outcome of the latest sync attempt for a path
 * @property {{path: string, at: string}|null} lastSync
 * @property {string|null} lastError
 * @property {boolean|null} historyOk result of the latest backup attempt (null: none yet)
 * @property {Map<string, {shadow?: Uint8Array}>} baseline the bytes each path last held on disk (shadow when Carbon's copy diverged or deleted it)
 * @property {import("./source.js").Observed|null} observed the last read-only Refresh of the folder
 */

/**
 * The serialized workspace (`serialize()`); stored as one `carbon-vfs` mount record with
 * `id`, `kind`, `title`, `updatedAt` and `rev` added (see vfs.js). Records may lack
 * `dispatches` and `lastArchiveRevision`; `restore()` tolerates that.
 * @typedef {Object} CacheRecord
 * @property {PackedStack} stack
 * @property {{stack: PackedStack, label: string, time: string}[]} history
 * @property {object|null} [documents] local tab and layout state
 * @property {string|null} current
 * @property {[string, string][]} drafts
 * @property {boolean} unexported
 * @property {CopyState} copyState
 * @property {(Omit<LegacyDispatch, "base"> & {base: PackedStack})|null} trusted
 * @property {DispatchRecord[]} [dispatches]
 * @property {number} [lastArchiveRevision]
 * @property {{handle: FileSystemDirectoryHandle, consent: LinkConsent, lastSync: {path: string, at: string}|null, baseline: [string, Uint8Array|null][], observed: object|null}|null} [link] linked source folder
 */

/**
 * A button rendered after a status notice.
 * @typedef {Object} NoticeAction
 * @property {string} label
 * @property {() => void} onClick
 */

/** @typedef {"info"|"ok"|"pending"|"error"} NoticeKind */

/**
 * @typedef {Object} Notice
 * @property {string} message
 * @property {NoticeKind} kind
 * @property {NoticeAction[]} actions at most two are rendered
 */

/**
 * Dependencies handed to every view module by the composition root (`app.js`).
 * Views call these instead of importing each other.
 * @typedef {Object} Deps
 * @property {WorkspaceState} state
 * @property {ReturnType<typeof import("./editor/view.js").createEditor>} editor
 * @property {ReturnType<typeof import("./ui/workspace.js").mountWorkspace>} workspace
 * @property {ReturnType<typeof import("./ui/images.js").mountImages>} images
 * @property {Record<string, string>} templates Entry templates by kind
 * @property {() => Promise<void>} persist queue a cache write of the live state; never rejects
 * @property {(candidate: Partial<WorkspaceState>) => Promise<void>} commit atomic: cache write first, then assign
 * @property {() => boolean} cacheAvailable true while durable browser storage (carbon-vfs) is usable
 * @property {(next: Documents, fields?: Partial<WorkspaceState>) => Promise<void>} openWorkspace open `next` as its own workspace, parking the open one
 * @property {(id: string) => Promise<void>} switchWorkspace activate a stored workspace (Scratch is created when never stored)
 * @property {(id: string, listedRev?: number|null) => Promise<void>} removeWorkspace delete a parked workspace from browser storage, if it is still at the listed revision
 * @property {() => (import("./vfs.js").Vfs|import("./vfs.js").MemoryVfs|null)} workspaceStore the workspace store, or null after a storage failure
 * @property {() => void} disableCache disable recovery after a failed write and show the export warning
 * @property {(fn: () => (void|Promise<void>)) => Promise<void>} run serialize a UI action (busy guard, aria-busy)
 * @property {(id: string, fn: () => (void|Promise<void>)) => void} action bind a click on `#id` to `run(fn)`
 * @property {typeof import("./ui/dialogs.js").modal} modal
 * @property {typeof import("./ui/dialogs.js").ask} ask
 * @property {typeof import("./ui/dialogs.js").confirm} confirm
 * @property {typeof import("./ui/status.js").notify} notify
 * @property {() => void} render full re-render (status, tree, editor, preview)
 * @property {() => void} renderStatus
 * @property {() => void} renderTree
 * @property {() => void} preview
 * @property {(path: string) => Promise<void>} openFile
 * @property {(next: Documents, label: string) => Promise<void>} replace commit a new revision, retaining the previous one in History
 * @property {() => void} requireStack throws in ordinary-folder mode for protocol-only actions
 * @property {() => void} requireSaved throws while any Entry draft is unsaved
 * @property {typeof import("./fs.js").download} download
 * @property {(text: string) => Promise<void>} reviewReturn legacy v0.2 Return review
 * @property {(path: string, options?: {skipHistory?: boolean, recreate?: boolean}) => Promise<object>} syncFile write one committed file to the linked folder (consent, permission, baseline check, backup, verification); the only disk-write path
 * @property {(path: string, options?: {expected?: Uint8Array}) => Promise<void>} takeDiskVersion replace Carbon's bytes for a path with the folder's current bytes (History first; the caller confirmed; `expected` binds an uncaptured version to the previewed bytes)
 * @property {(path: string) => Promise<Uint8Array>} readFolderVersion read the folder's current version of a path for a confirmation preview (read only)
 * @property {() => Promise<object>} refreshFolder read the linked folder and record what it holds (`link.observed`); changes nothing in Carbon's copy
 * @property {() => Promise<void>} checkRevision refuse when another tab stored a newer revision of this workspace (before Sync writes the folder)
 * @property {() => Promise<void>} openSourceChanges the "Folder changes…" dialog (ui/source.js)
 * @property {(path: string) => Promise<void>} openSourceFile the per-file source dialog (ui/source.js)
 * @property {((handle: FileSystemDirectoryHandle, options?: {create?: boolean}) => Promise<object>)|null} diskHistory opens the on-disk history (history/disk.js); `create: false` never writes; null until wired
 * @property {ReturnType<typeof import("./linked.js").createFolderMemory>} folderMemory remembered per-folder consent
 */

// ---- Dispatch typedefs (package D) ------------------------------------------------

/** @typedef {"draft"|"exported"|"staged"|"accepted"|"checkpoint"|"rejected"|"abandoned"} DispatchStatus */
/** @typedef {"question"|"plan"|"report"|"custom"} DispatchPreset */
/** @typedef {"text"|"files"|"tar"} DispatchTarget */
/** @typedef {"copy"|"download-md"|"download-files"|"download-tar"} ExportVia */

/**
 * Generated by `scripts/build.mjs` into `src/carbon/castkit-assets.json` and injected into
 * the dispatch controller as `deps.assets`.
 * @typedef {Object} CastkitAssets
 * @property {Record<string, string>} playbooks display name -> complete Playbook Markdown (frontmatter included)
 * @property {Record<string, string>} sources display name -> Cast `source` label (`builtin:<basename>`)
 * @property {string} contract `cast-kit/operating-contract-v0.1.md`
 * @property {string} bootstrap `cast-kit/bootstrap.md`
 */

/**
 * One ordered instruction document embedded in a Cast (`Cast.playbooks[]`).
 * @typedef {Object} Playbook
 * @property {string} name unique within the Cast; display label
 * @property {string} source provenance label (`builtin:<basename>`, `stack:<path>`, `import:<file>`); never fetched
 * @property {string} content complete Markdown including frontmatter, at most 16000 characters
 */

/**
 * Exact mutation allowlists copied into the Cast. Paths are Markdown Entry paths.
 * @typedef {Object} DispatchPermissions
 * @property {string[]} create new Entry paths the Return may supply
 * @property {string[]} replace existing Entry paths the Return may replace (must be in `context`)
 * @property {{path: string, keys: string[]}[]} metadata existing scalar frontmatter keys that may change, per replaced path
 * @property {string[]} delete existing Entry paths the Return may delete (must be in `context`)
 * @property {[string, string][]} rename `[from, to]` pairs (`from` must be in `context`)
 */

/**
 * The editable assignment while a record is a draft; frozen once exported.
 * @typedef {Object} DispatchDraft
 * @property {DispatchPreset} preset
 * @property {string} objective
 * @property {string|null} mission Entry path or null; must be in `context`
 * @property {string[]} criteria completion criteria (non-empty lines); the controller supplies a default when empty
 * @property {string[]} context Entry paths (`.md`) whose text is included
 * @property {string[]} assets Asset paths (non-`.md`) attached by files/tar exports only
 * @property {"selected"|"complete"} scope "complete" includes every Entry (and every Asset for files/tar targets)
 * @property {Playbook[]} playbooks ordered, at most 8
 * @property {DispatchPermissions} permissions
 * @property {DispatchTarget} target destination capability
 * @property {boolean} consent user confirmed data handling before export
 * @property {number} step wizard step 0..4 (UI convenience, persisted)
 */

/**
 * What an export produced. `base` holds the packed base Stack while the record awaits a
 * Return (exported, staged, rejected) and is null once the record is terminal.
 * @typedef {Object} Exported
 * @property {string} castSource Cast YAML exactly as exported
 * @property {string} handoff exact `envoy.handoff/v0.2` packet text (Cast `read` equals its `included_files`)
 * @property {string} dispatchId handoff `dispatch_id` (also the Cast `dispatch_id`)
 * @property {string} returnTemplate the empty Return skeleton sent with the Dispatch
 * @property {ExportVia} via
 * @property {string} at ISO timestamp
 * @property {PackedStack|null} base
 */

/**
 * A Return imported for review but not yet accepted.
 * @typedef {Object} Staged
 * @property {string} source raw Return text (untrusted model output)
 * @property {string} at ISO timestamp
 * @property {string} checkpointId Return `checkpoint_id`
 */

/**
 * Durable outcome of a Return.
 * @typedef {Object} Receipt
 * @property {"accepted"|"checkpoint"|"rejected"} kind
 * @property {string} source raw Return text
 * @property {{assignment_id: string, checkpoint_id: string, stack_id: string, base_revision: number, accepted_revision: number}} [acceptance] host-generated metadata (accepted only)
 * @property {string} at ISO timestamp
 */

/**
 * One Dispatch and everything it produced. Keyed by `assignmentId`; the dispatch and
 * return controllers own every mutation, views only render.
 * @typedef {Object} DispatchRecord
 * @property {string} assignmentId Cast `assignment_id` (`cast-<uuid>`)
 * @property {number} seq 1-based per workspace, display only ("Dispatch 3")
 * @property {DispatchStatus} status
 * @property {string} stackId
 * @property {number} baseRevision Stack revision the Cast was/will be built against
 * @property {string} createdAt ISO timestamp
 * @property {string} updatedAt ISO timestamp
 * @property {DispatchDraft} draft
 * @property {Exported|null} exported
 * @property {Staged|null} staged
 * @property {Receipt[]} receipts
 * @property {number|null} acceptedRevision
 */

/**
 * A blocker that prevents export, tagged with the wizard step that resolves it.
 * @typedef {Object} DispatchIssue
 * @property {number} step 0 Assignment, 1 Context, 2 Playbooks, 3 Deliverables, 4 Review & export
 * @property {string} text user-facing sentence
 * @property {string} [fix] hint for a UI action: "save" (save the draft Entry), "remove", "include"
 */

/**
 * Side-effect-free composition result for the Review step.
 * @typedef {Object} DispatchPreview
 * @property {string} castSource Cast YAML
 * @property {string[]} included handoff `included_files`
 * @property {string[]} omitted handoff `omitted_files`
 * @property {{castBytes: number, textBytes: number, assetBytes: number}} sizes UTF-8 sizes of the Cast, the composed dispatch text, and selected Asset bytes
 */

/**
 * One metadata (frontmatter scalar) difference inside a replaced Entry.
 * @typedef {Object} MetadataChange
 * @property {string} key
 * @property {unknown} before
 * @property {unknown} after
 * @property {boolean} permitted the Cast's `metadata` entry for the path lists `key`
 */

/**
 * One proposed file operation for the review diff.
 * @typedef {Object} ReviewChange
 * @property {"create"|"replace"|"delete"|"rename"} op
 * @property {string} path source path (rename: the `from` path)
 * @property {string} [to] rename target
 * @property {string|null} before current text (null for create)
 * @property {string|null} after proposed text (null for delete)
 * @property {MetadataChange[]} [metadata] replace only
 * @property {boolean} permitted within the Cast allowlists (and permitted metadata keys)
 */

/**
 * One review check. Texts are the contract; views only render them.
 * @typedef {Object} Check
 * @property {"framing"|"cast"|"base"|"permissions"|"ids"|"omitted"|"drafts"} id
 * @property {boolean} ok
 * @property {string} text
 */

/**
 * Everything the review mode renders for a staged Return.
 * @typedef {Object} ReviewModel
 * @property {DispatchRecord} dispatch
 * @property {"complete"|"partial"|"blocked"|"failed"|"cancelled"} selfStatus from `meta.status` (label "(self-reported)")
 * @property {string} checkpointId
 * @property {string} summary
 * @property {string[]} evidence
 * @property {string[]} unresolved questions followed by next actions
 * @property {string[]} blockers
 * @property {string[]} errors
 * @property {string[]} completed
 * @property {string[]} opsPerformed
 * @property {string[]} accepted
 * @property {string[]} decisions
 * @property {string[]} verification
 * @property {ReviewChange[]} changes
 * @property {Check[]} checks in order: framing, cast, base, permissions, ids, omitted, drafts
 * @property {boolean} canAccept every check ok and at least one file operation
 * @property {boolean} canSaveReceipt every check ok and no file operations (a checkpoint may be stored)
 * @property {string} reason footer sentence
 * @property {boolean} zeroOps no file operations: offer "Save receipt" instead of Accept
 * @property {boolean} stale the Stack moved past the Cast base: offer Re-dispatch
 * @property {string[]} dirtyPaths affected Entries with unsaved drafts
 * @property {string[]} warnings Cast Kit review warnings (text)
 * @property {string} [warning] set when the staged Return could not be persisted
 */

export {};
