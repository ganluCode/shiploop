import type { KnowledgeReadResult, KnowledgeSearchResultSet } from 'shiploop-core/protocol';

function oneLine(value: string): string {
  return value.replaceAll(/[\r\n]+/g, ' ');
}

function sourceSummary(sourceRefs: readonly { readonly artifactId: string; readonly version: number }[]): string {
  return sourceRefs.length === 0
    ? 'none'
    : sourceRefs.map((source) => `${source.artifactId}@${source.version}`).join(',');
}

export function formatKnowledgeSearchText(result: KnowledgeSearchResultSet): string {
  const lines = [
    `shiploop knowledge search: project=${result.projectId} results=${result.results.length} truncated=${String(result.truncated)}`,
    `  query=${JSON.stringify(result.query)}`,
    `  budget=${JSON.stringify(result.budget)}`,
  ];
  for (const match of result.results) {
    lines.push(
      `  - ${match.documentId}@${match.version} title=${oneLine(match.title)} ` +
      `hash=${match.contentHash} source=${sourceSummary(match.sourceRefs)} ` +
      `position=${match.position.start}-${match.position.end} ` +
      `line=${match.position.line}:${match.position.column}`,
      `    snippet=${oneLine(match.snippet)} reason=${oneLine(match.selectionReason)}`,
    );
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(`  diagnostic=${diagnostic.code} bytesRead=${diagnostic.bytesRead} reason=${oneLine(diagnostic.reason)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatKnowledgeReadText(result: KnowledgeReadResult): string {
  return [
    `shiploop knowledge read: project=${result.projectId} document=${result.documentId}@${result.version}`,
    `  title=${oneLine(result.title)} type=${oneLine(result.documentType)} hash=${result.contentHash}`,
    `  source=${sourceSummary(result.sourceRefs)} sizeBytes=${result.sizeBytes} budget=${JSON.stringify(result.budget)}`,
    '  content:',
    result.contentText,
  ].join('\n') + '\n';
}
