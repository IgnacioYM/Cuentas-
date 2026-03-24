import { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import { fetchInvoices, upsertInvoices, deleteInvoice, deleteAllInvoices, updateSingleInvoice, fetchGastosFinancieros, upsertGastosFinancieros, deleteAllGastosFinancieros, fetchEscrituras, fetchMovimientosBancarios, upsertMovimientosBancarios, deleteAllMovimientosBancarios, uploadFile, getSignedUrl, fetchConciliaciones, upsertConciliaciones, deleteConciliacion, deleteAllConciliaciones, updateFacturaEstado } from "./supabaseClient";
import DashboardTab from "./DashboardTab";
import { ESCRITURAS } from "./escrituras";
import { generarSugerencias, resumenConciliacion } from "./reconciliacion";

// ─── Clasificación Gastos Financieros ─────────────────────────────────────────
const RULES = [
  { match: /LIQUIDACION CTA\.?CTO/i, cat: "G. Financiero – Póliza",   sub: "Intereses póliza" },
  { match: /MANTENIMIENTO/i,         cat: "G. Financiero – Póliza",   sub: "Mantenimiento" },
  { match: /ADMINISTRACI[OÓ]N DEP/i, cat: "G. Financiero – Póliza",   sub: "Administración depósito" },
  { match: /PRECIO ED\.? EXTRACTO/i, cat: "G. Financiero – Póliza",   sub: "Precio extracto" },
  { match: /F0000005620267/i,        cat: "G. Financiero – Póliza",   sub: "Comisión apertura" },
  { match: /^PRES\./i,               cat: "G. Financiero – Préstamo", sub: "Intereses préstamo" },
  { match: /SEGUR.*CAIXA/i,         cat: "G. Financiero – Préstamo", sub: "Seguro vinculado" },
  { match: /MYBOX/i,                 cat: "G. Financiero – Póliza",   sub: "Fidelización MYBOX" },
  { match: /SEVIAM/i,                cat: "G. Financiero – Préstamo", sub: "Fidelización SEVIAM" },
];

const classify = (c) => {
  for (const r of RULES) if (r.match.test(c)) return { cat: r.cat, sub: r.sub };
  return null;
};

function parseCSV(text, account) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const sep = lines[0]?.includes("\t") ? "\t" : ";";
  return lines.flatMap(line => {
    const p = line.split(sep);
    if (p.length < 3) return [];
    const concept = p[0].trim(), dateRaw = p[1].trim();
    const amount = parseFloat(p[2].replace("EUR","").replace(/\./g,"").replace(",",".").trim());
    if (isNaN(amount) || concept.toLowerCase() === "concepto" || amount >= 0) return [];
    const cls = classify(concept);
    if (!cls) return [];
    return [{ id: `${account}-${dateRaw}-${concept}-${amount}`, date: dateRaw, concept, account, amount, cat: cls.cat, sub: cls.sub }];
  });
}

function parseXLSX(buffer, account) {
  try {
    const wb = XLSX.read(buffer, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, dateNF: "DD/MM/YYYY" });
    return rows.flatMap(row => {
      if (!row || row.length < 3) return [];
      const concept = String(row[0]||"").trim(), dateRaw = String(row[1]||"").trim();
      const amount = parseFloat(String(row[2]||"").replace("EUR","").replace(/\./g,"").replace(",",".").trim());
      if (isNaN(amount) || concept.toLowerCase() === "concepto" || amount >= 0) return [];
      const cls = classify(concept);
      if (!cls) return [];
      return [{ id: `${account}-${dateRaw}-${concept}-${amount}`, date: dateRaw, concept, account, amount, cat: cls.cat, sub: cls.sub }];
    });
  } catch { return []; }
}

// ─── Clasificación Movimientos Bancarios ─────────────────────────────────────
const BANK_TYPES = {
  aportacion:       { label: "Aportación",    color: "#4ade80", bg: "#052e16" },
  deposito:         { label: "Depósito",       color: "#a78bfa", bg: "#1e1b4b" },
  prestamo:         { label: "Préstamo",       color: "#c084fc", bg: "#2e1065" },
  transferencia:    { label: "Traspaso",       color: "#38bdf8", bg: "#0c4a6e" },
  gasto_financiero: { label: "G. Financiero",  color: "#8b5cf6", bg: "#1e1b4b" },
  pago_factura:     { label: "Pago factura",   color: "#60a5fa", bg: "#0f2942" },
  tributos:         { label: "Tributos",       color: "#fb923c", bg: "#431407" },
  comision:         { label: "Comisión banco", color: "#94a3b8", bg: "#1e293b" },
  compraventa:      { label: "Compraventa",    color: "#f87171", bg: "#450a0a" },
  devolucion:       { label: "Reembolso",      color: "#fbbf24", bg: "#422006" },
  fianza:           { label: "Fianza",         color: "#2dd4bf", bg: "#042f2e" },
  arras:            { label: "Arras",          color: "#f472b6", bg: "#500724" },
  otro:             { label: "Otro",           color: "#64748b", bg: "#1e293b" },
};

const BANK_RULES = [
  // Aportaciones de socios
  { match: /TRANSF\. A SU FAVOR/i,    tipo: "aportacion" },
  { match: /TRANSFER\. EN DIV/i,      tipo: "aportacion" },
  { match: /TRANSFER INMEDIATA/i,     tipo: "aportacion" },
  // Depósito pignorado
  { match: /CONST\. AHORRO PLAZO/i,   tipo: "deposito" },
  { match: /CANCEL\.AHORRO PLAZO/i,   tipo: "deposito" },
  // Préstamo
  { match: /CANCELAC\.PRESTAMO/i,     tipo: "prestamo" },
  { match: /CONSTIT\. PRESTAMO/i,     tipo: "prestamo" },
  // Transferencias internas
  { match: /TRASPASO/i,               tipo: "transferencia" },
  // Gastos financieros
  { match: /LIQUIDACION CTA\.?CTO/i,  tipo: "gasto_financiero" },
  { match: /MANTENIMIENTO/i,          tipo: "gasto_financiero" },
  { match: /ADMINISTRACI[OÓ]N DEP/i,  tipo: "gasto_financiero" },
  { match: /PRECIO ED\. EXTRACTO/i,   tipo: "gasto_financiero" },
  { match: /^PRES\.\d/i,              tipo: "gasto_financiero" },
  { match: /SEGUR.*CAIXA/i,           tipo: "gasto_financiero" },
  { match: /RECIBO UNICO MYBOX/i,     tipo: "gasto_financiero" },
  { match: /SEVIAM/i,                 tipo: "gasto_financiero" },
  { match: /F0000005620267/i,         tipo: "gasto_financiero" },
  // Reembolsos personales
  { match: /Devolucion gastos/i,      tipo: "devolucion" },
  { match: /Pago con cuenta p/i,      tipo: "devolucion" },
  // Tributos
  { match: /^TRIBUTOS$/i,             tipo: "tributos" },
  { match: /I\.R\.P\.F/i,             tipo: "tributos" },
  // Comisiones bancarias
  { match: /PRECIO ABONO TRF/i,      tipo: "comision" },
  { match: /PRECIO TRF\.REC/i,       tipo: "comision" },
  { match: /P\.SERV\.CERTIF/i,       tipo: "comision" },
  { match: /P\.SERV\. TRF/i,         tipo: "comision" },
  { match: /SERV\.RECEP\.TRANSF/i,   tipo: "comision" },
  { match: /SERV\. TRF URGENTE/i,    tipo: "comision" },
  { match: /SERV\.CONST\.FIANZA/i,   tipo: "comision" },
  // Fianzas
  { match: /CONSTITUCION FIANZA/i,   tipo: "fianza" },
  { match: /LIBERACION FIANZA/i,     tipo: "fianza" },
  { match: /^Fianzas/i,              tipo: "fianza" },
  // Compraventas
  { match: /Compraventa/i,           tipo: "compraventa" },
  { match: /CHEQUE BANCA/i,          tipo: "compraventa" },
  { match: /CH-\d+-\d+/i,            tipo: "compraventa" },
  { match: /CG-\d+-\d+/i,            tipo: "compraventa" },
  // Arras
  { match: /ARRAS/i,                 tipo: "arras" },
  // Pagos de facturas (genérico — va al final)
  { match: /Anticipos/i,             tipo: "pago_factura" },
  { match: /^Factura/i,              tipo: "pago_factura" },
  { match: /^FACTURA/i,              tipo: "pago_factura" },
  { match: /ALZAI/i,                 tipo: "pago_factura" },
  { match: /Indemnizacion/i,         tipo: "pago_factura" },
  { match: /C\.A\. MADRID/i,         tipo: "pago_factura" },
  { match: /BUILDING CENTER/i,       tipo: "pago_factura" },
  { match: /^PR1 \//i,               tipo: "pago_factura" },
  { match: /^L \/ \d+/i,             tipo: "pago_factura" },
  { match: /^802174R/i,              tipo: "pago_factura" },
  { match: /^0000\d+ PRO/i,          tipo: "pago_factura" },
  { match: /Factura.* ZL/i,          tipo: "pago_factura" },
];

const classifyBank = (concepto) => {
  for (const r of BANK_RULES) if (r.match.test(concepto)) return r.tipo;
  return "otro";
};

const parseBankAmount = (str) =>
  parseFloat((str || "").replace(/EUR/gi, "").replace(/\./g, "").replace(",", ".").trim());

function parseBankCSV(text, account) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(1).map((line, idx) => {
    const p = line.split(";");
    if (p.length < 4) return null;
    const concepto = p[0].trim();
    const fecha = p[1].trim();
    const importe = parseBankAmount(p[2]);
    const saldo = parseBankAmount(p[3]);
    if (isNaN(importe) || !concepto || !fecha) return null;
    const tipo = classifyBank(concepto);
    const id = `bk-${account}-${fecha.replace(/\//g, "")}-${importe.toFixed(2)}-${saldo.toFixed(2)}`;
    return { id, fecha, concepto, importe, saldo, cuenta: account, tipo, orden: idx, factura_id: null, contrapartida_id: null, notas: "" };
  }).filter(Boolean);
}

function parseBankXLSX(buffer, account) {
  try {
    const wb = XLSX.read(buffer, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
    return rows.slice(1).map((row, idx) => {
      if (!row || row.length < 4) return null;
      const concepto = String(row[0] || "").trim();
      const fecha = String(row[1] || "").trim();
      const importe = parseBankAmount(String(row[2] || ""));
      const saldo = parseBankAmount(String(row[3] || ""));
      if (isNaN(importe) || !concepto || !fecha) return null;
      const tipo = classifyBank(concepto);
      const id = `bk-${account}-${fecha.replace(/\//g, "")}-${importe.toFixed(2)}-${saldo.toFixed(2)}`;
      return { id, fecha, concepto, importe, saldo, cuenta: account, tipo, orden: idx, factura_id: null, contrapartida_id: null, notas: "" };
    }).filter(Boolean);
  } catch { return []; }
}

// ─── Constantes ───────────────────────────────────────────────────────────────
const CAT_COLORS = {
  "G. Financiero – Póliza":   { bg: "#0f2942", accent: "#3b82f6" },
  "G. Financiero – Préstamo": { bg: "#1a1a2e", accent: "#8b5cf6" },
};
const ACTIVOS = ["AN","FMM3","PR30","BB5","PB27","E65","M1","AG55"];
const CATEGORIAS = [
  "Costes de implementación (SPV, abogados, etc.)",
  "Opex",
  "Adquisición (incluye gastos e impuestos)",
  "Capex",
  "Comisión de gestión",
  "Costes legales",
  "Costes de posesión",
];
const SYSTEM_PROMPT = `Eres un asistente contable de Arena Nexus S.L., empresa de inversión inmobiliaria española.

═══ ACTIVOS ═══
AN = sociedad holding Arena Nexus S.L.
FMM3 = Francesc Martí Mora 3 / Francesc Martí i Mora 3, Palma (también: C/ Francesc Marti Mora, Carrer Francesc Martí Mora, M. Mora) — precio adquisición 180.000€, vendedor Cerberus
PR30 = Pascual Ribot 30 / Pasqual Ribot 30, Palma (también: C/ Pascual Ribot, Carrer Pasqual Ribot) — precio adquisición 205.000€, vendedor Cerberus
BB5 = Barrera de Baix 5, Palma (también: C/ Barrera de Baix, Carrer de la Barrera de Baix, Barrera d'Abaix, Barrera d'Abaix nº5) — precio adquisición 180.000€, familia vendedora (Pilar Sánchez Trullas)
PB27 = Padre Bartolomé 27 / Paul Bouvy 27 / Pau Bouvy 27 / Pare Bartomeu 27, Palma (también: C/ Padre Bartolomé Salva, Carrer Pare Bartomeu) — precio adquisición 325.000€, Servihabitat
E65 = Elfo 65, Ciudad Lineal, Madrid — precio adquisición 165.000€, vendedor Cerberus/Buildingcenter
M1 = Molino 1, Villanueva de la Cañada, Madrid — precio adquisición 179.000€, vendedor Cerberus/Buildingcenter
AG55 = Alfonso Gómez 55, San Blas, Madrid — precio adquisición 279.650€, vendedor Cerberus/Buildingcenter

═══ CATEGORÍAS ═══
"Costes de implementación (SPV, abogados, etc.)"
"Opex"
"Adquisición (incluye gastos e impuestos)"
"Capex"
"Comisión de gestión"
"Costes legales"
"Costes de posesión"

═══ TIPOS DE DOCUMENTO ═══
Procesa TODOS estos tipos:
- Facturas estándar y facturas simplificadas (tickets de compra, recibos TPV)
- Justificantes de pago telemático de ayuntamientos o consejos insulares
- Autoliquidaciones de impuestos municipales (ICIO, tasas urbanísticas)
- Documentos de indemnización firmados (acuerdos de compensación)
- Minutas de honorarios de notarías
- Facturas de burofax (Correos)
- ESCRITURAS DE COMPRAVENTA DE INMUEBLES
- Autoliquidaciones de ITP (Impuesto de Transmisiones Patrimoniales) — Modelo 600
- Depósitos de fianzas de arrendamiento — Modelo 251
NO ignores ningún documento por no tener formato de factura estándar.

═══ ESCRITURAS DE COMPRAVENTA ═══
Si el documento es una ESCRITURA de compraventa (no una factura de notaría, sino la propia escritura):
- fecha: fecha de firma de la escritura
- proveedor: nombre del vendedor tal como aparece
- concepto: "Compraventa [dirección completa del inmueble]"
- activo: código según inmueble por dirección y precio:
    · Barrera de Baix / Barrera d'Abaix, Palma (~180.000€, vendedora Pilar Sánchez) → BB5
    · Francesc Martí Mora, Palma (~180.000€, Promontoria/Cerberus) → FMM3
    · Pascual Ribot, Palma (~205.000€, Promontoria/Cerberus) → PR30
    · Pau Bouvy / Padre Bartolomé, Palma (~325.000€, Verde Iberia/Servihabitat) → PB27
    · Elfo 65, Madrid (~165.000€, Buildingcenter) → E65
    · Molino 1, Villanueva de la Cañada (~179.000€, Buildingcenter) → M1
    · Alfonso Gómez 55, Madrid (~279.650€, Buildingcenter) → AG55
    · Si una escritura incluye VARIOS inmuebles → dejar activo VACÍO, notas: "CV múltiples inmuebles — usar split"
- categoria: "Adquisición (incluye gastos e impuestos)"
- cuantia: precio de compraventa exacto de la escritura
- iva: 0 (las compraventas de segunda mano no llevan IVA, llevan ITP aparte)
- otros: 0
- notas: "Escritura: Notaría [nombre], protocolo [nº]. Ref catastral: [ref]. Superficie: [m²]m²"

═══ REGLAS POR PROVEEDOR ═══

FERRETERÍA LA CENTRAL / LA CENTRAL DE SAN MAGIN:
- Por defecto → BB5, Capex (material de obra)
- EXCEPCIÓN: si hay anotación manuscrita indicando otro activo (ej: "AN" escrito a mano), usar ese activo
- Si anotación manuscrita "AN" → AN, Capex

ARENA ASSET MANAGEMENT / ARENA AM / Arena Asset Management S.L.:
- Siempre → AN, Comisión de gestión
- Sin retención, sin IRPF
- cuantia = base imponible, iva = 21% de la base

ALZAI / ALZAI ALSP SL:
- Gestoría mensual (base ~150€, sin otro concepto especial) → AN, Opex
- Si el concepto incluye "Mod 600", "Modelo 600", "Presentación Modelo" o la base total ≥500€ → AN, Costes de implementación (SPV, abogados, etc.)

AIREUROPA / AIR EUROPA:
- Siempre → AN, Opex
- CRÍTICO: usar EXCLUSIVAMENTE "Total a Pagar / Amount to be Pay in EUR" como importe real
- iva = solo la suma de impuestos al 10% (IVA 10%). NO incluir el IVA 21% de tasas en el campo iva.
  Ejemplo: IVA 10% = 12,78 + 1,28 = 14,06€ → iva = 14,06
- cuantia = Total a Pagar - iva. Ejemplo: 92,46 - 14,06 = 78,40€
- IGNORAR "Total Factura" (ej: 288,21€) — es antes del descuento residente

CONSELL DE MALLORCA:
- Taxa residus demolició / fiança residuos → BB5, Capex
- Sin IVA. cuantia = Total (Taxa + Fiança). iva = 0, otros = null

AJUNTAMENT DE PALMA / AJUNTAMENT PALMA:
- Taxa per serveis urbanístics / Ordre d'execució (limpieza, apuntalamiento, escombros) en Barrera d'Abaix → BB5, Capex
- ICIO (Impuesto sobre construcciones) en Barrera de Baix → BB5, Capex. Importe = CUOTA/DEUDA (ej: 340€). NO usar BI Total (ej: 8.500€)
- Licencia ocupación vías públicas / LLICENCIES O PERM. PER OCUP. ACTIV. EN VIES PU → BB5, Capex
- CRÍTICO: estos documentos NO tienen IVA. iva = 0, otros = null
- CRÍTICO: leer CUOTA o DEUDA o TOTAL COBRADO como importe real

ZADAL:
- Siempre → AN, Costes de implementación

FINUTIVE:
- Siempre → AN, Costes de implementación

REGISTRADORES ESPAÑA / REGISTRO MERCANTIL / REGISTRO DE LA PROPIEDAD / JOSE MIGUEL BAÑON BERNARD:
- "Nota de registro", registros genéricos → AN, Opex
- Registro de constitución sociedad → AN, Costes de implementación
- Registro de propiedad post-compraventa → activo según inmueble, Adquisición
  · Si referencia un nº de protocolo: usar tabla de protocolos (577→BB5, 2214→FMM3, 2221→PR30, 2457→PB27, 2731→E65/M1/AG55)
  · Si referencia dirección del inmueble: usar tabla de direcciones

NOTARÍA / NOTARIOS ALCALA 35 / RAMOS ORTIZ NOTARIOS / B.ENTRENA-L.LOPEZ NOTARIOS / JUAN BARRIOS ALVAREZ / cualquier notaría:
- FECHA: usar "Fecha Firma" (NO "Fecha" de emisión de factura)
- "Constitución", "titularidad real", "poderes", "póliza" → AN, Costes de implementación
- "Préstamo", "préstamo personal sin afianzamiento" → AN, Costes de implementación
- "Afianzamiento", "aval" → AN, Costes de implementación
- "CV inmuebles" / "compraventa" → Adquisición (incluye gastos e impuestos), activo según valor escritura:
    · ~180.000€ con Cerberus → FMM3
    · ~205.000€ → PR30
    · ~180.000€ con familia vendedora → BB5
    · ~325.000€ → PB27
    · ~165.000€ → E65
    · ~179.000€ → M1
    · ~279.650€ → AG55
    · Valor muy alto (ej: ~623.650€ = varios inmuebles Madrid) → E65, notas: "CV múltiples inmuebles Madrid"
- cuantia = Base Imponible + Base no Sujeta (suplidos: papel timbrado, sellos seguridad, timbres)
  EJEMPLO REAL: BI=1.296,85€ + suplidos (7,95+0,15+0,15)=8,25€ → cuantia = 1.296,85 + 8,25 = 1.305,10€
  Suma cada céntimo. Comprueba que cuantia + iva + otros = Total Factura.
- IMPORTANTE: Si la factura referencia un NÚMERO DE PROTOCOLO de escritura, usar para identificar activo:
    · Protocolo 577 (López de Paz) → BB5
    · Protocolo 2214 (Blanca Valenzuela) → FMM3
    · Protocolo 2215 (Blanca Valenzuela) → poderes, → AN
    · Protocolo 2221 (Blanca Valenzuela) → PR30
    · Protocolo 2457 (Juan Barrios) → PB27
    · Protocolo 2731 (Juan Barrios) → E65+M1+AG55 (escritura conjunta 3 inmuebles Madrid) → si es factura de notaría CV, dejar activo vacío + notas "CV múltiples inmuebles — usar split"
  Si un registro o certificación referencia un protocolo, asociar al activo correspondiente.

AGENCIA TRIBUTARIA / COMUNIDAD DE MADRID / MODELO 600 (ITP):
- ITP ~13.617€ → BB5, Adquisición
- ITP ~18.788€ → PR30, Adquisición
- ITP ~15.056€ → FMM3, Adquisición
- ITP ~26.000€ → PB27, Adquisición
- Cualquier ITP individual → Adquisición, activo por importe más cercano
- CRÍTICO: Si el ITP/Modelo 600 cubre VARIOS inmuebles (ver Anexo 1 con varias direcciones):
  · Generar UN OBJETO JSON POR INMUEBLE en el array
  · Repartir la cuota proporcionalmente al valor declarado de cada inmueble
  · Usar estas direcciones para asignar activo:
    - Elfo 65, Madrid → E65
    - Molino 1, Villanueva de la Cañada → M1
    - Alfonso Gómez 55, Madrid → AG55
    - Barrera de Baix, Palma → BB5
    - Francesc Martí Mora, Palma → FMM3
    - Pascual Ribot, Palma → PR30
    - Pau Bouvy / Padre Bartolomé, Palma → PB27
  · Ejemplo: ITP total 13.005,55€ sobre 3 inmuebles con valores 188.921,78 + 179.000 + 282.355,79 = 650.277,57
    → E65: 13.005,55 × (188.921,78 / 650.277,57) = 3.778,44€
    → M1:  13.005,55 × (179.000 / 650.277,57) = 3.580,00€
    → AG55: 13.005,55 × (282.355,79 / 650.277,57) = 5.647,11€
  · proveedor = "Agencia Tributaria" o "Comunidad de Madrid" según aparezca
  · iva = 0, otros = null (ITP no lleva IVA ni retención)
  · concepto = "ITP Compraventa [dirección]"
- DETECCIÓN DE MÚLTIPLES INMUEBLES: Si el documento tiene un Anexo 1 con varias direcciones y valores declarados, O si la Base Imponible es la suma de varios precios de compraventa (ej: 650.277,57 = 188.921,78 + 179.000 + 282.355,79), SIEMPRE generar un objeto por inmueble. NO devolver una sola fila con el total.

DEPÓSITO DE FIANZAS / MODELO 251:
- Son depósitos de fianzas de arrendamiento ante la Comunidad de Madrid
- Buscar en sección "5.- Contrato" la dirección del inmueble y en "6.- Autoliquidación" el importe de la fianza
- proveedor = "Comunidad de Madrid"
- concepto = "Depósito fianza arrendamiento [dirección]"
- activo según dirección del contrato:
    · Elfo 65, Madrid → E65
    · Molino 1, Villanueva de la Cañada → M1
    · Alfonso Gómez 55, Madrid → AG55
    · Barrera de Baix, Palma → BB5
    · Francesc Martí Mora, Palma → FMM3
    · Pascual Ribot, Palma → PR30
    · Pau Bouvy, Palma → PB27
- También se puede determinar por el nombre del archivo: Fianza_E65 → E65, Fianza_AG55 → AG55
- categoria = "Costes de posesión"
- cuantia = importe total fianza, iva = 0, otros = null
- fecha = fecha del contrato o fecha de ingreso (sección 7)

GABRIEL LLABRÉS COMAMALA:
- Siempre → BB5, Capex (arquitecto)

RICARDO RUIZ RUBIO (detective):
- Siempre categoría → Capex
- IMPORTANTE: Ricardo trabaja para VARIOS activos (PB27 y FMM3). La factura NO indica cuál.
- Determinar activo por el nombre del archivo PDF:
  · Si el archivo contiene "PB27" o "Bartolom" o "Bouvy" → PB27
  · Si contiene "FMM3" o "M_Mora" o "Mora" o "Francesc" → FMM3
  · Si no hay pista clara → dejar activo VACÍO, notas: "Detective — confirmar activo (PB27 o FMM3)"

VÍCTOR JAVIER CUENCA CANALEJO:
- Abogado → Costes legales, activo según dirección en concepto:
  · Francesc Martí / FMM3 / Francesc Martí i Mora → FMM3
  · Pascual Ribot / PR30 → PR30
  · Pau Bouvy / Paul Bouvy / Padre Bartolomé / PB27 → PB27

CORREOS / SOCIEDAD ESTATAL CORREOS:
- Burofax → Capex, activo según nombre del archivo PDF:
  · Archivo contiene "E65" → E65
  · Archivo contiene "M1" → M1
  · Archivo contiene "AG55" → AG55
  · Archivo contiene "PB27" → PB27
  · Si no hay pista → dejar activo vacío
- cuantia = base imponible, iva = IVA de la factura, otros = null

PEDRO FERNÁNDEZ / PEDRO FERNÁNDEZ CASTAÑO:
- Siempre → BB5, Costes de posesión (ocupante de Barrera de Baix 5)
- Sin IVA, sin retención. cuantia = importe indemnización, iva = 0, otros = null
- IMPORTANTE: puede ser un acuerdo firmado, no factura estándar. Procesarlo igual.

═══ DOCUMENTOS QUE NO SON FACTURAS — DESCARTAR ═══
Si el documento es una DECLARACIÓN FISCAL de las siguientes: Modelo 111, 303, 200, 202, 347, 349, 390:
- Estos son presentaciones de impuestos ante la Agencia Tributaria
- NO son facturas aunque aparezca un "presentador" como Alzai
- El importe del Modelo 111 (retenciones IRPF) ya está contabilizado en las facturas individuales
- El Modelo 303 (IVA) es una declaración de IVA, no una factura
- Responde: [{"descartado":true,"motivo":"Declaración fiscal Modelo [nº] — no es factura","modelo":"111","periodo":"1T2025","importe":61.84}]
IMPORTANTE: El Modelo 251 (Depósito de Fianzas) NO es una declaración fiscal a descartar — es un documento contable que SÍ hay que procesar. Ver sección "DEPÓSITO DE FIANZAS / MODELO 251".
IMPORTANTE: El Modelo 600 (ITP) NO es una declaración a descartar — es un impuesto que SÍ hay que procesar. Ver sección "AGENCIA TRIBUTARIA / COMUNIDAD DE MADRID / MODELO 600".

═══ EXTRACCIÓN DE IMPORTES ═══
- "cuantia" = Base Imponible + Base no Sujeta + suplidos. TODO antes de IVA y retención.
  Suma cada línea con PRECISIÓN. Verifica: cuantia + iva + otros = Total Factura.
- "iva" = importe total de IVA
- "otros" = retención IRPF como número NEGATIVO (ej: -194.53). Es estándar, no mencionarlo en notas.
- Si hay suplidos, papel timbrado, base no sujeta → sumar en "cuantia"
- Para ESCRITURAS: cuantia = precio compraventa, iva = 0, otros = 0

═══ IVA INCLUIDO ═══
- Si la factura indica "IVA incluido", "IVA incl.", "IGIC incluido", o si NO desglosa base e IVA por separado pero el total incluye impuestos:
  · Calcular la base: base = total / (1 + tipo_iva/100)
  · El IVA más habitual es 21%. Ejemplo: Total 605€ IVA incl. → base = 605 / 1.21 = 500€, iva = 105€
  · Si es IVA 10%: base = total / 1.10
  · Si es IVA 4%: base = total / 1.04
- Si la factura SÍ desglosa base e IVA por separado, usar los importes desglosados directamente.
- NUNCA poner el total con IVA incluido como "cuantia" y dejar iva = 0. Siempre desglosar.

═══ CATEGORÍA ═══
- SIEMPRE rellena la categoría. Nunca vacío.
- Notarías de compraventa → "Adquisición (incluye gastos e impuestos)" siempre.
- Escrituras de compraventa → "Adquisición (incluye gastos e impuestos)" siempre.

═══ CAMPO NOTAS ═══
- SOLO para dudas reales de activo cuando no puedes determinarlo.
- Si el activo es claro → notas VACÍO.
- NO mencionar retenciones ni datos obvios en notas.
- En escrituras: incluir datos clave (notaría, protocolo, ref catastral, superficie).

Responde SOLO JSON válido sin texto adicional. SIEMPRE un array JSON, incluso para un solo documento:
- Facturas/documentos contables: [{"numero":"nº","fecha":"DD/MM/YYYY","proveedor":"nombre","concepto":"breve","activo":"código o vacío","categoria":"categoría exacta","cuantia":número,"iva":número,"otros":número_negativo_o_null,"notas":"solo si duda"}]
- Declaraciones fiscales: [{"descartado":true,"motivo":"explicación","modelo":"nº modelo"}]
- PDFs con varias facturas (una por página): un objeto por factura en el array`;

// ─── Validación post-IA ───────────────────────────────────────────────────────
const validateInvoice = (inv, filename) => {
  const v = { ...inv };
  const prov = (v.proveedor||"").toLowerCase();
  const concepto = (v.concepto||"").toLowerCase();
  const file = (filename||"").toLowerCase();

  if (prov.includes("arena asset") || prov.includes("arena am")) {
    v.activo = "AN"; v.categoria = "Comisión de gestión"; v.otros = null;
  }
  if (prov.includes("alzai")) {
    v.activo = "AN";
    if (concepto.includes("modelo 600") || concepto.includes("mod 600") || concepto.includes("presentación modelo") || (v.cuantia||0) >= 500) {
      v.categoria = "Costes de implementación (SPV, abogados, etc.)";
    } else if ((v.cuantia||0) <= 200) {
      v.categoria = "Opex";
    }
  }
  if (prov.includes("llabrés") || prov.includes("llabres") || prov.includes("comamala")) {
    v.activo = "BB5"; v.categoria = "Capex";
  }
  if (prov.includes("pedro fernández") || prov.includes("pedro fernandez") || concepto.includes("indemnización")) {
    v.activo = "BB5"; v.categoria = "Costes de posesión"; v.iva = 0; v.otros = null;
  }
  if (prov.includes("consell de mallorca")) {
    v.activo = "BB5"; v.categoria = "Capex"; v.iva = 0; v.otros = null;
  }
  if (prov.includes("ajuntament")) {
    v.iva = 0; v.otros = null;
    if (concepto.includes("icio") || concepto.includes("construccion") || concepto.includes("serveis urban") || concepto.includes("ordre d'execu") || concepto.includes("apuntalamiento") || concepto.includes("escombr")) {
      v.activo = "BB5"; v.categoria = "Capex";
    }
    if (concepto.includes("expedició de documents") || concepto.includes("llicenci")) {
      v.activo = "BB5"; v.categoria = "Capex";
    }
  }
  if (prov.includes("air europa") || prov.includes("aireuropa")) {
    v.activo = "AN"; v.categoria = "Opex";
  }
  if (prov.includes("correos") && (concepto.includes("burofax") || concepto.includes("premium online"))) {
    v.categoria = "Capex";
    if (file.includes("ag55")) v.activo = "AG55";
    else if (file.includes("m1")) v.activo = "M1";
    else if (file.includes("e65")) v.activo = "E65";
    else if (file.includes("pb27")) v.activo = "PB27";
  }
  if (prov.includes("ferretería") || prov.includes("ferreteria") || prov.includes("central de san mag")) {
    v.categoria = "Capex";
    if (!v.activo) v.activo = "BB5";
  }
  if (prov.includes("ricardo ruiz")) {
    v.categoria = "Capex";
    if (file.includes("fmm3") || file.includes("m_mora") || file.includes("mora")) v.activo = "FMM3";
    else if (file.includes("pb27") || file.includes("bartolom") || file.includes("bouvy")) v.activo = "PB27";
    else v.activo = "";
  }
  if (prov.includes("cuenca canalejo") || prov.includes("víctor javier")) {
    v.categoria = "Costes legales";
    if (concepto.includes("francesc") || concepto.includes("fmm3") || concepto.includes("martí")) v.activo = "FMM3";
    else if (concepto.includes("pascual") || concepto.includes("ribot") || concepto.includes("pr30")) v.activo = "PR30";
    else if (concepto.includes("bouvy") || concepto.includes("bartolom") || concepto.includes("pb27") || concepto.includes("pau bouvy")) v.activo = "PB27";
  }
  if (prov.includes("ramos ortiz")) {
    v.activo = "AN"; v.categoria = "Costes de implementación (SPV, abogados, etc.)";
  }
  if ((prov.includes("barrios") || prov.includes("notari") || prov.includes("alcala 35")) && concepto.includes("compraventa")) {
    v.categoria = "Adquisición (incluye gastos e impuestos)";
    const totalCV = v.cuantia + (v.iva||0) + (v.otros||0);
    if ((v.cuantia||0) > 900 || totalCV > 1200) {
      if ((v.cuantia||0) > 900) {
        v.activo = "";
        v.notas = "CV múltiples inmuebles — repartir entre E65, M1 y AG55 con split";
      }
    }
  }
  if (concepto.includes("compraventa") && (v.cuantia||0) >= 100000) {
    v.categoria = "Adquisición (incluye gastos e impuestos)";
    v.iva = 0; v.otros = 0;
  }

  // 15. IVA INCLUIDO — si cuantia > 0 y iva = 0 y el proveedor normalmente lleva IVA, avisar
  // Proveedores que SIEMPRE llevan IVA: Arena AM, notarías, abogados, detective, correos, ferretería, arquitecto
  const shouldHaveIVA = prov.includes("arena asset") || prov.includes("arena am") || prov.includes("notari") ||
    prov.includes("barrios") || prov.includes("ramos ortiz") || prov.includes("cuenca") || prov.includes("ricardo ruiz") ||
    prov.includes("correos") || prov.includes("ferret") || prov.includes("central de san mag") || prov.includes("llabrés") || prov.includes("llabres");
  if (shouldHaveIVA && (v.cuantia||0) > 0 && (v.iva||0) === 0) {
    // Posible IVA incluido — no corregimos automáticamente pero dejamos nota
    if (!v.notas || !v.notas.includes("IVA")) {
      v.notas = (v.notas ? v.notas + ". " : "") + "Revisar: IVA podría estar incluido en cuantía";
    }
  }

  // 16. Fianzas — assign activo by filename or concepto address
  if (concepto.includes("fianza") || concepto.includes("deposito fianza") || concepto.includes("depósito fianza") || 
      concepto.includes("modelo 251") || file.includes("fianza") || file.includes("mod_251")) {
    v.categoria = "Costes de posesión";
    v.iva = 0; v.otros = null;
    if (!v.activo) {
      if (file.includes("e65") || concepto.includes("elfo")) v.activo = "E65";
      else if (file.includes("m1") || concepto.includes("molino")) v.activo = "M1";
      else if (file.includes("ag55") || concepto.includes("alfonso")) v.activo = "AG55";
      else if (file.includes("bb5") || concepto.includes("barrera")) v.activo = "BB5";
      else if (file.includes("fmm3") || concepto.includes("francesc")) v.activo = "FMM3";
      else if (file.includes("pr30") || concepto.includes("ribot")) v.activo = "PR30";
      else if (file.includes("pb27") || concepto.includes("bouvy") || concepto.includes("bartolom")) v.activo = "PB27";
    }
  }

  // 17. Detectar declaraciones fiscales que la IA no descartó (safety net)
  // EXCLUIR: Modelo 251 (fianzas) y Modelo 600 (ITP) — son documentos contables válidos
  const isDeclaracionFiscal = (
    concepto.includes("modelo 111") || concepto.includes("modelo 303") || concepto.includes("modelo 200") ||
    concepto.includes("modelo 202") || concepto.includes("modelo 347") || concepto.includes("modelo 390") ||
    (file.includes("mod_111") || file.includes("mod_303") || file.includes("mod_200"))
  ) && !concepto.includes("modelo 251") && !concepto.includes("modelo 600") &&
    !file.includes("mod_251") && !file.includes("fianza");
  if (isDeclaracionFiscal) {
    v._descartado = true;
    v._motivo = `Declaración fiscal detectada (${concepto.slice(0,50)}) — no es factura`;
  }

  return v;
};

// ─── Detectar si un documento es un impuesto (ITP, IBI, ICIO, etc.) ─────────
const isImpuesto = (inv) => {
  // Manual override via comentario tag
  const com = (inv.comentario||"").toLowerCase();
  if (com.includes("[tipo:impuesto]")) return true;
  if (com.includes("[tipo:factura]")) return false;
  // Auto-detect
  const prov = (inv.proveedor||"").toLowerCase();
  const concepto = (inv.concepto||"").toLowerCase();
  // ITP
  if (concepto.includes("itp") || concepto.includes("transmisiones patrimoniales")) return true;
  if (concepto.includes("modelo 600")) return true;
  // IBI
  if (concepto.includes("ibi") || concepto.includes("impuesto sobre bienes inmuebles")) return true;
  // Fianzas
  if (concepto.includes("fianza") || concepto.includes("depósito fianza") || concepto.includes("deposito fianza")) return true;
  if (concepto.includes("modelo 251")) return true;
  // ICIO
  if (concepto.includes("icio") && (prov.includes("ajuntament") || prov.includes("ayuntamiento"))) return true;
  // Agencia Tributaria / Comunidad de Madrid con ITP/fianza
  if ((prov.includes("agencia tributaria") || prov.includes("comunidad de madrid") || prov.includes("hacienda")) &&
      (concepto.includes("compraventa") || concepto.includes("transmisi"))) return true;
  if (prov.includes("comunidad de madrid") && (concepto.includes("modelo 600") || concepto.includes("fianza"))) return true;
  return false;
};

const fmt = n => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(n);
const parseDate = d => { if (!d) return new Date(0); const [day,mon,yr] = d.split("/"); return new Date(`${yr}-${mon}-${day}`); };
// Strip accents for dedup
const stripAccents = s => (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const invoiceKey = inv => {
  const fecha   = (inv.fecha||"").trim();
  const prov    = stripAccents((inv.proveedor||"")).toLowerCase().trim().replace(/\s+/g," ").slice(0,15);
  const cuantia = parseFloat(inv.cuantia||0).toFixed(2);
  const iva     = parseFloat(inv.iva||0).toFixed(2);
  const otros   = parseFloat(inv.otros||0).toFixed(2);
  // Normalize number: strip leading zeros, spaces, keep only alphanumeric + / _
  const num     = stripAccents((inv.numero||"")).toLowerCase().trim().replace(/^0+/,"").replace(/[^a-z0-9/_.-]/g,"");
  const activo  = (inv.activo||"").trim().toUpperCase();
  // Con número: prov (first 15 chars, no accents) + num + activo
  if (num) return `${prov}|${num}|${activo}`;
  // Sin número: fecha + prov + importes + activo (no concepto — IA changes it between runs)
  return `${fecha}|${prov}|${cuantia}|${iva}|${otros}|${activo}`;
};
// Loose key: fecha + prov prefix + total amount + activo — catches same invoice with different concepto/numero
const invoiceKeyLoose = inv => {
  const fecha   = (inv.fecha||"").trim();
  const prov    = stripAccents((inv.proveedor||"")).toLowerCase().trim().replace(/\s+/g," ").slice(0,8);
  const total   = (parseFloat(inv.cuantia||0) + parseFloat(inv.iva||0) + parseFloat(inv.otros||0)).toFixed(2);
  const activo  = (inv.activo||"").trim().toUpperCase();
  return `${fecha}|${prov}|${total}|${activo}`;
};

// DD/MM/YYYY → "1T25", "2T25", etc.
const getQuarter = (fecha) => {
  if (!fecha) return "";
  const [,mon,yr] = fecha.split("/");
  const m = parseInt(mon, 10);
  const q = m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4;
  return `${q}T${(yr||"").slice(-2)}`;
};

// ─── Componentes pequeños ─────────────────────────────────────────────────────
function DropZone({ label, name, onFile, file }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
        <span style={{ background:"#0f2942", color:"#60a5fa", padding:"3px 10px", borderRadius:4, fontSize:12, fontWeight:700 }}>{label}</span>
        <span style={{ color:"#475569", fontSize:12 }}>{name}</span>
      </div>
      <div
        onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)onFile(f)}}
        onClick={()=>ref.current.click()}
        style={{ border:`2px dashed ${drag?"#3b82f6":file?"#22c55e":"#1e3a5f"}`, borderRadius:8, padding:"28px 20px", textAlign:"center", cursor:"pointer", background: drag?"#0d1f35":file?"#052e16":"#0a1628" }}
      >
        <input ref={ref} type="file" accept=".xlsx,.xls,.csv" onChange={e=>{const f=e.target.files[0];if(f)onFile(f);e.target.value=""}} style={{ display:"none" }} />
        {file
          ? <div><div style={{fontSize:20,marginBottom:6}}>✓</div><div style={{color:"#4ade80",fontSize:13,fontWeight:600}}>{file.name}</div></div>
          : <div><div style={{fontSize:24,marginBottom:8}}>📂</div><div style={{color:"#475569",fontSize:13}}>Arrastra el Excel o haz clic</div></div>}
      </div>
    </div>
  );
}

function PdfDropZone({ onFiles, files, disabled }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  return (
    <div
      onDragOver={e=>{e.preventDefault();if(!disabled)setDrag(true)}} onDragLeave={()=>setDrag(false)}
      onDrop={e=>{e.preventDefault();setDrag(false);if(disabled)return;const fs=Array.from(e.dataTransfer.files).filter(f=>f.type==="application/pdf");if(fs.length)onFiles(fs)}}
      onClick={()=>!disabled&&ref.current.click()}
      style={{ border:`2px dashed ${drag?"#3b82f6":files.length?"#22c55e":"#1e3a5f"}`, borderRadius:12, padding:"32px 20px", textAlign:"center", cursor:disabled?"default":"pointer", background: drag?"#0d1f35":files.length?"#052e16":"#0a1628", opacity:disabled?0.5:1 }}
    >
      <input ref={ref} type="file" accept=".pdf" multiple onChange={e=>{const fs=Array.from(e.target.files);if(fs.length)onFiles(fs);e.target.value=""}} style={{ display:"none" }} />
      {files.length > 0
        ? <div><div style={{fontSize:24,marginBottom:8}}>📄</div>{files.map((f,i)=><div key={i} style={{color:"#4ade80",fontSize:13,fontWeight:600}}>{f.name}</div>)}<div style={{color:"#475569",fontSize:11,marginTop:6}}>Haz clic para cambiar</div></div>
        : <div><div style={{fontSize:32,marginBottom:10}}>📄</div><div style={{color:"#64748b",fontSize:14}}>Arrastra PDFs: facturas, escrituras, ITP…</div><div style={{color:"#334155",fontSize:12,marginTop:4}}>o haz clic para seleccionar</div></div>}
    </div>
  );
}

// ─── Global style to hide number spinners ─────────────────────────────────
const HIDE_SPINNERS = `input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield;appearance:textfield}`;
if (!document.getElementById("hide-spinners")) {
  const s = document.createElement("style"); s.id = "hide-spinners"; s.textContent = HIDE_SPINNERS;
  document.head.appendChild(s);
}

function Field({ label, value, onChange, required, options, type="text", uppercase, negative, formula, dateAuto, suggestions }) {
  const [showSugs, setShowSugs] = useState(false);
  const [sugIdx, setSugIdx] = useState(-1);
  const [rawText, setRawText] = useState(null); // raw text while editing formula/negative fields
  const inputRef = useRef();
  const empty = required && (!value || value === "");

  // Date auto-format: DD/MM/YYYY
  const handleDateChange = (e) => {
    let v = e.target.value.replace(/[^\d/]/g, "");
    const raw = v.replace(/\//g, "");
    if (raw.length >= 2 && !v.includes("/")) v = raw.slice(0,2) + "/" + raw.slice(2);
    if (raw.length >= 4 && v.split("/").length < 3) {
      const parts = raw;
      v = parts.slice(0,2) + "/" + parts.slice(2,4) + "/" + parts.slice(4,8);
    }
    if (v.length > 10) v = v.slice(0,10);
    onChange(v);
  };

  // Formula: evaluate "100+50+25" on blur
  const evalFormula = (text) => {
    if (text && /^[\d.,+\-\s]+$/.test(text) && text.includes("+")) {
      try {
        const result = text.split("+").reduce((s, n) => s + (parseFloat(n.replace(",",".").trim()) || 0), 0);
        return parseFloat(result.toFixed(2));
      } catch { return parseFloat(text.replace(",",".")) || 0; }
    }
    return parseFloat(String(text).replace(",",".")) || 0;
  };

  // Filtered suggestions
  const filteredSugs = suggestions && value && value.length >= 2
    ? [...new Set(suggestions)].filter(s => s && s.toLowerCase().startsWith(value.toLowerCase()) && s.toLowerCase() !== value.toLowerCase()).slice(0, 6)
    : [];

  const displayValue = rawText !== null ? rawText : (value ?? "");
  const inputStyle = { width:"100%", background:empty?"#1f0a0a":"#0a1628", border:`1px solid ${empty?"#ef4444":"#1e3a5f"}`, borderRadius:6, color:"#e2e8f0", padding:"8px 10px", fontFamily:"inherit", fontSize:13, outline:"none", boxSizing:"border-box", ...(uppercase ? { textTransform:"uppercase" } : {}) };

  return (
    <div style={{ marginBottom: 14, position:"relative" }}>
      <div style={{ fontSize:11, color:empty?"#f87171":"#475569", marginBottom:4, letterSpacing:1, textTransform:"uppercase", display:"flex", alignItems:"center", gap:6 }}>
        {label}{empty && <span style={{color:"#f87171"}}>⚠</span>}
      </div>
      {options
        ? <select value={value||""} onChange={e=>onChange(e.target.value)} style={{ width:"100%", background:empty?"#1f0a0a":"#0a1628", border:`1px solid ${empty?"#ef4444":"#1e3a5f"}`, borderRadius:6, color:"#e2e8f0", padding:"8px 10px", fontFamily:"inherit", fontSize:13, outline:"none" }}>
            <option value="">— seleccionar —</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        : <div style={{ position:"relative" }}>
            <input
              ref={inputRef}
              type={type}
              value={displayValue}
              placeholder={negative ? "-0.00" : ""}
              onChange={e => {
                let v = e.target.value;
                if (uppercase) v = v.toUpperCase();
                if (negative || formula) {
                  // Keep raw text while typing, parse on blur
                  setRawText(v);
                  return;
                }
                if (dateAuto) { handleDateChange(e); return; }
                onChange(v);
              }}
              onFocus={() => {
                if (suggestions) setShowSugs(true);
                if ((formula || negative) && rawText === null && value !== null && value !== undefined && value !== "") {
                  setRawText(String(value));
                }
              }}
              onBlur={(e) => {
                setTimeout(() => setShowSugs(false), 150);
                if (rawText !== null && (formula || negative)) {
                  if (formula && rawText.includes("+")) {
                    const result = evalFormula(rawText);
                    onChange(result);
                  } else if (negative) {
                    const num = parseFloat(rawText.replace(",",".")) || 0;
                    onChange(num > 0 ? -Math.abs(num) : num);
                  } else {
                    onChange(parseFloat(rawText.replace(",",".")) || 0);
                  }
                  setRawText(null);
                }
              }}
              onKeyDown={(e) => {
                if (suggestions && filteredSugs.length > 0 && showSugs) {
                  if (e.key === "Tab" || e.key === "Enter") {
                    if (filteredSugs.length > 0) {
                      e.preventDefault();
                      const pick = sugIdx >= 0 ? filteredSugs[sugIdx] : filteredSugs[0];
                      onChange(uppercase ? pick.toUpperCase() : pick);
                      setShowSugs(false); setSugIdx(-1);
                    }
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault(); setSugIdx(prev => Math.min(prev + 1, filteredSugs.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault(); setSugIdx(prev => Math.max(prev - 1, -1));
                  }
                }
              }}
              style={inputStyle}
            />
            {/* Autocomplete dropdown */}
            {suggestions && showSugs && filteredSugs.length > 0 && (
              <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"#0d1f35", border:"1px solid #1e3a5f", borderRadius:6, zIndex:50, maxHeight:180, overflowY:"auto", marginTop:2 }}>
                {filteredSugs.map((s, i) => (
                  <div key={s} onMouseDown={(e) => { e.preventDefault(); onChange(uppercase ? s.toUpperCase() : s); setShowSugs(false); }}
                    style={{ padding:"7px 12px", fontSize:12, color: i === sugIdx ? "#93c5fd" : "#cbd5e1", background: i === sugIdx ? "#1e3a5f" : "transparent", cursor:"pointer" }}
                    onMouseEnter={() => setSugIdx(i)}>
                    {s}
                  </div>
                ))}
                <div style={{ padding:"4px 12px", fontSize:10, color:"#475569", borderTop:"1px solid #1e3a5f" }}>Tab para autocompletar</div>
              </div>
            )}
          </div>}
    </div>
  );
}

// ─── Excel-style column filter dropdown ───────────────────────────────────────
function FilterDropdown({ column, values, selected, onApply, isOpen, onToggle, onSort }) {
  // Local staged state — only applied on OK
  const [localSel, setLocalSel] = useState(null); // null = all selected
  const [search, setSearch] = useState("");
  const ref = useRef();

  // Sync local state when dropdown opens
  useEffect(() => {
    if (isOpen) { setLocalSel(selected ? new Set(selected) : null); setSearch(""); }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onToggle(null); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onToggle]);

  if (!isOpen) return null;

  const localAll = !localSel;
  const localSet = localSel || new Set(values);
  const filtered = search ? values.filter(v => (v||"").toLowerCase().includes(search.toLowerCase())) : values;
  const hasChanges = (() => {
    if (!selected && !localSel) return false;
    if (!selected && localSel) return true;
    if (selected && !localSel) return true;
    if (selected.size !== localSel.size) return true;
    for (const v of selected) { if (!localSel.has(v)) return true; }
    return false;
  })();

  const toggleAll = () => {
    if (localAll) setLocalSel(new Set()); // deselect all
    else setLocalSel(null); // select all
  };
  const toggleOne = (v) => {
    const next = new Set(localSet);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    if (next.size === values.length) setLocalSel(null);
    else setLocalSel(next);
  };

  const handleOK = () => {
    // If nothing is selected, treat same as "select all" to avoid blank table
    if (localSel && localSel.size === 0) { onApply(null); }
    else { onApply(localSel); }
    onToggle(null);
  };

  return (
    <div ref={ref} style={{ position:"absolute", top:"100%", left:0, zIndex:100, background:"#0d1f35", border:"1px solid #1e3a5f", borderRadius:8, minWidth:220, boxShadow:"0 8px 24px rgba(0,0,0,0.6)" }}
      onClick={e=>e.stopPropagation()}>
      {/* Sort options */}
      {onSort && <>
        <div style={{ padding:"8px 12px", cursor:"pointer", display:"flex", alignItems:"center", gap:8, fontSize:12, color:"#94a3b8" }}
          onMouseEnter={e=>e.currentTarget.style.background="#1e3a5f"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}
          onClick={()=>{onSort("asc");onToggle(null)}}>
          <span style={{ fontSize:11, color:"#60a5fa" }}>A↓Z</span> Ordenar A → Z
        </div>
        <div style={{ padding:"8px 12px", cursor:"pointer", display:"flex", alignItems:"center", gap:8, fontSize:12, color:"#94a3b8" }}
          onMouseEnter={e=>e.currentTarget.style.background="#1e3a5f"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}
          onClick={()=>{onSort("desc");onToggle(null)}}>
          <span style={{ fontSize:11, color:"#60a5fa" }}>Z↓A</span> Ordenar Z → A
        </div>
        <div style={{ borderBottom:"1px solid #1e3a5f", margin:"4px 0" }} />
      </>}
      {/* Clear filter for this column */}
      {selected && <div style={{ padding:"6px 12px", cursor:"pointer", fontSize:11, color:"#64748b" }}
        onMouseEnter={e=>e.currentTarget.style.color="#f87171"} onMouseLeave={e=>e.currentTarget.style.color="#64748b"}
        onClick={()=>{onApply(null);onToggle(null)}}>
        ✕ Limpiar filtro de "{column}"
      </div>}
      <div style={{ borderBottom:"1px solid #1e3a5f", margin:"4px 0" }} />
      {/* Search */}
      <div style={{ padding:"6px 10px" }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar…"
          style={{ width:"100%", background:"#080f1a", border:"1px solid #1e3a5f", borderRadius:4, color:"#e2e8f0", padding:"5px 8px", fontFamily:"inherit", fontSize:11, outline:"none", boxSizing:"border-box" }} />
      </div>
      {/* Checkboxes */}
      <div style={{ maxHeight:220, overflowY:"auto", padding:"4px 0" }}>
        <div style={{ padding:"4px 12px", display:"flex", alignItems:"center", gap:6, cursor:"pointer" }} onClick={toggleAll}>
          <input type="checkbox" checked={localAll} readOnly style={{ accentColor:"#3b82f6" }} />
          <span style={{ fontSize:12, color:"#94a3b8", fontWeight:600 }}>(Seleccionar todo)</span>
        </div>
        {filtered.sort().map(v => (
          <div key={v} style={{ padding:"3px 12px", display:"flex", alignItems:"center", gap:6, cursor:"pointer" }} onClick={()=>toggleOne(v)}>
            <input type="checkbox" checked={localSet.has(v)} readOnly style={{ accentColor:"#3b82f6" }} />
            <span style={{ fontSize:11, color:"#cbd5e1", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:200 }}>{v || "(vacío)"}</span>
          </div>
        ))}
      </div>
      {/* Status + OK / Cancel */}
      {localSel && localSel.size === 0 && <div style={{ padding:"4px 12px", fontSize:11, color:"#f59e0b" }}>⚠ Selecciona al menos un valor</div>}
      <div style={{ borderTop:"1px solid #1e3a5f", padding:"8px 10px", display:"flex", justifyContent:"space-between", alignItems:"center", gap:6 }}>
        <span style={{ fontSize:10, color:"#475569" }}>{localAll ? `${values.length} de ${values.length}` : `${localSel.size} de ${values.length}`}</span>
        <div style={{ display:"flex", gap:6 }}>
          <button onClick={handleOK} style={{ background: hasChanges?"#1d4ed8":"#1e3a5f", border:"none", color:"#fff", padding:"4px 14px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", fontWeight: hasChanges?700:400 }}>OK</button>
          <button onClick={()=>onToggle(null)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 14px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

function SplitRow({ split, index, onChange, onRemove, base, iva, otros, count }) {
  const total = (split.pct/100) * ((base||0)+(iva||0)+(otros||0));
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 90px 100px auto", gap:8, alignItems:"center", marginBottom:8, padding:"10px 12px", background:"#080f1a", borderRadius:8, border:"1px solid #1e3a5f" }}>
      <select value={split.activo} onChange={e=>onChange(index,"activo",e.target.value)}
        style={{ background:!split.activo?"#1f0a0a":"#0a1628", border:`1px solid ${!split.activo?"#ef4444":"#1e3a5f"}`, borderRadius:6, color:"#e2e8f0", padding:"7px 10px", fontFamily:"inherit", fontSize:13, outline:"none" }}>
        <option value="">— activo —</option>
        {ACTIVOS.map(a => <option key={a} value={a}>{a}</option>)}
      </select>
      <div style={{ position:"relative" }}>
        <input type="number" min="0" max="100" step="0.01" value={split.pct}
          onChange={e=>onChange(index,"pct",parseFloat(e.target.value)||0)}
          style={{ width:"100%", background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:6, color:"#93c5fd", padding:"7px 22px 7px 10px", fontFamily:"inherit", fontSize:13, outline:"none", boxSizing:"border-box" }} />
        <span style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", color:"#475569", fontSize:11 }}>%</span>
      </div>
      <div style={{ color:"#4ade80", fontSize:12, fontWeight:600, textAlign:"right" }}>{fmt(total)}</div>
      {count > 2
        ? <button onClick={()=>onRemove(index)} style={{ background:"transparent", border:"none", color:"#475569", cursor:"pointer", fontSize:16, padding:"2px 6px" }}>✕</button>
        : <div style={{ width:26 }} />}
    </div>
  );
}

function PdfViewer({ file }) {
  const canvasRef = useRef();
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setCurrentPage(1); setPdfDoc(null);
    const load = async () => {
      try {
        if (!window.pdfjsLib) {
          await new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
            s.onload = res; s.onerror = rej;
            document.head.appendChild(s);
          });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        }
        const buf = await file.arrayBuffer();
        const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
        if (!cancelled) { setPdfDoc(doc); setNumPages(doc.numPages); setLoading(false); }
      } catch(e) { if (!cancelled) { setError(e.message); setLoading(false); } }
    };
    load();
    return () => { cancelled = true; };
  }, [file]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let cancelled = false;
    const render = async () => {
      const page = await pdfDoc.getPage(currentPage);
      if (cancelled) return;
      const canvas = canvasRef.current;
      const dpr = Math.max(window.devicePixelRatio || 1, 2); // min 2x for crisp rendering
      const vp0 = page.getViewport({ scale: 1 });
      const containerWidth = canvas.parentElement?.clientWidth || 500;
      const scale = (containerWidth - 2) / vp0.width;
      const vp = page.getViewport({ scale: scale * dpr });
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = `${vp.width/dpr}px`; canvas.style.height = `${vp.height/dpr}px`;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    };
    render();
    return () => { cancelled = true; };
  }, [pdfDoc, currentPage]);

  return (
    <div style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:12, overflow:"hidden" }}>
      <div style={{ padding:"8px 14px", borderBottom:"1px solid #1e3a5f", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:11, color:"#475569", letterSpacing:1, textTransform:"uppercase" }}>Documento original</span>
        <span style={{ fontSize:11, color:"#334155", maxWidth:220, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{file.name}</span>
      </div>
      <div style={{ background:"#f8fafc", minHeight:300, display:"flex", flexDirection:"column", alignItems:"center", justifyContent: (loading||error) ? "center" : "flex-start", padding: (loading||error) ? 20 : 0 }}>
        {loading && <div style={{ color:"#64748b", fontSize:13 }}>Cargando PDF…</div>}
        {error && <div style={{ color:"#ef4444", fontSize:12, textAlign:"center" }}>No se puede mostrar el PDF.</div>}
        {!loading && !error && <canvas ref={canvasRef} style={{ width:"100%", display:"block" }} />}
      </div>
      {numPages > 1 && (
        <div style={{ padding:"8px 14px", borderTop:"1px solid #1e3a5f", display:"flex", alignItems:"center", justifyContent:"center", gap:12 }}>
          <button onClick={()=>setCurrentPage(p=>Math.max(1,p-1))} disabled={currentPage===1}
            style={{ background:"transparent", border:"1px solid #1e3a5f", color:currentPage===1?"#334155":"#64748b", padding:"3px 10px", borderRadius:5, cursor:currentPage===1?"default":"pointer", fontFamily:"inherit", fontSize:12 }}>←</button>
          <span style={{ fontSize:12, color:"#475569" }}>{currentPage} / {numPages}</span>
          <button onClick={()=>setCurrentPage(p=>Math.min(numPages,p+1))} disabled={currentPage===numPages}
            style={{ background:"transparent", border:"1px solid #1e3a5f", color:currentPage===numPages?"#334155":"#64748b", padding:"3px 10px", borderRadius:5, cursor:currentPage===numPages?"default":"pointer", fontFamily:"inherit", fontSize:12 }}>→</button>
        </div>
      )}
    </div>
  );
}

// ─── App principal ────────────────────────────────────────────────────────────
export default function App() {
  const [entries, setEntries]       = useState([]);
  const [invoices, setInvoices]     = useState([]);
  const [ccFile, setCcFile]         = useState(null);
  const [cpFile, setCpFile]         = useState(null);
  const [tab, setTab]               = useState("importar");
  const [flash, setFlash]           = useState(null);
  const [delConfirm, setDelConfirm] = useState(null);
  const [confirmBorrarTodoStep, setConfirmBorrarTodoStep] = useState(0); // 0=off, 1=first confirm, 2=second confirm
  const [confirmBorrarFacturas, setConfirmBorrarFacturas] = useState(false);
  const [loaded, setLoaded]         = useState(false);
  const [filterCat, setFilterCat]   = useState("Todas");
  const [filterQ, setFilterQ]       = useState("Todos");
  const [importing, setImporting]   = useState(false);
  const [apiKey, setApiKey]         = useState("");
  const [showApiModal, setShowApiModal] = useState(false);
  const [pdfFiles, setPdfFiles]     = useState([]);
  const [reviewQueue, setReviewQueue] = useState([]);
  const [reviewIdx, setReviewIdx]   = useState(0);
  const [analyzing, setAnalyzing]   = useState(false);
  const [progress, setProgress]     = useState({ current:0, total:0 });
  const [draft, setDraft]           = useState(null);
  const [splitMode, setSplitMode]   = useState(false);
  const [splits, setSplits]         = useState([{activo:"",pct:50},{activo:"",pct:50}]);
  const [previewFile, setPreviewFile] = useState(null);
  const [importLog, setImportLog]     = useState([]); // persistent log of descartados
  const [manualQueue, setManualQueue] = useState([]); // failed PDFs pending manual entry
  const [manualDraft, setManualDraft] = useState(null); // current manual entry fields
  const [manualSplitMode, setManualSplitMode] = useState(false);
  const [manualSplits, setManualSplits] = useState([{activo:"",pct:50},{activo:"",pct:50}]);
  const [skippedQueue, setSkippedQueue] = useState([]); // skipped items for later
  const totalPct = splits.reduce((a,s)=>a+(s.pct||0), 0);
  const splitValid = splits.every(s=>s.activo) && Math.abs(totalPct-100)<0.01;
  const invoicesRef = useRef([]);
  // Edit mode
  const [editMode, setEditMode]     = useState(false);
  const [editingId, setEditingId]   = useState(null);
  const [editDraft, setEditDraft]   = useState(null);
  const [editSplitMode, setEditSplitMode] = useState(false);
  const [editSplits, setEditSplits] = useState([{activo:"",pct:50},{activo:"",pct:50}]);
  // Escrituras from Supabase
  const [escriturasDB, setEscriturasDB] = useState([]);
  // Bank movements
  const [bankMovements, setBankMovements] = useState([]);
  const [bankFilterCuenta, setBankFilterCuenta] = useState("Todas");
  const [bankFilterTipo, setBankFilterTipo] = useState(null);
  const [confirmBorrarBanco, setConfirmBorrarBanco] = useState(false);
  const [confirmBorrarGF, setConfirmBorrarGF] = useState(false);
  const [bankFilterCol, setBankFilterCol] = useState(null);
  const [bankFilters, setBankFilters] = useState({});
  // Conciliacion state
  const [conciliaciones, setConciliaciones] = useState([]);
  const [concSugerencias, setConcSugerencias] = useState([]);
  const [concRunning, setConcRunning] = useState(false);
  const [concManualMov, setConcManualMov] = useState(null);
  const [concManualFacs, setConcManualFacs] = useState(new Set());
  const [concManualSearch, setConcManualSearch] = useState("");
  // BD sort & filter (Excel-style header filters)
  const [bdSortCol, setBdSortCol]   = useState("fecha");
  const [bdSortDir, setBdSortDir]   = useState("desc");
  const [bdFilters, setBdFilters]   = useState({}); // { colName: Set of selected values or null (all) }
  const [openFilterCol, setOpenFilterCol] = useState(null);
  // Facturas filter
  const [facFilterCol, setFacFilterCol] = useState(null);
  const [facFilters, setFacFilters] = useState({});
  // GF Excel-style filter
  const [gfFilterCol, setGfFilterCol] = useState(null);
  const [gfFilters, setGfFilters] = useState({});

  useEffect(() => {
    const loadData = async () => {
      try {
        const sbInvoices = await fetchInvoices();
        if (sbInvoices && sbInvoices.length > 0) {
          setInvoices(sbInvoices); invoicesRef.current = sbInvoices;
        } else {
          const i = localStorage.getItem("gf-invoices-arena-nexus");
          if (i) { const parsed = JSON.parse(i); setInvoices(parsed); invoicesRef.current = parsed; }
        }
        const sbEntries = await fetchGastosFinancieros();
        if (sbEntries && sbEntries.length > 0) { setEntries(sbEntries); }
        else { const e = localStorage.getItem("gf-entries-arena-nexus"); if (e) setEntries(JSON.parse(e)); }
        // Load escrituras from Supabase
        const sbEsc = await fetchEscrituras();
        if (sbEsc && sbEsc.length > 0) setEscriturasDB(sbEsc);
        // Load bank movements
        const sbBank = await fetchMovimientosBancarios();
        if (sbBank && sbBank.length > 0) setBankMovements(sbBank);
        // Load conciliaciones
        const sbConc = await fetchConciliaciones();
        if (sbConc && sbConc.length > 0) setConciliaciones(sbConc);
      } catch {
        try {
          const e = localStorage.getItem("gf-entries-arena-nexus"); if (e) setEntries(JSON.parse(e));
          const i = localStorage.getItem("gf-invoices-arena-nexus"); if (i) { const parsed = JSON.parse(i); setInvoices(parsed); invoicesRef.current = parsed; }
        } catch {}
      }
      const k = localStorage.getItem("gf-api-key"); if (k) setApiKey(k);
      setLoaded(true);
    };
    loadData();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem("gf-entries-arena-nexus", JSON.stringify(entries)); } catch {}
    if (entries.length > 0) upsertGastosFinancieros(entries).catch(() => {});
  }, [entries, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem("gf-invoices-arena-nexus", JSON.stringify(invoices)); } catch {}
    if (invoices.length > 0) upsertInvoices(invoices).catch(() => {});
  }, [invoices, loaded]);

  const showFlash = (msg, type="ok") => { setFlash({msg,type}); setTimeout(()=>setFlash(null),3500); };
  const saveApiKey = key => { setApiKey(key); try { localStorage.setItem("gf-api-key",key); } catch {} setShowApiModal(false); showFlash("API key guardada."); };
  const resetReview = () => { setDraft(null); setSplitMode(false); setSplits([{activo:"",pct:50},{activo:"",pct:50}]); };

  const addInvoices = (newInvs) => {
    const existingExact = new Set(invoicesRef.current.map(invoiceKey));
    const existingLoose = new Set(invoicesRef.current.map(invoiceKeyLoose));
    const seenExact = new Set();
    const seenLoose = new Set();
    const fresh = newInvs.filter(inv => {
      const ek = invoiceKey(inv);
      const lk = invoiceKeyLoose(inv);
      if (existingExact.has(ek) || existingLoose.has(lk)) return false;
      if (seenExact.has(ek) || seenLoose.has(lk)) return false;
      seenExact.add(ek); seenLoose.add(lk);
      return true;
    });
    const dupes = newInvs.length - fresh.length;
    if (dupes > 0 && fresh.length === 0) { showFlash("Ya registrada(s), omitidas.", "warn"); return; }
    if (dupes > 0) showFlash(`${dupes} duplicada(s) omitida(s).`, "warn");
    if (fresh.length > 0) {
      const merged = [...invoicesRef.current, ...fresh].sort((a,b) => parseDate(a.fecha) - parseDate(b.fecha));
      invoicesRef.current = merged; setInvoices(merged);
    }
  };

  const API_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "https://api.anthropic.com/v1/messages" : "/api/analyze";

  const callAPI = async (base64, filename, retries=2) => {
    for (let attempt=0; attempt<=retries; attempt++) {
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type":"application/json", "x-api-key":apiKey, "anthropic-version":"2023-06-01" },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514", max_tokens: 8192, system: SYSTEM_PROMPT,
            messages: [{ role:"user", content:[
              { type:"document", source:{ type:"base64", media_type:"application/pdf", data:base64 }},
              { type:"text", text:`Extrae y clasifica TODAS las facturas de este documento. Si el PDF contiene varias facturas (una por página), devuelve un ARRAY JSON con un objeto por factura. Si es una sola factura, devuelve igualmente un array con un solo elemento. Archivo: "${filename}". Responde SOLO el JSON array.` }
            ]}]
          })
        });
        if (res.status === 429) { await new Promise(r => setTimeout(r, (attempt+1)*5000)); continue; }
        if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message||`HTTP ${res.status}`); }
        const data = await res.json();
        const text = data.content.map(c=>c.text||"").join("");
        let parsed = JSON.parse(text.replace(/```json|```/g,"").trim());
        // Normalize to array
        if (!Array.isArray(parsed)) parsed = [parsed];
        // Process each invoice
        const results = [];
        for (const item of parsed) {
          if (item.descartado) {
            results.push({ _descartado: true, _motivo: item.motivo || "Documento descartado por IA", _filename: filename });
          } else {
            const validated = validateInvoice(item, filename);
            if (validated._descartado) {
              results.push({ _descartado: true, _motivo: validated._motivo, _filename: filename });
            } else {
              results.push(validated);
            }
          }
        }
        return results;
      } catch(e) { if (attempt === retries) throw e; await new Promise(r => setTimeout(r, 2000)); }
    }
  };

  const analyzeAll = async () => {
    if (!pdfFiles.length) return;
    if (!apiKey) { setShowApiModal(true); return; }
    setAnalyzing(true); resetReview(); setProgress({ current:0, total:pdfFiles.length });
    const fileData = await Promise.all(pdfFiles.map(file => new Promise((res,rej) => {
      const r = new FileReader();
      r.onload = e => res({ base64: e.target.result.split(",")[1], name: file.name, file });
      r.onerror = rej; r.readAsDataURL(file);
    })));
    // Process PDFs sequentially — multi-page PDFs need full attention
    const results = [];
    for (let i = 0; i < fileData.length; i++) {
      const fd = fileData[i];
      setProgress({ current: i + 1, total: fileData.length });
      try {
        const value = await callAPI(fd.base64, fd.name);
        results.push({ result: { status: "fulfilled", value }, fd });
      } catch (err) {
        results.push({ result: { status: "rejected", reason: err?.message || "Error desconocido" }, fd });
      }
      if (i < fileData.length - 1) {
        // Larger PDFs (multi-page) need more cooldown to avoid 429/truncation
        const delayMs = fd.base64.length > 100000 ? 5000 : 3000;
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    const autoSaved = [], needsReview = [], descartados = [], failedPdfs = [];
    for (const { result, fd } of results) {
      if (result.status === "fulfilled" && result.value) {
        // callAPI now returns an array of invoices
        const items = Array.isArray(result.value) ? result.value : [result.value];
        let archivoPath = "";
        try {
          const datePrefix = new Date().toISOString().slice(0,7);
          const safeName = fd.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          archivoPath = `facturas/${datePrefix}/${safeName}`;
          await uploadFile(fd.file, archivoPath);
        } catch { archivoPath = ""; }
        for (const item of items) {
          if (item._descartado) {
            descartados.push({ filename: fd.name, motivo: item._motivo });
          } else {
            const inv = { ...item, numero: item.numero||"", otros: item.otros||null, comentario: "", archivo_origen: archivoPath };
            needsReview.push({ ...inv, _file: fd.file });
          }
        }
      } else {
        failedPdfs.push(fd);
      }
    }

    // Import log: only descartados
    const log = [];
    if (descartados.length) descartados.forEach(d => log.push({ type: "skip", text: `⏭ ${d.filename}: ${d.motivo}` }));
    setImportLog(log);

    // Failed PDFs → manual queue (individual card entry before review table)
    if (failedPdfs.length > 0) {
      setManualQueue(failedPdfs);
      setManualDraft({ fecha: "", proveedor: "", concepto: "", activo: "", categoria: "", cuantia: 0, iva: 0, otros: null, numero: "", comentario: "", notas: "", archivo_origen: "", _file: failedPdfs[0].file });
    }

    setAnalyzing(false); setProgress({ current:0, total:0 }); setPdfFiles([]);
    const msgs = [];
    if (needsReview.length) msgs.push(`${needsReview.length} documento(s) para revisión`);
    if (failedPdfs.length) msgs.push(`${failedPdfs.length} con error (rellenar a mano)`);
    if (descartados.length) msgs.push(`${descartados.length} descartado(s)`);
    if (msgs.length === 0) showFlash("No se procesó ningún documento.", "warn");
    else showFlash(msgs.join(" · "), needsReview.length > 0 ? "ok" : "warn");
    if (needsReview.length > 0) {
      setReviewQueue(needsReview); setReviewIdx(0); setDraft(needsReview[0]);
    }
  };

  const advanceReview = () => {
    const next = reviewIdx + 1;
    if (next < reviewQueue.length) { setReviewIdx(next); setDraft(reviewQueue[next]); setSplitMode(false); setSplits([{activo:"",pct:50},{activo:"",pct:50}]); }
    else { resetReview(); setReviewQueue([]); setReviewIdx(0); }
  };

  const confirmInvoice = () => {
    if (!draft.fecha || !draft.proveedor || !draft.categoria || !draft.cuantia) { showFlash("Completa los campos obligatorios.","err"); return; }
    if (splitMode) {
      if (!splitValid) { showFlash("Los % deben sumar 100%.","err"); return; }
      const newInvs = splits.map((s,i) => ({
        ...draft, _file: undefined, id: crypto.randomUUID(), activo: s.activo,
        numero: draft.numero ? `${draft.numero}-${i+1}` : "",
        cuantia: parseFloat(((s.pct/100)*(draft.cuantia||0)).toFixed(2)),
        iva: parseFloat(((s.pct/100)*(draft.iva||0)).toFixed(2)),
        otros: draft.otros!=null ? parseFloat(((s.pct/100)*(draft.otros||0)).toFixed(2)) : null,
        comentario: `${s.pct}% de factura original${draft.comentario ? " — "+draft.comentario : ""}`,
      }));
      addInvoices(newInvs);
    } else {
      if (!draft.activo) { showFlash("Selecciona el activo.","err"); return; }
      const { _file, ...inv } = draft;
      addInvoices([{ ...inv, id: crypto.randomUUID() }]);
    }
    if (reviewQueue.length - reviewIdx - 1 === 0) showFlash("✓ Todos los documentos procesados.");
    advanceReview();
  };

  const readFile = file => new Promise((res,rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result); r.onerror = rej;
    file.name.endsWith(".csv") ? r.readAsText(file,"utf-8") : r.readAsArrayBuffer(file);
  });

  const handleImport = async () => {
    if (!ccFile && !cpFile) { showFlash("Selecciona al menos un archivo.","err"); return; }
    setImporting(true);
    try {
      let allBank = [], allGF = [];
      for (const [file, account] of [[ccFile,"CC"],[cpFile,"CP"]]) {
        if (!file) continue;
        const data = await readFile(file);
        let is4Col = false;
        if (typeof data === "string") {
          is4Col = (data.split(/\r?\n/)[0] || "").split(";").length >= 4;
        } else {
          try {
            const wb = XLSX.read(data, { type: "array" });
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
            is4Col = rows.length > 0 && (rows[0] || []).length >= 4;
          } catch {}
        }
        if (is4Col) {
          const bankMov = typeof data === "string" ? parseBankCSV(data, account) : parseBankXLSX(data, account);
          allBank.push(...bankMov);
          bankMov.filter(m => m.tipo === "gasto_financiero").forEach(m => {
            const cls = classify(m.concepto);
            if (cls) allGF.push({ id: `${account}-${m.fecha}-${m.concepto}-${m.importe}`, date: m.fecha, concept: m.concepto, account, amount: m.importe, cat: cls.cat, sub: cls.sub });
          });
        } else {
          const gf = typeof data === "string" ? parseCSV(data, account) : parseXLSX(data, account);
          allGF.push(...gf);
        }
      }
      let msgs = [];
      if (allBank.length > 0) {
        const ok = await upsertMovimientosBancarios(allBank);
        if (ok) {
          const fresh = await fetchMovimientosBancarios();
          if (fresh) setBankMovements(fresh);
          else setBankMovements(allBank);
          msgs.push(`${allBank.length} movimientos bancarios`);
        } else {
          msgs.push("Error guardando movimientos bancarios");
        }
      }
      if (allGF.length > 0) {
        const ids = new Set(entries.map(e => e.id));
        const freshGF = allGF.filter(e => !ids.has(e.id));
        if (freshGF.length > 0) {
          setEntries(prev => [...prev, ...freshGF].sort((a,b) => parseDate(a.date) - parseDate(b.date)));
          msgs.push(`${freshGF.length} G. Financieros`);
        }
      }
      if (msgs.length === 0) showFlash("No se encontraron movimientos nuevos.", "warn");
      else showFlash(`✓ ${msgs.join(" + ")} importados.`);
      setCcFile(null); setCpFile(null);
    } catch(e) { console.error("Import error:", e); showFlash(`Error: ${e.message}`, "err"); }
    setImporting(false);
  };

  // ── Computed ──
  const summary = entries.reduce((acc,e) => { acc[e.cat]=(acc[e.cat]||0)+e.amount; return acc; }, {});
  const total   = Object.values(summary).reduce((a,b)=>a+b, 0);
  const cats    = ["Todas",...Object.keys(CAT_COLORS)];
  const filtered = filterCat==="Todas" ? entries : entries.filter(e=>e.cat===filterCat);

  // Build escrituras map from DB (with fallback to static file)
  const escriturasMap = {};
  if (escriturasDB.length > 0) {
    escriturasDB.forEach(e => { escriturasMap[e.activo] = e; });
  } else {
    Object.entries(ESCRITURAS).forEach(([code, e]) => {
      escriturasMap[code] = { id: `esc-static-${code}`, activo: code, tipo: "compraventa", fecha_firma: e.fecha_firma, notaria: e.notaria, protocolo: e.protocolo, precio: e.precio, datos_extra: {}, archivo_origen: "" };
    });
  }

  // Base de datos: all movements merged
  const allMovements = (() => {
    const m = [];
    Object.values(escriturasMap).forEach(esc => {
      const nombre = ESCRITURAS[esc.activo]?.nombre || esc.activo;
      m.push({ id: esc.id || `esc-${esc.activo}`, fecha: esc.fecha_firma, tipo: "Escritura", proveedor: esc.datos_extra?.vendedora || ESCRITURAS[esc.activo]?.vendedor || "", concepto: `Compraventa ${nombre}`, activo: esc.activo, categoria: "Adquisición (incluye gastos e impuestos)", cuantia: esc.precio, iva: 0, otros: 0, archivo_origen: esc.archivo_origen || "" });
    });
    invoices.forEach(inv => {
      const tipo = isImpuesto(inv) ? "Impuesto" : "Factura";
      m.push({ id: inv.id, fecha: inv.fecha, tipo, proveedor: inv.proveedor, concepto: inv.concepto, activo: inv.activo, categoria: inv.categoria, cuantia: inv.cuantia||0, iva: inv.iva||0, otros: inv.otros||0, archivo_origen: inv.archivo_origen || "" });
    });
    entries.forEach(e => {
      m.push({ id: e.id, fecha: e.date, tipo: "G. Financiero", proveedor: e.account==="CC"?"Cuenta Corriente":"Póliza Crédito", concepto: e.concept, activo: "AN", categoria: e.cat, cuantia: Math.abs(e.amount), iva: 0, otros: 0, archivo_origen: "" });
    });
    return m.sort((a,b) => parseDate(a.fecha) - parseDate(b.fecha));
  })();

  // Sorted & filtered for BD tab
  const bdMovements = (() => {
    let list = [...allMovements];
    // Apply header filters
    Object.entries(bdFilters).forEach(([col, selected]) => {
      if (!selected) return; // null = all selected, no filter
      if (selected.size === 0) { list = []; return; }
      list = list.filter(m => {
        const val = col === "periodo" ? getQuarter(m.fecha) : m[col];
        return selected.has(val);
      });
    });
    if (bdSortCol === "fecha") {
      list.sort((a,b) => bdSortDir === "desc" ? parseDate(b.fecha) - parseDate(a.fecha) : parseDate(a.fecha) - parseDate(b.fecha));
    } else {
      list.sort((a,b) => {
        const va = (bdSortCol === "periodo" ? getQuarter(a.fecha) : String(a[bdSortCol]||"")).toLowerCase();
        const vb = (bdSortCol === "periodo" ? getQuarter(b.fecha) : String(b[bdSortCol]||"")).toLowerCase();
        return bdSortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      });
    }
    return list;
  })();

  // Unique values per column for filters
  const bdUniqueVals = {
    periodo: [...new Set(allMovements.map(m => getQuarter(m.fecha)).filter(Boolean))],
    tipo: [...new Set(allMovements.map(m => m.tipo).filter(Boolean))],
    proveedor: [...new Set(allMovements.map(m => m.proveedor).filter(Boolean))],
    activo: [...new Set(allMovements.map(m => m.activo).filter(Boolean))],
    categoria: [...new Set(allMovements.map(m => m.categoria).filter(Boolean))],
  };
  const setFilter = (col, val) => setBdFilters(prev => ({ ...prev, [col]: val }));
  const hasActiveFilters = Object.values(bdFilters).some(v => v !== null && v !== undefined) || bdSortCol !== "fecha" || bdSortDir !== "desc";
  const clearAllFilters = () => { setBdFilters({}); setBdSortCol("fecha"); setBdSortDir("desc"); setOpenFilterCol(null); };

  // Precomputed set for estado badges across tabs
  const bdConcFacIds = new Set(conciliaciones.map(c => c.factura_id));

  // ── Edit helpers ──
  const startEdit = (mov) => {
    setEditingId(mov.id);
    setEditDraft({ ...mov });
  };
  const cancelEdit = () => { setEditingId(null); setEditDraft(null); setEditSplitMode(false); setEditSplits([{activo:"",pct:50},{activo:"",pct:50}]); };
  const saveEdit = async () => {
    if (!editDraft) return;
    if (editSplitMode) {
      // Split: delete original, create N new invoices
      const totalPctEdit = editSplits.reduce((a,s)=>a+(s.pct||0),0);
      if (!editSplits.every(s=>s.activo) || Math.abs(totalPctEdit-100)>=0.01) { showFlash("Split: selecciona activos y que los % sumen 100%.","err"); return; }
      const base = { ...editDraft, cuantia: parseFloat(editDraft.cuantia)||0, iva: parseFloat(editDraft.iva)||0, otros: editDraft.otros ? parseFloat(editDraft.otros) : null, comentario: editDraft.comentario||"" };
      const newInvs = editSplits.map((s, si) => ({
        ...base, id: crypto.randomUUID(), activo: s.activo,
        numero: base.numero ? `${base.numero}-${si+1}` : "",
        cuantia: parseFloat(((s.pct/100)*base.cuantia).toFixed(2)),
        iva: parseFloat(((s.pct/100)*base.iva).toFixed(2)),
        otros: base.otros!=null ? parseFloat(((s.pct/100)*base.otros).toFixed(2)) : null,
        comentario: `${s.pct}% de factura original${base.comentario ? " — "+base.comentario : ""}`,
      }));
      // Remove original
      const withoutOrig = invoices.filter(inv => inv.id !== editDraft.id);
      await deleteInvoice(editDraft.id).catch(()=>{});
      // Add splits
      const merged = [...withoutOrig, ...newInvs].sort((a,b) => parseDate(a.fecha) - parseDate(b.fecha));
      invoicesRef.current = merged; setInvoices(merged);
      // Sync to Supabase
      await upsertInvoices(newInvs).catch(()=>{});
      showFlash(`✓ Dividida en ${newInvs.length} partes.`);
    } else {
      const updated = invoices.map(inv => inv.id === editDraft.id ? { ...inv, fecha: editDraft.fecha, proveedor: editDraft.proveedor, concepto: editDraft.concepto, activo: editDraft.activo, categoria: editDraft.categoria, cuantia: parseFloat(editDraft.cuantia)||0, iva: parseFloat(editDraft.iva)||0, otros: editDraft.otros ? parseFloat(editDraft.otros) : null, comentario: editDraft.comentario||"" } : inv);
      invoicesRef.current = updated;
      setInvoices(updated);
      const target = updated.find(inv => inv.id === editDraft.id);
      if (target) updateSingleInvoice(target).catch(() => {});
      showFlash("Guardado.");
    }
    cancelEdit();
  };
  const addManualRow = () => {
    const newInv = { id: crypto.randomUUID(), fecha: new Date().toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit",year:"numeric"}), proveedor: "", concepto: "", activo: "", categoria: "", cuantia: 0, iva: 0, otros: null, numero: "", comentario: "", notas: "", archivo_origen: "" };
    const merged = [...invoicesRef.current, newInv];
    invoicesRef.current = merged;
    setInvoices(merged);
    startEdit(newInv);
    showFlash("Nueva fila añadida — rellena los campos.", "warn");
  };
  const openDoc = async (path) => {
    if (!path || !path.includes("/")) { showFlash("Sin documento en Storage.", "warn"); return; }
    try {
      const url = await getSignedUrl(path);
      if (url) window.open(url, "_blank");
      else showFlash("Documento no encontrado.", "warn");
    } catch {
      showFlash("Error al acceder al documento.", "err");
    }
  };
  const hasDoc = (path) => path && path.includes("/"); // valid storage path has a folder

  // Facturas para IVA/IRPF — with quarter + column filtering
  const allFacturasIVA = invoices.filter(inv => !isImpuesto(inv) && ((inv.iva||0)!==0 || (inv.otros||0)!==0 || (inv.numero && inv.numero.trim())));
  const quarters = [...new Set(allFacturasIVA.map(inv => getQuarter(inv.fecha)).filter(Boolean))].sort();
  let facturasIVA = filterQ === "Todos" ? [...allFacturasIVA]
    : filterQ.length === 4 && !filterQ.includes("T")
      ? allFacturasIVA.filter(inv => { const q = getQuarter(inv.fecha); return q && "20"+q.slice(-2) === filterQ; })
      : allFacturasIVA.filter(inv => getQuarter(inv.fecha) === filterQ);
  // Apply column filters
  Object.entries(facFilters).forEach(([col, selected]) => {
    if (!selected) return;
    if (selected.size === 0) { facturasIVA = []; return; }
    facturasIVA = facturasIVA.filter(inv => {
      const val = col === "periodo" ? getQuarter(inv.fecha) : inv[col];
      return selected.has(val);
    });
  });
  const facUniqueVals = {
    periodo: [...new Set(allFacturasIVA.map(inv => getQuarter(inv.fecha)).filter(Boolean))],
    proveedor: [...new Set(allFacturasIVA.map(inv => inv.proveedor).filter(Boolean))],
    activo: [...new Set(allFacturasIVA.map(inv => inv.activo).filter(Boolean))],
    categoria: [...new Set(allFacturasIVA.map(inv => inv.categoria).filter(Boolean))],
  };
  const setFacFilter = (col, val) => setFacFilters(prev => ({ ...prev, [col]: val }));
  const hasFacFilters = Object.values(facFilters).some(v => v !== null && v !== undefined);
  const totalBaseIVA = facturasIVA.reduce((s,inv) => s+(inv.cuantia||0), 0);
  const totalIVASop = facturasIVA.reduce((s,inv) => s+(inv.iva||0), 0);
  const totalRet = facturasIVA.reduce((s,inv) => s+(inv.otros||0), 0);

  const exportCSV = () => {
    const BOM = "\uFEFF";
    const header = "Fecha;Proveedor;Concepto;Activo;Categoría;Cuantía;IVA;Retención;Total s/ret.;Total factura;Comentario\n";
    const rows = invoices.map(e => [e.fecha,e.proveedor,e.concepto,e.activo,e.categoria,
      (e.cuantia||0).toFixed(2).replace(".",","),(e.iva||0).toFixed(2).replace(".",","),(e.otros||0).toFixed(2).replace(".",","),
      ((e.cuantia||0)+(e.iva||0)).toFixed(2).replace(".",","),((e.cuantia||0)+(e.iva||0)+(e.otros||0)).toFixed(2).replace(".",","),e.comentario||""
    ].join(";")).join("\n");
    const blob = new Blob([BOM+header+rows], { type:"text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href=url; a.download="facturas_arena_nexus.csv"; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  };

  if (!loaded) return <div style={{ background:"#080f1a", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", color:"#3b82f6", fontFamily:"monospace" }}>Cargando…</div>;

  const TABS = [["importar","⬆ Importar"],["bd","🗄 Base de datos"],["facturas","🧾 Facturas"],["dashboard","📊 Dashboard"],["banco","💳 Banco"],["conciliacion","🔗 Conciliación"],["gf","🏦 G. Financieros"],["resumen","📈 Resumen"]];

  return (
    <div style={{ background:"#080f1a", minHeight:"100vh", fontFamily:"'DM Mono','Fira Code',monospace", color:"#e2e8f0" }}>
      {flash && <div style={{ position:"fixed", top:20, right:20, zIndex:999, background:flash.type==="ok"?"#052e16":flash.type==="warn"?"#1c1917":"#1f0a0a", border:`1px solid ${flash.type==="ok"?"#22c55e":flash.type==="warn"?"#f59e0b":"#ef4444"}`, color:flash.type==="ok"?"#4ade80":flash.type==="warn"?"#fbbf24":"#f87171", padding:"10px 18px", borderRadius:8, fontSize:13, maxWidth:380, boxShadow:"0 4px 20px rgba(0,0,0,0.5)" }}>{flash.msg}</div>}

      {showApiModal && <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.8)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ background:"#0d1f35", border:"1px solid #1e3a5f", borderRadius:12, padding:28, width:420, maxWidth:"90vw" }}>
          <div style={{ fontSize:16, fontWeight:700, color:"#f1f5f9", marginBottom:8 }}>API Key de Anthropic</div>
          <div style={{ fontSize:12, color:"#475569", marginBottom:16 }}>Necesaria para analizar PDFs.</div>
          <input type="password" placeholder="sk-ant-..." defaultValue={apiKey} id="api-key-input" style={{ width:"100%", background:"#080f1a", border:"1px solid #1e3a5f", borderRadius:6, color:"#e2e8f0", padding:"10px 12px", fontFamily:"inherit", fontSize:13, outline:"none", boxSizing:"border-box", marginBottom:16 }} />
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={()=>saveApiKey(document.getElementById("api-key-input").value)} style={{ background:"#1d4ed8", border:"none", color:"#fff", padding:"8px 20px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"inherit", fontWeight:600 }}>Guardar</button>
            <button onClick={()=>setShowApiModal(false)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"8px 16px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"inherit" }}>Cancelar</button>
          </div>
        </div>
      </div>}

      {/* Header */}
      <div style={{ borderBottom:"1px solid #1e3a5f", padding:"22px 32px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div>
          <div style={{ fontSize:11, color:"#3b82f6", letterSpacing:3, textTransform:"uppercase", marginBottom:4 }}>Arena Nexus · Contabilidad</div>
          <div style={{ fontSize:22, fontWeight:700, color:"#f1f5f9", letterSpacing:-0.5 }}>Gestión de Gastos</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:16 }}>
          <button onClick={()=>setShowApiModal(true)} style={{ background:"transparent", border:"1px solid #1e3a5f", color:apiKey?"#22c55e":"#f59e0b", padding:"5px 12px", borderRadius:6, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>
            {apiKey ? "✓ API configurada" : "⚙ Configurar API"}
          </button>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, color:"#64748b", marginBottom:2 }}>{allMovements.length} movimientos · {invoices.length} facturas · {conciliaciones.length} conciliaciones</div>
          </div>
        </div>
      </div>

      <div style={{ display:"flex", borderBottom:"1px solid #1e3a5f", padding:"0 32px", overflowX:"auto" }}>
        {TABS.map(([key,label]) => <button key={key} onClick={()=>{ setTab(key); if(editMode){ setEditMode(false); cancelEdit(); } }} style={{ background:"none", border:"none", cursor:"pointer", padding:"12px 20px", fontSize:13, fontFamily:"inherit", color:tab===key?"#3b82f6":"#64748b", borderBottom:tab===key?"2px solid #3b82f6":"2px solid transparent", marginBottom:-1, whiteSpace:"nowrap" }}>{label}</button>)}
      </div>

      <div style={{ padding:"24px 32px" }}>

        {/* ══ IMPORTAR ══ */}
        {tab==="importar" && <div>
          <div style={{ display:"flex", gap:32, flexWrap:"wrap", alignItems:"flex-start" }}>
            {/* Left: PDF upload */}
            <div style={{ flex:"1 1 300px", minWidth:280 }}>
              <div style={{ fontSize:15, fontWeight:700, color:"#f1f5f9", marginBottom:6 }}>Documentos PDF</div>
              <div style={{ fontSize:12, color:"#475569", marginBottom:16, lineHeight:1.7 }}>Arrastra facturas, escrituras, ITP o cualquier documento.</div>
              <PdfDropZone files={pdfFiles} disabled={analyzing} onFiles={newFiles => setPdfFiles(prev => { const names = new Set(prev.map(f=>f.name)); return [...prev, ...newFiles.filter(f=>!names.has(f.name))]; })} />
              {pdfFiles.length > 0 && reviewQueue.length === 0 && <button onClick={analyzeAll} disabled={analyzing} style={{ marginTop:14, width:"100%", background:analyzing?"#1e3a5f":"#1d4ed8", border:"none", color:"#fff", padding:"11px", borderRadius:8, cursor:analyzing?"default":"pointer", fontSize:14, fontFamily:"inherit", fontWeight:600 }}>{analyzing ? `Analizando… (${progress.current}/${progress.total})` : `✦ Analizar ${pdfFiles.length>1?pdfFiles.length+" documentos":"documento"} con IA`}</button>}
              {analyzing && progress.total > 0 && <div style={{ marginTop:8 }}><div style={{ background:"#1e3a5f", borderRadius:4, height:4, overflow:"hidden" }}><div style={{ background:"#3b82f6", height:"100%", borderRadius:4, transition:"width 0.4s", width:`${(progress.current/progress.total)*100}%` }} /></div></div>}
              {!apiKey && <div style={{ marginTop:10, fontSize:11, color:"#f59e0b" }}>⚠ Configura la API key antes de analizar</div>}
            </div>
            {/* Right: Extractos bancarios */}
            <div style={{ flex:"1 1 300px", minWidth:280 }}>
              <div style={{ fontSize:15, fontWeight:700, color:"#f1f5f9", marginBottom:6 }}>Extractos bancarios</div>
              <div style={{ fontSize:12, color:"#475569", marginBottom:16, lineHeight:1.7 }}>Importa extractos completos (CC y/o CP). Detecta formato automáticamente.</div>
              <DropZone label="CC" name="Cuenta Corriente" file={ccFile} onFile={setCcFile} />
              <DropZone label="CP" name="Póliza de Crédito" file={cpFile} onFile={setCpFile} />
              <button onClick={handleImport} disabled={importing} style={{ background:importing?"#1e3a5f":"#1d4ed8", border:"none", color:"#fff", padding:"10px 24px", borderRadius:8, cursor:importing?"default":"pointer", fontSize:14, fontFamily:"inherit", fontWeight:600 }}>{importing ? "Procesando…" : "Importar movimientos"}</button>
            </div>
          </div>

          {/* ── Import log (descartados) ── */}
          {importLog.length > 0 && <div style={{ marginTop:20, background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, padding:"14px 18px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <span style={{ fontSize:12, fontWeight:700, color:"#94a3b8" }}>Log de importación</span>
              <button onClick={()=>setImportLog([])} style={{ background:"transparent", border:"none", color:"#475569", cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>✕ cerrar</button>
            </div>
            {importLog.map((entry, i) => (
              <div key={i} style={{ fontSize:12, color:"#fbbf24", padding:"3px 0" }}>{entry.text}</div>
            ))}
          </div>}

          {/* ── Manual entry card for failed PDFs ── */}
          {manualQueue.length > 0 && manualDraft && (() => {
            const manualTotalPct = manualSplits.reduce((a,s)=>a+(s.pct||0),0);
            const manualSplitValid = manualSplits.every(s=>s.activo) && Math.abs(manualTotalPct-100)<0.01;
            const advanceManual = () => {
              setManualSplitMode(false); setManualSplits([{activo:"",pct:50},{activo:"",pct:50}]);
              const remaining = manualQueue.slice(1);
              setManualQueue(remaining);
              if (remaining.length > 0) {
                setManualDraft({ fecha:"", proveedor:"", concepto:"", activo:"", categoria:"", cuantia:0, iva:0, otros:null, numero:"", comentario:"", notas:"", archivo_origen:"", _file:remaining[0].file });
              } else { setManualDraft(null); }
            };
            return <div style={{ marginTop:24, background:"#0a1628", border:"1px solid #f59e0b44", borderRadius:12, overflow:"hidden" }}>
              <div style={{ background:"#422006", padding:"12px 20px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ fontSize:14, fontWeight:700, color:"#fbbf24" }}>⚠ Error IA — rellenar manualmente ({manualQueue.length} pendiente{manualQueue.length!==1?"s":""})</div>
                <span style={{ fontSize:12, color:"#94a3b8" }}>{manualQueue[0].name}</span>
              </div>
              <div style={{ display:"flex", gap:20, padding:20, alignItems:"flex-start" }}>
                {/* Left: PDF preview */}
                <div style={{ flex:"0 0 360px", minWidth:280, maxHeight:500, overflow:"auto" }}>
                  {manualDraft._file && <PdfViewer file={manualDraft._file} />}
                </div>
                {/* Right: form fields */}
                <div style={{ flex:1, minWidth:260 }}>
                  <Field label="Fecha" value={manualDraft.fecha} onChange={v => setManualDraft(p=>({...p,fecha:v}))} required dateAuto />
                  <Field label="Nº Factura" value={manualDraft.numero} onChange={v => setManualDraft(p=>({...p,numero:v}))} />
                  <Field label="Proveedor" value={manualDraft.proveedor} onChange={v => setManualDraft(p=>({...p,proveedor:v}))} required uppercase suggestions={invoices.map(i=>i.proveedor).filter(Boolean)} />
                  <Field label="Concepto" value={manualDraft.concepto} onChange={v => setManualDraft(p=>({...p,concepto:v}))} />
                  {!manualSplitMode
                    ? <Field label="Activo" value={manualDraft.activo} onChange={v => setManualDraft(p=>({...p,activo:v}))} required options={ACTIVOS} />
                    : null}
                  <Field label="Categoría" value={manualDraft.categoria} onChange={v => setManualDraft(p=>({...p,categoria:v}))} required options={CATEGORIAS} />
                  <div style={{ display:"flex", gap:10 }}>
                    <Field label="Cuantía" value={manualDraft.cuantia||""} onChange={v => setManualDraft(p=>({...p,cuantia:parseFloat(String(v).replace(",","."))||0}))} required formula />
                    <Field label="IVA" value={manualDraft.iva||""} onChange={v => setManualDraft(p=>({...p,iva:parseFloat(String(v).replace(",","."))||0}))} formula />
                    <Field label="Retención" value={manualDraft.otros} onChange={v => setManualDraft(p=>({...p,otros:v}))} negative />
                  </div>
                  <div style={{ fontSize:12, color:"#475569", marginBottom:14 }}>
                    Total: <span style={{ color:"#f87171", fontWeight:700 }}>{fmt((manualDraft.cuantia||0)+(manualDraft.iva||0)+(manualDraft.otros||0))}</span>
                  </div>

                  {/* Split mode */}
                  <div style={{ marginBottom:14 }}>
                    <button onClick={()=>{ setManualSplitMode(!manualSplitMode); setManualSplits([{activo:"",pct:50},{activo:"",pct:50}]); }}
                      style={{ background:manualSplitMode?"#1e3a5f":"transparent", border:`1px solid ${manualSplitMode?"#3b82f6":"#1e3a5f"}`, color:manualSplitMode?"#93c5fd":"#475569", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>
                      {manualSplitMode ? "✕ Cancelar split" : "⇅ Repartir entre activos"}
                    </button>
                  </div>
                  {manualSplitMode && <div style={{ marginBottom:14 }}>
                    {manualSplits.map((s, si) => (
                      <SplitRow key={si} split={s} index={si} count={manualSplits.length}
                        base={manualDraft.cuantia} iva={manualDraft.iva} otros={manualDraft.otros}
                        onChange={(idx, field, val) => setManualSplits(prev => prev.map((x, j) => j===idx ? {...x, [field]:val} : x))}
                        onRemove={(idx) => setManualSplits(prev => prev.filter((_,j)=>j!==idx))} />
                    ))}
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <button onClick={()=>setManualSplits(prev=>[...prev,{activo:"",pct:0}])} style={{ background:"transparent", border:"1px solid #1e3a5f", color:"#475569", padding:"4px 12px", borderRadius:6, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>＋ Añadir</button>
                      <span style={{ fontSize:11, color:Math.abs(manualTotalPct-100)<0.01?"#4ade80":"#f87171" }}>Total: {manualTotalPct.toFixed(1)}%</span>
                    </div>
                  </div>}

                  <div style={{ display:"flex", gap:10 }}>
                    <button onClick={async () => {
                      if (!manualDraft.fecha || !manualDraft.proveedor || !manualDraft.categoria || !manualDraft.cuantia) {
                        showFlash("Completa fecha, proveedor, categoría y cuantía.", "err"); return;
                      }
                      // Upload PDF to Storage
                      let archivoPath = "";
                      if (manualDraft._file) {
                        try {
                          const datePrefix = new Date().toISOString().slice(0,7);
                          const safeName = manualQueue[0].name.replace(/[^a-zA-Z0-9._-]/g, "_");
                          archivoPath = `facturas/${datePrefix}/${safeName}`;
                          await uploadFile(manualDraft._file, archivoPath);
                        } catch { archivoPath = ""; }
                      }
                      if (manualSplitMode) {
                        if (!manualSplitValid) { showFlash("Los % deben sumar 100% y todos los activos deben estar seleccionados.", "err"); return; }
                        const newInvs = manualSplits.map((s, si) => ({
                          ...manualDraft, _file: manualDraft._file, activo: s.activo,
                          archivo_origen: archivoPath,
                          numero: manualDraft.numero ? `${manualDraft.numero}-${si+1}` : "",
                          cuantia: parseFloat(((s.pct/100)*(manualDraft.cuantia||0)).toFixed(2)),
                          iva: parseFloat(((s.pct/100)*(manualDraft.iva||0)).toFixed(2)),
                          otros: manualDraft.otros!=null ? parseFloat(((s.pct/100)*(manualDraft.otros||0)).toFixed(2)) : null,
                          comentario: `${s.pct}% de factura original`,
                        }));
                        setReviewQueue(prev => [...prev, ...newInvs]);
                      } else {
                        if (!manualDraft.activo) { showFlash("Selecciona el activo.", "err"); return; }
                        const { _file, ...inv } = manualDraft;
                        setReviewQueue(prev => [...prev, { ...inv, _file, archivo_origen: archivoPath }]);
                      }
                      advanceManual();
                      showFlash("✓ Añadido a la tabla de revisión.");
                    }} style={{ background:"#052e16", border:"1px solid #22c55e", color:"#4ade80", padding:"8px 20px", borderRadius:8, cursor:"pointer", fontSize:13, fontFamily:"inherit", fontWeight:600 }}>✓ Confirmar</button>
                    <button onClick={() => {
                      setSkippedQueue(prev => [...prev, { ...manualDraft, _filename: manualQueue[0].name }]);
                      advanceManual();
                      showFlash("Guardado en pendientes.");
                    }} style={{ background:"transparent", border:"1px solid #1e3a5f", color:"#64748b", padding:"8px 14px", borderRadius:8, cursor:"pointer", fontSize:13, fontFamily:"inherit" }}>Saltar</button>
                    <button onClick={() => {
                      advanceManual();
                      showFlash("Documento eliminado.", "warn");
                    }} style={{ background:"transparent", border:"1px solid #450a0a", color:"#f87171", padding:"8px 14px", borderRadius:8, cursor:"pointer", fontSize:13, fontFamily:"inherit" }}>Eliminar</button>
                  </div>
                </div>
              </div>
            </div>;
          })()}

          {/* ── Skipped / pending review ── */}
          {skippedQueue.length > 0 && <div style={{ marginTop:20, background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, padding:"14px 18px" }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#94a3b8", marginBottom:10 }}>Pendientes de revisión ({skippedQueue.length})</div>
            {skippedQueue.map((item, i) => (
              <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:"1px solid #0d1f35" }}>
                <div>
                  <span style={{ fontSize:12, color:"#fbbf24" }}>{item._filename || "Sin nombre"}</span>
                  {item.proveedor && <span style={{ fontSize:11, color:"#64748b", marginLeft:8 }}>{item.proveedor}</span>}
                  {item.fecha && <span style={{ fontSize:11, color:"#475569", marginLeft:8 }}>{item.fecha}</span>}
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  <button onClick={() => {
                    setManualQueue([{ name: item._filename, file: item._file }]);
                    setManualDraft({ ...item }); setManualSplitMode(false); setManualSplits([{activo:"",pct:50},{activo:"",pct:50}]);
                    setSkippedQueue(prev => prev.filter((_, j) => j !== i));
                  }} style={{ background:"#0f2942", border:"1px solid #1e3a5f", color:"#93c5fd", padding:"3px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>Editar</button>
                  <button onClick={() => setSkippedQueue(prev => prev.filter((_, j) => j !== i))}
                    style={{ background:"transparent", border:"1px solid #450a0a", color:"#f87171", padding:"3px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>✕</button>
                </div>
              </div>
            ))}
          </div>}

          {/* ── Review table ── */}
          {reviewQueue.length > 0 && <div style={{ marginTop:28 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
              <div style={{ fontSize:15, fontWeight:700, color:"#f59e0b" }}>⚠ {reviewQueue.length} documentos pendientes de revisión</div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={()=>{
                  const valid = reviewQueue.filter(inv => inv.fecha && inv.proveedor && inv.categoria && inv.cuantia && inv.activo);
                  if (valid.length === 0) { showFlash("Rellena al menos activo y categoría en cada fila.","err"); return; }
                  const toSave = valid.map(inv => { const { _file, _error, ...rest } = inv; return { ...rest, id: crypto.randomUUID() }; });
                  addInvoices(toSave);
                  const remaining = reviewQueue.filter(inv => !(inv.fecha && inv.proveedor && inv.categoria && inv.cuantia && inv.activo));
                  setReviewQueue(remaining);
                  setPreviewFile(null);
                  if (remaining.length === 0) showFlash(`✓ ${toSave.length} documentos guardados.`);
                  else showFlash(`✓ ${toSave.length} guardados. ${remaining.length} incompletos.`, "warn");
                }} style={{ background:"#052e16", border:"1px solid #22c55e", color:"#4ade80", padding:"8px 20px", borderRadius:8, cursor:"pointer", fontSize:13, fontFamily:"inherit", fontWeight:600 }}>✓ Confirmar todos</button>
                <button onClick={()=>{ setReviewQueue([]); setPreviewFile(null); showFlash("Revisión descartada.","warn"); }} style={{ background:"transparent", border:"1px solid #450a0a", color:"#f87171", padding:"8px 14px", borderRadius:8, cursor:"pointer", fontSize:13, fontFamily:"inherit" }}>Descartar todos</button>
              </div>
            </div>
            <div style={{ display:"flex", gap:20, alignItems:"flex-start" }}>
              <div style={{ flex:1, overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                  <thead><tr style={{ background:"#0d1f35" }}>
                    {["Fecha","Proveedor","Concepto","Activo","Categoría","Cuantía","IVA","Ret.","Total","Notas","Doc",""].map(h => <th key={h} style={{ padding:"8px 8px", textAlign:["Cuantía","IVA","Ret.","Total"].includes(h)?"right":h==="Doc"?"center":"left", color:"#475569", fontWeight:600, fontSize:10, letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #1e3a5f", whiteSpace:"nowrap" }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {reviewQueue.map((inv,i) => {
                      const t = (inv.cuantia||0)+(inv.iva||0)+(inv.otros||0);
                      const upd = (field, val) => setReviewQueue(prev => prev.map((r,j) => j===i ? {...r, [field]:val} : r));
                      return <tr key={i} style={{ background:(!inv.activo||!inv.categoria)?"#1f0a0a":i%2===0?"#0a1628":"#080f1a" }}>
                        <td style={{ padding:"4px 6px" }}><input value={inv.fecha||""} onChange={e=>upd("fecha",e.target.value)} style={{ width:80, background:"#080f1a", border:`1px solid ${inv.fecha?"#1e3a5f":"#ef4444"}`, borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none" }} /></td>
                        <td style={{ padding:"4px 6px" }}><input value={inv.proveedor||""} onChange={e=>upd("proveedor",e.target.value)} style={{ width:120, background:"#080f1a", border:"1px solid #1e3a5f", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none" }} /></td>
                        <td style={{ padding:"4px 6px" }}><input value={inv.concepto||""} onChange={e=>upd("concepto",e.target.value)} style={{ width:140, background:"#080f1a", border:"1px solid #1e3a5f", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none" }} /></td>
                        <td style={{ padding:"4px 6px" }}><select value={inv.activo||""} onChange={e=>upd("activo",e.target.value)} style={{ background:"#080f1a", border:`1px solid ${inv.activo?"#1e3a5f":"#ef4444"}`, borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none" }}><option value="">—</option>{ACTIVOS.map(a=><option key={a} value={a}>{a}</option>)}</select></td>
                        <td style={{ padding:"4px 6px" }}><select value={inv.categoria||""} onChange={e=>upd("categoria",e.target.value)} style={{ width:120, background:"#080f1a", border:`1px solid ${inv.categoria?"#1e3a5f":"#ef4444"}`, borderRadius:4, color:"#e2e8f0", padding:"4px 4px", fontFamily:"inherit", fontSize:11, outline:"none" }}><option value="">—</option>{CATEGORIAS.map(c=><option key={c} value={c}>{c}</option>)}</select></td>
                        <td style={{ padding:"4px 6px" }}><input type="number" value={inv.cuantia||""} onChange={e=>upd("cuantia",parseFloat(e.target.value)||0)} style={{ width:70, background:"#080f1a", border:"1px solid #1e3a5f", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none", textAlign:"right" }} /></td>
                        <td style={{ padding:"4px 6px" }}><input type="number" value={inv.iva||""} onChange={e=>upd("iva",parseFloat(e.target.value)||0)} style={{ width:60, background:"#080f1a", border:"1px solid #1e3a5f", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none", textAlign:"right" }} /></td>
                        <td style={{ padding:"4px 6px" }}><input type="number" value={inv.otros||""} onChange={e=>upd("otros",parseFloat(e.target.value)||null)} style={{ width:60, background:"#080f1a", border:"1px solid #1e3a5f", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none", textAlign:"right" }} /></td>
                        <td style={{ padding:"4px 6px", textAlign:"right", color:"#f87171", fontWeight:600, fontSize:12 }}>{fmt(t)}</td>
                        <td style={{ padding:"4px 6px", color:"#fbbf24", fontSize:11, maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={inv.notas||""}>{inv.notas||"—"}</td>
                        <td style={{ padding:"4px 6px", textAlign:"center" }}>
                          {inv._file ? <button onClick={()=>{ const url = URL.createObjectURL(inv._file); window.open(url, "_blank"); }} title="Ver PDF" style={{ background:"transparent", border:"none", color:"#3b82f6", cursor:"pointer", fontSize:14, padding:"2px 5px" }}>📄</button> : "—"}
                        </td>
                        <td style={{ padding:"4px 6px", textAlign:"center", whiteSpace:"nowrap" }}>
                          <button onClick={()=>{
                            if (!inv.fecha || !inv.proveedor || !inv.categoria || !inv.cuantia || !inv.activo) { showFlash("Completa fecha, proveedor, activo, categoría y cuantía.","err"); return; }
                            const { _file, _error, ...rest } = inv;
                            addInvoices([{ ...rest, id: crypto.randomUUID() }]);
                            setReviewQueue(prev => prev.filter((_,j) => j!==i));
                            showFlash("✓ Factura guardada.");
                          }} title="Confirmar" style={{ background:"transparent", border:"none", color:"#4ade80", cursor:"pointer", fontSize:13, padding:"2px 5px" }}>✓</button>
                          <button onClick={()=>setReviewQueue(prev=>prev.filter((_,j)=>j!==i))} title="Descartar" style={{ background:"transparent", border:"none", color:"#475569", cursor:"pointer", fontSize:13, padding:"2px 5px" }}>✕</button>
                        </td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>}
        </div>}

        {/* ══ BASE DE DATOS ══ */}
        {tab==="bd" && <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div style={{ fontSize:13, color:"#64748b" }}>{bdMovements.length} de {allMovements.length} movimientos</div>
            <div style={{ display:"flex", gap:8 }}>
              {editMode && <button onClick={addManualRow} style={{ background:"#052e16", border:"1px solid #22c55e", color:"#4ade80", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>＋ Añadir fila</button>}
              <button onClick={()=>{ setEditMode(v=>!v); cancelEdit(); }} style={{ background:editMode?"#1e3a5f":"transparent", border:`1px solid ${editMode?"#3b82f6":"#1e3a5f"}`, color:editMode?"#93c5fd":"#64748b", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>{editMode?"✓ Salir de edición":"✏ Editar"}</button>
              <button onClick={exportCSV} style={{ background:"#0f2942", border:"1px solid #1e3a5f", color:"#93c5fd", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Exportar CSV</button>
              {confirmBorrarTodoStep===0
                ? <button onClick={()=>setConfirmBorrarTodoStep(1)} style={{ background:"transparent", border:"1px solid #450a0a", color:"#f87171", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Borrar todo</button>
                : confirmBorrarTodoStep===1
                ? <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:12, color:"#f87171" }}>¿Borrar TODOS los datos?</span>
                    <button onClick={()=>setConfirmBorrarTodoStep(2)} style={{ background:"#450a0a", border:"1px solid #ef4444", color:"#f87171", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Sí</button>
                    <button onClick={()=>setConfirmBorrarTodoStep(0)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>No</button>
                  </span>
                : <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:12, color:"#ef4444", fontWeight:700 }}>⚠ Se borrarán facturas, movimientos, conciliaciones y G. Financieros. ¿Seguro?</span>
                    <button onClick={async ()=>{
                      await deleteAllConciliaciones().catch(()=>{});
                      await deleteAllMovimientosBancarios().catch(()=>{});
                      await deleteAllGastosFinancieros().catch(()=>{});
                      setInvoices([]); invoicesRef.current=[]; await deleteAllInvoices().catch(()=>{});
                      setBankMovements([]); setConciliaciones([]); setEntries([]);
                      try { localStorage.removeItem("gf-entries-arena-nexus"); } catch{}
                      setConfirmBorrarTodoStep(0);
                      showFlash("Todos los datos eliminados (excepto escrituras).","err");
                    }} style={{ background:"#7f1d1d", border:"1px solid #ef4444", color:"#fca5a5", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:700 }}>CONFIRMAR</button>
                    <button onClick={()=>setConfirmBorrarTodoStep(0)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Cancelar</button>
                  </span>}
            </div>
          </div>
          {/* Clear filters */}
          <div style={{ display:"flex", gap:8, marginBottom:14, alignItems:"center" }}>
            {hasActiveFilters && <button onClick={clearAllFilters} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>✕ Limpiar filtros</button>}
            <span style={{ fontSize:11, color:"#334155" }}>{bdMovements.length} de {allMovements.length}</span>
          </div>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
              <thead><tr style={{ background:"#0d1f35" }}>
                {[
                  { key:"fecha", label:"Fecha", filterable:true, sortable:true },
                  { key:"periodo", label:"Período", filterable:true, sortable:true },
                  { key:"tipo", label:"Tipo", filterable:true, sortable:true },
                  { key:"proveedor", label:"Proveedor", filterable:true, sortable:true },
                  { key:"concepto", label:"Concepto", sortable:true },
                  { key:"activo", label:"Activo", filterable:true, sortable:true },
                  { key:"categoria", label:"Categoría", filterable:true, sortable:true },
                  { key:"cuantia", label:"Cuantía", align:"right" },
                  { key:"iva", label:"IVA", align:"right" },
                  { key:"otros", label:"Ret.", align:"right" },
                  { key:"total", label:"Total", align:"right" },
                  { key:"estado", label:"Estado", align:"center" },
                  { key:"doc", label:"Doc", align:"center" },
                  { key:"actions", label:"" },
                ].map(col => (
                  <th key={col.key} style={{ padding:"9px 10px", textAlign:col.align||"left", color:bdFilters[col.key]?"#3b82f6":"#475569", fontWeight:600, fontSize:10, letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #1e3a5f", whiteSpace:"nowrap", position:"relative", cursor:col.filterable?"pointer":"default" }}
                    onClick={()=>{ if(col.filterable) setOpenFilterCol(openFilterCol===col.key?null:col.key) }}>
                    {col.label}
                    {col.filterable && <span style={{ marginLeft:4, fontSize:8, color:bdFilters[col.key]?"#3b82f6":"#334155" }}>▼</span>}
                    {col.filterable && <FilterDropdown
                      column={col.key}
                      values={bdUniqueVals[col.key]||[]}
                      selected={bdFilters[col.key]||null}
                      isOpen={openFilterCol===col.key}
                      onToggle={setOpenFilterCol}
                      onApply={(val)=>setFilter(col.key,val)}
                      onSort={col.sortable ? (dir) => { setBdSortCol(col.key); setBdSortDir(dir); } : null}
                    />}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {bdMovements.map((mov,i) => {
                  const t = (mov.cuantia||0)+(mov.iva||0)+(mov.otros||0);
                  const tc = mov.tipo==="Escritura"?"#4ade80":mov.tipo==="G. Financiero"?"#8b5cf6":mov.tipo==="Impuesto"?"#fb923c":"#60a5fa";
                  const isEditing = editingId === mov.id && (mov.tipo === "Factura" || mov.tipo === "Impuesto");

                  if (isEditing && editDraft) {
                    // ── Editing row ──
                    const ed = editDraft;
                    const etotal = (parseFloat(ed.cuantia)||0)+(parseFloat(ed.iva)||0)+(ed.otros?parseFloat(ed.otros):0);
                    return <><tr key={mov.id+"-edit"} style={{ background:"#0d1f35" }}>
                      <td style={{ padding:"4px 6px" }}><input value={ed.fecha||""} onChange={e=>setEditDraft(d=>({...d,fecha:e.target.value}))} style={{ width:80, background:"#080f1a", border:"1px solid #3b82f6", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none" }} /></td>
                      <td style={{ padding:"4px 6px" }}><span style={{ background:"#0f2942", color:"#93c5fd", padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:600 }}>{getQuarter(ed.fecha)}</span></td>
                      <td style={{ padding:"4px 6px" }}><select value={isImpuesto(ed) ? "Impuesto" : "Factura"} onChange={e=>{
                        const newTipo = e.target.value;
                        setEditDraft(d => {
                          let com = (d.comentario||"").replace(/\[tipo:\w+\]/gi, "").trim();
                          const autoTipo = isImpuesto({...d, comentario:""});
                          // Only add tag if overriding the auto-detected tipo
                          if ((newTipo==="Impuesto") !== autoTipo) com = `[tipo:${newTipo}] ${com}`.trim();
                          return {...d, comentario: com};
                        });
                      }} style={{ background:"#080f1a", border:"1px solid #3b82f6", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:11, outline:"none" }}><option value="Factura">Factura</option><option value="Impuesto">Impuesto</option></select></td>
                      <td style={{ padding:"4px 6px" }}><input value={ed.proveedor||""} onChange={e=>setEditDraft(d=>({...d,proveedor:e.target.value}))} style={{ width:120, background:"#080f1a", border:"1px solid #3b82f6", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none" }} /></td>
                      <td style={{ padding:"4px 6px" }}><input value={ed.concepto||""} onChange={e=>setEditDraft(d=>({...d,concepto:e.target.value}))} style={{ width:140, background:"#080f1a", border:"1px solid #3b82f6", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none" }} /></td>
                      <td style={{ padding:"4px 6px" }}>
                        {!editSplitMode
                          ? <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                              <select value={ed.activo||""} onChange={e=>setEditDraft(d=>({...d,activo:e.target.value}))} style={{ background:"#080f1a", border:"1px solid #3b82f6", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none" }}><option value="">—</option>{ACTIVOS.map(a=><option key={a} value={a}>{a}</option>)}</select>
                              <button onClick={()=>{ setEditSplitMode(true); setEditSplits([{activo:ed.activo||"",pct:50},{activo:"",pct:50}]); }} title="Repartir entre activos" style={{ background:"transparent", border:"1px solid #1e3a5f", color:"#475569", padding:"2px 6px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"inherit" }}>⇅</button>
                            </div>
                          : <span style={{ fontSize:10, color:"#fbbf24" }}>Split ↓</span>}
                      </td>
                      <td style={{ padding:"4px 6px" }}><select value={ed.categoria||""} onChange={e=>setEditDraft(d=>({...d,categoria:e.target.value}))} style={{ width:120, background:"#080f1a", border:"1px solid #3b82f6", borderRadius:4, color:"#e2e8f0", padding:"4px 4px", fontFamily:"inherit", fontSize:11, outline:"none" }}><option value="">—</option>{CATEGORIAS.map(c=><option key={c} value={c}>{c}</option>)}</select></td>
                      <td style={{ padding:"4px 6px" }}><input type="number" value={ed.cuantia||""} onChange={e=>setEditDraft(d=>({...d,cuantia:e.target.value}))} style={{ width:70, background:"#080f1a", border:"1px solid #3b82f6", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none", textAlign:"right" }} /></td>
                      <td style={{ padding:"4px 6px" }}><input type="number" value={ed.iva||""} onChange={e=>setEditDraft(d=>({...d,iva:e.target.value}))} style={{ width:60, background:"#080f1a", border:"1px solid #3b82f6", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none", textAlign:"right" }} /></td>
                      <td style={{ padding:"4px 6px" }}><input type="number" value={ed.otros||""} onChange={e=>setEditDraft(d=>({...d,otros:e.target.value}))} style={{ width:60, background:"#080f1a", border:"1px solid #3b82f6", borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none", textAlign:"right" }} /></td>
                      <td style={{ padding:"4px 6px", textAlign:"right", color:"#f87171", fontWeight:600 }}>{fmt(etotal)}</td>
                      <td style={{ padding:"4px 6px", textAlign:"center" }}><span style={{ color:"#334155", fontSize:10 }}>—</span></td>
                      <td style={{ padding:"4px 6px" }}></td>
                      <td style={{ padding:"4px 6px", whiteSpace:"nowrap" }}>
                        <button onClick={saveEdit} style={{ background:"#052e16", border:"1px solid #22c55e", color:"#4ade80", padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", marginRight:4 }}>✓</button>
                        <button onClick={cancelEdit} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>✕</button>
                      </td>
                    </tr>
                    {editSplitMode && editSplits.map((sp, si) => {
                      const spTotal = (sp.pct/100) * ((parseFloat(ed.cuantia)||0)+(parseFloat(ed.iva)||0)+(ed.otros?parseFloat(ed.otros):0));
                      return <tr key={`split-${si}`} style={{ background:"#0d1f35" }}>
                        <td colSpan={5} style={{ padding:"4px 6px", textAlign:"right" }}>
                          {si === 0 && <button onClick={()=>{ setEditSplitMode(false); setEditSplits([{activo:"",pct:50},{activo:"",pct:50}]); }} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"inherit", marginRight:8 }}>✕ Cancelar split</button>}
                          <span style={{ fontSize:10, color:"#fbbf24" }}>Parte {si+1}</span>
                        </td>
                        <td style={{ padding:"4px 6px" }}><select value={sp.activo} onChange={e=>setEditSplits(prev=>prev.map((x,j)=>j===si?{...x,activo:e.target.value}:x))} style={{ background:"#080f1a", border:`1px solid ${sp.activo?"#3b82f6":"#ef4444"}`, borderRadius:4, color:"#e2e8f0", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none" }}><option value="">—</option>{ACTIVOS.map(a=><option key={a} value={a}>{a}</option>)}</select></td>
                        <td colSpan={2} style={{ padding:"4px 6px" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                            <input type="number" min="0" max="100" step="0.01" value={sp.pct} onChange={e=>setEditSplits(prev=>prev.map((x,j)=>j===si?{...x,pct:parseFloat(e.target.value)||0}:x))} style={{ width:50, background:"#080f1a", border:"1px solid #3b82f6", borderRadius:4, color:"#93c5fd", padding:"4px 6px", fontFamily:"inherit", fontSize:12, outline:"none", textAlign:"right" }} /><span style={{ color:"#475569", fontSize:10 }}>%</span>
                          </div>
                        </td>
                        <td style={{ padding:"4px 6px", textAlign:"right", color:"#4ade80", fontSize:12, fontWeight:600 }}>{fmt(spTotal)}</td>
                        <td colSpan={2} style={{ padding:"4px 6px", textAlign:"right" }}>
                          {si === editSplits.length - 1 && <button onClick={()=>setEditSplits(prev=>[...prev,{activo:"",pct:0}])} style={{ background:"transparent", border:"1px solid #1e3a5f", color:"#475569", padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"inherit" }}>＋</button>}
                          {editSplits.length > 2 && <button onClick={()=>setEditSplits(prev=>prev.filter((_,j)=>j!==si))} style={{ background:"transparent", border:"none", color:"#475569", cursor:"pointer", fontSize:12, padding:"2px 4px", marginLeft:4 }}>✕</button>}
                        </td>
                        <td style={{ padding:"4px 6px" }}>
                          {si === editSplits.length - 1 && <span style={{ fontSize:10, color:Math.abs(editSplits.reduce((a,s)=>a+(s.pct||0),0)-100)<0.01?"#4ade80":"#f87171" }}>{editSplits.reduce((a,s)=>a+(s.pct||0),0).toFixed(0)}%</span>}
                        </td>
                      </tr>;
                    })}
                    </>;
                  }

                  // ── Normal row ──
                  return <tr key={mov.id+"-"+i} style={{ background:i%2===0?"#0a1628":"#080f1a", cursor:editMode&&(mov.tipo==="Factura"||mov.tipo==="Impuesto")?"pointer":"default" }} onMouseEnter={e=>e.currentTarget.style.background="#0d1f35"} onMouseLeave={e=>e.currentTarget.style.background=i%2===0?"#0a1628":"#080f1a"} onClick={()=>{ if(editMode && (mov.tipo==="Factura"||mov.tipo==="Impuesto") && editingId!==mov.id) startEdit(mov); }}>
                    <td style={{ padding:"8px 10px", color:"#94a3b8", whiteSpace:"nowrap" }}>{mov.fecha}</td>
                    <td style={{ padding:"8px 10px" }}><span style={{ background:"#0f2942", color:"#93c5fd", padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:600 }}>{getQuarter(mov.fecha)}</span></td>
                    <td style={{ padding:"8px 10px" }}><span style={{ background:`${tc}15`, color:tc, border:`1px solid ${tc}30`, padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:600 }}>{mov.tipo}</span></td>
                    <td style={{ padding:"8px 10px", color:"#cbd5e1", maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{mov.proveedor}</td>
                    <td style={{ padding:"8px 10px", color:"#94a3b8", maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{mov.concepto}</td>
                    <td style={{ padding:"8px 10px" }}><span style={{ background:"#0f2942", color:"#60a5fa", padding:"2px 7px", borderRadius:4, fontSize:11, fontWeight:700 }}>{mov.activo}</span></td>
                    <td style={{ padding:"8px 10px", color:"#64748b", fontSize:11, maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{mov.categoria}</td>
                    <td style={{ padding:"8px 10px", textAlign:"right", color:"#e2e8f0" }}>{fmt(mov.cuantia||0)}</td>
                    <td style={{ padding:"8px 10px", textAlign:"right", color:"#64748b" }}>{(mov.iva||0)!==0?fmt(mov.iva):"—"}</td>
                    <td style={{ padding:"8px 10px", textAlign:"right", color:mov.otros?"#f59e0b":"#334155" }}>{mov.otros?fmt(mov.otros):"—"}</td>
                    <td style={{ padding:"8px 10px", textAlign:"right", color:"#f87171", fontWeight:600 }}>{fmt(t)}</td>
                    <td style={{ padding:"8px 6px", textAlign:"center" }}>
                      {(mov.tipo==="Factura"||mov.tipo==="Impuesto") ? (() => { const paid = bdConcFacIds.has(mov.id); return <span style={{ background:paid?"#052e16":"#1c1917", color:paid?"#4ade80":"#f59e0b", padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:600 }}>{paid?"Pagada":"Pdte"}</span>; })() : <span style={{ color:"#1e3a5f", fontSize:10 }}>—</span>}
                    </td>
                    <td style={{ padding:"8px 6px", textAlign:"center" }}>
                      {hasDoc(mov.archivo_origen)
                        ? <button onClick={(e)=>{e.stopPropagation();openDoc(mov.archivo_origen)}} title="Ver documento" style={{ background:"transparent", border:"none", color:"#3b82f6", cursor:"pointer", fontSize:14, padding:"2px 5px" }}>📎</button>
                        : <span style={{ color:"#1e3a5f", fontSize:11 }}>—</span>}
                    </td>
                    <td style={{ padding:"8px 6px", textAlign:"center" }}>
                      {(mov.tipo==="Factura"||mov.tipo==="Impuesto") && !editMode && (delConfirm===mov.id
                        ? <span><button onClick={()=>{ const u=invoices.filter(x=>x.id!==mov.id); invoicesRef.current=u; setInvoices(u); deleteInvoice(mov.id).catch(()=>{}); setDelConfirm(null); showFlash("Eliminada.","warn"); }} style={{ background:"#450a0a", border:"1px solid #ef4444", color:"#f87171", padding:"2px 7px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", marginRight:4 }}>Sí</button><button onClick={()=>setDelConfirm(null)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"2px 7px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>No</button></span>
                        : <button onClick={(e)=>{e.stopPropagation();setDelConfirm(mov.id)}} style={{ background:"transparent", border:"none", color:"#334155", cursor:"pointer", fontSize:13, padding:"2px 5px" }}>✕</button>)}
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>}

        {/* ══ FACTURAS IVA/IRPF ══ */}
        {tab==="facturas" && (() => {
          // Build year options from quarters
          const yearSet = new Set(quarters.map(q => "20" + q.slice(-2)));
          const yearOptions = [...yearSet].sort().reverse();

          return <div>
            {/* Filter buttons: years + quarters, most recent first */}
            <div style={{ display:"flex", gap:6, marginBottom:16, flexWrap:"wrap" }}>
              <button onClick={()=>setFilterQ("Todos")} style={{ background:filterQ==="Todos"?"#1e3a5f":"transparent", border:`1px solid ${filterQ==="Todos"?"#3b82f6":"#1e3a5f"}`, color:filterQ==="Todos"?"#93c5fd":"#64748b", padding:"5px 14px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:filterQ==="Todos"?600:400 }}>Todos</button>
              {yearOptions.map(yr => <button key={yr} onClick={()=>setFilterQ(yr)} style={{ background:filterQ===yr?"#1e3a5f":"transparent", border:`1px solid ${filterQ===yr?"#3b82f6":"#1e3a5f"}`, color:filterQ===yr?"#93c5fd":"#64748b", padding:"5px 14px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:filterQ===yr?600:400 }}>{yr}</button>)}
              {quarters.slice().reverse().map(q => <button key={q} onClick={()=>setFilterQ(q)} style={{ background:filterQ===q?"#1e3a5f":"transparent", border:`1px solid ${filterQ===q?"#3b82f6":"#1e3a5f"}`, color:filterQ===q?"#93c5fd":"#64748b", padding:"5px 14px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:filterQ===q?600:400 }}>{q}</button>)}
            </div>

            {/* Summary cards */}
            <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:20 }}>
              {[["Base imponible",totalBaseIVA,"#60a5fa"],["IVA soportado",totalIVASop,"#fbbf24"],["Retenciones",totalRet,"#f59e0b"],["Neto",totalBaseIVA+totalIVASop+totalRet,"#f87171"]].map(([l,v,c]) =>
                <div key={l} style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, padding:"12px 18px", flex:"1 1 160px", minWidth:140 }}>
                  <div style={{ fontSize:10, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>{l}{filterQ!=="Todos"?` (${filterQ})`:""}</div>
                  <div style={{ fontSize:18, fontWeight:700, color:c }}>{fmt(v)}</div>
                </div>)}
            </div>

            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <div style={{ fontSize:12, color:"#475569" }}>{facturasIVA.length} facturas{filterQ!=="Todos" ? ` en ${filterQ}` : ""}</div>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                {hasFacFilters && <button onClick={()=>setFacFilters({})} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>✕ Limpiar filtros</button>}
                {!confirmBorrarFacturas
                  ? <button onClick={()=>setConfirmBorrarFacturas(true)} style={{ background:"transparent", border:"1px solid #450a0a", color:"#f87171", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>{filterQ!=="Todos" ? `Borrar ${filterQ}` : "Borrar facturas"}</button>
                  : <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:12, color:"#f87171" }}>¿Seguro? Se borrarán {facturasIVA.length} facturas{filterQ!=="Todos"?` de ${filterQ}`:""}</span>
                      <button onClick={async ()=>{
                        if (filterQ === "Todos") {
                          // Borrar todas las facturas (no impuestos)
                          const toDelete = invoices.filter(inv => !isImpuesto(inv));
                          const toKeep = invoices.filter(inv => isImpuesto(inv));
                          for (const inv of toDelete) { await deleteInvoice(inv.id).catch(()=>{}); }
                          invoicesRef.current = toKeep; setInvoices(toKeep);
                        } else {
                          // Borrar solo las del filtro actual
                          const idsToDelete = new Set(facturasIVA.map(f => f.id));
                          const toKeep = invoices.filter(inv => !idsToDelete.has(inv.id));
                          for (const id of idsToDelete) { await deleteInvoice(id).catch(()=>{}); }
                          invoicesRef.current = toKeep; setInvoices(toKeep);
                        }
                        setConfirmBorrarFacturas(false);
                        showFlash(`Facturas${filterQ!=="Todos"?` de ${filterQ}`:""} eliminadas.`,"err");
                      }} style={{ background:"#450a0a", border:"1px solid #ef4444", color:"#f87171", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Sí</button>
                      <button onClick={()=>setConfirmBorrarFacturas(false)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>No</button>
                    </span>}
              </div>
            </div>

            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead><tr style={{ background:"#0d1f35" }}>
                  {[
                    { key:"numero", label:"Nº" },
                    { key:"fecha", label:"Fecha" },
                    { key:"periodo", label:"Período", filterable:true },
                    { key:"proveedor", label:"Proveedor", filterable:true },
                    { key:"concepto", label:"Concepto" },
                    { key:"activo", label:"Activo", filterable:true },
                    { key:"categoria", label:"Categoría", filterable:true },
                    { key:"cuantia", label:"Base", align:"right" },
                    { key:"iva", label:"IVA", align:"right" },
                    { key:"otros", label:"Retención", align:"right" },
                    { key:"total", label:"Total", align:"right" },
                    { key:"estado", label:"Estado", align:"center" },
                    { key:"doc", label:"Doc", align:"center" },
                    { key:"del", label:"", align:"center" },
                  ].map(col => (
                    <th key={col.key} style={{ padding:"9px 10px", textAlign:col.align||"left", color:facFilters[col.key]?"#3b82f6":"#475569", fontWeight:600, fontSize:10, letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #1e3a5f", whiteSpace:"nowrap", position:"relative", cursor:col.filterable?"pointer":"default" }}
                      onClick={()=>{ if(col.filterable) setFacFilterCol(facFilterCol===col.key?null:col.key) }}>
                      {col.label}
                      {col.filterable && <span style={{ marginLeft:4, fontSize:8, color:facFilters[col.key]?"#3b82f6":"#334155" }}>▼</span>}
                      {col.filterable && <FilterDropdown
                        column={col.key}
                        values={facUniqueVals[col.key]||[]}
                        selected={facFilters[col.key]||null}
                        isOpen={facFilterCol===col.key}
                        onToggle={setFacFilterCol}
                        onApply={(val)=>setFacFilter(col.key,val)}
                        onSort={null}
                      />}
                    </th>
                  ))}
                </tr></thead>
                <tbody>
                  {facturasIVA.map((inv,i) => <tr key={inv.id} style={{ background:i%2===0?"#0a1628":"#080f1a" }} onMouseEnter={e=>e.currentTarget.style.background="#0d1f35"} onMouseLeave={e=>e.currentTarget.style.background=i%2===0?"#0a1628":"#080f1a"}>
                    <td style={{ padding:"8px 10px", color:"#475569", fontSize:11, whiteSpace:"nowrap" }}>{inv.numero||"—"}</td>
                    <td style={{ padding:"8px 10px", color:"#94a3b8", whiteSpace:"nowrap" }}>{inv.fecha}</td>
                    <td style={{ padding:"8px 10px" }}><span style={{ background:"#0f2942", color:"#93c5fd", padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:600 }}>{getQuarter(inv.fecha)}</span></td>
                    <td style={{ padding:"8px 10px", color:"#cbd5e1", maxWidth:130, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{inv.proveedor}</td>
                    <td style={{ padding:"8px 10px", color:"#94a3b8", maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{inv.concepto}</td>
                    <td style={{ padding:"8px 10px" }}><span style={{ background:"#0f2942", color:"#60a5fa", padding:"2px 7px", borderRadius:4, fontSize:11, fontWeight:700 }}>{inv.activo}</span></td>
                    <td style={{ padding:"8px 10px", color:"#64748b", fontSize:11, maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{inv.categoria}</td>
                    <td style={{ padding:"8px 10px", textAlign:"right", color:"#e2e8f0" }}>{fmt(inv.cuantia||0)}</td>
                    <td style={{ padding:"8px 10px", textAlign:"right", color:"#fbbf24", fontWeight:600 }}>{fmt(inv.iva||0)}</td>
                    <td style={{ padding:"8px 10px", textAlign:"right", color:inv.otros?"#f59e0b":"#334155" }}>{inv.otros?fmt(inv.otros):"—"}</td>
                    <td style={{ padding:"8px 10px", textAlign:"right", color:"#f87171", fontWeight:600 }}>{fmt((inv.cuantia||0)+(inv.iva||0)+(inv.otros||0))}</td>
                    <td style={{ padding:"8px 6px", textAlign:"center" }}>
                      {(() => { const paid = bdConcFacIds.has(inv.id); return <span style={{ background: paid?"#052e16":"#1c1917", color: paid?"#4ade80":"#f59e0b", padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:600 }}>{paid?"Pagada":"Pendiente"}</span>; })()}
                    </td>
                    <td style={{ padding:"8px 6px", textAlign:"center" }}>
                      {hasDoc(inv.archivo_origen) ? <button onClick={()=>openDoc(inv.archivo_origen)} style={{ background:"transparent", border:"none", color:"#3b82f6", cursor:"pointer", fontSize:14, padding:"2px 5px" }}>📎</button> : <span style={{ color:"#1e3a5f" }}>—</span>}
                    </td>
                    <td style={{ padding:"8px 6px", textAlign:"center" }}>
                      {delConfirm===inv.id
                        ? <span style={{ fontSize:11 }}><button onClick={()=>{ const u=invoices.filter(x=>x.id!==inv.id); invoicesRef.current=u; setInvoices(u); deleteInvoice(inv.id).catch(()=>{}); setDelConfirm(null); showFlash("Eliminada.","warn"); }} style={{ background:"#450a0a", border:"1px solid #ef4444", color:"#f87171", padding:"2px 7px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", marginRight:4 }}>Sí</button><button onClick={()=>setDelConfirm(null)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"2px 7px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>No</button></span>
                        : <button onClick={()=>setDelConfirm(inv.id)} style={{ background:"transparent", border:"none", color:"#334155", cursor:"pointer", fontSize:13, padding:"2px 5px" }} title="Eliminar">✕</button>}
                    </td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          </div>;
        })()}

        {/* ══ DASHBOARD ══ */}
        {tab==="dashboard" && <DashboardTab invoices={invoices} entries={entries} />}

        {/* ══ G. FINANCIEROS ══ */}
        {tab==="gf" && (() => {
          // Deposit calculation: 1.250.000€ at 1.7% annual from 07/07/2025
          const depositAmount = 1250000;
          const depositRate = 0.017;
          const depositStart = new Date(2025, 6, 7); // 07/07/2025
          const today = new Date();
          const daysSinceDeposit = Math.max(0, Math.floor((today - depositStart) / (1000*60*60*24)));
          const depositAccrued = depositAmount * depositRate * (daysSinceDeposit / 365);
          const netFinancial = total + depositAccrued; // total is negative (costs), deposit is positive

          return <div>
          {/* Summary cards on top */}
          {entries.length > 0 && <div style={{ marginBottom:28 }}>
            <div style={{ display:"flex", gap:14, flexWrap:"wrap", marginBottom:20 }}>
              {/* Póliza card */}
              <div style={{ flex:"1 1 240px", minWidth:220, background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, overflow:"hidden" }}>
                <div style={{ background:"#0f294220", borderBottom:"1px solid #1e3a5f", padding:"10px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ color:"#3b82f6", fontSize:12, fontWeight:700 }}>Póliza de crédito</span>
                  <span style={{ color:"#f87171", fontSize:16, fontWeight:700 }}>{fmt(summary["G. Financiero – Póliza"]||0)}</span>
                </div>
                <div style={{ padding:"10px 16px" }}>
                  {entries.filter(e=>e.cat==="G. Financiero – Póliza").reduce((acc,e)=>{ acc[e.sub]=(acc[e.sub]||0)+e.amount; return acc; }, {}) && Object.entries(entries.filter(e=>e.cat==="G. Financiero – Póliza").reduce((acc,e)=>{ acc[e.sub]=(acc[e.sub]||0)+e.amount; return acc; }, {})).map(([sub,v]) => <div key={sub} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#475569", padding:"3px 0" }}><span>{sub}</span><span style={{ color:"#94a3b8" }}>{fmt(v)}</span></div>)}
                </div>
              </div>
              {/* Préstamo card */}
              <div style={{ flex:"1 1 240px", minWidth:220, background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, overflow:"hidden" }}>
                <div style={{ background:"#1a1a2e20", borderBottom:"1px solid #1e3a5f", padding:"10px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ color:"#8b5cf6", fontSize:12, fontWeight:700 }}>Préstamo</span>
                  <span style={{ color:"#f87171", fontSize:16, fontWeight:700 }}>{fmt(summary["G. Financiero – Préstamo"]||0)}</span>
                </div>
                <div style={{ padding:"10px 16px" }}>
                  {Object.entries(entries.filter(e=>e.cat==="G. Financiero – Préstamo").reduce((acc,e)=>{ acc[e.sub]=(acc[e.sub]||0)+e.amount; return acc; }, {})).map(([sub,v]) => <div key={sub} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#475569", padding:"3px 0" }}><span>{sub}</span><span style={{ color:"#94a3b8" }}>{fmt(v)}</span></div>)}
                </div>
              </div>
              {/* Depósito pignorado card */}
              <div style={{ flex:"1 1 240px", minWidth:220, background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, overflow:"hidden" }}>
                <div style={{ background:"#052e1620", borderBottom:"1px solid #1e3a5f", padding:"10px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ color:"#4ade80", fontSize:12, fontWeight:700 }}>Depósito pignorado</span>
                  <span style={{ color:"#4ade80", fontSize:16, fontWeight:700 }}>+{fmt(depositAccrued)}</span>
                </div>
                <div style={{ padding:"10px 16px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#475569", padding:"3px 0" }}><span>Capital</span><span style={{ color:"#94a3b8" }}>{fmt(depositAmount)}</span></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#475569", padding:"3px 0" }}><span>Tipo</span><span style={{ color:"#94a3b8" }}>1,70% anual</span></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#475569", padding:"3px 0" }}><span>Desde</span><span style={{ color:"#94a3b8" }}>07/07/2025</span></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#475569", padding:"3px 0" }}><span>Días</span><span style={{ color:"#94a3b8" }}>{daysSinceDeposit} días</span></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#475569", padding:"3px 0", marginTop:4, paddingTop:4, borderTop:"1px solid #1e3a5f" }}><span>Intereses devengados</span><span style={{ color:"#4ade80", fontWeight:600 }}>+{fmt(depositAccrued)}</span></div>
                </div>
              </div>
            </div>
            {/* Net financial costs box */}
            <div style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, padding:"14px 18px", maxWidth:400 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                <span style={{ fontSize:12, color:"#475569" }}>Total gastos financieros</span>
                <span style={{ color:"#f87171", fontWeight:600 }}>{fmt(total)}</span>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                <span style={{ fontSize:12, color:"#475569" }}>Ingresos depósito</span>
                <span style={{ color:"#4ade80", fontWeight:600 }}>+{fmt(depositAccrued)}</span>
              </div>
              <div style={{ borderTop:"1px solid #1e3a5f", paddingTop:10, display:"flex", justifyContent:"space-between" }}>
                <span style={{ fontSize:14, fontWeight:700, color:"#94a3b8" }}>G. Financieros netos</span>
                <span style={{ fontSize:18, fontWeight:700, color:netFinancial>=0?"#4ade80":"#f87171" }}>{fmt(netFinancial)}</span>
              </div>
            </div>
          </div>}

          <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
            {cats.map(c => <button key={c} onClick={()=>setFilterCat(c)} style={{ background:filterCat===c?"#1e3a5f":"transparent", border:`1px solid ${filterCat===c?"#3b82f6":"#1e3a5f"}`, color:filterCat===c?"#93c5fd":"#64748b", padding:"5px 12px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>{c}</button>)}
            {entries.length > 0 && <div style={{ marginLeft:"auto" }}>
              {!confirmBorrarGF
                ? <button onClick={()=>setConfirmBorrarGF(true)} style={{ background:"transparent", border:"1px solid #450a0a", color:"#f87171", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Borrar G. Financieros</button>
                : <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:12, color:"#f87171" }}>¿Seguro? Se borrarán {entries.length} movimientos</span>
                    <button onClick={async ()=>{ setEntries([]); try { localStorage.removeItem("gf-entries-arena-nexus"); } catch{} await deleteAllGastosFinancieros(); setConfirmBorrarGF(false); showFlash("G. Financieros eliminados.","warn"); }} style={{ background:"#450a0a", border:"1px solid #ef4444", color:"#f87171", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Sí</button>
                    <button onClick={()=>setConfirmBorrarGF(false)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>No</button>
                  </span>}
            </div>}
          </div>
          {(() => {
            // Apply category filter first
            let gfFiltered = filterCat==="Todas" ? entries : entries.filter(e=>e.cat===filterCat);
            // Apply Excel-style column filters
            Object.entries(gfFilters).forEach(([col, selected]) => {
              if (!selected) return;
              if (selected.size === 0) { gfFiltered = []; return; }
              gfFiltered = gfFiltered.filter(e => {
                const val = col === "account" ? e.account : col === "cat" ? e.cat : col === "sub" ? e.sub : e[col];
                return selected.has(val);
              });
            });
            const gfUniqueVals = {
              account: [...new Set(entries.map(e => e.account).filter(Boolean))],
              cat: [...new Set(entries.map(e => e.cat).filter(Boolean))],
              sub: [...new Set(entries.map(e => e.sub).filter(Boolean))],
            };
            const setGfFilter = (col, val) => setGfFilters(prev => ({ ...prev, [col]: val }));
            const hasGfFilters = Object.values(gfFilters).some(v => v !== null && v !== undefined);

            return gfFiltered.length === 0
            ? <div style={{ textAlign:"center", color:"#334155", padding:"60px 0", fontSize:14 }}>
                {entries.length === 0
                  ? <>No hay movimientos. Ve a <span style={{ color:"#3b82f6", cursor:"pointer" }} onClick={()=>setTab("importar")}>Importar</span>.</>
                  : <>Sin resultados para estos filtros. {hasGfFilters && <button onClick={()=>setGfFilters({})} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", marginLeft:8 }}>✕ Limpiar</button>}</>}
              </div>
            : <div>
                {hasGfFilters && <div style={{ marginBottom:10 }}><button onClick={()=>setGfFilters({})} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>✕ Limpiar filtros</button> <span style={{ fontSize:11, color:"#334155", marginLeft:8 }}>{gfFiltered.length} de {entries.length}</span></div>}
                <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                  <thead><tr style={{ background:"#0d1f35" }}>
                    {[
                      { key:"date", label:"Fecha" },
                      { key:"concept", label:"Concepto" },
                      { key:"account", label:"Cta.", filterable:true },
                      { key:"cat", label:"Categoría", filterable:true },
                      { key:"sub", label:"Subcategoría", filterable:true },
                      { key:"amount", label:"Importe", align:"right" },
                      { key:"actions", label:"" },
                    ].map(col => (
                      <th key={col.key} style={{ padding:"10px 12px", textAlign:col.align||"left", color:gfFilters[col.key]?"#3b82f6":"#475569", fontWeight:600, fontSize:11, letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #1e3a5f", whiteSpace:"nowrap", position:"relative", cursor:col.filterable?"pointer":"default" }}
                        onClick={()=>{ if(col.filterable) setGfFilterCol(gfFilterCol===col.key?null:col.key) }}>
                        {col.label}
                        {col.filterable && <span style={{ marginLeft:4, fontSize:8, color:gfFilters[col.key]?"#3b82f6":"#334155" }}>▼</span>}
                        {col.filterable && <FilterDropdown
                          column={col.key}
                          values={gfUniqueVals[col.key]||[]}
                          selected={gfFilters[col.key]||null}
                          isOpen={gfFilterCol===col.key}
                          onToggle={setGfFilterCol}
                          onApply={(val)=>setGfFilter(col.key,val)}
                          onSort={null}
                        />}
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {gfFiltered.map((e,i) => { const col = CAT_COLORS[e.cat]||{bg:"#111",accent:"#888"}; return <tr key={e.id} style={{ background:i%2===0?"#0a1628":"#080f1a" }} onMouseEnter={ev=>ev.currentTarget.style.background="#0d1f35"} onMouseLeave={ev=>ev.currentTarget.style.background=i%2===0?"#0a1628":"#080f1a"}>
                      <td style={{ padding:"9px 12px", color:"#94a3b8", whiteSpace:"nowrap" }}>{e.date}</td>
                      <td style={{ padding:"9px 12px", color:"#cbd5e1", maxWidth:260 }}>{e.concept}</td>
                      <td style={{ padding:"9px 12px" }}><span style={{ background:"#0f2942", color:"#60a5fa", padding:"2px 8px", borderRadius:4, fontSize:11, fontWeight:700 }}>{e.account}</span></td>
                      <td style={{ padding:"9px 12px" }}><span style={{ background:col.bg, color:col.accent, border:`1px solid ${col.accent}30`, padding:"2px 8px", borderRadius:4, fontSize:11 }}>{e.cat}</span></td>
                      <td style={{ padding:"9px 12px", color:"#64748b", fontSize:12 }}>{e.sub}</td>
                      <td style={{ padding:"9px 12px", textAlign:"right", color:"#f87171", fontWeight:600, whiteSpace:"nowrap" }}>{fmt(e.amount)}</td>
                      <td style={{ padding:"9px 8px", textAlign:"center" }}>
                        {delConfirm===e.id ? <span style={{ fontSize:11 }}><button onClick={()=>{ setEntries(p=>p.filter(x=>x.id!==e.id)); setDelConfirm(null); showFlash("Eliminado.","warn"); }} style={{ background:"#450a0a", border:"1px solid #ef4444", color:"#f87171", padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", marginRight:4 }}>Sí</button><button onClick={()=>setDelConfirm(null)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>No</button></span>
                        : <button onClick={()=>setDelConfirm(e.id)} style={{ background:"transparent", border:"none", color:"#334155", cursor:"pointer", fontSize:14, padding:"2px 6px" }}>✕</button>}
                      </td>
                    </tr>; })}
                  </tbody>
                </table>
              </div></div>;
          })()}
          {entries.length > 0 && <div style={{ marginTop:16, padding:14, background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:8, fontSize:12, color:"#475569" }}>Período: <span style={{ color:"#94a3b8" }}>{entries[0]?.date}</span> → <span style={{ color:"#94a3b8" }}>{entries[entries.length-1]?.date}</span> · {entries.length} movimientos</div>}
        </div>;
        })()}

        {/* ══ BANCO ══ */}
        {tab==="banco" && (() => {
          const bankCC = bankMovements.filter(m => m.cuenta === "CC");
          const bankCP = bankMovements.filter(m => m.cuenta === "CP");
          const saldoCC = bankCC.length > 0 ? bankCC.reduce((best, m) => (m.orden < best.orden ? m : best), bankCC[0]).saldo : 0;
          const saldoCP = bankCP.length > 0 ? bankCP.reduce((best, m) => (m.orden < best.orden ? m : best), bankCP[0]).saldo : 0;

          // Excel-style filtered list
          let fMov = [...bankMovements];
          Object.entries(bankFilters).forEach(([col, selected]) => {
            if (!selected) return;
            if (selected.size === 0) { fMov = []; return; }
            fMov = fMov.filter(m => {
              const val = col === "tipo" ? (BANK_TYPES[m.tipo]||BANK_TYPES.otro).label : m[col];
              return selected.has(val);
            });
          });
          fMov.sort((a, b) => {
            const da = parseDate(a.fecha), db = parseDate(b.fecha);
            if (da.getTime() !== db.getTime()) return db - da;
            return a.orden - b.orden;
          });

          const bankUniqueVals = {
            tipo: [...new Set(bankMovements.map(m => (BANK_TYPES[m.tipo]||BANK_TYPES.otro).label))],
            cuenta: [...new Set(bankMovements.map(m => m.cuenta))],
          };
          const setBankFilter = (col, val) => setBankFilters(prev => ({ ...prev, [col]: val }));
          const hasBankFilters = Object.values(bankFilters).some(v => v !== null && v !== undefined);

          const byTipo = {};
          bankMovements.forEach(m => {
            if (!byTipo[m.tipo]) byTipo[m.tipo] = { ing: 0, car: 0, n: 0 };
            if (m.importe >= 0) byTipo[m.tipo].ing += m.importe;
            else byTipo[m.tipo].car += m.importe;
            byTipo[m.tipo].n++;
          });
          const tiposPresent = [...new Set(bankMovements.map(m => m.tipo))].sort();

          const bankCols = [
            { key:"fecha", label:"Fecha" },
            { key:"concepto", label:"Concepto" },
            { key:"tipo", label:"Tipo", filterable:true },
            { key:"cuenta", label:"Cta.", filterable:true },
            { key:"importe", label:"Importe", align:"right" },
            { key:"saldo", label:"Saldo", align:"right" },
          ];

          return <div>
            {bankMovements.length === 0
              ? <div style={{ textAlign:"center", padding:"60px 0" }}>
                  <div style={{ fontSize:48, marginBottom:16 }}>💳</div>
                  <div style={{ fontSize:16, color:"#64748b", marginBottom:8 }}>Sin movimientos bancarios</div>
                  <div style={{ fontSize:13, color:"#334155" }}>Ve a <span style={{ color:"#3b82f6", cursor:"pointer" }} onClick={()=>setTab("importar")}>Importar</span> para cargar extractos completos.</div>
                </div>
              : <>
                {/* Balance cards */}
                <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:24 }}>
                  <div style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, padding:"16px 20px", flex:"1 1 260px", minWidth:220 }}>
                    <div style={{ fontSize:11, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Cuenta Corriente</div>
                    <div style={{ fontSize:22, fontWeight:700, color:saldoCC>=0?"#4ade80":"#f87171" }}>{fmt(saldoCC)}</div>
                    <div style={{ fontSize:11, color:"#334155", marginTop:2 }}>{bankCC.length} movimientos</div>
                  </div>
                  <div style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, padding:"16px 20px", flex:"1 1 260px", minWidth:220 }}>
                    <div style={{ fontSize:11, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Póliza de Crédito</div>
                    <div style={{ fontSize:22, fontWeight:700, color:"#f87171" }}>{fmt(saldoCP)}</div>
                    <div style={{ fontSize:11, color:"#334155", marginTop:2 }}>Dispuesto · {bankCP.length} movimientos</div>
                  </div>
                </div>

                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <span style={{ fontSize:12, color:"#475569" }}>{fMov.length} de {bankMovements.length} movimientos</span>
                    {hasBankFilters && <button onClick={()=>{setBankFilters({});setBankFilterCol(null)}} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>✕ Limpiar filtros</button>}
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    {!confirmBorrarBanco
                      ? <button onClick={()=>setConfirmBorrarBanco(true)} style={{ background:"transparent", border:"1px solid #450a0a", color:"#f87171", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Borrar todo</button>
                      : <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                          <span style={{ fontSize:12, color:"#f87171" }}>¿Seguro?</span>
                          <button onClick={async ()=>{ await deleteAllMovimientosBancarios(); setBankMovements([]); setConfirmBorrarBanco(false); showFlash("Movimientos bancarios eliminados.","err"); }} style={{ background:"#450a0a", border:"1px solid #ef4444", color:"#f87171", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Sí</button>
                          <button onClick={()=>setConfirmBorrarBanco(false)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>No</button>
                        </span>}
                  </div>
                </div>

                {/* Table with Excel-style header filters */}
                <div style={{ overflowX:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                    <thead><tr style={{ background:"#0d1f35" }}>
                      {bankCols.map(col => (
                        <th key={col.key} style={{ padding:"9px 10px", textAlign:col.align||"left", color:bankFilters[col.key]?"#3b82f6":"#475569", fontWeight:600, fontSize:10, letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #1e3a5f", whiteSpace:"nowrap", position:"relative", cursor:col.filterable?"pointer":"default" }}
                          onClick={()=>{ if(col.filterable) setBankFilterCol(bankFilterCol===col.key?null:col.key) }}>
                          {col.label}
                          {col.filterable && <span style={{ marginLeft:4, fontSize:8, color:bankFilters[col.key]?"#3b82f6":"#334155" }}>▼</span>}
                          {col.filterable && <FilterDropdown
                            column={col.key}
                            values={bankUniqueVals[col.key]||[]}
                            selected={bankFilters[col.key]||null}
                            isOpen={bankFilterCol===col.key}
                            onToggle={setBankFilterCol}
                            onApply={(val)=>setBankFilter(col.key,val)}
                            onSort={null}
                          />}
                        </th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {fMov.map((m, i) => {
                        const bt = BANK_TYPES[m.tipo] || BANK_TYPES.otro;
                        return <tr key={m.id} style={{ background:i%2===0?"#0a1628":"#080f1a" }} onMouseEnter={e=>e.currentTarget.style.background="#0d1f35"} onMouseLeave={e=>e.currentTarget.style.background=i%2===0?"#0a1628":"#080f1a"}>
                          <td style={{ padding:"8px 10px", color:"#94a3b8", whiteSpace:"nowrap" }}>{m.fecha}</td>
                          <td style={{ padding:"8px 10px", color:"#cbd5e1", maxWidth:300, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.concepto}</td>
                          <td style={{ padding:"8px 10px" }}><span style={{ background:bt.bg, color:bt.color, border:`1px solid ${bt.color}30`, padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:600, whiteSpace:"nowrap" }}>{bt.label}</span></td>
                          <td style={{ padding:"8px 10px" }}><span style={{ background:"#0f2942", color:m.cuenta==="CC"?"#60a5fa":"#c084fc", padding:"2px 8px", borderRadius:4, fontSize:11, fontWeight:700 }}>{m.cuenta}</span></td>
                          <td style={{ padding:"8px 10px", textAlign:"right", color:m.importe>=0?"#4ade80":"#f87171", fontWeight:600, whiteSpace:"nowrap" }}>{m.importe>=0?"+":""}{fmt(m.importe)}</td>
                          <td style={{ padding:"8px 10px", textAlign:"right", color:"#64748b", whiteSpace:"nowrap" }}>{fmt(m.saldo)}</td>
                        </tr>;
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Summary by type */}
                <div style={{ marginTop:32, maxWidth:640 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:"#94a3b8", marginBottom:16, letterSpacing:1, textTransform:"uppercase" }}>Resumen por tipo</div>
                  {tiposPresent.map(t => {
                    const bt = BANK_TYPES[t] || BANK_TYPES.otro;
                    const d = byTipo[t];
                    return <div key={t} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #0d1f35" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ background:bt.bg, color:bt.color, border:`1px solid ${bt.color}30`, padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:600, whiteSpace:"nowrap", minWidth:100, textAlign:"center" }}>{bt.label}</span>
                        <span style={{ color:"#475569", fontSize:11 }}>{d.n} mov.</span>
                      </div>
                      <div style={{ display:"flex", gap:16, fontSize:12 }}>
                        {d.ing > 0 && <span style={{ color:"#4ade80" }}>+{fmt(d.ing)}</span>}
                        {d.car < 0 && <span style={{ color:"#f87171" }}>{fmt(d.car)}</span>}
                      </div>
                    </div>;
                  })}
                  <div style={{ borderTop:"1px solid #1e3a5f", paddingTop:12, marginTop:12, display:"flex", justifyContent:"space-between" }}>
                    <span style={{ fontSize:13, fontWeight:700, color:"#94a3b8" }}>Total movimientos</span>
                    <span style={{ fontSize:13, fontWeight:700, color:"#64748b" }}>{bankMovements.length}</span>
                  </div>
                </div>
              </>
            }
          </div>;
        })()}

        {/* ══ CONCILIACIÓN ══ */}
        {tab==="conciliacion" && (() => {
          const concFacIds = new Set(conciliaciones.map(c => c.factura_id));
          const concMovIds = new Set(conciliaciones.map(c => c.movimiento_id));
          const stats = resumenConciliacion(bankMovements, invoices, conciliaciones);

          const getEstadoFactura = (facId) => {
            if (concFacIds.has(facId)) return "pagada";
            return "pendiente";
          };

          // Conciliaciones agrupadas por movimiento
          const concByMov = {};
          conciliaciones.forEach(c => {
            if (!concByMov[c.movimiento_id]) concByMov[c.movimiento_id] = [];
            concByMov[c.movimiento_id].push(c);
          });

          // Auto-conciliar handler
          const runAutoConciliar = async () => {
            setConcRunning(true);
            try {
              const facsSinConc = invoices.filter(f => !concFacIds.has(f.id));
              const movsSinConc = bankMovements.filter(m => !concMovIds.has(m.id));
              const sugs = generarSugerencias(movsSinConc, facsSinConc);
              setConcSugerencias(sugs);
              if (sugs.length === 0) showFlash("No se encontraron nuevas coincidencias.", "warn");
              else showFlash(`${sugs.length} coincidencia(s) encontrada(s).`);
            } catch (err) {
              showFlash("Error en auto-conciliación: " + err.message, "err");
            }
            setConcRunning(false);
          };

          // Accept ALL suggestions in one batch
          const acceptAllSugerencias = async () => {
            const allItems = [];
            const allFacIds = new Set();
            for (const sug of concSugerencias) {
              for (const sf of sug.facturas) {
                allItems.push({
                  movimiento_id: sug.movimiento.id,
                  factura_id: sf.factura.id,
                  importe: sf.importe,
                  metodo: sug.metodo,
                  confianza: sug.confianza,
                });
                allFacIds.add(sf.factura.id);
              }
            }
            if (allItems.length === 0) return;
            const result = await upsertConciliaciones(allItems);
            if (result) {
              for (const fid of allFacIds) {
                await updateFacturaEstado(fid, "pagada");
              }
              setConciliaciones(prev => [...prev, ...allItems.map((it, i) => ({ ...it, id: result[i]?.id || `temp-${Date.now()}-${i}` }))]);
              setConcSugerencias([]);
              showFlash(`✓ ${allItems.length} conciliación(es) guardada(s).`);
            } else {
              showFlash("Error al guardar conciliaciones.", "err");
            }
          };

          // Accept single suggestion
          const acceptSugerencia = async (sug, idx) => {
            const items = sug.facturas.map(sf => ({
              movimiento_id: sug.movimiento.id,
              factura_id: sf.factura.id,
              importe: sf.importe,
              metodo: sug.metodo,
              confianza: sug.confianza,
            }));
            const result = await upsertConciliaciones(items);
            if (result) {
              // Update factura estado
              for (const sf of sug.facturas) {
                await updateFacturaEstado(sf.factura.id, "pagada");
              }
              setConciliaciones(prev => [...prev, ...items.map((it, i) => ({ ...it, id: result[i]?.id || `temp-${Date.now()}-${i}` }))]);
              setConcSugerencias(prev => prev.filter((_, i) => i !== idx));
              showFlash("Conciliación aceptada.");
            } else {
              showFlash("Error al guardar conciliación.", "err");
            }
          };

          // Reject suggestion
          const rejectSugerencia = (idx) => {
            setConcSugerencias(prev => prev.filter((_, i) => i !== idx));
          };

          // Delete existing conciliacion
          const removeConciliacion = async (concId, facId) => {
            const ok = await deleteConciliacion(concId);
            if (ok) {
              setConciliaciones(prev => prev.filter(c => c.id !== concId));
              // Check if factura still has other conciliaciones
              const remaining = conciliaciones.filter(c => c.factura_id === facId && c.id !== concId);
              if (remaining.length === 0) {
                await updateFacturaEstado(facId, "pendiente");
              }
              showFlash("Conciliación eliminada.");
            }
          };

          // Manual conciliation
          const submitManual = async () => {
            if (!concManualMov || concManualFacs.size === 0) return;
            const mov = bankMovements.find(m => m.id === concManualMov);
            if (!mov) return;
            const items = [...concManualFacs].map(fid => {
              const fac = invoices.find(f => f.id === fid);
              const total = fac ? Math.abs((fac.cuantia||0) + (fac.iva||0) + (fac.otros||0)) : 0;
              return {
                movimiento_id: mov.id,
                factura_id: fid,
                importe: total,
                metodo: "manual",
                confianza: 1,
              };
            });
            const result = await upsertConciliaciones(items);
            if (result) {
              for (const fid of concManualFacs) {
                await updateFacturaEstado(fid, "pagada");
              }
              setConciliaciones(prev => [...prev, ...items.map((it, i) => ({ ...it, id: result[i]?.id || `temp-${Date.now()}-${i}` }))]);
              setConcManualMov(null);
              setConcManualFacs(new Set());
              setConcManualSearch("");
              showFlash("Conciliación manual guardada.");
            } else {
              showFlash("Error al guardar.", "err");
            }
          };

          // Helper: find factura/mov by id
          const facById = (id) => invoices.find(f => f.id === id);
          const movById = (id) => bankMovements.find(m => m.id === id);

          // Badge helper
          const confianzaBadge = (conf) => {
            const pct = Math.round(conf * 100);
            const color = conf >= 0.9 ? "#4ade80" : conf >= 0.7 ? "#fbbf24" : "#fb923c";
            const bg = conf >= 0.9 ? "#052e16" : conf >= 0.7 ? "#422006" : "#431407";
            return <span style={{ background: bg, color, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600 }}>{pct}%</span>;
          };
          const metodoBadge = (m) => {
            const labels = { auto_exacto: "Exacto", auto_proveedor: "Proveedor", auto_numero: "Nº factura", auto_agrupado: "Agrupado", auto_importe: "Importe", manual: "Manual" };
            const colors = { auto_exacto: "#4ade80", auto_proveedor: "#60a5fa", auto_numero: "#38bdf8", auto_agrupado: "#c084fc", auto_importe: "#fbbf24", manual: "#94a3b8" };
            return <span style={{ background: "#0d1f35", color: colors[m] || "#64748b", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, border: `1px solid ${colors[m] || "#334155"}33` }}>{labels[m] || m}</span>;
          };

          // Movimientos pendientes (pagos sin conciliar) for manual mode
          const movsPendientes = bankMovements
            .filter(m => m.importe < 0 && ["pago_factura","tributos","devolucion"].includes(m.tipo) && !concMovIds.has(m.id))
            .sort((a, b) => parseDate(b.fecha) - parseDate(a.fecha));

          // Facturas pendientes for manual mode
          let facsPendientes = invoices.filter(f => !concFacIds.has(f.id));
          if (concManualSearch) {
            const q = concManualSearch.toLowerCase();
            facsPendientes = facsPendientes.filter(f =>
              (f.proveedor||"").toLowerCase().includes(q) ||
              (f.concepto||"").toLowerCase().includes(q) ||
              (f.numero||"").toLowerCase().includes(q)
            );
          }

          return <div>
            {/* ── Summary cards ── */}
            <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:24 }}>
              {[
                ["Facturas conciliadas", `${stats.facConciliadas} / ${stats.totalFacturas}`, stats.facConciliadas === stats.totalFacturas ? "#4ade80" : "#60a5fa"],
                ["Facturas pendientes", stats.facPendientes, stats.facPendientes === 0 ? "#4ade80" : "#f87171"],
                ["Mov. conciliados", `${stats.movConciliados} / ${stats.movimientosPago}`, "#60a5fa"],
                ["Importe conciliado", fmt(stats.importeConciliado), "#4ade80"],
                ["Importe pendiente", fmt(stats.importePendiente), "#f87171"],
              ].map(([label, value, color]) =>
                <div key={label} style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, padding:"14px 18px", flex:"1 1 160px", minWidth:150 }}>
                  <div style={{ fontSize:10, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>{label}</div>
                  <div style={{ fontSize:18, fontWeight:700, color }}>{value}</div>
                </div>
              )}
            </div>

            {/* ── Action buttons ── */}
            <div style={{ display:"flex", gap:12, marginBottom:24, alignItems:"center", flexWrap:"wrap" }}>
              <button onClick={runAutoConciliar} disabled={concRunning} style={{ background:"#1d4ed8", border:"none", color:"#fff", padding:"10px 24px", borderRadius:8, cursor:concRunning?"wait":"pointer", fontSize:13, fontFamily:"inherit", fontWeight:600, opacity:concRunning?0.6:1 }}>
                {concRunning ? "⏳ Procesando…" : "🔄 Auto-conciliar"}
              </button>
              {concSugerencias.length > 0 && <span style={{ fontSize:12, color:"#fbbf24" }}>{concSugerencias.length} sugerencia(s) pendientes</span>}
              {conciliaciones.length > 0 && <button onClick={async () => {
                if (!window.confirm(`¿Borrar las ${conciliaciones.length} conciliaciones? Esta acción no se puede deshacer.`)) return;
                const ok = await deleteAllConciliaciones();
                if (ok) { setConciliaciones([]); setConcSugerencias([]); showFlash("Conciliaciones borradas.","warn"); }
                else showFlash("Error al borrar.","err");
              }} style={{ background:"transparent", border:"1px solid #450a0a", color:"#f87171", padding:"8px 16px", borderRadius:8, cursor:"pointer", fontSize:12, fontFamily:"inherit", marginLeft:"auto" }}>🗑 Borrar conciliaciones ({conciliaciones.length})</button>}
            </div>

            {/* ── Sugerencias de conciliación ── */}
            {concSugerencias.length > 0 && <div style={{ marginBottom:32 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                <div style={{ fontSize:14, fontWeight:700, color:"#f1f5f9" }}>Sugerencias de conciliación</div>
                <button onClick={acceptAllSugerencias} style={{ background:"#052e16", border:"1px solid #22c55e44", color:"#4ade80", padding:"6px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:600 }}>✓ Aceptar todas ({concSugerencias.length})</button>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {concSugerencias.map((sug, idx) => {
                  const mov = sug.movimiento;
                  return <div key={`sug-${idx}`} style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, padding:"16px 20px" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:12 }}>
                      {/* Left: movimiento */}
                      <div style={{ flex:"1 1 300px" }}>
                        <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:6 }}>
                          {metodoBadge(sug.metodo)}
                          {confianzaBadge(sug.confianza)}
                        </div>
                        <div style={{ fontSize:12, color:"#94a3b8", marginBottom:2 }}>
                          <span style={{ color:"#475569" }}>Mov:</span> {mov.fecha} · <span style={{ color:"#f87171", fontWeight:600 }}>{fmt(mov.importe)}</span>
                        </div>
                        <div style={{ fontSize:11, color:"#64748b", maxWidth:400, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{mov.concepto}</div>
                      </div>
                      {/* Center: arrow */}
                      <div style={{ color:"#334155", fontSize:20, alignSelf:"center", padding:"0 8px" }}>↔</div>
                      {/* Right: factura(s) */}
                      <div style={{ flex:"1 1 300px" }}>
                        {sug.facturas.map((sf, fi) => (
                          <div key={fi} style={{ marginBottom: fi < sug.facturas.length - 1 ? 6 : 0 }}>
                            <div style={{ fontSize:12, color:"#cbd5e1" }}>{sf.factura.proveedor}</div>
                            <div style={{ fontSize:11, color:"#64748b" }}>
                              {sf.factura.fecha} · {sf.factura.numero || "s/n"} · <span style={{ color:"#f87171" }}>{fmt(sf.importe)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      {/* Actions */}
                      <div style={{ display:"flex", gap:8, alignSelf:"center" }}>
                        <button onClick={() => acceptSugerencia(sug, idx)} style={{ background:"#052e16", border:"1px solid #22c55e44", color:"#4ade80", padding:"6px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:600 }}>✓ Aceptar</button>
                        <button onClick={() => rejectSugerencia(idx)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"6px 12px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>✕</button>
                      </div>
                    </div>
                  </div>;
                })}
              </div>
            </div>}

            {/* ── Manual conciliation ── */}
            <div style={{ marginBottom:32 }}>
              <div style={{ fontSize:14, fontWeight:700, color:"#f1f5f9", marginBottom:12 }}>Conciliación manual</div>
              <div style={{ display:"flex", gap:20, flexWrap:"wrap" }}>
                {/* Select movimiento */}
                <div style={{ flex:"1 1 380px", minWidth:300 }}>
                  <div style={{ fontSize:11, color:"#475569", marginBottom:6, letterSpacing:1, textTransform:"uppercase" }}>1. Seleccionar movimiento</div>
                  <div style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:8, maxHeight:280, overflowY:"auto" }}>
                    {movsPendientes.length === 0
                      ? <div style={{ padding:20, textAlign:"center", color:"#334155", fontSize:12 }}>Todos los movimientos de pago están conciliados</div>
                      : movsPendientes.map(m => (
                        <div key={m.id} onClick={() => setConcManualMov(concManualMov === m.id ? null : m.id)}
                          style={{ padding:"10px 14px", borderBottom:"1px solid #0d1f35", cursor:"pointer", background: concManualMov === m.id ? "#0d2847" : "transparent" }}
                          onMouseEnter={e => { if (concManualMov !== m.id) e.currentTarget.style.background="#0d1f35"; }}
                          onMouseLeave={e => { if (concManualMov !== m.id) e.currentTarget.style.background="transparent"; }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                            <div>
                              <div style={{ fontSize:12, color:concManualMov===m.id?"#93c5fd":"#94a3b8" }}>{m.fecha} · {m.cuenta}</div>
                              <div style={{ fontSize:11, color:"#64748b", maxWidth:280, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.concepto}</div>
                            </div>
                            <div style={{ fontSize:13, fontWeight:700, color:"#f87171", whiteSpace:"nowrap" }}>{fmt(m.importe)}</div>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>

                {/* Select factura(s) */}
                <div style={{ flex:"1 1 380px", minWidth:300 }}>
                  <div style={{ fontSize:11, color:"#475569", marginBottom:6, letterSpacing:1, textTransform:"uppercase" }}>2. Seleccionar factura(s)</div>
                  <input type="text" placeholder="Buscar por proveedor, concepto, nº…" value={concManualSearch} onChange={e => setConcManualSearch(e.target.value)}
                    style={{ width:"100%", background:"#080f1a", border:"1px solid #1e3a5f", borderRadius:6, color:"#e2e8f0", padding:"8px 12px", fontFamily:"inherit", fontSize:12, outline:"none", boxSizing:"border-box", marginBottom:8 }} />
                  <div style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:8, maxHeight:240, overflowY:"auto" }}>
                    {facsPendientes.length === 0
                      ? <div style={{ padding:20, textAlign:"center", color:"#334155", fontSize:12 }}>Sin facturas pendientes{concManualSearch ? " para esta búsqueda" : ""}</div>
                      : facsPendientes.map(f => {
                        const total = Math.abs((f.cuantia||0) + (f.iva||0) + (f.otros||0));
                        const sel = concManualFacs.has(f.id);
                        return <div key={f.id} onClick={() => {
                            setConcManualFacs(prev => {
                              const next = new Set(prev);
                              if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                              return next;
                            });
                          }}
                          style={{ padding:"10px 14px", borderBottom:"1px solid #0d1f35", cursor:"pointer", background: sel ? "#0d2847" : "transparent" }}
                          onMouseEnter={e => { if (!sel) e.currentTarget.style.background="#0d1f35"; }}
                          onMouseLeave={e => { if (!sel) e.currentTarget.style.background="transparent"; }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                            <div>
                              <div style={{ fontSize:12, color:sel?"#93c5fd":"#94a3b8" }}>{f.proveedor}</div>
                              <div style={{ fontSize:11, color:"#64748b" }}>{f.fecha} · {f.numero || "s/n"} · {f.concepto?.slice(0,40)}</div>
                            </div>
                            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                              <span style={{ fontSize:13, fontWeight:700, color:"#f87171", whiteSpace:"nowrap" }}>{fmt(total)}</span>
                              <span style={{ width:16, height:16, borderRadius:4, border:`1px solid ${sel?"#3b82f6":"#334155"}`, background:sel?"#1d4ed8":"transparent", display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:10, color:"#fff" }}>{sel?"✓":""}</span>
                            </div>
                          </div>
                        </div>;
                      })}
                  </div>
                  {/* Manual summary + submit */}
                  {concManualMov && concManualFacs.size > 0 && (() => {
                    const mov = movById(concManualMov);
                    const sumFacs = [...concManualFacs].reduce((s, fid) => {
                      const f = facById(fid);
                      return s + (f ? Math.abs((f.cuantia||0)+(f.iva||0)+(f.otros||0)) : 0);
                    }, 0);
                    const diff = Math.abs(mov?.importe || 0) - sumFacs;
                    return <div style={{ marginTop:10, padding:"12px 14px", background:"#0d1f35", borderRadius:8, border:"1px solid #1e3a5f" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:4 }}>
                        <span style={{ color:"#94a3b8" }}>Movimiento:</span>
                        <span style={{ color:"#f87171", fontWeight:600 }}>{fmt(Math.abs(mov?.importe||0))}</span>
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:4 }}>
                        <span style={{ color:"#94a3b8" }}>Σ Facturas ({concManualFacs.size}):</span>
                        <span style={{ color:"#60a5fa", fontWeight:600 }}>{fmt(sumFacs)}</span>
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, borderTop:"1px solid #1e3a5f", paddingTop:4 }}>
                        <span style={{ color:"#94a3b8" }}>Diferencia:</span>
                        <span style={{ color: Math.abs(diff) < 0.03 ? "#4ade80" : "#fbbf24", fontWeight:600 }}>{fmt(diff)}</span>
                      </div>
                      <button onClick={submitManual} style={{ marginTop:10, width:"100%", background:"#1d4ed8", border:"none", color:"#fff", padding:"8px 0", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:600 }}>Vincular</button>
                    </div>;
                  })()}
                </div>
              </div>
            </div>

            {/* ── Conciliaciones existentes ── */}
            <div>
              <div style={{ fontSize:14, fontWeight:700, color:"#f1f5f9", marginBottom:12 }}>Conciliaciones registradas ({conciliaciones.length})</div>
              {conciliaciones.length === 0
                ? <div style={{ textAlign:"center", padding:"40px 0", color:"#334155", fontSize:13 }}>Aún no hay conciliaciones. Usa Auto-conciliar o la conciliación manual.</div>
                : <div style={{ overflowX:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                    <thead><tr style={{ background:"#0d1f35" }}>
                      {["Fecha mov.", "Concepto mov.", "Importe mov.", "Proveedor fac.", "Nº factura", "Importe fac.", "Método", "Confianza", ""].map((h, i) =>
                        <th key={i} style={{ padding:"9px 10px", textAlign: i===2||i===5 ? "right" : "left", color:"#475569", fontWeight:600, fontSize:10, letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #1e3a5f", whiteSpace:"nowrap" }}>{h}</th>
                      )}
                    </tr></thead>
                    <tbody>
                      {conciliaciones.map((c, ci) => {
                        const mov = movById(c.movimiento_id);
                        const fac = facById(c.factura_id);
                        return <tr key={c.id || ci} style={{ background: ci%2===0 ? "#0a1628" : "#080f1a" }}
                          onMouseEnter={e=>e.currentTarget.style.background="#0d1f35"} onMouseLeave={e=>e.currentTarget.style.background=ci%2===0?"#0a1628":"#080f1a"}>
                          <td style={{ padding:"8px 10px", color:"#94a3b8", whiteSpace:"nowrap" }}>{mov?.fecha || "—"}</td>
                          <td style={{ padding:"8px 10px", color:"#64748b", maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{mov?.concepto || "—"}</td>
                          <td style={{ padding:"8px 10px", textAlign:"right", color:"#f87171", fontWeight:600 }}>{mov ? fmt(mov.importe) : "—"}</td>
                          <td style={{ padding:"8px 10px", color:"#cbd5e1" }}>{fac?.proveedor || "—"}</td>
                          <td style={{ padding:"8px 10px", color:"#475569" }}>{fac?.numero || "—"}</td>
                          <td style={{ padding:"8px 10px", textAlign:"right", color:"#f87171" }}>{fmt(c.importe)}</td>
                          <td style={{ padding:"8px 10px" }}>{metodoBadge(c.metodo)}</td>
                          <td style={{ padding:"8px 10px" }}>{confianzaBadge(c.confianza)}</td>
                          <td style={{ padding:"8px 6px", textAlign:"center" }}>
                            <button onClick={() => removeConciliacion(c.id, c.factura_id)} style={{ background:"transparent", border:"none", color:"#475569", cursor:"pointer", fontSize:13, padding:"2px 5px" }} title="Eliminar conciliación">🗑</button>
                          </td>
                        </tr>;
                      })}
                    </tbody>
                  </table>
                </div>
              }
            </div>

            {/* ── Anomalías: facturas sin pago + pagos sin factura ── */}
            <div style={{ display:"flex", gap:20, flexWrap:"wrap", marginTop:32 }}>
              {/* Facturas sin pago */}
              <div style={{ flex:"1 1 420px", minWidth:300 }}>
                <div style={{ fontSize:14, fontWeight:700, color:"#f59e0b", marginBottom:10 }}>⚠ Facturas sin pago ({stats.facPendientes})</div>
                {stats.facPendientes === 0
                  ? <div style={{ background:"#052e16", border:"1px solid #22c55e44", borderRadius:8, padding:"16px 20px", color:"#4ade80", fontSize:12 }}>Todas las facturas están conciliadas.</div>
                  : <div style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:8, maxHeight:320, overflowY:"auto" }}>
                    {invoices.filter(f => !concFacIds.has(f.id)).map(f => {
                      const total = Math.abs((f.cuantia||0) + (f.iva||0) + (f.otros||0));
                      return <div key={f.id} style={{ padding:"10px 14px", borderBottom:"1px solid #0d1f35", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <div>
                          <div style={{ fontSize:12, color:"#cbd5e1" }}>{f.proveedor}</div>
                          <div style={{ fontSize:11, color:"#64748b" }}>{f.fecha} · {f.numero || "s/n"} · {f.activo || "—"}</div>
                        </div>
                        <div style={{ fontSize:13, fontWeight:700, color:"#f87171", whiteSpace:"nowrap" }}>{fmt(total)}</div>
                      </div>;
                    })}
                  </div>
                }
              </div>

              {/* Pagos sin factura */}
              {(() => {
                const movsPagosSinConc = bankMovements
                  .filter(m => m.importe < 0 && ["pago_factura","tributos","devolucion"].includes(m.tipo) && !concMovIds.has(m.id))
                  .sort((a, b) => parseDate(b.fecha) - parseDate(a.fecha));
                return <div style={{ flex:"1 1 420px", minWidth:300 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:"#60a5fa", marginBottom:10 }}>🔍 Pagos sin factura ({movsPagosSinConc.length})</div>
                  {movsPagosSinConc.length === 0
                    ? <div style={{ background:"#052e16", border:"1px solid #22c55e44", borderRadius:8, padding:"16px 20px", color:"#4ade80", fontSize:12 }}>Todos los pagos tienen factura asociada.</div>
                    : <div style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:8, maxHeight:320, overflowY:"auto" }}>
                      {movsPagosSinConc.map(m => (
                        <div key={m.id} style={{ padding:"10px 14px", borderBottom:"1px solid #0d1f35", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                          <div>
                            <div style={{ fontSize:12, color:"#94a3b8" }}>{m.fecha} · {m.cuenta}</div>
                            <div style={{ fontSize:11, color:"#64748b", maxWidth:300, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.concepto}</div>
                          </div>
                          <div style={{ fontSize:13, fontWeight:700, color:"#f87171", whiteSpace:"nowrap" }}>{fmt(m.importe)}</div>
                        </div>
                      ))}
                    </div>
                  }
                </div>;
              })()}
            </div>
          </div>;
        })()}

        {/* ══ RESUMEN ══ */}
        {tab==="resumen" && <div style={{ textAlign:"center", padding:"80px 0" }}>
          <div style={{ fontSize:48, marginBottom:16 }}>📈</div>
          <div style={{ fontSize:16, color:"#64748b", marginBottom:8 }}>P&L · Balance · Cuenta de resultados</div>
          <div style={{ fontSize:13, color:"#334155" }}>Próximamente</div>
        </div>}

      </div>
    </div>
  );
}
