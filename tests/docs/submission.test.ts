import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = readFileSync("docs/SUBMISSION.md", "utf8");
const between = (start: string, end: string): string => {
  const a = doc.indexOf(start), b = doc.indexOf(end);
  assert.ok(a >= 0 && b > a, `markers ${start} … ${end} missing`);
  assert.equal(doc.indexOf(start, a + 1), -1, `${start} appears twice`);
  return doc.slice(a + start.length, b).trim();
};

test("SUBMISSION.md: 'What did you build?' is 20–2000 characters and covers NEAR's role", () => {
  const d = between("<!-- desc:start -->", "<!-- desc:end -->");
  assert.ok(d.length >= 20 && d.length <= 2000, `length ${d.length}`);
  for (const s of ["NEAR Intents", "1Click", "intents.near", "sign", "NEAR AI Cloud"]) assert.ok(d.includes(s), `missing ${s}`);
});

test("SUBMISSION.md: X post draft is at most 280 characters, says Built at NEAR HACKATHON and links the repo", () => {
  const x = between("<!-- x:start -->", "<!-- x:end -->");
  assert.ok(x.length > 0 && x.length <= 280, `length ${x.length}`);
  assert.ok(x.includes("Built at NEAR HACKATHON"));
  assert.match(x, /https:\/\/github\.com\/\S+/);
});

test("SUBMISSION.md: tracks, deadline and no invented links", () => {
  for (const s of ["08 Real-World Money", "04 Autonomous Business", "06 AI Security & Defense", "14 Nov 2026 23:59 UTC"]) assert.ok(doc.includes(s), s);
  // Production URL, video, X post and payout wallet are placeholders until they exist.
  for (const s of ["Live app: `<add after deploy>`", "Demo video: `<add after recording>`", "X demo post: `<add after posting>`", "NEAR payout wallet: `<add before submitting>`"]) assert.ok(doc.includes(s), s);
  for (const w of ["safe", "guaranteed", "insured"]) assert.ok(!new RegExp(`\\b${w}\\b`, "i").test(doc), w);
});
