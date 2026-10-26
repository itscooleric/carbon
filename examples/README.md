# Public example

`supplier-lead-times.stack/` is a complete sanitized Stack with two managed Entries and a 256-byte synthetic binary Asset (`assets/example-marker.bin`, values 0–255). No private records are included.

- `supplier-lead-times.stack.tar` and `.stack.tar.gz` are complete deterministic archives.
- `supplier-lead-times.handoff.md` includes the manifest and two Entries and explicitly omits the binary Asset.
- Carbon can import either complete archive. To use the supplied handoff as a Return base, select **Register original handoff** after importing the matching Stack.

`npm run examples` regenerates the archives from the directory and creates a fresh handoff dispatch ID/boundary. Archive bytes are deterministic for unchanged files; handoff IDs deliberately change on each export.
