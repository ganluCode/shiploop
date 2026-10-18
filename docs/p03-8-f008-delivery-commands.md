# P03-8 F-008 Feature delivery command contract

Feature delivery uses the existing authenticated `POST /v1/commands` channel. The protocol remains protocolVersion 1 / schemaVersion 5. Approval still uses `task.approval.approve`, `task.approval.reject` and `task.approval.unblock`; approval alone does not start delivery.

| Operation | Behavior |
| --- | --- |
| `feature.verification.continue` | Explicitly run the existing final verification, read current approval and finalize through controlled Git commit. A pending Git intent requires reconciliation first. |
| `git.operation.reconcile` | Inspect an existing Git operation through the reconciliation service. It never starts another commit or Runtime. |

Both commands require project scope, `execution.start`, a fresh `issuedAt`, optional `expiresAt`, `commandId`, and `expectedRevision` for the **Feature**. Payload fields are exactly `featureId`, `runId`, `batchId`, `operationId`; the operation ID is a UUID v4. Project, Feature, Run, Batch and any stored Git intent must agree. Requests cannot supply actors, principals, Git identity, evidence or authorization flags. Push, PR and automatic merge remain unsupported.

The command service reads current approval from Core facts and obtains immutable intent identity from a trusted adapter. Git user name/email remain delivery configuration, separate from the authenticated principal. Verification and Git adapters must retain their existing authorization, evidence, resource ownership, fencing and stop-confirmation checks. Runtime receives no new metadata access.

The trusted assembly option is `featureDeliveryFactory({ atomicStore })`, accepted by `openCoreApplication` and forwarded by `startHost`. It must return verification, intent-reading, controlled commit and reconciliation dependencies. This is a code-only injection point, unavailable through argv, environment, settings or requests. No Fake adapter is installed by default. An omitted factory yields `unsupported`; an invalid factory or incomplete dependency set rejects assembly. Host advertises the two optional capabilities together only after successful assembly. Handshake validation accepts the original capability set or the complete pair and rejects partial or invented capabilities.

Command receipts remain separate from Git receipts. Completed results include `gitOperationId`, outcome, reason and deliveryStatus, without native paths or Git identity. Same principal/commandId and digest replay the original durable receipt, including business rejection receipts for existing projects; conflicting parameters reject. Missing projects, malformed or unauthorized requests and invalid command timing follow existing channel errors. Completed receipts can replay after restart even when adapters are unavailable or the original command has expired, with authorization checked again.

In-flight duplicates share one result; different command IDs for the same Feature serialize and recheck revision before external calls. SQLite transactions never span asynchronous verification or Git I/O. A crash after a Git intent is registered requires explicit operation reconciliation rather than another commit. Execution budget expiry prevents starting delivery checks, while an existing operation can still be reconciled with a fresh authorized command.

Delivery activities join Host quiesce. New delivery requests stop entering, accepted work must settle before Core closes, and a timeout preserves the existing unconfirmed-stop behavior. This does not cancel or claim to stop an external process.

Task-local verification is in `test/modules/delivery/p03-8-f008-delivery-commands.test.ts`, using real SQLite and Host HTTP plus explicitly injected adapter doubles. Real Git driver and reconciliation regressions are selected for Nezha; this task's HTTP tests do not claim to validate those drivers again.
