# Targeted CLI investigation recipe

Use this recipe for a specific CLI question. Preserve authorization rules, API slugs,
and the repository's CodeDB refresh gate. This is a retrieval recipe, not permission
to write CRM data or change agent configuration.

1. Call `codedb_context` once with the task and likely symbol names. Use a bounded
   output budget (for example, `max_tokens: 1800`, `semantic: "local"`). Avoid generic
   symbols such as `register` when the function name is known.
2. Follow the returned file and line locator. Use `codedb_explain` for a symbol and
   its callers, or `codedb <root> read <path> -L <start>-<end>` for the needed range.
   Expand only when an unresolved question requires it. CodeDB navigates; native
   tools edit. On a missing/stale index, index the repository, use direct reads
   meanwhile, and return to CodeDB once ready.
3. Discover API operations through attio-code-mode `search`, projecting method,
   path, and relevant parameter names. For authorized reads, project only fields
   needed to answer the question, and include the result count and any pagination
   limit. A bounded result is not proof that all records were examined.
4. Save complete test output locally; return exit status, pass/fail totals, and
   failure locations. Preserve the full log path so the evidence remains available.
   Do not rerun a passing test merely to print its output differently.

## Example: record search syntax and object names

Task: determine the argument order for `records search` and whether renamed object
labels should replace API slugs.

```javascript
// codedb_context arguments
({ task: "searchRecords query --object", semantic: "local", max_tokens: 1800 })
```

Follow the current locator to the command registration and `searchRecords`.
The public syntax is `attio records search <query> --object <api-slug>`;
`--object` is repeatable. Names are presentation metadata; API slugs remain in
commands, paths, filters, and record references.

```javascript
// attio-code-mode execute; read-only object metadata, no record dumps
const response = await api.request({ method: 'GET', path: '/v2/objects' });
return {
  total: response.data.length,
  rows: response.data.map(({ api_slug, singular_noun, plural_noun }) =>
    ({ api_slug, singular_noun, plural_noun }))
};
```

```bash
# From the repository root. Keep the exit code even if a summary command succeeds.
evidence_dir=$(mktemp -d "${TMPDIR:-/tmp}/attio-investigation.XXXXXX")
status=0
node --import tsx --test tests/agent-snippet.test.ts tests/object-names.test.ts \
  >"$evidence_dir/tests.log" 2>&1 || status=$?
printf 'test_exit=%s full_log=%s\n' "$status" "$evidence_dir/tests.log"
tail -n 12 "$evidence_dir/tests.log"
# Read the full log on failure or when the summary omits needed evidence.
exit "$status"
```

For measurement, keep the question and model fixed. Count actual returned text
with one named local tokenizer, including orientation and follow-up reads. Compare
against the same information from complete files/results. Report these local
output counts separately from provider input usage and cache behavior. Never add
overlapping categories or turn one replay into future savings.
