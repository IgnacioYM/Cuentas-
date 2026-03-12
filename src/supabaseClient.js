import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://buxdmnesgggtmzdsrtqw.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ1eGRtbmVzZ2dndG16ZHNydHF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNDE4NzksImV4cCI6MjA4ODcxNzg3OX0.C19nxqFKELOEpJr9qbl3gYSHA6CNjz9ZEIfL5NIhySc";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toISO = (d) => {
  if (!d) return null;
  const [day, mon, yr] = d.split("/");
  return `${yr}-${mon}-${day}`;
};

const fromISO = (d) => {
  if (!d) return "";
  const [yr, mon, day] = d.split("-");
  return `${day}/${mon}/${yr}`;
};

// App → Supabase
const toRow = (inv) => ({
  id: inv.id || undefined,
  numero: inv.numero || null,
  fecha: toISO(inv.fecha),
  proveedor: inv.proveedor,
  concepto: inv.concepto || null,
  activo: inv.activo || null,
  categoria: inv.categoria,
  cuantia: inv.cuantia || 0,
  iva: inv.iva || 0,
  otros: inv.otros || null,
  comentario: inv.comentario || null,
  notas_ia: inv.notas || null,
  archivo_origen: inv.archivo_origen || null,
});

// Supabase → App
const fromRow = (row) => ({
  id: row.id,
  numero: row.numero || "",
  fecha: fromISO(row.fecha),
  proveedor: row.proveedor,
  concepto: row.concepto || "",
  activo: row.activo || "",
  categoria: row.categoria,
  cuantia: parseFloat(row.cuantia) || 0,
  iva: parseFloat(row.iva) || 0,
  otros: row.otros ? parseFloat(row.otros) : null,
  comentario: row.comentario || "",
  notas: row.notas_ia || "",
  archivo_origen: row.archivo_origen || "",
});

// ─── Facturas CRUD ────────────────────────────────────────────────────────────

export async function fetchInvoices() {
  const { data, error } = await supabase
    .from("facturas")
    .select("*")
    .order("fecha", { ascending: true });
  if (error) { console.error("Supabase fetch error:", error); return null; }
  return data.map(fromRow);
}

export async function upsertInvoices(invoices) {
  const rows = invoices.map(toRow);
  const { data, error } = await supabase
    .from("facturas")
    .upsert(rows, { onConflict: "id" })
    .select();
  if (error) { console.error("Supabase upsert error:", error); return null; }
  return data.map(fromRow);
}

export async function updateSingleInvoice(inv) {
  const row = toRow(inv);
  const { data, error } = await supabase
    .from("facturas")
    .update(row)
    .eq("id", inv.id)
    .select();
  if (error) { console.error("Supabase update error:", error); return null; }
  return data.length > 0 ? fromRow(data[0]) : null;
}

export async function deleteInvoice(id) {
  const { error } = await supabase
    .from("facturas")
    .delete()
    .eq("id", id);
  if (error) { console.error("Supabase delete error:", error); return false; }
  return true;
}

export async function deleteAllInvoices() {
  const { error } = await supabase
    .from("facturas")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (error) { console.error("Supabase delete all error:", error); return false; }
  return true;
}

// ─── Gastos Financieros ───────────────────────────────────────────────────────

export async function fetchGastosFinancieros() {
  const { data, error } = await supabase
    .from("gastos_financieros")
    .select("*")
    .order("fecha", { ascending: true });
  if (error) { console.error("Supabase GF fetch error:", error); return null; }
  return data.map(row => ({
    id: row.id,
    date: fromISO(row.fecha),
    concept: row.concepto,
    account: row.cuenta,
    cat: row.categoria,
    sub: row.subcategoria || "",
    amount: parseFloat(row.importe) || 0,
  }));
}

export async function upsertGastosFinancieros(entries) {
  const rows = entries.map(e => ({
    id: e.id,
    fecha: toISO(e.date),
    concepto: e.concept,
    cuenta: e.account,
    categoria: e.cat,
    subcategoria: e.sub || null,
    importe: e.amount,
  }));
  const { error } = await supabase
    .from("gastos_financieros")
    .upsert(rows, { onConflict: "id" });
  if (error) { console.error("Supabase GF upsert error:", error); return false; }
  return true;
}

// ─── Escrituras ───────────────────────────────────────────────────────────────

export async function fetchEscrituras() {
  const { data, error } = await supabase
    .from("escrituras")
    .select("*")
    .order("fecha_firma", { ascending: true });
  if (error) { console.error("Supabase escrituras fetch error:", error); return null; }
  return data.map(row => ({
    id: row.id,
    activo: row.activo,
    tipo: row.tipo,
    fecha_firma: fromISO(row.fecha_firma),
    notaria: row.notaria || "",
    protocolo: row.protocolo || "",
    precio: parseFloat(row.precio_escritura) || 0,
    datos_extra: row.datos_extra || {},
    archivo_origen: row.archivo_origen || "",
  }));
}

export async function updateEscritura(esc) {
  const { data, error } = await supabase
    .from("escrituras")
    .update({
      activo: esc.activo,
      tipo: esc.tipo,
      fecha_firma: toISO(esc.fecha_firma),
      notaria: esc.notaria,
      protocolo: esc.protocolo,
      precio_escritura: esc.precio,
      datos_extra: esc.datos_extra,
      archivo_origen: esc.archivo_origen || null,
    })
    .eq("id", esc.id)
    .select();
  if (error) { console.error("Supabase escritura update error:", error); return null; }
  return data.length > 0 ? data[0] : null;
}

// ─── Movimientos Bancarios ────────────────────────────────────────────────────

export async function fetchMovimientosBancarios() {
  const { data, error } = await supabase
    .from("movimientos_bancarios")
    .select("*")
    .order("fecha", { ascending: false });
  if (error) { console.error("Supabase mov banco fetch error:", error); return null; }
  return data.map(row => ({
    id: row.id,
    fecha: fromISO(row.fecha),
    concepto: row.concepto,
    importe: parseFloat(row.importe) || 0,
    saldo: parseFloat(row.saldo) || 0,
    cuenta: row.cuenta,
    tipo: row.tipo || "otro",
    orden: row.orden || 0,
    factura_id: row.factura_id || null,
    contrapartida_id: row.contrapartida_id || null,
    notas: row.notas || "",
  }));
}

export async function upsertMovimientosBancarios(movimientos) {
  const rows = movimientos.map(m => ({
    id: m.id,
    fecha: toISO(m.fecha),
    concepto: m.concepto,
    importe: m.importe,
    saldo: m.saldo,
    cuenta: m.cuenta,
    tipo: m.tipo || "otro",
    orden: m.orden || 0,
    factura_id: m.factura_id || null,
    contrapartida_id: m.contrapartida_id || null,
    notas: m.notas || null,
  }));
  // Upsert in batches of 500 to avoid payload limits
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase
      .from("movimientos_bancarios")
      .upsert(batch, { onConflict: "id" });
    if (error) { console.error("Supabase mov banco upsert error:", error); return false; }
  }
  return true;
}

export async function deleteAllMovimientosBancarios() {
  const { error } = await supabase
    .from("movimientos_bancarios")
    .delete()
    .neq("id", "---");
  if (error) { console.error("Supabase mov banco delete error:", error); return false; }
  return true;
}

// ─── File Storage (bucket: documentos) ────────────────────────────────────────

export async function uploadFile(file, path) {
  // path example: "facturas/2025-10/factura_arena_am.pdf"
  const { data, error } = await supabase.storage
    .from("documentos")
    .upload(path, file, {
      cacheControl: "3600",
      upsert: true,
    });
  if (error) { console.error("Storage upload error:", error); return null; }
  return data.path;
}

export async function getSignedUrl(path) {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from("documentos")
    .createSignedUrl(path, 3600); // 1 hour
  if (error) { console.error("Storage signed URL error:", error); return null; }
  return data.signedUrl;
}
