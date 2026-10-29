/** Safe Work tool operations shared by settings/resource schemas without loading authorization. */
export const WORK_ACCESS_OPERATIONS = ['task.read', 'candidate.submit', 'evidence.submit', 'planning.candidate.submit'] as const;
