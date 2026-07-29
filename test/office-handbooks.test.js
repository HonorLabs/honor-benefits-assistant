import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFullOfficeHandbookContext,
  handbookContentHash,
  resolveOfficeAgency,
} from "../office-handbooks.js";

test("normalizes line endings before hashing duplicate handbook text", () => {
  assert.equal(handbookContentHash("Policy A\r\n\r\nPolicy B  \r\n"), handbookContentHash("Policy A\n\nPolicy B\n"));
});

test("resolves a named office and carries it into a short follow-up", () => {
  const result = resolveOfficeAgency([
    { role: "user", content: "I work for VMT Home Health." },
    { role: "assistant", content: "What would you like to know?" },
    { role: "user", content: "What is the vacation rule?" },
  ]);
  assert.equal(result.ambiguous, false);
  assert.equal(result.agency.slug, "vmt_home_health");
});

test("does not guess between ambiguous Angels on Call offices", () => {
  const result = resolveOfficeAgency([{ role: "user", content: "What is the policy at Angels on Call?" }]);
  assert.equal(result.ambiguous, true);
  assert.equal(result.candidates.length, 2);
});

test("uses a specific state qualifier to resolve an otherwise ambiguous office", () => {
  const result = resolveOfficeAgency([
    { role: "user", content: "What is the attendance policy at Angels on Call Michigan?" },
  ]);
  assert.equal(result.ambiguous, false);
  assert.equal(result.agency.slug, "angels_on_call_mi");
});

test("asks for a new office when a follow-up says other offices", () => {
  const result = resolveOfficeAgency([
    { role: "user", content: "What training does Central Penn require?" },
    { role: "assistant", content: "Here is the rule." },
    { role: "user", content: "What about other offices?" },
  ]);
  assert.equal(result.ambiguous, true);
  assert.match(result.reason, /different office/i);
});

test("formats a complete handbook for request-time cached grounding", () => {
  const context = buildFullOfficeHandbookContext({
    agency: { name: "Central Penn Nursing Care, Inc." },
    sourceName: "CPNC Office Employee Handbook 2026.doc",
    sourceDate: "2026-07-17T14:13:00Z",
    fullText: "Training\n\nEmployees must complete annual training.",
  });
  assert.match(context, /complete current source/);
  assert.match(context, /Employees must complete annual training/);
  assert.match(context, /Source: CPNC Office Employee Handbook 2026\.doc/);
});
