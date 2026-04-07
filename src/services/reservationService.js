// src/services/reservationService.js
// ─────────────────────────────────────────────────────────────────
// Service de réservations NEXPOS
// Disponibilités · Créneaux · Confirmation SMS/email · Google · TheFork
// ─────────────────────────────────────────────────────────────────
import { prisma } from "../utils/prisma.js";
import { logger } from "../utils/logger.js";
import crypto     from "crypto";

// ─── CONFIGURATION DISPONIBILITÉS ────────────────────────────────

/**
 * Calcule les créneaux disponibles pour une date et un nombre de couverts.
 * Tient compte : capacité salle, tables déjà réservées, horaires d'ouverture.
 */
export async function getAvailableSlots(establishmentId, date, covers, duration = 90) {
  const config = await getOrCreateConfig(establishmentId);
  if (!config.acceptReservations) return { available: false, reason: "Réservations fermées", slots: [] };

  const dayOfWeek = new Date(date).getDay(); // 0=dim, 1=lun, …, 6=sam
  const dayConfig = config.schedule[dayOfWeek];

  if (!dayConfig?.open) {
    return { available: false, reason: "Établissement fermé ce jour", slots: [] };
  }

  // Générer les créneaux selon la config
  const slots = generateSlots(dayConfig.services, config.slotInterval, date);

  // Récupérer les réservations existantes pour cette date
  const dayStart = new Date(date); dayStart.setHours(0,0,0,0);
  const dayEnd   = new Date(date); dayEnd.setHours(23,59,59,999);

  const existing = await prisma.reservation.findMany({
    where: {
      establishmentId,
      status:  { in: ["CONFIRMED","PENDING","SEATED"] },
      date:    { gte: dayStart, lte: dayEnd },
    },
    select: { date: true, covers: true, duration: true, tableId: true },
  });

  // Tables disponibles
  const tables = await prisma.table.findMany({
    where: { establishmentId, active: true },
    select: { id: true, covers: true, section: true },
  });

  const maxCapacity = tables.reduce((s, t) => s + t.covers, 0);

  // Pour chaque créneau, calculer la disponibilité
  const slotsWithAvail = slots.map(slot => {
    const slotStart = new Date(`${date}T${slot}:00`);
    const slotEnd   = new Date(slotStart.getTime() + duration * 60000);

    // Couverts déjà réservés pendant ce créneau
    const occupiedCovers = existing
      .filter(r => {
        const rStart = new Date(r.date);
        const rEnd   = new Date(rStart.getTime() + r.duration * 60000);
        return rStart < slotEnd && rEnd > slotStart;
      })
      .reduce((s, r) => s + r.covers, 0);

    const remaining = maxCapacity - occupiedCovers;
    const available = remaining >= covers &&
      (config.maxAdvanceDays === null || daysBetween(new Date(), new Date(date)) <= config.maxAdvanceDays);

    return {
      time:       slot,
      available,
      remaining:  Math.max(0, remaining),
      capacity:   maxCapacity,
    };
  });

  const hasAny = slotsWithAvail.some(s => s.available);
  return {
    date,
    covers,
    available: hasAny,
    slots: slotsWithAvail,
    closedReason: hasAny ? null : "Complet pour cette date",
  };
}

/**
 * Crée une réservation après validation des disponibilités.
 */
export async function createReservation(data) {
  const {
    establishmentId, firstName, lastName, phone, email,
    covers, date, duration = 90, notes, allergyNotes,
    occasion, source = "online", customerId,
  } = data;

  // Vérifier disponibilité
  const dateStr = new Date(date).toISOString().slice(0, 10);
  const { slots } = await getAvailableSlots(establishmentId, dateStr, covers, duration);
  const timeStr   = new Date(date).toTimeString().slice(0, 5);
  const slot      = slots.find(s => s.time === timeStr);

  if (!slot?.available) {
    throw new Error(`Créneau ${timeStr} indisponible pour ${covers} couverts`);
  }

  // Trouver une table adaptée (optionnel — attribution manuelle possible)
  const table = await findBestTable(establishmentId, date, covers, duration);

  const config = await getOrCreateConfig(establishmentId);

  const reservation = await prisma.reservation.create({
    data: {
      establishmentId,
      customerId:    customerId || null,
      firstName:     firstName.trim(),
      lastName:      lastName.trim(),
      phone:         phone.trim(),
      email:         email?.trim() || null,
      covers,
      date:          new Date(date),
      duration,
      tableId:       table?.id || null,
      notes:         notes       || null,
      allergyNotes:  allergyNotes || null,
      occasion:      occasion     || null,
      source,
      status:        config.autoConfirm ? "CONFIRMED" : "PENDING",
    },
    include: { table: { select: { label: true } }, establishment: true },
  });

  // Envoyer confirmation
  if (config.sendConfirmation) {
    await sendConfirmation(reservation);
  }

  logger.info(`[Reservations] Nouvelle réservation: ${firstName} ${lastName} — ${covers} couverts le ${new Date(date).toLocaleDateString("fr-FR")}`);
  return reservation;
}

/**
 * Confirme une réservation en attente.
 */
export async function confirmReservation(reservationId, userId) {
  const r = await prisma.reservation.update({
    where: { id: reservationId },
    data:  { status: "CONFIRMED" },
    include: { establishment: true },
  });
  await sendConfirmation(r);
  logger.info(`[Reservations] Confirmée: ${r.id} — ${r.firstName} ${r.lastName}`);
  return r;
}

/**
 * Annule une réservation avec notification.
 */
export async function cancelReservation(reservationId, reason, byCustomer = false) {
  const r = await prisma.reservation.update({
    where: { id: reservationId },
    data:  { status: "CANCELLED", notes: reason ? `Annulation: ${reason}` : null },
    include: { establishment: true },
  });
  if (r.phone || r.email) {
    await sendCancellationNotice(r, byCustomer);
  }
  logger.info(`[Reservations] Annulée: ${r.id} — ${byCustomer ? "par client" : "par établissement"}`);
  return r;
}

/**
 * Envoie un rappel SMS/email aux clients dont la réservation est dans X heures.
 */
export async function sendReminders(hoursAhead = 24) {
  const targetTime = new Date(Date.now() + hoursAhead * 3600000);
  const window     = new Date(Date.now() + (hoursAhead + 1) * 3600000);

  const reservations = await prisma.reservation.findMany({
    where: {
      status:          "CONFIRMED",
      reminderSent:    false,
      date:            { gte: targetTime, lte: window },
    },
    include: { establishment: true },
  });

  let sent = 0;
  for (const r of reservations) {
    await sendReminder(r, hoursAhead);
    await prisma.reservation.update({ where: { id: r.id }, data: { reminderSent: true } });
    sent++;
  }

  logger.info(`[Reservations] ${sent} rappels envoyés (J${hoursAhead === 24 ? "-1" : "-0"})`);
  return { sent };
}

// ─── TROUVER LA MEILLEURE TABLE ───────────────────────────────────
async function findBestTable(establishmentId, date, covers, duration) {
  const allTables = await prisma.table.findMany({
    where: { establishmentId, active: true },
    orderBy: { covers: "asc" },
  });

  const dateStart = new Date(date);
  const dateEnd   = new Date(dateStart.getTime() + duration * 60000);

  // Tables déjà occupées à ce moment
  const busyTableIds = (await prisma.reservation.findMany({
    where: {
      establishmentId,
      status: { in: ["CONFIRMED","SEATED","PENDING"] },
      date:   { lt: dateEnd },
      AND:    [{ date: { gte: new Date(dateStart.getTime() - 90 * 60000) } }],
    },
    select: { tableId: true },
  })).map(r => r.tableId).filter(Boolean);

  // Trouver la plus petite table qui convient
  return allTables.find(t => !busyTableIds.includes(t.id) && t.covers >= covers) || null;
}

// ─── GÉNÉRATION DES CRÉNEAUX ──────────────────────────────────────
function generateSlots(services, interval, date) {
  const slots = [];
  for (const service of services) {
    const [startH, startM] = service.start.split(":").map(Number);
    const [endH, endM]     = service.end.split(":").map(Number);
    const startMins = startH * 60 + startM;
    const endMins   = endH   * 60 + endM - interval; // Dernier créneau avant fermeture

    for (let m = startMins; m <= endMins; m += interval) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      slots.push(`${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}`);
    }
  }
  return slots;
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────
async function sendConfirmation(r) {
  const dateStr = new Date(r.date).toLocaleDateString("fr-FR", {
    weekday:"long", day:"numeric", month:"long",
  });
  const timeStr = new Date(r.date).toLocaleTimeString("fr-FR", {
    hour:"2-digit", minute:"2-digit",
  });
  const estab = r.establishment?.name || "le restaurant";
  const cancelToken = generateCancelToken(r.id);

  const smsText = `✅ Réservation confirmée chez ${estab} — ${r.covers} pers. le ${dateStr} à ${timeStr}. Annuler: ${process.env.BASE_URL || "https://reservation.nexpos.fr"}/cancel/${cancelToken}`;
  const emailSubject = `Confirmation de votre réservation chez ${estab}`;
  const emailHtml = buildConfirmationEmail(r, dateStr, timeStr, cancelToken);

  if (r.phone) await logSms(r.phone, smsText);
  if (r.email) await logEmail(r.email, emailSubject, emailHtml);

  await prisma.reservation.update({ where: { id: r.id }, data: { confirmationSent: true } });
}

async function sendReminder(r, hoursAhead) {
  const dateStr = new Date(r.date).toLocaleDateString("fr-FR", { weekday:"long", day:"numeric", month:"long" });
  const timeStr = new Date(r.date).toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });
  const estab   = r.establishment?.name || "le restaurant";
  const label   = hoursAhead >= 20 ? "demain" : "ce soir";
  const cancelToken = generateCancelToken(r.id);

  const smsText = `⏰ Rappel: votre réservation ${label} à ${timeStr} chez ${estab} — ${r.covers} pers. Annuler: ${process.env.BASE_URL}/cancel/${cancelToken}`;
  if (r.phone) await logSms(r.phone, smsText);
  if (r.email) {
    const emailHtml = buildReminderEmail(r, dateStr, timeStr, cancelToken);
    await logEmail(r.email, `Rappel: votre réservation ${label} chez ${estab}`, emailHtml);
  }
}

async function sendCancellationNotice(r, byCustomer) {
  const estab = r.establishment?.name || "le restaurant";
  const smsText = byCustomer
    ? `Votre réservation chez ${estab} a bien été annulée. À bientôt !`
    : `Votre réservation chez ${estab} a dû être annulée. Veuillez nous contacter pour plus d'information.`;
  if (r.phone) await logSms(r.phone, smsText);
}

function buildConfirmationEmail(r, dateStr, timeStr, cancelToken) {
  const estab = r.establishment?.name || "le restaurant";
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<div style="background:#111827;color:#fff;padding:24px;border-radius:12px;margin-bottom:20px">
  <h1 style="margin:0;font-size:22px">✅ Réservation confirmée</h1>
</div>
<p>Bonjour <strong>${r.firstName}</strong>,</p>
<p>Votre réservation chez <strong>${estab}</strong> est confirmée :</p>
<div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:16px 0">
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:6px 0;color:#666">Date</td><td style="font-weight:600">${dateStr}</td></tr>
    <tr><td style="padding:6px 0;color:#666">Heure</td><td style="font-weight:600">${timeStr}</td></tr>
    <tr><td style="padding:6px 0;color:#666">Couverts</td><td style="font-weight:600">${r.covers} personne${r.covers > 1 ? "s" : ""}</td></tr>
    ${r.allergyNotes ? `<tr><td style="padding:6px 0;color:#666">Allergies</td><td style="color:#ef4444">${r.allergyNotes}</td></tr>` : ""}
  </table>
</div>
${r.notes ? `<p><em>${r.notes}</em></p>` : ""}
<p>Besoin d'annuler ? <a href="${process.env.BASE_URL || "https://reservation.nexpos.fr"}/cancel/${cancelToken}" style="color:#4f7bff">Cliquez ici</a> (lien valable 48h avant la réservation).</p>
<p>À très bientôt,<br><strong>L'équipe ${estab}</strong></p>
</body></html>`;
}

function buildReminderEmail(r, dateStr, timeStr, cancelToken) {
  const estab = r.establishment?.name || "le restaurant";
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<h2>⏰ Rappel de votre réservation</h2>
<p>Bonjour <strong>${r.firstName}</strong>, nous vous rappelons votre réservation :</p>
<div style="background:#f3f4f6;border-radius:8px;padding:16px">
  <strong>${estab}</strong> — ${dateStr} à ${timeStr} — ${r.covers} couvert${r.covers > 1 ? "s" : ""}
</div>
<p style="margin-top:16px">Vous ne pouvez pas venir ? <a href="${process.env.BASE_URL}/cancel/${cancelToken}" style="color:#4f7bff">Annuler ma réservation</a></p>
</body></html>`;
}

function generateCancelToken(reservationId) {
  return crypto.createHmac("sha256", process.env.JWT_SECRET || "nexpos")
    .update(reservationId).digest("hex").slice(0, 16);
}

async function logSms(phone, text) {
  logger.info(`[SMS] → ${phone}: ${text.slice(0, 60)}...`);
  // Production: await twilio.messages.create({ to: phone, from: ..., body: text });
}

async function logEmail(to, subject, html) {
  logger.info(`[Email] → ${to}: ${subject}`);
  // Production: await brevo.sendEmail({ to:[{email:to}], subject, htmlContent: html });
}

// ─── CONFIG PAR DÉFAUT ────────────────────────────────────────────
async function getOrCreateConfig(establishmentId) {
  let config = await prisma.reservationConfig.findUnique({ where: { establishmentId } });
  if (!config) {
    config = await prisma.reservationConfig.create({
      data: {
        establishmentId,
        acceptReservations: true,
        autoConfirm:        true,
        sendConfirmation:   true,
        slotInterval:       30,
        minNoticeHours:     2,
        maxAdvanceDays:     30,
        maxCoversPerSlot:   20,
        schedule: {
          0: { open: false, services: [] },
          1: { open: true,  services: [{ start:"12:00", end:"14:30" },{ start:"19:00", end:"22:00" }] },
          2: { open: true,  services: [{ start:"12:00", end:"14:30" },{ start:"19:00", end:"22:00" }] },
          3: { open: true,  services: [{ start:"12:00", end:"14:30" },{ start:"19:00", end:"22:00" }] },
          4: { open: true,  services: [{ start:"12:00", end:"14:30" },{ start:"19:00", end:"22:00" }] },
          5: { open: true,  services: [{ start:"12:00", end:"14:30" },{ start:"19:00", end:"22:30" }] },
          6: { open: true,  services: [{ start:"12:00", end:"15:00" },{ start:"19:00", end:"22:30" }] },
        },
      },
    });
  }
  return config;
}

function daysBetween(d1, d2) {
  return Math.floor(Math.abs(d2 - d1) / 86400000);
}
