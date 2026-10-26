# Capability and authority checklist

Observe capabilities at each fresh session; provider names do not determine them.

| Check | Record |
|---|---|
| Can the supplied bytes actually be read? | Paths inspected; missing attachments; omitted Assets |
| Text-only response? | Level A; proposed content only |
| Actual downloadable attachment creation? | Level B only after an attachment exists and is checked |
| Filesystem/execution tools? | Level C; actual paths/tool receipts, sandbox boundary |
| Browsing/network? | Available versus authorized; destinations and selected data scope |
| Structured-output API? | Exact model/API/schema subset; refusals and incomplete responses |
| Output/context limits? | Smaller Cast if complete files will not fit; no silent splitting |
| Persistence? | Where the user retained original Stack, Cast and Return; verify downloads manually |

Capabilities can be absent, observed available, or observed failed. Do not test an
external endpoint or perform a write merely to claim capability without permission.
The shipped workbench is offline. The driver supplies no filesystem, execution or
network tools; a future adapter is trusted host code, never code loaded from a Stack.

Permission to propose `entries/report.md` does not authorize writing a real file.
`operations_performed: []` is normal for Level A. For Level B/C, receipts must name
actual tool operations and distinguish their results from the proposed Stack revision.
