import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { ArtifactPublishResult, ArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.js';
import { createWorkRecordingPublisher } from '../../../packages/core/src/application/work-recording-publish.js';

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function fakePublisher(seen: string[]): ArtifactPublisher {
  return {
    async publishArtifact(input: unknown): Promise<ArtifactPublishResult> {
      const value = input as { expectedHash: string; projectId: string; kind: string; mediaType: string; locator: string; content: AsyncIterable<Uint8Array> };
      const chunks: Uint8Array[] = [];
      for await (const chunk of value.content) chunks.push(chunk);
      const content = Buffer.concat(chunks);
      seen.push(content.toString('utf8'));
      return {
        artifact: {
          id: `artifact-${seen.length}`,
          projectId: value.projectId,
          kind: value.kind,
          mediaType: value.mediaType,
          status: 'ready',
          expectedHash: value.expectedHash,
          contentHash: digest(content.toString('utf8')),
          sizeBytes: content.byteLength,
          locator: value.locator,
          version: 1,
          failureReason: null,
          revision: 2,
          createdAtUtcMs: 1,
          updatedAtUtcMs: 1,
        },
        finalRelativePath: `artifacts/${seen.length}`,
      };
    },
  };
}

describe('F-002 Work recording publisher', () => {
  test('[case:managed-public-bodies] redacts and publishes message/tool/output bodies and attachments through ArtifactPublisher', async () => {
    const seen: string[] = [];
    const publisher = createWorkRecordingPublisher({
      artifacts: fakePublisher(seen),
      limits: { maxBodyBytes: 64, maxAttachmentBytes: 64, maxTotalBytes: 128, maxChunkBytes: 16, maxQueueBytes: 32 },
      redactionValues: ['secret-token'],
    });

    const result = await publisher.publishMessage({
      projectId: 'project-1',
      message: {
        kind: 'tool_finished',
        role: 'tool',
        locator: 'work/session-1/messages/7/body',
        mediaType: 'text/plain',
        expectedHash: digest('result=[REDACTED]'),
        content: [Buffer.from('result=secret-'), Buffer.from('token')],
      },
      attachments: [{
        name: 'stdout.txt',
        mediaType: 'text/plain',
        locator: 'work/session-1/messages/7/attachments/0',
        expectedHash: digest('stdout'),
        content: [Buffer.from('stdout')],
      }],
    });

    expect(result.body.status).toBe('complete');
    expect(result.body.ref?.contentHash).toBe(digest('result=[REDACTED]'));
    expect(result.body.redacted).toBe(true);
    expect(result.attachments[0]?.status).toBe('complete');
    expect(result.attachments[0]?.redacted).toBe(false);
    expect(seen).toEqual(['result=[REDACTED]', 'stdout']);
  });

  test('[case:bounded-truncation] reports truncated while retaining only the bounded body', async () => {
    const seen: string[] = [];
    const publisher = createWorkRecordingPublisher({
      artifacts: fakePublisher(seen),
      limits: { maxBodyBytes: 5, maxAttachmentBytes: 8, maxTotalBytes: 8, maxChunkBytes: 16, maxQueueBytes: 16 },
    });

    const result = await publisher.publishBody({
      projectId: 'project-1',
      kind: 'stdout',
      locator: 'work/session-1/stdout',
      mediaType: 'text/plain',
      expectedHash: digest('01234'),
      content: [Buffer.from('0123456789')],
    });

    expect(result.status).toBe('truncated');
    expect(result.ref?.sizeBytes).toBe(5);
    expect(result.gapReasons).toContain('body_limit');
    expect(seen).toEqual(['01234']);
  });

  test('[case:failure-evidence] reports unavailable and a safe gap for chunk, hash, and volume failures', async () => {
    const seen: string[] = [];
    const publisher = createWorkRecordingPublisher({
      artifacts: fakePublisher(seen),
      limits: { maxBodyBytes: 32, maxAttachmentBytes: 32, maxTotalBytes: 2, maxChunkBytes: 4, maxQueueBytes: 4 },
    });

    const chunkFailure = await publisher.publishBody({
      projectId: 'project-1',
      kind: 'stderr',
      locator: 'work/session-1/stderr',
      mediaType: 'text/plain',
      expectedHash: digest('12345'),
      content: [Buffer.from('12345')],
    });
    expect(chunkFailure.status).toBe('unavailable');
    expect(chunkFailure.gapReasons).toEqual(['chunk_limit']);

    const hashFailure = await publisher.publishBody({
      projectId: 'project-1',
      kind: 'tool_output',
      locator: 'work/session-1/tool-output',
      mediaType: 'text/plain',
      expectedHash: digest('wrong'),
      content: [Buffer.from('abc')],
    });
    expect(hashFailure.status).toBe('unavailable');
    expect(hashFailure.gapReasons).toEqual(['body_hash_mismatch']);

    const message = await publisher.publishMessage({
      projectId: 'project-1',
      message: {
        kind: 'message',
        role: 'assistant',
        locator: 'work/session-1/messages/8/body',
        mediaType: 'text/plain',
        expectedHash: digest('ok'),
        content: [Buffer.from('ok')],
      },
      attachments: [{
        name: 'large.bin',
        mediaType: 'application/octet-stream',
        locator: 'work/session-1/messages/8/attachments/0',
        expectedHash: digest('123'),
        content: [Buffer.from('123')],
      }],
    });
    expect(message.coverage).toBe('failed');
    expect(message.attachments[0]?.gapReasons).toEqual(['total_volume_limit']);
    expect(JSON.stringify(message)).not.toContain('/Users/');
  });
});
