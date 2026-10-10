/** Bounded streaming literal/header redaction. Not a generic secret detector or OS sandbox. */
export function createOutputRedactor(values: readonly string[]) {
  const secrets = [...new Set(values.filter((value) => value.length > 0))];
  if (secrets.length > 256 || secrets.some((s) => s.length > 4_096)
      || secrets.reduce((n, s) => n + Buffer.byteLength(s), 0) > 65_536) {
    throw new TypeError('Output redaction: invalid secret budget');
  }
  const headers = ['authorization:', 'proxy-authorization:', 'cookie:', 'set-cookie:'];
  let pending = '';
  let inHeader = false;
  function resolve(final: boolean, redactPartial = true): string {
    let output = '';
    while (pending) {
      const lower = pending.toLowerCase();
      const header = headers.find((h) => lower.startsWith(h));
      if (header) {
        output += `${header} [REDACTED]`;
        pending = pending.slice(header.length);
        inHeader = true;
        break;
      }
      // Wait for longer overlapping matches; never emit an unresolved secret prefix.
      const partial = secrets.some((s) => s.startsWith(pending)) || headers.some((h) => h.startsWith(lower));
      if (partial && !final) break;
      const match = secrets.filter((s) => pending.startsWith(s)).sort((a, b) => b.length - a.length)[0];
      if (match) { output += '[REDACTED]'; pending = pending.slice(match.length); }
      else if (partial && final && redactPartial) { output += '[REDACTED]'; pending = ''; }
      else { output += pending[0]; pending = pending.slice(1); }
    }
    return output;
  }
  return {
    feed(text: string): string {
      let output = '';
      for (const character of text) {
        if (inHeader) {
          if (character === '\n' || character === '\r') { inHeader = false; output += character; }
          continue;
        }
        pending += character;
        output += resolve(false);
      }
      return output;
    },
    end(redactPartial = true): string { return resolve(true, redactPartial); },
  };
}

export function redactOutputText(text: string, values: readonly string[]): string {
  const redactor = createOutputRedactor(values);
  // Complete metadata fields are not interrupted output: preserve unmatched suffixes.
  return redactor.feed(text) + redactor.end(false);
}
