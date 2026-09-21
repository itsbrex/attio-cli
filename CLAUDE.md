# Attio CLI

Read SPEC.md for the full specification. It contains everything you need:
architecture, API mappings, implementation code for tricky parts, and edge cases.

Read openapi.json for exact Attio API endpoint paths, request bodies, and response shapes.
Cross-reference SPEC.md with openapi.json when implementing each command.

Key rules:
- Use POST (not GET) for /records/query and /entries/query endpoints
- Always unwrap the {"data": ...} response envelope
- Use the filter parser from SPEC.md exactly as specified
- Use the value flattener from SPEC.md exactly as specified
- Auto-detect TTY for output format (table for terminal, JSON for pipes)
- --quiet mode outputs only IDs, one per line
## Attio CLI (`attio`)

Use the `attio` CLI for Attio CRM operations. Reads are the default; writes require explicit user authorization. Pass `--yes` on deletes only after the user explicitly authorizes the exact target and scope; the flag skips a prompt, not approval.

### Workspace object names

Object display names can change. Always use API slugs in commands, API paths, filters, and record references. Run `attio objects list` to check current names.

| Display name | Singular | API slug |
| --- | --- | --- |
| People | Person | `people` |
| Opportunities | Opportunity | `deals` |
| Warm Intros | Warm Intro | `the_swarm_warm_intros` |
| Leads | Lead | `users` |
| Messages | Message | `messages` |
| Companies | Company | `companies` |
| Locations | Location | `locations` |

### Discovery & setup

Run `attio --help`, `attio <group> --help`, then `attio <group> <command> --help` for syntax and options. Check attributes with `attio attributes list <object>`.

Search: `attio records search <query> --object <api-slug>` (repeat `--object` to add objects; omit to search all).

Output: `--json`, `--csv`, `--table`, or `-q` for IDs. Defaults: table in a terminal, JSON when piped.

Refresh this guide with `attio config claude-md --compact`; omit `--compact` for examples.
