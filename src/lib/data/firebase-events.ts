import "server-only";
import { nanoid } from "nanoid";
import { adminDb } from "../firebase/admin";
import { buildSeed } from "./seed";
import { calculatePlatformFee } from "../monetization";
import type { EventGuest, EventTable, EventTicket, EventTicketType, GiftEvent, RsvpStatus } from "../types";
import type { CreateEventInput } from "./repo-types";
import { HttpError } from "./server-store";

const slugify = (name: string) =>
  `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event"}-${nanoid(6)}`;

function seedEvent(slug: string): GiftEvent | undefined {
  return buildSeed().events[slug];
}

function cleanText(value: string | undefined, fallback = "") {
  return (value ?? fallback).trim().replace(/\s+/g, " ");
}

function normalizeEvent(input: CreateEventInput, organizerId: string): GiftEvent {
  const celebrants = cleanText(input.celebrants);
  if (celebrants.length < 2) throw new Error("Celebrant name is required.");
  const title = cleanText(input.title, `${celebrants} Occasion`);
  const date = new Date(input.date);
  if (Number.isNaN(date.getTime())) throw new Error("Valid event date is required.");
  return {
    id: nanoid(),
    slug: slugify(title || celebrants),
    organizerId,
    organizerName: cleanText(input.organizerName, "Occasion host"),
    type: input.type,
    title,
    celebrants,
    date: date.toISOString(),
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    story: input.story,
    gradient: input.gradient,
    currency: input.currency,
    showTotal: input.showTotal,
    goalAmount: input.goalAmount,
    campaignMode: input.campaignMode,
    maxContribution: input.maxContribution,
    settlementAccount: input.settlementAccount,
    payoutProvider: input.payoutProvider,
    revenuePlan: input.revenuePlan ?? "starter",
    isPublic: input.isPublic,
    ticketingEnabled: input.ticketingEnabled,
    rsvpEnabled: input.rsvpEnabled,
    seatingEnabled: input.seatingEnabled,
    checkInEnabled: input.checkInEnabled,
    ticketTypes: input.ticketTypes ?? [],
    tables: input.tables ?? [],
    guests: input.guests ?? [],
    tickets: input.tickets ?? [],
    contributions: [],
    createdAt: new Date().toISOString(),
  };
}

export async function createFirebaseEvent(input: CreateEventInput, organizerId: string): Promise<GiftEvent> {
  const event = normalizeEvent(input, organizerId);
  await adminDb().collection<GiftEvent>("events").doc(event.slug).set(event);
  return event;
}

export async function getFirebaseEvent(slug: string): Promise<GiftEvent | undefined> {
  const snap = await adminDb().collection<GiftEvent>("events").doc(slug).get();
  return snap.data() ?? seedEvent(slug);
}

export async function listFirebaseEvents(limit = 25): Promise<GiftEvent[]> {
  const snap = await adminDb().collection<GiftEvent>("events").orderBy("createdAt", "desc").limit(limit).get();
  const events = snap.docs.map((doc) => doc.data());
  const seed = seedEvent("tunde-and-zainab");
  if (seed && !events.some((event) => event.slug === seed.slug)) events.push(seed);
  return events;
}

async function saveEvent(event: GiftEvent) {
  await adminDb().collection<GiftEvent>("events").doc(event.slug).set(event);
  return event;
}

async function requireEvent(slug: string): Promise<GiftEvent> {
  const event = await getFirebaseEvent(slug);
  if (!event) throw new HttpError(404, "Event not found");
  return event;
}

function ticketType(event: GiftEvent, ticketTypeId: string): EventTicketType {
  const type = event.ticketTypes?.find((t) => t.id === ticketTypeId && t.active);
  if (!type) throw new HttpError(400, "Ticket type not available.");
  if (type.sold >= type.quantity) throw new HttpError(409, "This ticket type is sold out.");
  return type;
}

function firstTable(event: GiftEvent): EventTable | undefined {
  return event.tables?.find((t) => (t.assignedGuestIds?.length ?? 0) < t.capacity);
}

export async function rsvpToEvent(slug: string, input: { name: string; email?: string; phone?: string; plusOnes?: number; status?: RsvpStatus; notes?: string; tableId?: string }): Promise<{ event: GiftEvent; guest: EventGuest; passUrl: string }> {
  const event = await requireEvent(slug);
  const name = cleanText(input.name);
  if (name.length < 2) throw new HttpError(400, "Guest name is required.");
  if (input.tableId && !(event.tables ?? []).some((table) => table.id === input.tableId)) {
    throw new HttpError(400, "Selected table does not exist.");
  }
  const guest: EventGuest = {
    id: `guest_${nanoid(10)}`,
    name,
    email: input.email?.trim() || undefined,
    phone: input.phone?.trim() || undefined,
    rsvpStatus: input.status ?? "yes",
    plusOnes: Math.max(0, Math.min(10, Number(input.plusOnes) || 0)),
    inviteCode: `INV-${nanoid(8).toUpperCase()}`,
    tableId: input.tableId,
    notes: input.notes?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  const guests = [guest, ...(event.guests ?? [])];
  let tables = event.tables ?? [];
  const targetTableId = input.tableId || firstTable(event)?.id;
  if (targetTableId) {
    guest.tableId = targetTableId;
    tables = tables.map((table) => table.id === targetTableId && !table.assignedGuestIds.includes(guest.id)
      ? { ...table, assignedGuestIds: [...table.assignedGuestIds, guest.id] }
      : table);
  }
  const updated = await saveEvent({ ...event, guests, tables });
  return { event: updated, guest, passUrl: `/event/${slug}/pass/${guest.inviteCode}` };
}

export async function purchaseTicket(slug: string, input: { ticketTypeId: string; buyerName: string; buyerEmail?: string; quantity?: number; tableId?: string }): Promise<{ event: GiftEvent; ticket: EventTicket; guests: EventGuest[] }> {
  const event = await requireEvent(slug);
  const buyerName = cleanText(input.buyerName);
  if (buyerName.length < 2) throw new HttpError(400, "Ticket holder name is required.");
  if (!cleanText(input.ticketTypeId)) throw new HttpError(400, "Ticket type is required.");
  if (input.tableId && !(event.tables ?? []).some((table) => table.id === input.tableId)) {
    throw new HttpError(400, "Selected table does not exist.");
  }
  const type = ticketType(event, input.ticketTypeId);
  const quantity = Math.max(1, Math.min(20, Number(input.quantity) || 1));
  if (type.sold + quantity > type.quantity) throw new HttpError(409, "Not enough tickets left.");
  const qrCode = `OCC-${slug}-${nanoid(14)}`;
  const grossAmount = type.price * quantity;
  const fee = calculatePlatformFee(grossAmount, "tickets", event.revenuePlan, type.currency);
  const ticket: EventTicket = {
    id: `ticket_${nanoid(10)}`,
    eventSlug: slug,
    ticketTypeId: type.id,
    buyerName,
    buyerEmail: input.buyerEmail?.trim() || undefined,
    quantity,
    totalAmount: grossAmount,
    platformFee: fee.platformFee,
    netAmount: fee.netAmount,
    currency: type.currency,
    status: type.price > 0 ? "pending_payment" : "paid",
    qrCode,
    tableId: input.tableId,
    guestIds: [],
    paymentReference: `ticket-${nanoid(10)}`,
    createdAt: new Date().toISOString(),
  };
  const guests: EventGuest[] = Array.from({ length: quantity }, (_, index) => ({
    id: `guest_${nanoid(10)}`,
    name: quantity === 1 ? ticket.buyerName : `${ticket.buyerName} ${index + 1}`,
    email: index === 0 ? ticket.buyerEmail : undefined,
    rsvpStatus: "approved",
    plusOnes: 0,
    tableId: input.tableId,
    inviteCode: `INV-${nanoid(8).toUpperCase()}`,
    ticketId: ticket.id,
    createdAt: new Date().toISOString(),
  }));
  ticket.guestIds = guests.map((g) => g.id);
  const ticketTypes = (event.ticketTypes ?? []).map((t) => t.id === type.id ? { ...t, sold: t.sold + quantity } : t);
  let tables = event.tables ?? [];
  if (input.tableId) {
    tables = tables.map((table) => table.id === input.tableId
      ? { ...table, assignedGuestIds: [...new Set([...table.assignedGuestIds, ...ticket.guestIds])] }
      : table);
  }
  const updated = await saveEvent({ ...event, ticketTypes, tickets: [ticket, ...(event.tickets ?? [])], guests: [...guests, ...(event.guests ?? [])], tables });
  return { event: updated, ticket, guests };
}

export async function checkInPass(slug: string, input: { code: string }): Promise<{ event: GiftEvent; status: "valid" | "already_used"; guest?: EventGuest; ticket?: EventTicket }> {
  const event = await requireEvent(slug);
  const code = cleanText(input.code);
  if (!code) throw new HttpError(400, "Pass code is required.");
  const ticket = event.tickets?.find((t) => t.qrCode === code || t.id === code);
  const guest = event.guests?.find((g) => g.inviteCode === code || g.id === code || (ticket?.guestIds ?? []).includes(g.id));
  if (!ticket && !guest) throw new HttpError(404, "Invalid pass code.");
  if (ticket?.checkedInAt || guest?.checkedInAt) return { event, status: "already_used", guest, ticket };
  const now = new Date().toISOString();
  const guests = (event.guests ?? []).map((g) => guest && g.id === guest.id ? { ...g, checkedInAt: now, rsvpStatus: "checked_in" as const } : g);
  const tickets = (event.tickets ?? []).map((t) => ticket && t.id === ticket.id ? { ...t, checkedInAt: now, status: "checked_in" as const } : t);
  const updated = await saveEvent({ ...event, guests, tickets });
  return { event: updated, status: "valid", guest: guests.find((g) => guest && g.id === guest.id), ticket: tickets.find((t) => ticket && t.id === ticket.id) };
}

export async function assignGuestToTable(slug: string, input: { guestId: string; tableId?: string }): Promise<{ event: GiftEvent; guest?: EventGuest }> {
  const event = await requireEvent(slug);
  const guestId = cleanText(input.guestId);
  if (!guestId) throw new HttpError(400, "Guest ID is required.");
  const existingGuest = (event.guests ?? []).find((guest) => guest.id === guestId);
  if (!existingGuest) throw new HttpError(404, "Guest not found.");
  const targetTable = input.tableId ? (event.tables ?? []).find((table) => table.id === input.tableId) : undefined;
  if (input.tableId && !targetTable) throw new HttpError(400, "Selected table does not exist.");
  if (targetTable && !targetTable.assignedGuestIds.includes(guestId) && targetTable.assignedGuestIds.length >= targetTable.capacity) {
    throw new HttpError(409, "Selected table is full.");
  }
  const guests = (event.guests ?? []).map((guest) => guest.id === guestId ? { ...guest, tableId: input.tableId } : guest);
  const tables = (event.tables ?? []).map((table) => ({
    ...table,
    assignedGuestIds: table.id === input.tableId
      ? [...new Set([...table.assignedGuestIds.filter((id) => id !== guestId), guestId])]
      : table.assignedGuestIds.filter((id) => id !== guestId),
  }));
  const updated = await saveEvent({ ...event, guests, tables });
  return { event: updated, guest: guests.find((guest) => guest.id === guestId) };
}
