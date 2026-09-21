# Resumable workspace export

`attio export` writes full API record payloads and related data into a private local directory. It makes read requests only, including the record-query API's read-only POST operation. It does not use the 10,000-record cap in the interactive `records list --all` helper.

```bash
# Use object API slugs. The standard deals object may be named Opportunities.
attio export people companies deals locations --dir .attio-workspace/full

# Continue an interrupted run or retry resources after fixing access.
# Keep the same object, --include, and --max-choices selection.
attio export people companies deals locations --dir .attio-workspace/full --resume

# A smaller export, with all current attribute values still in the records.
attio export people companies --include records,attributes --dir .attio-workspace/records
```

New exports require an empty directory. To refresh a completed snapshot, choose a new directory; `--resume` continues the original run and reuses its successful pages. Earlier export formats are preserved and are not silently migrated. This repository ignores `/.attio-workspace/`; add an equivalent ignore rule if using another location or repository.

## Files and scope

| Output | Contents |
| --- | --- |
| `<object-api-slug>.json` | Every record with its original `id`, `created_at`, `web_url`, `values`, and any other returned fields. `deals.json` contains Opportunities in workspaces using that display name. |
| `attributes/<slug>.json` | Active object attribute definitions, including configuration, defaults, and relationship metadata. |
| `attributes/<slug>-choices.json` | Up to 100 active select-option/status payloads per attribute by default, with available/exported counts and a truncation flag. |
| `notes.json` | Full plaintext/Markdown note payloads whose parent or record tag matches a selected record. |
| `emails.json` | Available email metadata linked to selected People/Companies. Not created if access is denied. |
| `files.json` | File, connected-file, folder, and connected-folder metadata at every nesting level for every selected record. |
| `files/<file-id>.bin` | Downloaded bytes. Original names, types, provider IDs, and record links remain in `files.json`. |
| `downloads.json` | Mapping from file IDs to local paths, SHA-256 hashes, sizes, and individual download failures. |
| `manifest.json` | Object/workspace identity, resource status, exported file hashes/counts, scan evidence, limitations, and errors. |
| `.checkpoints/` | Hashed, atomic request checkpoints used to resume. Keep these with the manifest. |

`--include` accepts a comma-separated subset of `records,attributes,notes,emails,files`; the default includes all five. Related resources require record membership, so choosing notes, emails, or files also exports records. Directories use mode `0700`; files use `0600`. Progress goes to stderr, while stdout contains a JSON summary. An incomplete export exits nonzero even if other resources succeeded.

## Completeness and resume behavior

- Record pagination continues until an actual empty page, even after short pages. Two complete opposite-order scans must have identical unique IDs before the record JSON is published. Membership changes trigger up to two additional scans. Duplicate IDs fail the resource instead of silently discarding data.
- Successful pages are saved atomically before advancing their offset or cursor. Resume verifies checkpoint hashes and published outputs and rejects a different workspace, object selection, resource selection, or attribute policy.
- Cursor-based files and emails continue until `next_cursor` is explicitly `null`, including when an intermediate page is empty. Missing or repeated cursors fail the resource.
- One writer owns the export directory. A later process can recover a lock left by a dead process on the same host. An active or foreign-host lock is preserved.
- Successful file downloads are hashed and verified on resume. An interrupted individual download is retried from the beginning; HTTP byte-range resume is not implemented. API credentials are sent only to Attio, never forwarded to signed download hosts. Signed URLs are not saved.
- `--concurrency` controls file requests and downloads (default 8, range 1–32). API request starts are spaced at least 30 ms apart; notes have additional pacing for their lower rate limit. The API client honors `Retry-After`.

A successful export proves traversal of the accessible API pages within the configured scope, including any explicit choice cap, not a transactionally consistent database snapshot. Attio can change during the run. Resume retains successful pages from the original time interval; it does not refresh them. Incomplete resources remain explicit in the manifest, and independent resources can still finish.

## API boundaries

- **Attributes:** current values, active definitions, and up to 100 active options/statuses per attribute are included by default. `--max-choices` changes the cap. Attio exposes no server-side limit/pagination for options and statuses, so the cap is applied after receiving the API response; checkpoints and output keep only the capped active choices. Counts and `truncated` flags identify capped lists. Historical changes and list-entry values are separate resources. The standalone `attributes` commands support both object and list definitions via `--target`.
- **Notes:** Attio returns plaintext and Markdown. Embedded note images are not included in the Markdown API representation. Note scanning uses the workspace endpoint because Attio requires both a parent object and a parent record ID when filtering. Checkpoints retain only selected notes plus the source page count.
- **Emails:** the alpha endpoint requires workspace/app access and `email:read`. It never returns bodies or attachments. Direct record filters support only People/Companies, in groups of up to ten IDs; visibility and protected-recipient rules still apply. Locations and Opportunities have no direct email filter. Successful metadata access does not mean a full mailbox backup.
- **Files:** all metadata types are retained. Download is attempted for internal and connected files; unavailable provider content remains an explicit failed download. A folder entry does not itself have file bytes. File export does not retrieve email attachments or note images through unrelated providers.
- **Other resources:** tasks, threads/comments, list entries, meetings, and recordings are not part of this command's export selection.

Sources: [record queries](https://docs.attio.com/rest-api/endpoint-reference/records/list-records), [notes](https://docs.attio.com/rest-api/endpoint-reference/notes/list-notes), [emails](https://docs.attio.com/rest-api/endpoint-reference/emails/list-emails), [files](https://docs.attio.com/rest-api/endpoint-reference/files/list-files), [file downloads](https://docs.attio.com/rest-api/endpoint-reference/files/download-a-file), and [rate limits](https://docs.attio.com/rest-api/guides/rate-limiting).
