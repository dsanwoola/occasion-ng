import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createFoodCardRelaySignature, parseOccasionFlutterwaveEvent,
  verifyFoodCardRelaySignature } from "../src/lib/payments/flutterwave-relay.ts";

const raw = JSON.stringify({
  id: "wbk_synthetic_occasion_001",
  type: "charge.completed",
  data: { id: "chg_synthetic_occasion_001", reference: "OCFLWSYNTHETIC001" },
});
const secret = "synthetic-relay-secret-for-tests-only-0001";
const now = 1_789_240_000_000;
const timestamp = String(now);

test("FoodCard relay signature binds timestamp and exact raw body", () => {
  const signature = createFoodCardRelaySignature(raw, timestamp, secret);
  assert.equal(signature, crypto.createHmac("sha256", secret).update(timestamp).update(".").update(raw).digest("base64"));
  assert.equal(verifyFoodCardRelaySignature(raw, timestamp, signature, secret, now), true);
  assert.equal(verifyFoodCardRelaySignature(`${raw} `, timestamp, signature, secret, now), false);
  assert.equal(verifyFoodCardRelaySignature(raw, timestamp, `${signature.slice(0, -1)}A`, secret, now), false);
});

test("FoodCard relay rejects stale, future, malformed, and unconfigured authentication", () => {
  const signature = createFoodCardRelaySignature(raw, timestamp, secret);
  assert.equal(verifyFoodCardRelaySignature(raw, String(now - 300_001), signature, secret, now), false);
  assert.equal(verifyFoodCardRelaySignature(raw, String(now + 300_001), signature, secret, now), false);
  assert.equal(verifyFoodCardRelaySignature(raw, "invalid", signature, secret, now), false);
  assert.equal(verifyFoodCardRelaySignature(raw, timestamp, signature, undefined, now), false);
  assert.equal(verifyFoodCardRelaySignature(raw, timestamp, signature, "too-short", now), false);
});

test("Occasion event parsing accepts provider dialects and rejects ambiguous aliases", () => {
  assert.deepEqual(parseOccasionFlutterwaveEvent(raw), {
    eventName: "charge.completed", reference: "OCFLWSYNTHETIC001", transactionId: "chg_synthetic_occasion_001",
  });
  assert.deepEqual(parseOccasionFlutterwaveEvent(JSON.stringify({
    event: "charge.successful", data: { id: 123, tx_ref: "ocflwlegacy123" },
  })), { eventName: "charge.successful", reference: "OCFLWLEGACY123", transactionId: 123 });
  assert.deepEqual(parseOccasionFlutterwaveEvent(JSON.stringify({
    event: "charge.success", type: "charge.success",
    data: { id: 124, tx_ref: "ocflwsame123", reference: "OCFLWSAME123" },
  })), { eventName: "charge.success", reference: "OCFLWSAME123", transactionId: 124 });
  assert.equal(parseOccasionFlutterwaveEvent(JSON.stringify({
    type: "transfer.disburse", data: { reference: "OCFLWSYNTHETIC001" },
  })), null);
  assert.throws(() => parseOccasionFlutterwaveEvent(JSON.stringify({
    event: "charge.completed", type: "transfer.disburse", data: { tx_ref: "OCFLWSYNTHETIC001" },
  })), /Conflicting webhook event aliases/);
  assert.throws(() => parseOccasionFlutterwaveEvent(JSON.stringify({
    type: "charge.completed", data: { tx_ref: "OCFLWSYNTHETIC001", reference: "FCO-OTHER" },
  })), /Conflicting webhook reference aliases/);
});
