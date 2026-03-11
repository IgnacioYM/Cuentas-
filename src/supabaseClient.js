import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://buxdmnesgggtmzdsrtqw.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ1eGRtbmVzZ2dndG16ZHNydHF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNDE4NzksImV4cCI6MjA4ODcxNzg3OX0.C19nxqFKELOEpJr9qbl3gYSHA6CNjz9ZEIfL5NIhySc";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Helpers para facturas ────────────────────────────────────────────────────

// Convierte DD/MM/YYYY → YYYY-MM-DD para Supabase
const toISO = (d) => {
  if (!d) return null;
  const [day, mon, yr] = d.split("/");
  return `${yr}-${mon}-${day}`;
};

// Convierte YYYY-MM-DD → DD/MM/YYYY para la app
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
});

// ─── CRUD ─────────────────────────────────────────────────────────────────────

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
    .neq("id", "00000000-0000-0000-0000-000000000000"); // delete all
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
