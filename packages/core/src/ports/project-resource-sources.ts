export interface ProjectResourceSourceInput {
  readonly projectId: string;
  readonly sourceId: string;
  readonly action: 'register' | 'remove';
  readonly expectedRevision: number;
  readonly manifestPath?: string;
}

export interface ProjectResourceSourceResult {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly sourceId: string;
  readonly revision: number;
  readonly registered: boolean;
}

export interface ProjectResourceSourceDirectory {
  configure(input: ProjectResourceSourceInput): ProjectResourceSourceResult;
}
