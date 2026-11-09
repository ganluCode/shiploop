/** Git names use persistent display aliases, never mutable plan order or UUIDs. */
export function createFeatureBranchName(featureCode: string, title: string): string {
  const code = /^(P\d{2,})-(F\d{2,})$/.exec(featureCode);
  if (!code) throw new TypeError('feature_display_code_required');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 64).replace(/-$/, '') || 'feature';
  return `feat/${code[1]!.toLowerCase()}/${code[2]!.toLowerCase()}-${slug}`;
}

export function createTaskCommitMessage(taskCode: string, title: string): string {
  const code = /^P\d{2,}-F\d{2,}-(T\d{3,})$/.exec(taskCode);
  const subject = title.replace(/[\p{C}\s]+/gu, ' ').trim().slice(0, 200).trim();
  if (!code) throw new TypeError('task_display_code_required');
  if (!subject) throw new TypeError('task_commit_title_required');
  return `${code[1]}: ${subject}`;
}
