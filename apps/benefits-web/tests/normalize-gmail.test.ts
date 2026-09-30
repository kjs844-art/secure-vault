import assert from "node:assert/strict";
import { test } from "node:test";
import { MAIL_LIMITS, type PreparedMail } from "../src/server/mail/contracts.ts";
import { normalizeGmailMessagesJson } from "../src/server/mail/normalize-gmail.ts";

type Fixture = Record<string, unknown>;
const INVALID = { ok: false, code: "MAIL_INPUT_INVALID" };
const LIMIT = { ok: false, code: "MAIL_LIMIT_EXCEEDED" };
const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
const plain = (text: string, extra: Fixture = {}): Fixture => ({
  mimeType: "text/plain", body: { data: encode(text) }, ...extra,
});
const message = (extra: Fixture = {}): Fixture => ({
  id: "synthetic-message-id", internalDate: "0", payload: plain("합성 본문"), ...extra,
});
const normalize = (value: unknown) => normalizeGmailMessagesJson(JSON.stringify(value));
function one(value: Fixture = message()): PreparedMail {
  const result = normalize([value]);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected a successful synthetic fixture");
  assert.equal(result.messages.length, 1);
  return result.messages[0]!;
}
function nested(depth: number, leaf: Fixture = plain("depth")): Fixture {
  let result = leaf;
  for (let level = 1; level < depth; level += 1) {
    result = { mimeType: "multipart/mixed", parts: [result] };
  }
  return result;
}

test("normalizes plain UTF-8 and exposes only ephemeral indices, never Gmail IDs", () => {
  const result = one(message({ payload: plain("합성 본문 😀", { headers: [{ name: "sUbJeCt", value: "합성 제목" }] }) }));
  assert.deepEqual(result, {
    index: 0, receivedAt: "1970-01-01T00:00:00.000Z", subject: "합성 제목",
    body: "합성 본문 😀", bodySource: "plain", warnings: [],
  });
  assert.equal(JSON.stringify(result).includes("synthetic-message-id"), false);
});

test("accepts and freezes empty batches", () => {
  const result = normalize([]);
  assert.deepEqual(result, { ok: true, messages: [] });
  assert.equal(Object.isFrozen(result), true);
  if (result.ok) assert.equal(Object.isFrozen(result.messages), true);
});

test("freezes every result, message, and warnings collection", () => {
  const result = normalize([message({ internalDate: undefined })]);
  assert.equal(Object.isFrozen(result), true);
  if (!result.ok) throw new Error("Expected a successful synthetic fixture");
  assert.equal(Object.isFrozen(result.messages), true);
  assert.equal(Object.isFrozen(result.messages[0]), true);
  assert.equal(Object.isFrozen(result.messages[0]!.warnings), true);
  assert.equal(Object.isFrozen(normalizeGmailMessagesJson("{")), true);
  assert.equal(Object.isFrozen(normalizeGmailMessagesJson(" ".repeat(MAIL_LIMITS.jsonBytes + 1))), true);
});

test("malformed JSON and non-array roots use fixed errors without raw data", () => {
  for (const input of ["{synthetic-private-detail", "null", "{}", '"mail"', "[", "[null]"]) {
    assert.deepEqual(normalizeGmailMessagesJson(input), INVALID);
  }
  assert.deepEqual(normalizeGmailMessagesJson(null as unknown as string), INVALID);
});

test("bounds input before parsing, including UTF-8 multibyte expansion", () => {
  assert.deepEqual(normalizeGmailMessagesJson(" ".repeat(MAIL_LIMITS.jsonBytes + 1)), LIMIT);
  const multibyte = JSON.stringify([{ ignored: "한".repeat(710000) }]);
  assert.ok(multibyte.length < MAIL_LIMITS.jsonBytes);
  assert.ok(Buffer.byteLength(multibyte, "utf8") > MAIL_LIMITS.jsonBytes);
  assert.deepEqual(normalizeGmailMessagesJson(multibyte), LIMIT);
});

test("accepts a JSON input exactly at the byte limit", () => {
  const prefix = JSON.stringify([message({ ignored: "" })]);
  const padding = "a".repeat(MAIL_LIMITS.jsonBytes - Buffer.byteLength(prefix));
  const input = JSON.stringify([message({ ignored: padding })]);
  assert.equal(Buffer.byteLength(input), MAIL_LIMITS.jsonBytes);
  assert.equal(normalizeGmailMessagesJson(input).ok, true);
});

test("accepts thirty messages and rejects thirty-one", () => {
  const batch = Array.from({ length: 30 }, (_, index) => message({ id: `synthetic-${index}` }));
  const result = normalize(batch);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.messages[29]!.index, 29);
  assert.deepEqual(normalize([...batch, message({ id: "synthetic-extra" })]), LIMIT);
});

test("requires bounded, nonempty unique message IDs without exposing them", () => {
  for (const id of [undefined, null, 7, "", " \t"]) assert.deepEqual(normalize([message({ id })]), INVALID);
  assert.equal(normalize([message({ id: "a".repeat(256) })]).ok, true);
  assert.deepEqual(normalize([message({ id: "a".repeat(257) })]), LIMIT);
  assert.deepEqual(normalize([message(), message()]), INVALID);
});

test("does not return partial successes when a later message fails", () => {
  assert.deepEqual(normalize([message(), message({ id: "synthetic-next", payload: [] })]), INVALID);
});

test("ignores unrelated properties and unused malformed snippets", () => {
  const result = one(message({ unrelated: { any: [1, null, false] }, snippet: { unused: true } }));
  assert.equal(result.body, "합성 본문");
});

test("rejects malformed fields that are accessed", () => {
  for (const payload of [null, [], { headers: {} }, { headers: [null] }, { headers: [{ name: 1, value: "x" }] },
    { headers: [{ name: "Subject", value: false }] }, { mimeType: 1 }, { filename: null },
    { body: [] }, { body: { data: 1 } }, { body: { attachmentId: false } }, { parts: {} }, { parts: [null] }]) {
    assert.deepEqual(normalize([message({ payload })]), INVALID);
  }
  assert.deepEqual(normalize([message({ payload: undefined, snippet: 7 })]), INVALID);
});

test("Subject names are case-insensitive; identical duplicates work, conflicts fail", () => {
  const headers = [{ name: "Subject", value: "same" }, { name: "SUBJECT", value: "same" }];
  assert.equal(one(message({ payload: plain("body", { headers }) })).subject, "same");
  headers[1]!.value = "different";
  assert.deepEqual(normalize([message({ payload: plain("body", { headers }) })]), INVALID);
});

test("header count, names and values have inclusive limits", () => {
  const headers = Array.from({ length: 64 }, () => ({ name: "X-Synthetic", value: "x".repeat(2048) }));
  assert.equal(normalize([message({ payload: plain("body", { headers }) })]).ok, true);
  assert.deepEqual(normalize([message({ payload: plain("body", { headers: [...headers, headers[0]] }) })]), LIMIT);
  assert.deepEqual(normalize([message({ payload: plain("body", { headers: [{ name: "X", value: "x".repeat(2049) }] }) })]), LIMIT);
  assert.equal(normalize([message({ payload: plain("body", { headers: [{ name: "X".repeat(2048), value: "x" }] }) })]).ok, true);
  assert.deepEqual(normalize([message({ payload: plain("body", { headers: [{ name: "X".repeat(2049), value: "x" }] }) })]), LIMIT);
});

test("accepts depth eight and rejects depth nine before descent", () => {
  assert.equal(one(message({ payload: nested(8) })).body, "depth");
  assert.deepEqual(normalize([message({ payload: nested(9) })]), LIMIT);
});

test("counts root and every child against the 128-part budget", () => {
  const parts = Array.from({ length: 127 }, () => plain("x"));
  assert.equal(normalize([message({ payload: { mimeType: "multipart/mixed", parts } })]).ok, true);
  assert.deepEqual(normalize([message({ payload: { mimeType: "multipart/mixed", parts: [...parts, plain("y")] } })]), LIMIT);
});

test("enforces depth/count bounds even inside excluded attachments", () => {
  assert.deepEqual(normalize([message({ payload: { ...nested(9), filename: "synthetic.txt" } })]), LIMIT);
  assert.deepEqual(normalize([message({ payload: { mimeType: "text/html", parts: Array.from({ length: 128 }, () => plain("x")) } })]), LIMIT);
});

test("aggregates multipart/mixed plain children deterministically in tree order", () => {
  const payload = { mimeType: "multipart/mixed", parts: [plain("first"), nested(2, plain("second")), plain("third")] };
  assert.equal(one(message({ payload })).body, "first\nsecond\nthird");
});

test("multipart/alternative selects one plain subtree, not duplicate alternatives", () => {
  const payload = { mimeType: "multipart/alternative", parts: [
    { mimeType: "text/html", body: { data: encode("<p>HTML</p>") } },
    { mimeType: "multipart/mixed", parts: [plain("first"), plain("subtree")] }, plain("second alternative"),
  ] };
  assert.equal(one(message({ payload })).body, "first\nsubtree");
});

test("skips filename, attachmentId, Content-Disposition and nested attachment subtrees", () => {
  const payload = { mimeType: "multipart/mixed", parts: [
    plain("hidden filename", { filename: "synthetic.txt" }),
    plain("hidden ID", { body: { attachmentId: "synthetic-attachment", data: "not+base64" } }),
    plain("hidden disposition", { headers: [{ name: "Content-Disposition", value: "ATTACHMENT; filename=synthetic.txt" }] }),
    plain("hidden inline", { headers: [{ name: "Content-Disposition", value: 'inline; filename="synthetic.txt"' }] }),
    { mimeType: "multipart/mixed", filename: "synthetic.eml", parts: [plain("hidden child")] }, plain("visible"),
  ] };
  assert.equal(one(message({ payload })).body, "visible");
});

test("skips extended and continued filename parameters on inline attachments", () => {
  for (const parameter of ["filename*=UTF-8''synthetic.txt", "filename*0=synthetic", "filename*0*=UTF-8''synthetic"]) {
    const payload = plain("hidden", { headers: [{ name: "Content-Disposition", value: "inline; " + parameter }] });
    assert.equal(one(message({ payload })).bodySource, "none");
  }
});

test("never decodes HTML or descends into HTML/message media for extraction", () => {
  for (const mimeType of ["text/html", "message/rfc822", "application/octet-stream"]) {
    const result = one(message({ payload: { mimeType, body: { data: "not+base64" }, parts: [plain("hidden")] } }));
    assert.equal(result.bodySource, "none");
    assert.deepEqual(result.warnings, ["NO_TEXT"]);
  }
});

test("falls back to snippet explicitly and never mistakes it for complete plain text", () => {
  const result = one(message({ payload: { mimeType: "text/html" }, snippet: "합성 미리보기" }));
  assert.equal(result.body, "합성 미리보기");
  assert.equal(result.bodySource, "snippet");
  assert.deepEqual(result.warnings, ["SNIPPET_ONLY"]);
});

test("missing/empty text yields NO_TEXT and no invented body", () => {
  for (const payload of [undefined, {}, plain("")]) {
    const result = one(message({ payload, snippet: "" }));
    assert.equal(result.body, "");
    assert.equal(result.bodySource, "none");
    assert.deepEqual(result.warnings, ["NO_TEXT"]);
  }
});

test("accepts canonical base64url with each remainder and URL-safe alphabet", () => {
  for (const body of ["a", "ab", "abc", "abcd", "😀", "\uffff\uffff", "\uFEFFbody"]) {
    assert.equal(one(message({ payload: plain(body) })).body, body);
  }
});

test("accepts exactly padded base64url as well as omitted padding", () => {
  for (const [data, body] of [["YQ==", "a"], ["YWI=", "ab"], ["YWJj", "abc"], ["77-_77-_", "\uffff\uffff"]]) {
    assert.equal(one(message({ payload: { mimeType: "text/plain", body: { data } } })).body, body);
  }
});

test("rejects malformed padding, standard alphabet, whitespace, length and noncanonical bits", () => {
  for (const data of ["YQ=", "YQ===", "Y=Q=", "=YQ=", "=", "==", "====", "YWJj=", "YWJj====", "YR==", "YWJ=", "YQ\n", "YQ ", "++8", "//8", "a", "YR", "YWJ", "%%%", "YQ."]) {
    assert.deepEqual(normalize([message({ payload: { mimeType: "text/plain", body: { data } } })]), INVALID);
  }
});

test("fatal UTF-8 rejects incomplete, overlong, surrogate and invalid sequences", () => {
  for (const bytes of [[0xc3], [0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    const data = Buffer.from(bytes).toString("base64url");
    assert.deepEqual(normalize([message({ payload: { mimeType: "text/plain", body: { data } } })]), INVALID);
  }
});

test("encoded-part limit applies before decode, even to ignored media", () => {
  assert.equal(normalize([message({ payload: plain("a".repeat(98304)) })]).ok, true);
  for (const mimeType of ["text/plain", "text/html"]) {
    assert.deepEqual(normalize([message({ payload: { mimeType, body: { data: "a".repeat(131073) } } })]), LIMIT);
  }
});

test("decoded-byte budget applies across parts and multibyte data", () => {
  assert.equal(normalize([message({ payload: plain("한".repeat(32768)) })]).ok, true);
  const payload = { mimeType: "multipart/mixed", parts: [plain("한".repeat(16384)), plain("한".repeat(16384) + "x")] };
  assert.deepEqual(normalize([message({ payload })]), LIMIT);
});

test("unselected plain alternatives still consume the decoded-byte budget", () => {
  const payload = { mimeType: "multipart/alternative", parts: [plain("a".repeat(65536)), plain("b".repeat(65536))] };
  assert.deepEqual(normalize([message({ payload })]), LIMIT);
});

test("decoded budget resets per message", () => {
  const payload = plain("a".repeat(98304));
  assert.equal(normalize([message({ id: "synthetic-a", payload }), message({ id: "synthetic-b", payload })]).ok, true);
});

test("supports explicit UTF-8/us-ascii and rejects unsupported or ambiguous charsets", () => {
  for (const contentType of ['text/plain; charset="UTF-8"', "text/plain; charset=us-ascii", "text/plain"]) {
    assert.equal(one(message({ payload: plain("ascii", { headers: [{ name: "Content-Type", value: contentType }] }) })).body, "ascii");
  }
  for (const value of ["text/plain; charset=iso-8859-1", "text/plain; charset=", "text/plain; charset=utf-8; charset=us-ascii", "text/plain; charset*=UTF-8''utf-8", "text/plain; charset*0=utf-8", "text/html"]) {
    assert.deepEqual(normalize([message({ payload: plain("body", { headers: [{ name: "Content-Type", value }] }) })]), INVALID);
  }
});

test("honors ASCII charset declarations without lossy conversions", () => {
  const headers = [{ name: "Content-Type", value: "text/plain; charset=us-ascii" }];
  assert.equal(one(message({ payload: plain("ascii", { headers }) })).body, "ascii");
  assert.deepEqual(normalize([message({ payload: plain("한", { headers }) })]), INVALID);
});

test("FULL body.data is decoded once regardless of original MIME transfer labels", () => {
  for (const value of ["7bit", "8bit", "binary", "quoted-printable", "base64", "unknown-original-label"]) {
    const headers = [{ name: "Content-Transfer-Encoding", value }];
    assert.equal(one(message({ payload: plain("합성 본문", { headers }) })).body, "합성 본문");
    // These are literal contents of FULL body.data, never instructions for another decode.
    assert.equal(one(message({ payload: plain("SGVsbG8= =ED=95=9C", { headers }) })).body, "SGVsbG8= =ED=95=9C");
  }
});

test("rejects escaped lone surrogates in the selected subject and fallback snippet", () => {
  for (const text of ["\ud800", "\udfff", "before\ud800after", "\ud800\ud800", "\udc00\udc00"]) {
    assert.deepEqual(normalize([message({ payload: plain("body", { headers: [{ name: "Subject", value: text }] }) })]), INVALID);
    assert.deepEqual(normalize([message({ payload: undefined, snippet: text })]), INVALID);
  }
  assert.equal(one(message({ payload: undefined, snippet: "😀" })).body, "😀");
});

test("maximum normalized batch stays within the aggregate analysis character budget", () => {
  const payload = plain("b".repeat(3001), { headers: [{ name: "Subject", value: "s".repeat(241) }] });
  const result = normalize(Array.from({ length: 30 }, (_, index) => message({ id: `synthetic-max-${index}`, payload })));
  assert.equal(result.ok, true);
  if (result.ok) {
    const total = result.messages.reduce((count, item) => count + item.subject.length + item.body.length, 0);
    assert.equal(total, 97200);
    assert.ok(total <= MAIL_LIMITS.analysisChars);
  }
});

test("Subject and body are bounded with explicit warnings and no split surrogate pairs", () => {
  const subject = "s".repeat(239) + "😀";
  const body = "b".repeat(2999) + "😀";
  const result = one(message({ payload: plain(body, { headers: [{ name: "Subject", value: subject }] }) }));
  assert.equal(result.subject, "s".repeat(239));
  assert.equal(result.body, "b".repeat(2999));
  assert.deepEqual(result.warnings, ["SUBJECT_TRUNCATED", "BODY_TRUNCATED"]);
});

test("inclusive subject/body limits do not add truncation warnings", () => {
  const result = one(message({ payload: plain("b".repeat(3000), { headers: [{ name: "Subject", value: "s".repeat(240) }] }) }));
  assert.equal(result.subject.length, 240);
  assert.equal(result.body.length, 3000);
  assert.deepEqual(result.warnings, []);
});

test("snippet fallback is truncated safely and retains both warning meanings", () => {
  const result = one(message({ payload: undefined, snippet: "s".repeat(2999) + "😀" }));
  assert.equal(result.body.length, 2999);
  assert.deepEqual(result.warnings, ["SNIPPET_ONLY", "BODY_TRUNCATED"]);
});

test("internalDate uses exact accepted timestamp bounds", () => {
  assert.equal(one(message({ internalDate: "0000" })).receivedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(one(message({ internalDate: "1" })).receivedAt, "1970-01-01T00:00:00.001Z");
  assert.equal(one(message({ internalDate: "253402300799999" })).receivedAt, "9999-12-31T23:59:59.999Z");
});

test("invalid internalDate stays unknown; Date header and current time are never fallbacks", () => {
  for (const internalDate of [undefined, null, 0, "", "-1", "+1", "1.5", "1e3", " 0", "0 ", "253402300800000", "9007199254740992", "9".repeat(400)]) {
    const result = one(message({ internalDate, payload: plain("body", { headers: [{ name: "Date", value: "Mon, 28 Sep 2026 01:00:00 +0000" }] }) }));
    assert.equal(result.receivedAt, null);
    assert.deepEqual(result.warnings, ["DATE_UNKNOWN"]);
  }
});

test("returns stable content and warning order for the same synthetic JSON", () => {
  const input = JSON.stringify([message({ internalDate: "unknown", payload: undefined, snippet: "s".repeat(3001) })]);
  const first = normalizeGmailMessagesJson(input);
  assert.deepEqual(normalizeGmailMessagesJson(input), first);
  if (first.ok) assert.deepEqual(first.messages[0]!.warnings, ["DATE_UNKNOWN", "SNIPPET_ONLY", "BODY_TRUNCATED"]);
});
