# Learning guide: how the CRM stays correct

A contact answers “who is this?” A lead answers “what are they interested in this time?” Jordan can ask about one service today and another next month. One contact and two leads keep current contact details consistent without erasing the history of either inquiry. Company contacts use the same idea; no industry-specific model is embedded.

Matching answers “might these records refer to the same person?” Idempotency answers “have we already accepted this delivery?” A shared family email can be a matching clue without proving identity. Retrying an interrupted request should not create another lead, while a genuinely new inquiry should. That is why matching suggests a human choice and idempotency uses a durable request key.

An organization is the tenant boundary. A composite foreign key is like checking both the building and apartment number: `(organization_id, contact_id)` must match a contact with those same two values. Knowing a foreign contact's UUID does not let a lead point at it. RLS independently checks which rows a verified member can see, even through the direct database API.

Authentication, authorization and isolation are different jobs. Authentication establishes who signed in. Authorization checks whether that person currently belongs to this organization and may perform this action. Isolation prevents the operation from touching other organizations' rows. A URL, a hidden button or a model's claim cannot substitute for backend authorization.

The browser holds an opaque HttpOnly session cookie. The API verifies the existing server-held Auth credentials, resolves organization membership and sends a user-JWT database request. It never uses the session-store login to read tenant data. The narrow CRM function owner cannot log in, bypass RLS, read Auth or open the session store. Public wrappers call bounded operations; they do not expose a general SQL tool.

A version number prevents an invisible overwrite. If two people load version 3, the first accepted edit creates version 4. The second edit still says version 3 and receives a conflict. Their unsaved work remains visible for review. Revalidation must not silently change the draft's original version.

Locks answer a different concurrency question: which operation gets to decide first? CRM work holds a shared organization lock; membership changes need an exclusive lock. If authorized work enters first it may finish, then revocation proceeds. If revocation wins first, queued CRM work checks membership again and fails. Ordered contact/delivery locks prevent two imports acquiring the same records in opposite order.

Assignment has a historical member ID plus a membership generation. Revoking and later rejoining advances that generation. The old assignment remains an accurate historical fact, but the returning member does not automatically regain the lead. A new eligible assignment is a deliberate action.

An activity event and its business change share one database transaction. Either both commit or neither does. The timeline records useful actor/record IDs, field names and lifecycle changes; it does not copy the contact's full details on every edit. Immutable attribution preserves how each lead arrived. Current views deliberately resolve the contact's current details. These are different kinds of truth.

An import has three identities. The **job** is the batch you are reviewing. An **attempt** is one exact submission and its immutable result. A **delivery** is a logical source row across corrections. If rows one and three succeed but two fails, the correction gets a new attempt while row two keeps its delivery ID. Successful delivery IDs cannot create a second lead. Replaying the first attempt still shows its original result, even after a later attempt fixes row two.

A client timeout cannot tell you whether a transaction committed. The server might have saved the row just before the connection disappeared. The UI freezes uncertain creates/imports and retries the same payload and key. A process restart does not erase database receipts. This is reliable replay, not a claim that arbitrary external effects are exactly-once. No external send exists in this phase.

A keyset cursor says “continue after this timestamp and UUID.” Its HMAC binds the current user, organization, query, matching mode and order. It is a navigation token, not permission. Current membership is checked again on every page. Records can move as people edit them; pagination is not a snapshot frozen across requests.

Search has an explicit matching meaning. “Starts with” uses native indexed prefixes over normalized names/titles/channels. “Contains anywhere” is more flexible, but broad queries need more work and can exceed the bounded timeout on large organizations. The benchmark preserves these failures. We did not cache membership across requests, bypass RLS, mark arbitrary functions leakproof, or add a search service to improve a local number.

Drafts are temporary private work. They live in memory under verified user/workspace keys. A successful same-person session check restores them; a user change, revocation or workspace switch clears or isolates them. Late network callbacks carry a scope token and cannot fill another workspace. Nothing sensitive is saved in localStorage or sessionStorage. A hard refresh can lose the draft even when a browser warning is requested; durable import results have a different recovery path.

Business activity, private security audit events, operational logs and future agent traces must remain separate. They have different readers and retention needs. A business timeline may need a reopening reason; an operational log needs a safe error code and request ID. Logging an entire contact payload does not make the system more observable.

Future AI tools would call these same authorized services using backend-bound organization context. A lead description is untrusted data, even if it says “ignore your rules.” A model may propose a change, but deterministic policy, expected version, permissions and any human approval decide whether it can execute. Customer facts, human input, integration claims and model inferences need distinct provenance. An SDK coordinates reasoning; it does not replace our database integrity, consent policy, durable retries or security boundary. No agent runs in Phase 02.

For hands-on steps, see the [manual verification guide](../phases/phase-02-manual.md). For actual counts, timings and limitations, see the [engineering report](../phases/phase-02-report.md).
