/** F-010: explicit intent only; file effects are executed by the supervised file executor. */
import { assertTrustedPrincipal, authorizeCommand } from '../ports/authorization.js';
import { evaluateCommandTiming, PublicError } from '../ports/commands.js';
import type { ProjectDeleteCommandHandler, ProjectDeleteStore } from '../ports/project-delete.js';
import type { ProjectDeletePreviewService } from './project-delete-preview.js';

export function createProjectDeleteCommandHandler(options: {
  readonly store: ProjectDeleteStore;
  readonly preview: ProjectDeletePreviewService;
  readonly nowUtcMs?: () => number;
}): ProjectDeleteCommandHandler {
  return {
    async submit(principal, envelope, digest) {
      assertTrustedPrincipal(principal);
      authorizeCommand(principal, envelope);
      const replay = options.store.findReceipt(principal, envelope.commandId, digest);
      if (replay !== undefined) return replay;
      if (envelope.operation !== 'project.delete.confirm' || envelope.scope.kind !== 'project') throw new PublicError('unsupported', envelope.operation);
      if (evaluateCommandTiming(envelope, (options.nowUtcMs ?? Date.now)()).kind !== 'fresh') throw new PublicError('command_expired', envelope.operation);
      const payload = envelope.payload;
      const { page, inventory } = await options.preview.captureForConfirmation({
        principal, projectId: envelope.scope.projectId,
        ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }),
      }, payload.expiresAtUtcMs as number);
      if (!page.confirmable || page.previewDigest !== payload.previewDigest) {
        throw new PublicError('conflict', envelope.operation, undefined, { details: { reason: 'preview_content_changed' } });
      }
      // The committing store rechecks principal, timing, activity and all database
      // facts using the captured snapshot token under BEGIN IMMEDIATE.
      return options.store.accept(principal, envelope, digest, inventory);
    },
  };
}
