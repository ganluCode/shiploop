/**
 * Frozen v32 JSON guards. Keep these literals independent of evolving port limits:
 * migration checksums must remain stable when a later recording format is added.
 * All generated SQL is embedded in the migration descriptor; no database UDFs.
 */
function invalidText(value: string, max: number): string {
  return `(typeof(${value}) <> 'text' OR length(trim(${value})) = 0 OR length(${value}) > ${max}
    OR instr(${value}, char(0)) > 0 OR ${value} GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*'))`;
}

function invalidId(value: string): string {
  return `(length(${value}) NOT BETWEEN 1 AND 128 OR substr(${value}, 1, 1) NOT GLOB '[A-Za-z0-9]'
    OR ${value} GLOB '*[^A-Za-z0-9._-]*')`;
}

function invalidArray(value: string, count: number, length: number): string {
  return `(json_type(${value}) IS NOT 'array' OR json_array_length(${value}) > ${count}
    OR EXISTS (SELECT 1 FROM json_each(${value}) item WHERE item.type IS NOT 'text' OR ${invalidText('item.value', length)}))`;
}

function unknownKeys(value: string, keys: readonly string[]): string {
  return `EXISTS (SELECT 1 FROM json_each(${value}) field WHERE field.key NOT IN (${keys.map((key) => `'${key}'`).join(',')}))`;
}

function invalidFlags(value: string): string {
  return `(json_type(${value}) IS NOT 'object' OR ${unknownKeys(value, ['applied', 'reasons'])}
    OR json_type(${value}, '$.applied') NOT IN ('true','false') OR json_type(${value}, '$.applied') IS NULL
    OR ${invalidArray(`json_extract(${value}, '$.reasons')`, 32, 256)}
    OR json_extract(${value}, '$.applied') <> (json_array_length(${value}, '$.reasons') > 0))`;
}

const attachment = 'r.value';
const invalidAttachments = `EXISTS (SELECT 1 FROM json_each(NEW.attachment_refs) r WHERE
  r.type IS NOT 'object'
  OR ${unknownKeys(attachment, ['artifactId', 'contentHash', 'sizeBytes', 'locator', 'name', 'mediaType', 'truncated', 'redacted'])}
  OR json_type(${attachment}, '$.artifactId') IS NOT 'text'
  OR json_type(${attachment}, '$.contentHash') IS NOT 'text'
  OR json_type(${attachment}, '$.locator') IS NOT 'text'
  OR json_type(${attachment}, '$.sizeBytes') IS NOT 'integer'
  OR json_extract(${attachment}, '$.sizeBytes') NOT BETWEEN 0 AND 9007199254740991
  OR json_type(${attachment}, '$.name') IS NULL OR json_type(${attachment}, '$.name') NOT IN ('text','null')
  OR (json_type(${attachment}, '$.name') = 'text' AND ${invalidText(`json_extract(${attachment}, '$.name')`, 200)})
  OR json_type(${attachment}, '$.mediaType') IS NOT 'text' OR ${invalidText(`json_extract(${attachment}, '$.mediaType')`, 128)}
  OR json_type(${attachment}, '$.truncated') IS NULL OR json_type(${attachment}, '$.truncated') NOT IN ('true','false')
  OR json_type(${attachment}, '$.redacted') IS NULL OR json_type(${attachment}, '$.redacted') NOT IN ('true','false'))`;

const invalidScope = `${unknownKeys('NEW.scope', ['covers', 'excludes'])}
  OR ${invalidArray("json_extract(NEW.scope, '$.covers')", 32, 128)}
  OR json_array_length(NEW.scope, '$.covers') = 0
  OR EXISTS (SELECT 1 FROM json_each(NEW.scope, '$.covers') c
    WHERE c.value NOT IN ('public_events','public_messages','public_tools','attachments','final_result','minimal_diagnostics')
      OR c.value IN (SELECT value FROM json_each(NEW.scope, '$.excludes')))
  OR ${invalidArray("json_extract(NEW.scope, '$.excludes')", 32, 128)}
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.scope, '$.excludes') WHERE value = 'hidden_reasoning')
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.scope, '$.excludes') WHERE value = 'native_private_storage')
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.scope, '$.excludes') WHERE value = 'unified_audit')`;

const invalidNativeRef = `(NEW.native_ref IS NOT NULL AND (
  NOT json_valid(NEW.native_ref) OR json_type(NEW.native_ref) IS NOT 'object'
  OR ${unknownKeys('NEW.native_ref', ['schemaVersion', 'storageKind', 'formatVersion'])}
  OR json_type(NEW.native_ref, '$.schemaVersion') IS NOT 'integer'
  OR json_extract(NEW.native_ref, '$.schemaVersion') IS NOT 1
  OR json_type(NEW.native_ref, '$.storageKind') IS NOT 'text'
  OR json_type(NEW.native_ref, '$.formatVersion') IS NOT 'text'
  OR ${invalidText("json_extract(NEW.native_ref, '$.storageKind')", 128)}
  OR ${invalidText("json_extract(NEW.native_ref, '$.formatVersion')", 64)}
  OR EXISTS (SELECT 1 FROM json_each(NEW.native_ref) n WHERE n.key IN ('storageKind','formatVersion')
    AND (instr(n.value, '/') > 0 OR instr(n.value, char(92)) > 0 OR instr(n.value, '..') > 0))))`;

export const WORK_RECORDING_V32_JSON_GUARDS_SQL = `
CREATE TRIGGER session_messages_json_guard BEFORE INSERT ON session_messages
WHEN ${invalidId('NEW.id')} OR ${invalidText('NEW.event_id', 256)} OR ${invalidText('NEW.message_key', 256)}
  OR ${invalidText('NEW.content_locator', 1024)}
  OR (NEW.provider_message_id IS NOT NULL AND ${invalidText('NEW.provider_message_id', 256)})
  OR (NEW.tool_call_id IS NOT NULL AND ${invalidText('NEW.tool_call_id', 256)})
  OR (NEW.parent_tool_call_id IS NOT NULL AND ${invalidText('NEW.parent_tool_call_id', 256)})
  OR ${invalidArray('NEW.source_refs', 16, 256)} OR ${invalidAttachments}
BEGIN SELECT RAISE(ABORT, 'invalid bounded session message metadata'); END;
CREATE TRIGGER recording_manifests_json_guard BEFORE INSERT ON recording_manifests
WHEN ${invalidId('NEW.id')} OR ${invalidText('NEW.format_version', 128)}
  OR (NEW.sdk_version IS NOT NULL AND ${invalidText('NEW.sdk_version', 128)}) OR ${invalidScope}
  OR ${invalidArray('NEW.missing_reasons', 32, 256)} OR ${invalidArray('NEW.diagnostics', 32, 256)}
  OR ${invalidFlags('NEW.truncation')} OR ${invalidFlags('NEW.redaction')} OR ${invalidNativeRef}
BEGIN SELECT RAISE(ABORT, 'invalid bounded recording manifest metadata'); END;
-- JSON attachment refs have no native FK; retain them and freeze all indexed Artifact identities.
CREATE TRIGGER recording_attachment_delete_guard BEFORE DELETE ON artifacts
WHEN EXISTS (SELECT 1 FROM session_messages m, json_each(m.attachment_refs) a
  WHERE json_extract(a.value, '$.artifactId') = OLD.id)
BEGIN SELECT RAISE(ABORT, 'recording attachment artifact is referenced'); END;
CREATE TRIGGER recording_artifact_identity_guard
BEFORE UPDATE OF id, project_id, status, content_hash, size_bytes, storage_locator ON artifacts
WHEN OLD.status = 'ready'
AND (NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.status IS NOT OLD.status
  OR NEW.content_hash IS NOT OLD.content_hash OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.storage_locator IS NOT OLD.storage_locator)
AND (EXISTS (SELECT 1 FROM session_messages WHERE content_ref = OLD.id)
  OR EXISTS (SELECT 1 FROM recording_manifests WHERE manifest_ref = OLD.id)
  OR EXISTS (SELECT 1 FROM session_messages m, json_each(m.attachment_refs) a WHERE json_extract(a.value, '$.artifactId') = OLD.id))
BEGIN SELECT RAISE(ABORT, 'indexed recording artifact identity is immutable'); END;
`;
