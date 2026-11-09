export const MANAGED_DOCUMENTS_MIGRATION_SQL = `
CREATE TABLE managed_document_sources (
  id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  document_id TEXT,
  PRIMARY KEY(project_id,path),
  FOREIGN KEY(project_id,document_id) REFERENCES documents(project_id,id) ON DELETE RESTRICT
);
CREATE TABLE feature_document_sources (
  id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  path TEXT NOT NULL,
  role TEXT NOT NULL CONSTRAINT feature_document_sources_role_check CHECK(role IN ('prd','design','architecture','product','index')),
  PRIMARY KEY(project_id,feature_id,path),
  FOREIGN KEY(project_id,feature_id) REFERENCES features(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,path) REFERENCES managed_document_sources(project_id,path) ON DELETE RESTRICT
);
`;
