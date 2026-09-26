/// <reference types="@woofx3/module-sdk/function-ctx" />

// The forms site owns everything viewer-facing: building forms, signing
// viewers in, moderating. It sends this module only what is ready for stream,
// as signed POSTs to the `forms_webhook` trigger's URL:
//
//   headers  x-forms-timestamp: <unix seconds>
//            x-forms-signature: <hex HMAC-SHA256 of "<timestamp>.<raw body>">
//   body     { "version": 1, "type": "submission.approved", "submission": {
//                "id", "formId", "formTitle", "submittedAt",
//                "viewer": { "displayName" } | null,
//                "answers": [{ "label", "value" }] } }
//            { "version": 1, "type": "submission.withdrawn",
//              "submission": { "id", "formId" } }
//
// The queue a submission waits in is a woofx3 `queue`, reached through the
// bundled workflows: an approval announces `forms.submission.approved`, which
// adds the submission's id to the linked queue, and `queue.next` on any queue
// runs `show`. The queue holds only the id, since its entries are short
// strings in woofx3's storage, which this module's widget cannot read. The
// submission itself is kept here at `sub:<id>`, and what a queue's Spotlight
// widgets show at `shown:<queue canonical id>`.

// Five minutes absorbs clock skew while still bounding how long a captured
// request can be replayed.
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

// Enough to ride out a burst of simultaneous updates; running out means
// something is writing this key continuously, which is worth failing loudly.
const MAX_ATTEMPTS = 25;

// The id doubles as the queue entry and part of a storage key, so it is kept
// to characters that are safe in both.
const SUBMISSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_NAME_LENGTH = 64;
const MAX_ANSWERS = 20;
const MAX_LABEL_LENGTH = 200;
const MAX_VALUE_LENGTH = 2000;

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function receive(ctx) {
  /** @type {import("@woofx3/module-sdk/function-ctx").WebhookRequest} */
  const req = ctx.event.data;
  if (req.method !== "POST") {
    return { status: 405 };
  }
  if (!isSignedBySite(ctx, req)) {
    return { status: 401 };
  }

  const message = req.body;
  if (!isObject(message) || message.version !== 1 || !isObject(message.submission)) {
    return rejected(400, "expected a version 1 forms message");
  }
  const id = message.submission.id;
  if (typeof id !== "string" || !SUBMISSION_ID.test(id)) {
    return rejected(400, "submission.id must be 1 to 64 letters, digits, '_' or '-'");
  }

  switch (message.type) {
    case "submission.approved": {
      return receiveApproved(ctx, message.submission);
    }
    case "submission.withdrawn": {
      return receiveWithdrawn(ctx, id);
    }
    default: {
      return rejected(400, "unknown message type");
    }
  }
}

// Stores the submission and announces it, which queues it. A retried delivery
// announces again until the submission has been shown, because the engine
// publishes the event only after this returns and a failed publish is
// retried by the site: the queue refuses the duplicate while the entry is
// still waiting, so announcing twice is harmless and not announcing could
// lose the submission.
function receiveApproved(ctx, raw) {
  const submission = normalizeSubmission(raw);
  if (typeof submission === "string") {
    return rejected(400, submission);
  }
  const link = findLink(ctx, submission.formId);
  if (!link) {
    return rejected(404, `no form link for form ${submission.formId}`);
  }
  const queue = link.settings && link.settings.queue;
  if (typeof queue !== "string" || queue === "") {
    return rejected(409, `the link for form ${submission.formId} has no queue`);
  }
  const options = storageOptions(ctx, queue);
  if (!options) {
    return rejected(409, `the queue linked to form ${submission.formId} no longer exists`);
  }

  const record = { submission, queue, shownAt: 0, withdrawn: false };
  const written = ctx.storage.compareAndSet(subKey(submission.id), null, record, options);
  const stored = written.swapped ? record : written.current;
  if (stored.withdrawn || stored.shownAt > 0) {
    return { status: 200 };
  }
  return {
    status: 200,
    events: [{
      type: "forms.submission.approved",
      data: {
        submissionId: submission.id,
        formId: submission.formId,
        formTitle: submission.formTitle,
        queue: stored.queue,
        viewerName: submission.viewer ? submission.viewer.displayName : "",
      },
    }],
  };
}

// Marks the submission withdrawn so a later `show` skips it, takes it off any
// Spotlight showing it, and announces it so the queue drops the entry. A
// withdrawal for a submission never received has nothing to undo.
function receiveWithdrawn(ctx, id) {
  const record = updateRecord(ctx, id, (current) => (current.withdrawn ? null : Object.assign({}, current, { withdrawn: true })));
  if (!record) {
    return { status: 200 };
  }
  clearIfShowing(ctx, record.queue, id);
  return {
    status: 200,
    events: [{
      type: "forms.submission.withdrawn",
      data: { submissionId: id, formId: record.submission.formId, queue: record.queue },
    }],
  };
}

// Runs for every entry taken from any queue, so an entry that is not a
// submission this module holds is the normal case for other queues, not an
// error.
/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function show(ctx) {
  const queue = queueParameter(ctx);
  const raw = parameters(ctx).entry;
  const entry = typeof raw === "string" ? raw.trim() : "";
  const skipped = ctx.result({ queue, entry, shown: false }, []);
  if (!SUBMISSION_ID.test(entry)) {
    return skipped;
  }
  const shownAt = Date.now();
  const record = updateRecord(ctx, entry, (current) => (current.withdrawn ? null : Object.assign({}, current, { shownAt })));
  if (!record) {
    return skipped;
  }
  ctx.storage.set(shownKey(queue), { submission: record.submission, shownAt }, storageOptions(ctx, queue) || {});
  return ctx.result({ queue, entry, shown: true }, []);
}

/** @param {import("@woofx3/module-sdk/function-ctx").Ctx} ctx */
function hide(ctx) {
  const queue = queueParameter(ctx);
  ctx.storage.set(shownKey(queue), { submission: null, shownAt: Date.now() }, storageOptions(ctx, queue) || {});
  return ctx.result({ queue }, []);
}

// The site signs `${timestamp}.${rawBody}`, so the timestamp is covered by the
// signature and checking its age is enough to refuse replays.
function isSignedBySite(ctx, req) {
  const secret = ctx.module.settings.webhookSecret;
  if (typeof secret !== "string" || secret === "") {
    ctx.log.warn("refusing a forms webhook: the signing secret is not set");
    return false;
  }
  const timestamp = req.headers["x-forms-timestamp"] || "";
  const signature = req.headers["x-forms-signature"] || "";
  if (!/^\d+$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) {
    return false;
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return false;
  }
  const expected = ctx.crypto.hmac("sha256", secret, `${timestamp}.${req.rawBody}`);
  return ctx.crypto.timingSafeEqual(expected, signature);
}

// The site is trusted to have moderated the submission, not to have shaped it
// correctly: everything kept is checked and bounded here, because it ends up
// on stream. Returns the reason instead when it cannot be kept.
function normalizeSubmission(raw) {
  const formId = raw.formId;
  if (typeof formId !== "string" || formId === "") {
    return "submission.formId is required";
  }
  if (!Array.isArray(raw.answers) || raw.answers.length === 0 || raw.answers.length > MAX_ANSWERS) {
    return `submission.answers must hold 1 to ${MAX_ANSWERS} answers`;
  }
  const answers = [];
  for (const answer of raw.answers) {
    if (!isObject(answer)) {
      return "each answer must be an object";
    }
    answers.push({
      label: bounded(answer.label, MAX_LABEL_LENGTH),
      value: bounded(answer.value, MAX_VALUE_LENGTH),
    });
  }
  const viewer = isObject(raw.viewer) ? { displayName: bounded(raw.viewer.displayName, MAX_NAME_LENGTH) } : null;
  return {
    id: raw.id,
    formId,
    formTitle: bounded(raw.formTitle, MAX_TITLE_LENGTH),
    submittedAt: typeof raw.submittedAt === "string" ? raw.submittedAt : "",
    viewer: viewer && viewer.displayName !== "" ? viewer : null,
    answers,
  };
}

// The link's instance id is whatever the dashboard minted, so a form is found
// by the site's id kept in the link's settings.
function findLink(ctx, formId) {
  const prefix = `${ctx.module.id}:form:`;
  return ctx.resources.list("form").find((instance) => {
    return instance.canonical_id.indexOf(prefix) === 0 && instance.settings && instance.settings.formId === formId;
  }) || null;
}

// What this module keeps for a queue lives as long as the queue's own value,
// so a session queue does not leave submissions behind when it empties at
// the end of the stream. Null when the queue no longer exists.
function storageOptions(ctx, queue) {
  const instance = ctx.resources.get(queue);
  if (!instance || instance.kind !== "queue") {
    return null;
  }
  return { clearOnSessionEnd: Boolean(instance.settings && instance.settings.lifetime === "session") };
}

// Applies `change` to a stored submission until the write lands. `change`
// returns the new record, or null to leave it as it is; either way the
// record is returned, or null when the submission is unknown or `change`
// declined it.
function updateRecord(ctx, id, change) {
  const key = subKey(id);
  let stored = ctx.storage.get(key);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!isObject(stored)) {
      return null;
    }
    const next = change(stored);
    if (next === null) {
      return null;
    }
    const written = ctx.storage.compareAndSet(key, stored, next, storageOptions(ctx, next.queue) || {});
    if (written.swapped) {
      return next;
    }
    stored = written.current;
  }
  throw new Error(`forms: submission ${id} changed ${MAX_ATTEMPTS} times while updating it`);
}

function clearIfShowing(ctx, queue, id) {
  const key = shownKey(queue);
  const showing = ctx.storage.get(key);
  if (!isObject(showing) || !isObject(showing.submission) || showing.submission.id !== id) {
    return;
  }
  ctx.storage.compareAndSet(key, showing, { submission: null, shownAt: Date.now() }, storageOptions(ctx, queue) || {});
}

function queueParameter(ctx) {
  const queue = parameters(ctx).queue;
  if (typeof queue !== "string" || queue === "") {
    throw new Error("forms: no queue chosen");
  }
  return queue;
}

function parameters(ctx) {
  return (ctx.event && ctx.event.parameters) || {};
}

function rejected(status, error) {
  return { status, body: { error } };
}

function subKey(id) {
  return `sub:${id}`;
}

function shownKey(queue) {
  return `shown:${queue}`;
}

function bounded(value, max) {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
