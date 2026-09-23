import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { confirmFlutterwaveEventPayment } from "@/lib/payments/flutterwave-event-payments";
import { verifyFlutterwaveSignature } from "@/lib/payments/flutterwave";
import { parseOccasionFlutterwaveEvent, verifyFoodCardRelaySignature } from "@/lib/payments/flutterwave-relay";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/data/server-store";

async function quarantinePermanentRejection(rawBody: string, eventName: string, reference: string, status: number) {
  const rejectionId = crypto.createHash("sha256").update(rawBody).digest("hex");
  await adminDb().collection("payment_webhook_rejections").doc(rejectionId).set({
    provider: "flutterwave",
    eventName,
    reference,
    reasonCode: `HTTP_${status}`,
    rejectedAt: new Date().toISOString(),
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    provider: "flutterwave",
    endpoint: "/api/payments/flutterwave/webhook",
  });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const providerAuthenticated = verifyFlutterwaveSignature(raw, req.headers.get("flutterwave-signature"));
  const relayAuthenticated = verifyFoodCardRelaySignature(
    raw,
    req.headers.get("x-foodcard-relay-timestamp"),
    req.headers.get("x-foodcard-relay-signature"),
    process.env.OCCASION_FLUTTERWAVE_RELAY_SECRET?.trim(),
  );
  if (!providerAuthenticated && !relayAuthenticated) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = parseOccasionFlutterwaveEvent(raw);
  if (!event) return NextResponse.json({ received: true, status: "ignored" });
  try {
    await confirmFlutterwaveEventPayment(event.reference, { transactionId: event.transactionId });
  } catch (error) {
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
      await quarantinePermanentRejection(raw, event.eventName, event.reference, error.status);
      return NextResponse.json({ received: true, status: "rejected_permanent" });
    }
    throw error;
  }
  return NextResponse.json({ received: true, status: "processed" });
}
