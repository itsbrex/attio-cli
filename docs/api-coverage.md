# Attio CLI API coverage audit

Audited 2026-09-21 UTC against the current [Attio OpenAPI document](https://api.attio.com/openapi/api). The CLI routes **53 of 94 documented method/path pairs**; **41 have no CLI route**. This measures endpoint reachability, not complete parameter support or live validation of every operation.

## Evidence and scope

- Upstream fetched: `2026-09-21T06:48:21.620263+00:00`.
- Upstream SHA-256: `623c79a2e7bf52fe4fc289228153e069d06ac340da73fe16a99da9408b4be380`.
- Checked-in `openapi.json` SHA-256: `27a1d7f96023f7295f4bfe6f373a1210a2a2b285b78bc808e512c659f091a916`.
- The checked-in specification has 67 operations. Upstream adds 28 method/path pairs absent from that file. One local entry, `GET /scim/v2/Schemas`, is absent from the current core API document; this does not prove the separate SCIM endpoint was removed from the service.
- The original audit inspected all command registrations and 52 API client call sites. This update adds eight reachable operations through attribute/member/comment reads and the export command (including its streamed file-download method). Dynamic attribute paths support both object and list targets. Shortcut commands and export reuse of existing routes are counted once.
- The earlier workspace-name, timeout, and compact-guide review passed 49 tests. With the export and new read commands, `npm test` passes 68 tests; TypeScript and build pass. Tests exercise interruption/resume (including a killed process), legacy-export preservation, 10,001 records, checksums, workspace/scope guards, cursor pagination, blocked resources, binary download redirects, and read-command output. Existing write behavior is tested only with mocks.
- The resumable export and new read commands add read coverage without changing authentication or performing CRM writes. The checked-in `openapi.json` remains unchanged; the current upstream document is the implementation reference.

## Coverage by API group

| Group | Routed | Upstream | Missing |
| --- | ---: | ---: | ---: |
| Objects | 2 | 6 | 4 |
| Activities | 0 | 5 | 5 |
| Activity records | 0 | 6 | 6 |
| Attributes | 4 | 10 | 6 |
| Records | 9 | 12 | 3 |
| SQL | 0 | 1 | 1 |
| Lists | 2 | 5 | 3 |
| Entries | 6 | 9 | 3 |
| Workspace members | 2 | 2 | 0 |
| Notes | 4 | 5 | 1 |
| Tasks | 5 | 5 | 0 |
| Threads | 2 | 2 | 0 |
| Comments | 3 | 3 | 0 |
| Emails | 1 | 1 | 0 |
| Sequences | 0 | 1 | 1 |
| Meetings | 2 | 4 | 2 |
| Call recordings | 2 | 4 | 2 |
| Transcripts | 1 | 1 | 0 |
| Files | 2 | 6 | 4 |
| Webhooks | 5 | 5 | 0 |
| Meta | 1 | 1 | 0 |
| **Total** | **53** | **94** | **41** |

## Relevant gaps and limitations

- **Full exports:** [`attio export`](export.md) has no record-count cap, supports durable resume, exports related resources, and reports incomplete resources with a nonzero exit. The shared [`paginate` helper](../src/pagination.ts) still stops interactive `--all` commands after 10,000 records with a warning. Table/CSV output is presentation-oriented.
- **Attribute reads:** listing, detail, select options, and statuses support both `objects` and `lists`. Listing supports pagination and archived definitions. Attribute/option/status writes remain missing.
- **Update semantics:** record and list-entry updates expose PATCH, which appends multiselect values. Their PUT overwrite operations are missing. Record merge and record/list-entry attribute-value writes are also missing.
- **Read coverage:** list-entry attribute-value reads, saved views, individual file detail, activities/activity records, and SQL remain missing. Email metadata and file listing/downloads are reachable through export, subject to access and documented API limits. Existing recording transcript retrieval uses an operation marked deprecated upstream.
- **Options:** record/list-entry queries do not expose `filter_view_id`. Presence of a route therefore does not imply full request-schema parity.
- **Remaining writes:** no object/list configuration writes, note update, meeting create/delete, recording create/delete, or sequence unsubscribe command.

## Complete operation inventory

`Routed` means an existing CLI action reaches that method/path. The source column identifies one call site; some operations have multiple callers. Export-only routes are identified in the source column; they do not imply a standalone resource command.

| Method | Upstream path | Status | Source |
| --- | --- | --- | --- |
| `GET` | `/v2/objects` | Routed | [src/commands/objects.ts:26](../src/commands/objects.ts#L26) |
| `POST` | `/v2/objects` | Missing | — |
| `GET` | `/v2/objects/{object}` | Routed | [src/commands/objects.ts:45](../src/commands/objects.ts#L45) |
| `PATCH` | `/v2/objects/{object}` | Missing | — |
| `DELETE` | `/v2/objects/{object}` | Missing | — |
| `GET` | `/v2/objects/{object}/views` | Missing | — |
| `GET` | `/v2/activities` | Missing | — |
| `POST` | `/v2/activities` | Missing | — |
| `GET` | `/v2/activities/{activity}` | Missing | — |
| `PATCH` | `/v2/activities/{activity}` | Missing | — |
| `DELETE` | `/v2/activities/{activity}` | Missing | — |
| `POST` | `/v2/activities/{activity}/records/query` | Missing | — |
| `POST` | `/v2/activities/{activity}/records` | Missing | — |
| `GET` | `/v2/activities/{activity}/records/{record_id}` | Missing | — |
| `PATCH` | `/v2/activities/{activity}/records/{record_id}` | Missing | — |
| `PUT` | `/v2/activities/{activity}/records/{record_id}` | Missing | — |
| `DELETE` | `/v2/activities/{activity}/records/{record_id}` | Missing | — |
| `GET` | `/v2/{target}/{identifier}/attributes` | Routed | [src/commands/attributes.ts](../src/commands/attributes.ts) |
| `POST` | `/v2/{target}/{identifier}/attributes` | Missing | — |
| `GET` | `/v2/{target}/{identifier}/attributes/{attribute}` | Routed | [src/commands/attributes.ts](../src/commands/attributes.ts) |
| `PATCH` | `/v2/{target}/{identifier}/attributes/{attribute}` | Missing | — |
| `GET` | `/v2/{target}/{identifier}/attributes/{attribute}/options` | Routed | [src/commands/attributes.ts](../src/commands/attributes.ts) |
| `POST` | `/v2/{target}/{identifier}/attributes/{attribute}/options` | Missing | — |
| `PATCH` | `/v2/{target}/{identifier}/attributes/{attribute}/options/{option}` | Missing | — |
| `GET` | `/v2/{target}/{identifier}/attributes/{attribute}/statuses` | Routed | [src/commands/attributes.ts](../src/commands/attributes.ts) |
| `POST` | `/v2/{target}/{identifier}/attributes/{attribute}/statuses` | Missing | — |
| `PATCH` | `/v2/{target}/{identifier}/attributes/{attribute}/statuses/{status}` | Missing | — |
| `POST` | `/v2/objects/{object}/records/query` | Routed | [src/commands/records.ts:69](../src/commands/records.ts#L69) |
| `POST` | `/v2/objects/{object}/records` | Routed | [src/commands/records.ts:124](../src/commands/records.ts#L124) |
| `PUT` | `/v2/objects/{object}/records` | Routed | [src/commands/records.ts:201](../src/commands/records.ts#L201) |
| `GET` | `/v2/objects/{object}/records/{record_id}` | Routed | [src/commands/open.ts:19](../src/commands/open.ts#L19) |
| `PATCH` | `/v2/objects/{object}/records/{record_id}` | Routed | [src/commands/records.ts:150](../src/commands/records.ts#L150) |
| `PUT` | `/v2/objects/{object}/records/{record_id}` | Missing | — |
| `DELETE` | `/v2/objects/{object}/records/{record_id}` | Routed | [src/commands/records.ts:183](../src/commands/records.ts#L183) |
| `POST` | `/v2/objects/{object}/records/merge` | Missing | — |
| `GET` | `/v2/objects/{object}/records/{record_id}/attributes/{attribute}/values` | Routed | [src/commands/records.ts:308](../src/commands/records.ts#L308) |
| `PUT` | `/v2/objects/{object}/records/{record_id}/attributes/{attribute}/values` | Missing | — |
| `GET` | `/v2/objects/{object}/records/{record_id}/entries` | Routed | [src/commands/records.ts:356](../src/commands/records.ts#L356) |
| `POST` | `/v2/objects/records/search` | Routed | [src/commands/records.ts:242](../src/commands/records.ts#L242) |
| `POST` | `/v2/sql` | Missing | — |
| `GET` | `/v2/lists` | Routed | [src/commands/lists.ts:19](../src/commands/lists.ts#L19) |
| `POST` | `/v2/lists` | Missing | — |
| `GET` | `/v2/lists/{list}` | Routed | [src/commands/lists.ts:57](../src/commands/lists.ts#L57) |
| `PATCH` | `/v2/lists/{list}` | Missing | — |
| `GET` | `/v2/lists/{list}/views` | Missing | — |
| `POST` | `/v2/lists/{list}/entries/query` | Routed | [src/commands/entries.ts:57](../src/commands/entries.ts#L57) |
| `POST` | `/v2/lists/{list}/entries` | Routed | [src/commands/entries.ts:114](../src/commands/entries.ts#L114) |
| `PUT` | `/v2/lists/{list}/entries` | Routed | [src/commands/entries.ts:148](../src/commands/entries.ts#L148) |
| `GET` | `/v2/lists/{list}/entries/{entry_id}` | Routed | [src/commands/entries.ts:80](../src/commands/entries.ts#L80) |
| `PATCH` | `/v2/lists/{list}/entries/{entry_id}` | Routed | [src/commands/entries.ts:178](../src/commands/entries.ts#L178) |
| `PUT` | `/v2/lists/{list}/entries/{entry_id}` | Missing | — |
| `DELETE` | `/v2/lists/{list}/entries/{entry_id}` | Routed | [src/commands/entries.ts:206](../src/commands/entries.ts#L206) |
| `GET` | `/v2/lists/{list}/entries/{entry_id}/attributes/{attribute}/values` | Missing | — |
| `PUT` | `/v2/lists/{list}/entries/{entry_id}/attributes/{attribute}/values` | Missing | — |
| `GET` | `/v2/workspace_members` | Routed | [src/commands/members.ts](../src/commands/members.ts) |
| `GET` | `/v2/workspace_members/{workspace_member_id}` | Routed | [src/commands/members.ts](../src/commands/members.ts) |
| `GET` | `/v2/notes` | Routed | [src/commands/notes.ts:30](../src/commands/notes.ts#L30) |
| `POST` | `/v2/notes` | Routed | [src/commands/notes.ts:97](../src/commands/notes.ts#L97) |
| `GET` | `/v2/notes/{note_id}` | Routed | [src/commands/notes.ts:70](../src/commands/notes.ts#L70) |
| `PATCH` | `/v2/notes/{note_id}` | Missing | — |
| `DELETE` | `/v2/notes/{note_id}` | Routed | [src/commands/notes.ts:119](../src/commands/notes.ts#L119) |
| `GET` | `/v2/tasks` | Routed | [src/commands/tasks.ts:35](../src/commands/tasks.ts#L35) |
| `POST` | `/v2/tasks` | Routed | [src/commands/tasks.ts:119](../src/commands/tasks.ts#L119) |
| `GET` | `/v2/tasks/{task_id}` | Routed | [src/commands/tasks.ts:73](../src/commands/tasks.ts#L73) |
| `PATCH` | `/v2/tasks/{task_id}` | Routed | [src/commands/tasks.ts:143](../src/commands/tasks.ts#L143) |
| `DELETE` | `/v2/tasks/{task_id}` | Routed | [src/commands/tasks.ts:167](../src/commands/tasks.ts#L167) |
| `GET` | `/v2/threads` | Routed | [src/commands/comments.ts](../src/commands/comments.ts) |
| `GET` | `/v2/threads/{thread_id}` | Routed | [src/commands/threads.ts:84](../src/commands/threads.ts#L84) |
| `POST` | `/v2/comments` | Routed | [src/commands/comments.ts](../src/commands/comments.ts) |
| `GET` | `/v2/comments/{comment_id}` | Routed | [src/commands/comments.ts](../src/commands/comments.ts) |
| `DELETE` | `/v2/comments/{comment_id}` | Routed | [src/commands/comments.ts](../src/commands/comments.ts) |
| `GET` | `/v2/emails` | Routed | [src/export.ts](../src/export.ts) |
| `POST` | `/v2/sequences/unsubscribed_emails` | Missing | — |
| `GET` | `/v2/meetings` | Routed | [src/commands/meetings.ts:38](../src/commands/meetings.ts#L38) |
| `POST` | `/v2/meetings` | Missing | — |
| `GET` | `/v2/meetings/{meeting_id}` | Routed | [src/commands/meetings.ts:107](../src/commands/meetings.ts#L107) |
| `DELETE` | `/v2/meetings/{meeting_id}` | Missing | — |
| `GET` | `/v2/meetings/{meeting_id}/call_recordings` | Routed | [src/commands/recordings.ts:28](../src/commands/recordings.ts#L28) |
| `POST` | `/v2/meetings/{meeting_id}/call_recordings` | Missing | — |
| `GET` | `/v2/meetings/{meeting_id}/call_recordings/{call_recording_id}` | Routed | [src/commands/recordings.ts:125](../src/commands/recordings.ts#L125) |
| `DELETE` | `/v2/meetings/{meeting_id}/call_recordings/{call_recording_id}` | Missing | — |
| `GET` | `/v2/meetings/{meeting_id}/call_recordings/{call_recording_id}/transcript` | Routed | [src/commands/recordings.ts:58](../src/commands/recordings.ts#L58) |
| `GET` | `/v2/files` | Routed | [src/export.ts](../src/export.ts) |
| `POST` | `/v2/files` | Missing | — |
| `POST` | `/v2/files/upload` | Missing | — |
| `GET` | `/v2/files/{file_id}` | Missing | — |
| `DELETE` | `/v2/files/{file_id}` | Missing | — |
| `GET` | `/v2/files/{file_id}/download` | Routed | [src/client.ts](../src/client.ts) |
| `GET` | `/v2/webhooks` | Routed | [src/commands/webhooks.ts:113](../src/commands/webhooks.ts#L113) |
| `POST` | `/v2/webhooks` | Routed | [src/commands/webhooks.ts:173](../src/commands/webhooks.ts#L173) |
| `GET` | `/v2/webhooks/{webhook_id}` | Routed | [src/commands/webhooks.ts:143](../src/commands/webhooks.ts#L143) |
| `PATCH` | `/v2/webhooks/{webhook_id}` | Routed | [src/commands/webhooks.ts:218](../src/commands/webhooks.ts#L218) |
| `DELETE` | `/v2/webhooks/{webhook_id}` | Routed | [src/commands/webhooks.ts:238](../src/commands/webhooks.ts#L238) |
| `GET` | `/v2/self` | Routed | [src/commands/comments.ts](../src/commands/comments.ts) |

## Sensible next implementation batches

1. Add list-entry attribute-value reads, saved views, and individual file detail.
2. Add explicit overwrite update modes and note updates, then expand new resource families.
3. Add a reproducible upstream specification comparison in CI so new operations become visible without claiming automatic implementation coverage.

## Workspace export verification

Private exports live under git-ignored `.attio-workspace/`. The permanent [`attio export` command](export.md) uses the existing API client, explicit pages, and no record-count cap. Each object must reach an empty page in two opposite-order scans with identical unique record IDs before its JSON file is published. The manifest records resource status, counts, object/workspace identity, output hashes, and limitations; hashed request checkpoints support resume.

The command also exports active attribute definitions/options/statuses, related note bodies, accessible email metadata, file/folder metadata, and available file bytes. Email bodies, historical attribute values, list-entry values, and note images are outside this API export scope. Offset pagination provides no transactional snapshot; matching record scans verifies stable observed membership, not simultaneous attribute values. See the [export guide](export.md) for exact coverage and failure semantics.
