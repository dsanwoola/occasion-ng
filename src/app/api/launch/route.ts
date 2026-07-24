import { NextResponse } from "next/server";
import { REVENUE_PLANS, MONETIZATION_CHANNELS } from "@/lib/monetization";
import { isPaysureConfigured } from "@/lib/payments/paysure";
import { isFlutterwaveConfigured } from "@/lib/payments/flutterwave";

export async function GET() {
  const paystackConfigured = Boolean(process.env.PAYSTACK_SECRET_KEY?.trim());
  const paysureConfigured = isPaysureConfigured();
  const flutterwaveConfigured = isFlutterwaveConfigured();
  const flutterwaveMode = (process.env.FLUTTERWAVE_ENV || "unknown").trim().toLowerCase();
  const flutterwaveLive = flutterwaveConfigured && flutterwaveMode === "live";
  const livePaymentsEnabled = flutterwaveLive || paysureConfigured || paystackConfigured;
  const agentMailConfigured = Boolean(process.env.AGENTMAIL_API_KEY?.trim());
  const publicBaseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://occasion.ng";

  return NextResponse.json({
    launch: {
      app: "Occasion.ng",
      status: livePaymentsEnabled
        ? "ready_for_paid_pilot"
        : flutterwaveConfigured
          ? "ready_for_test_checkout_live_credentials_required"
          : "ready_for_free_launch_payment_setup_required",
      publicBaseUrl,
    },
    monetization: {
      plans: REVENUE_PLANS,
      channels: MONETIZATION_CHANNELS,
      paystackConfigured,
      paysureConfigured,
      flutterwaveConfigured,
      flutterwaveMode,
      testPaymentsEnabled: flutterwaveConfigured && !flutterwaveLive,
      activeCheckoutProvider: flutterwaveConfigured ? "flutterwave" : paysureConfigured ? "paysure" : paystackConfigured ? "paystack" : null,
      agentMailConfigured,
      livePaymentsEnabled,
      notes: flutterwaveConfigured && !flutterwaveLive
        ? ["Flutterwave test checkout is configured and can be exercised without real settlement. Live credentials are required before accepting real payments."]
        : flutterwaveLive
          ? ["Flutterwave live checkout is configured. Verify the production webhook and complete a low-value settlement test before public launch."]
        : paysureConfigured
        ? ["Paysure checkout is configured. Verify callback and webhook in Paysure before announcing live paid events."]
        : paystackConfigured
          ? ["Paystack secret is configured. Verify callback and webhook in Paystack before announcing live paid events."]
          : ["No checkout provider secret is configured, so paid checkout is blocked until provider credentials are added."],
    },
    checklist: [
      { item: "Firebase App Hosting deployment", status: "done" },
      { item: "Custom domain backend cutover", status: "pending_giftcash_acceptance" },
      { item: "Firestore server datastore", status: "configured" },
      { item: "Firebase Auth authorized domains", status: "done" },
      { item: "Pricing and fee model", status: "done" },
      { item: "Paysure checkout credentials", status: paysureConfigured ? "done" : "blocked" },
      { item: "Paysure callback verification", status: "implemented" },
      { item: "Paysure webhook server-side verification", status: "implemented" },
      { item: "Paystack server secret", status: paystackConfigured ? "done" : "optional" },
      { item: "Paystack webhook signature verification", status: "implemented" },
      { item: "Bank-alert reconciliation", status: agentMailConfigured ? "configured" : "optional_not_configured" },
    ],
  });
}
