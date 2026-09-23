import crypto from "node:crypto";

const MAX_RELAY_SKEW_MS = 5 * 60 * 1000;

export interface OccasionFlutterwaveEvent {
  eventName: "charge.completed" | "charge.successful" | "charge.success";
  reference: string;
  transactionId?: string | number;
}

function safeEqualBase64(expected: string, actual: string | null): boolean {
  if (!actual || actual.length > 512) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

export function createFoodCardRelaySignature(rawBody: string, timestamp: string, secret: string): string {
  if (!/^\d{13}$/.test(timestamp) || secret.length < 32) return "";
  return crypto.createHmac("sha256", secret).update(timestamp).update(".").update(rawBody).digest("base64");
}

export function verifyFoodCardRelaySignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!timestamp || !/^\d{13}$/.test(timestamp) || !secret || secret.length < 32) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > MAX_RELAY_SKEW_MS) return false;
  const expected = createFoodCardRelaySignature(rawBody, timestamp, secret);
  return safeEqualBase64(expected, signature);
}

export function parseOccasionFlutterwaveEvent(rawBody: string): OccasionFlutterwaveEvent | null {
  if (rawBody.length === 0 || Buffer.byteLength(rawBody, "utf8") > 256_000) throw new Error("Invalid webhook body");
  const parsed = JSON.parse(rawBody) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid webhook body");
  const value = parsed as Record<string, unknown>;
  const eventAlias = typeof value.event === "string" ? value.event : undefined;
  const typeAlias = typeof value.type === "string" ? value.type : undefined;
  if (eventAlias && typeAlias && eventAlias !== typeAlias) throw new Error("Conflicting webhook event aliases");
  const eventName = eventAlias ?? typeAlias;
  if (eventName !== "charge.completed" && eventName !== "charge.successful" && eventName !== "charge.success") return null;
  if (value.data === null || typeof value.data !== "object" || Array.isArray(value.data)) throw new Error("Missing webhook data");
  const data = value.data as Record<string, unknown>;
  const txReference = typeof data.tx_ref === "string" ? data.tx_ref.toUpperCase() : undefined;
  const referenceAlias = typeof data.reference === "string" ? data.reference.toUpperCase() : undefined;
  if (txReference && referenceAlias && txReference !== referenceAlias) throw new Error("Conflicting webhook reference aliases");
  const reference = txReference ?? referenceAlias;
  if (!reference?.startsWith("OCFLW")) return null;
  const transactionId = typeof data.id === "string" || typeof data.id === "number" ? data.id : undefined;
  return { eventName, reference, transactionId };
}
