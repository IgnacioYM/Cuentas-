import { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import { fetchInvoices, upsertInvoices, deleteInvoice, deleteAllInvoices, fetchGastosFinancieros, upsertGastosFinancieros } from "./supabaseClient";
import DashboardTab from "./DashboardTab";
import { ESCRITURAS } from "./escrituras";

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
- Autoliquidaciones de ITP (Impuesto de Transmisiones Patrimoniales)
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

REGISTRADORES ESPAÑA / REGISTRO MERCANTIL / JOSE MIGUEL BAÑON BERNARD:
- "Nota de registro", registros genéricos → AN, Opex
- Registro de constitución sociedad → AN, Costes de implementación
- Registro de propiedad post-compraventa → activo según inmueble, Adquisición

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

AGENCIA TRIBUTARIA:
- ITP ~13.617€ → BB5, Adquisición
- ITP ~18.788€ → PR30, Adquisición
- ITP ~15.056€ → FMM3, Adquisición
- ITP ~26.000€ → PB27, Adquisición
- Cualquier ITP → Adquisición, activo por importe más cercano

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

═══ EXTRACCIÓN DE IMPORTES ═══
- "cuantia" = Base Imponible + Base no Sujeta + suplidos. TODO antes de IVA y retención.
  Suma cada línea con PRECISIÓN. Verifica: cuantia + iva + otros = Total Factura.
- "iva" = importe total de IVA
- "otros" = retención IRPF como número NEGATIVO (ej: -194.53). Es estándar, no mencionarlo en notas.
- Si hay suplidos, papel timbrado, base no sujeta → sumar en "cuantia"
- Para ESCRITURAS: cuantia = precio compraventa, iva = 0, otros = 0

═══ CATEGORÍA ═══
- SIEMPRE rellena la categoría. Nunca vacío.
- Notarías de compraventa → "Adquisición (incluye gastos e impuestos)" siempre.
- Escrituras de compraventa → "Adquisición (incluye gastos e impuestos)" siempre.

═══ CAMPO NOTAS ═══
- SOLO para dudas reales de activo cuando no puedes determinarlo.
- Si el activo es claro → notas VACÍO.
- NO mencionar retenciones ni datos obvios en notas.
- En escrituras: incluir datos clave (notaría, protocolo, ref catastral, superficie).

Responde SOLO JSON válido sin texto adicional:
{"numero":"número exacto o vacío","fecha":"DD/MM/YYYY","proveedor":"nombre tal como aparece","concepto":"descripción breve","activo":"código o vacío si duda","categoria":"categoría exacta","cuantia":número,"iva":número,"otros":número_negativo_o_null,"notas":"solo si duda real, si no vacío"}`;

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

  return v;
};

const fmt = n => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(n);
const parseDate = d => { if (!d) return new Date(0); const [day,mon,yr] = d.split("/"); return new Date(`${yr}-${mon}-${day}`); };
const invoiceKey = inv => {
  const fecha   = (inv.fecha||"").trim();
  const prov    = (inv.proveedor||"").toLowerCase().trim().replace(/\s+/g," ");
  const cuantia = parseFloat(inv.cuantia||0).toFixed(2);
  const iva     = parseFloat(inv.iva||0).toFixed(2);
  const num     = (inv.numero||"").trim().toLowerCase();
  if (num) return `${prov}|${num}`;
  return `${fecha}|${prov}|${cuantia}|${iva}`;
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
        <input ref={ref} type="file" accept=".xlsx,.xls,.csv" onChange={e=>{const f=e.target.files[0];if(f)onFile(f)}} style={{ display:"none" }} />
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

function Field({ label, value, onChange, required, options, type="text" }) {
  const empty = required && (!value || value === "");
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize:11, color:empty?"#f87171":"#475569", marginBottom:4, letterSpacing:1, textTransform:"uppercase", display:"flex", alignItems:"center", gap:6 }}>
        {label}{empty && <span style={{color:"#f87171"}}>⚠</span>}
      </div>
      {options
        ? <select value={value||""} onChange={e=>onChange(e.target.value)} style={{ width:"100%", background:empty?"#1f0a0a":"#0a1628", border:`1px solid ${empty?"#ef4444":"#1e3a5f"}`, borderRadius:6, color:"#e2e8f0", padding:"8px 10px", fontFamily:"inherit", fontSize:13, outline:"none" }}>
            <option value="">— seleccionar —</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        : <input type={type} value={value||""} onChange={e=>onChange(e.target.value)} style={{ width:"100%", background:empty?"#1f0a0a":"#0a1628", border:`1px solid ${empty?"#ef4444":"#1e3a5f"}`, borderRadius:6, color:"#e2e8f0", padding:"8px 10px", fontFamily:"inherit", fontSize:13, outline:"none", boxSizing:"border-box" }} />}
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
      const dpr = window.devicePixelRatio || 1;
      const vp0 = page.getViewport({ scale: 1 });
      const scale = ((canvas.parentElement?.clientWidth || 400) - 2) / vp0.width;
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
  const [confirmBorrarTodo, setConfirmBorrarTodo] = useState(false);
  const [loaded, setLoaded]         = useState(false);
  const [filterCat, setFilterCat]   = useState("Todas");
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
  const totalPct = splits.reduce((a,s)=>a+(s.pct||0), 0);
  const splitValid = splits.every(s=>s.activo) && Math.abs(totalPct-100)<0.01;
  const invoicesRef = useRef([]);

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
    const existing = new Set(invoicesRef.current.map(invoiceKey));
    const fresh = newInvs.filter(inv => !existing.has(invoiceKey(inv)));
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
            model: "claude-sonnet-4-20250514", max_tokens: 1024, system: SYSTEM_PROMPT,
            messages: [{ role:"user", content:[
              { type:"document", source:{ type:"base64", media_type:"application/pdf", data:base64 }},
              { type:"text", text:`Extrae y clasifica este documento (factura, escritura, ITP o lo que sea). Archivo: "${filename}". Responde SOLO el JSON.` }
            ]}]
          })
        });
        if (res.status === 429) { await new Promise(r => setTimeout(r, (attempt+1)*3000)); continue; }
        if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message||`HTTP ${res.status}`); }
        const data = await res.json();
        const text = data.content.map(c=>c.text||"").join("");
        return validateInvoice(JSON.parse(text.replace(/```json|```/g,"").trim()), filename);
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
    const BATCH = 2, results = [];
    for (let i=0; i<fileData.length; i+=BATCH) {
      const batch = fileData.slice(i, i+BATCH);
      const br = await Promise.allSettled(batch.map(fd => callAPI(fd.base64, fd.name)));
      br.forEach((r, j) => results.push({ result: r.status==="fulfilled" ? {status:"fulfilled",value:r.value} : {status:"rejected",reason:r.reason?.message}, fd: batch[j] }));
      setProgress({ current: Math.min(i+BATCH, fileData.length), total: fileData.length });
      if (i+BATCH < fileData.length) await new Promise(r => setTimeout(r, 3000));
    }
    const autoSaved = [], needsReview = [], errors = [];
    results.forEach(({ result, fd }) => {
      if (result.status === "fulfilled" && result.value) {
        const inv = { ...result.value, numero: result.value.numero||"", otros: result.value.otros||null, comentario: "" };
        const hasDoubt = !inv.activo || (inv.notas && inv.notas.trim() !== "");
        if (hasDoubt) needsReview.push({ ...inv, _file: fd.file });
        else autoSaved.push({ ...inv, id: crypto.randomUUID() });
      } else errors.push(fd.name + ": " + (result.reason||"error"));
    });
    if (autoSaved.length) addInvoices(autoSaved);
    setAnalyzing(false); setProgress({ current:0, total:0 }); setPdfFiles([]);
    if (errors.length) showFlash(`⚠ ${errors.length} error(es): ${errors[0]}`, "err");
    if (needsReview.length === 0 && autoSaved.length === 0 && errors.length === 0) showFlash("No se procesó ningún documento.", "warn");
    else if (needsReview.length === 0) showFlash(`✓ ${autoSaved.length} guardado${autoSaved.length!==1?"s":""} automáticamente.`);
    else {
      if (autoSaved.length) showFlash(`✓ ${autoSaved.length} auto. ${needsReview.length} requieren revisión.`, "warn");
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
      let all = [];
      for (const [file, account] of [[ccFile,"CC"],[cpFile,"CP"]]) {
        if (!file) continue;
        const data = await readFile(file);
        all = [...all, ...(file.name.endsWith(".csv") ? parseCSV(data,account) : parseXLSX(data,account))];
      }
      if (!all.length) { showFlash("No se encontraron gastos financieros.","err"); setImporting(false); return; }
      const ids = new Set(entries.map(e=>e.id));
      const fresh = all.filter(e=>!ids.has(e.id));
      if (!fresh.length) { showFlash("Todos ya estaban registrados.","warn"); setImporting(false); return; }
      setEntries(prev => [...prev,...fresh].sort((a,b)=>parseDate(a.date)-parseDate(b.date)));
      setCcFile(null); setCpFile(null);
      showFlash(`✓ ${fresh.length} movimiento${fresh.length!==1?"s":""} importado${fresh.length!==1?"s":""}.`);
    } catch { showFlash("Error leyendo archivos.","err"); }
    setImporting(false);
  };

  // ── Computed ──
  const summary = entries.reduce((acc,e) => { acc[e.cat]=(acc[e.cat]||0)+e.amount; return acc; }, {});
  const total   = Object.values(summary).reduce((a,b)=>a+b, 0);
  const cats    = ["Todas",...Object.keys(CAT_COLORS)];
  const filtered = filterCat==="Todas" ? entries : entries.filter(e=>e.cat===filterCat);

  // Base de datos: all movements merged
  const allMovements = (() => {
    const m = [];
    Object.entries(ESCRITURAS).forEach(([code, esc]) => {
      m.push({ id:`esc-${code}`, fecha:esc.fecha_firma, tipo:"Escritura", proveedor:esc.vendedor,
        concepto:`Compraventa ${esc.nombre}`, activo:code, categoria:"Adquisición (incluye gastos e impuestos)",
        cuantia:esc.precio, iva:0, otros:0 });
    });
    invoices.forEach(inv => {
      m.push({ id:inv.id, fecha:inv.fecha, tipo:"Factura", proveedor:inv.proveedor, concepto:inv.concepto,
        activo:inv.activo, categoria:inv.categoria, cuantia:inv.cuantia||0, iva:inv.iva||0, otros:inv.otros||0 });
    });
    entries.forEach(e => {
      m.push({ id:e.id, fecha:e.date, tipo:"G. Financiero", proveedor:e.account==="CC"?"Cuenta Corriente":"Póliza Crédito",
        concepto:e.concept, activo:"AN", categoria:e.cat, cuantia:Math.abs(e.amount), iva:0, otros:0 });
    });
    return m.sort((a,b) => parseDate(a.fecha) - parseDate(b.fecha));
  })();

  // Facturas para IVA/IRPF
  const facturasIVA = invoices.filter(inv => (inv.iva||0)!==0 || (inv.otros||0)!==0 || (inv.numero && inv.numero.trim()));
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

  const TABS = [["importar","⬆ Importar"],["bd","🗄 Base de datos"],["facturas","🧾 Facturas"],["dashboard","📊 Dashboard"],["gf","🏦 G. Financieros"],["resumen","📈 Resumen"]];

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
            <div style={{ fontSize:11, color:"#64748b", marginBottom:2 }}>{allMovements.length} movimientos · {invoices.length} facturas</div>
          </div>
        </div>
      </div>

      <div style={{ display:"flex", borderBottom:"1px solid #1e3a5f", padding:"0 32px", overflowX:"auto" }}>
        {TABS.map(([key,label]) => <button key={key} onClick={()=>setTab(key)} style={{ background:"none", border:"none", cursor:"pointer", padding:"12px 20px", fontSize:13, fontFamily:"inherit", color:tab===key?"#3b82f6":"#64748b", borderBottom:tab===key?"2px solid #3b82f6":"2px solid transparent", marginBottom:-1, whiteSpace:"nowrap" }}>{label}</button>)}
      </div>

      <div style={{ padding:"24px 32px" }}>

        {/* ══ IMPORTAR ══ */}
        {tab==="importar" && <div>
          <div style={{ display:"flex", gap:32, flexWrap:"wrap", alignItems:"flex-start" }}>
            <div style={{ flex:"0 0 300px" }}>
              <div style={{ fontSize:15, fontWeight:700, color:"#f1f5f9", marginBottom:6 }}>Documentos PDF</div>
              <div style={{ fontSize:12, color:"#475569", marginBottom:16, lineHeight:1.7 }}>Arrastra facturas, escrituras, ITP o cualquier documento. Claude los analiza y clasifica.</div>
              <PdfDropZone files={pdfFiles} disabled={analyzing} onFiles={newFiles => setPdfFiles(prev => { const names = new Set(prev.map(f=>f.name)); return [...prev, ...newFiles.filter(f=>!names.has(f.name))]; })} />
              {pdfFiles.length > 0 && !draft && <button onClick={analyzeAll} disabled={analyzing} style={{ marginTop:14, width:"100%", background:analyzing?"#1e3a5f":"#1d4ed8", border:"none", color:"#fff", padding:"11px", borderRadius:8, cursor:analyzing?"default":"pointer", fontSize:14, fontFamily:"inherit", fontWeight:600 }}>{analyzing ? `Analizando… (${progress.current}/${progress.total})` : `✦ Analizar ${pdfFiles.length>1?pdfFiles.length+" documentos":"documento"} con IA`}</button>}
              {analyzing && progress.total > 0 && <div style={{ marginTop:8 }}><div style={{ background:"#1e3a5f", borderRadius:4, height:4, overflow:"hidden" }}><div style={{ background:"#3b82f6", height:"100%", borderRadius:4, transition:"width 0.4s", width:`${(progress.current/progress.total)*100}%` }} /></div><div style={{ fontSize:11, color:"#475569", marginTop:4, textAlign:"center" }}>{progress.current < progress.total ? `Lote ${Math.ceil((progress.current||1)/2)} de ${Math.ceil(progress.total/2)}` : "Finalizando…"}</div></div>}
              {reviewQueue.length > 0 && draft && <div style={{ marginTop:10, padding:"8px 12px", background:"#1c1917", border:"1px solid #f59e0b", borderRadius:8, fontSize:12, color:"#fbbf24" }}>⚠ Revisión {reviewIdx+1} de {reviewQueue.length}</div>}
              {!apiKey && <div style={{ marginTop:10, fontSize:11, color:"#f59e0b" }}>⚠ Configura la API key antes de analizar</div>}

              <div style={{ borderTop:"1px solid #1e3a5f", marginTop:28, paddingTop:24 }}>
                <div style={{ fontSize:15, fontWeight:700, color:"#f1f5f9", marginBottom:6 }}>Extractos bancarios</div>
                <div style={{ fontSize:12, color:"#475569", marginBottom:16, lineHeight:1.7 }}>Para gastos financieros (intereses, comisiones, seguros).</div>
                <DropZone label="CC" name="Cuenta Corriente" file={ccFile} onFile={setCcFile} />
                <DropZone label="CP" name="Póliza de Crédito" file={cpFile} onFile={setCpFile} />
                <button onClick={handleImport} disabled={importing} style={{ background:importing?"#1e3a5f":"#1d4ed8", border:"none", color:"#fff", padding:"10px 24px", borderRadius:8, cursor:importing?"default":"pointer", fontSize:14, fontFamily:"inherit", fontWeight:600 }}>{importing ? "Procesando…" : "Importar extractos"}</button>
              </div>
            </div>

            {draft && draft._file && <div style={{ flex:"1 1 360px", minWidth:300, maxWidth:500 }}><PdfViewer file={draft._file} /></div>}

            {draft && <div style={{ flex:"1 1 320px", minWidth:280, background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:12, padding:20 }}>
              <div style={{ fontSize:13, color:"#3b82f6", marginBottom:16, fontWeight:600 }}>Revisa y confirma
                {draft.notas && draft.notas.trim() && <div style={{ marginTop:6, padding:"8px 12px", background:"#1c1917", border:"1px solid #f59e0b", borderRadius:6, color:"#fbbf24", fontSize:12, fontWeight:400 }}>⚠ {draft.notas}</div>}
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 16px" }}>
                <Field label="Fecha" value={draft.fecha} onChange={v=>setDraft(d=>({...d,fecha:v}))} required />
                {!splitMode ? <Field label="Activo" value={draft.activo} onChange={v=>setDraft(d=>({...d,activo:v}))} required options={ACTIVOS} /> : <div style={{ display:"flex", alignItems:"center", fontSize:11, color:"#475569" }}>Activo → reparto ↓</div>}
                <div style={{ gridColumn:"span 2" }}><Field label="Proveedor" value={draft.proveedor} onChange={v=>setDraft(d=>({...d,proveedor:v}))} required /></div>
                <div style={{ gridColumn:"span 2" }}><Field label="Concepto" value={draft.concepto} onChange={v=>setDraft(d=>({...d,concepto:v}))} required /></div>
                <div style={{ gridColumn:"span 2" }}><Field label="Categoría" value={draft.categoria} onChange={v=>setDraft(d=>({...d,categoria:v}))} required options={CATEGORIAS} /></div>
                <Field label="Cuantía (base)" value={String(draft.cuantia||"")} onChange={v=>setDraft(d=>({...d,cuantia:parseFloat(v)||0}))} required type="number" />
                <Field label="IVA" value={String(draft.iva||"")} onChange={v=>setDraft(d=>({...d,iva:parseFloat(v)||0}))} type="number" />
                <Field label="Retención (neg)" value={String(draft.otros||"")} onChange={v=>setDraft(d=>({...d,otros:parseFloat(v)||null}))} type="number" />
                <div style={{ color:"#94a3b8", fontSize:13, display:"flex", alignItems:"center", gap:8 }}>Total: <span style={{ color:"#f87171", fontWeight:700 }}>{fmt((draft.cuantia||0)+(draft.iva||0)+(draft.otros||0))}</span></div>
              </div>
              <div style={{ marginTop:4, marginBottom:16 }}>
                <div style={{ fontSize:11, color:"#475569", marginBottom:4, letterSpacing:1, textTransform:"uppercase" }}>Comentario</div>
                <textarea value={draft.comentario||""} onChange={e=>setDraft(d=>({...d,comentario:e.target.value}))} placeholder="Aclaraciones…" rows={2} style={{ width:"100%", background:"#080f1a", border:"1px solid #1e3a5f", borderRadius:6, color:"#94a3b8", padding:"8px 10px", fontFamily:"inherit", fontSize:12, outline:"none", resize:"vertical", boxSizing:"border-box" }} />
              </div>
              <div style={{ marginBottom:14, borderTop:"1px solid #1e3a5f", paddingTop:14, display:"flex", alignItems:"center", gap:10, cursor:"pointer" }} onClick={()=>setSplitMode(v=>!v)}>
                <div style={{ width:36, height:20, borderRadius:10, background:splitMode?"#1d4ed8":"#1e3a5f", position:"relative", transition:"background 0.2s", flexShrink:0 }}><div style={{ position:"absolute", top:3, left:splitMode?18:3, width:14, height:14, borderRadius:"50%", background:splitMode?"#93c5fd":"#475569", transition:"left 0.2s" }} /></div>
                <span style={{ fontSize:12, color:splitMode?"#93c5fd":"#475569", userSelect:"none" }}>Repartir entre varios activos</span>
              </div>
              {splitMode && <div style={{ background:"#080f1a", border:"1px solid #1e3a5f", borderRadius:10, padding:14, marginBottom:16 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                  <span style={{ fontSize:11, color:"#475569", letterSpacing:1, textTransform:"uppercase" }}>Distribución</span>
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={()=>{ const p=parseFloat((100/splits.length).toFixed(4)); setSplits(prev=>prev.map((s,i)=>({...s,pct:i===prev.length-1?100-p*(prev.length-1):p}))); }} style={{ background:"transparent", border:"1px solid #1e3a5f", color:"#64748b", padding:"3px 10px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>Igualar %</button>
                    <button onClick={()=>setSplits(prev=>[...prev,{activo:"",pct:0}])} style={{ background:"transparent", border:"1px solid #1e3a5f", color:"#64748b", padding:"3px 10px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>+ Añadir</button>
                  </div>
                </div>
                {splits.map((s,i) => <SplitRow key={i} split={s} index={i} count={splits.length} base={draft.cuantia} iva={draft.iva} otros={draft.otros} onChange={(idx,key,val)=>setSplits(prev=>prev.map((sp,k)=>k===idx?{...sp,[key]:val}:sp))} onRemove={idx=>setSplits(prev=>prev.filter((_,k)=>k!==idx))} />)}
                <div style={{ marginTop:8, display:"flex", justifyContent:"space-between", fontSize:12 }}>
                  <span style={{ color:Math.abs(totalPct-100)<0.01?"#4ade80":"#f87171" }}>{totalPct.toFixed(1)}% {Math.abs(totalPct-100)<0.01?"✓":`(falta ${(100-totalPct).toFixed(1)}%)`}</span>
                  <span style={{ color:"#475569" }}>{fmt((draft.cuantia||0)+(draft.iva||0)+(draft.otros||0))}</span>
                </div>
              </div>}
              <div style={{ display:"flex", gap:10 }}>
                <button onClick={confirmInvoice} style={{ background:"#052e16", border:"1px solid #22c55e", color:"#4ade80", padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:13, fontFamily:"inherit", fontWeight:600 }}>✓ Confirmar y guardar</button>
                <button onClick={advanceReview} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"9px 14px", borderRadius:8, cursor:"pointer", fontSize:13, fontFamily:"inherit" }}>{reviewQueue.length > 1 ? "Saltar" : "Cancelar"}</button>
              </div>
            </div>}
          </div>
        </div>}

        {/* ══ BASE DE DATOS ══ */}
        {tab==="bd" && <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <div style={{ fontSize:13, color:"#64748b" }}>{allMovements.length} movimientos totales</div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={exportCSV} style={{ background:"#0f2942", border:"1px solid #1e3a5f", color:"#93c5fd", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Exportar CSV</button>
              {!confirmBorrarTodo
                ? <button onClick={()=>setConfirmBorrarTodo(true)} style={{ background:"transparent", border:"1px solid #450a0a", color:"#f87171", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Borrar facturas</button>
                : <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:12, color:"#f87171" }}>¿Seguro?</span>
                    <button onClick={()=>{ setInvoices([]); invoicesRef.current=[]; deleteAllInvoices().catch(()=>{}); setConfirmBorrarTodo(false); showFlash("Facturas eliminadas.","err"); }} style={{ background:"#450a0a", border:"1px solid #ef4444", color:"#f87171", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Sí</button>
                    <button onClick={()=>setConfirmBorrarTodo(false)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>No</button>
                  </span>}
            </div>
          </div>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
              <thead><tr style={{ background:"#0d1f35" }}>
                {["Fecha","Tipo","Proveedor","Concepto","Activo","Categoría","Cuantía","IVA","Ret.","Total",""].map(h => <th key={h} style={{ padding:"9px 10px", textAlign:["Cuantía","IVA","Ret.","Total"].includes(h)?"right":"left", color:"#475569", fontWeight:600, fontSize:10, letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #1e3a5f", whiteSpace:"nowrap" }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {allMovements.map((mov,i) => {
                  const t = (mov.cuantia||0)+(mov.iva||0)+(mov.otros||0);
                  const tc = mov.tipo==="Escritura"?"#4ade80":mov.tipo==="G. Financiero"?"#8b5cf6":"#60a5fa";
                  return <tr key={mov.id+"-"+i} style={{ background:i%2===0?"#0a1628":"#080f1a" }} onMouseEnter={e=>e.currentTarget.style.background="#0d1f35"} onMouseLeave={e=>e.currentTarget.style.background=i%2===0?"#0a1628":"#080f1a"}>
                    <td style={{ padding:"8px 10px", color:"#94a3b8", whiteSpace:"nowrap" }}>{mov.fecha}</td>
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
                      {mov.tipo==="Factura" && (delConfirm===mov.id
                        ? <span><button onClick={()=>{ const u=invoices.filter(x=>x.id!==mov.id); invoicesRef.current=u; setInvoices(u); deleteInvoice(mov.id).catch(()=>{}); setDelConfirm(null); showFlash("Eliminada.","warn"); }} style={{ background:"#450a0a", border:"1px solid #ef4444", color:"#f87171", padding:"2px 7px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", marginRight:4 }}>Sí</button><button onClick={()=>setDelConfirm(null)} style={{ background:"transparent", border:"1px solid #334155", color:"#64748b", padding:"2px 7px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>No</button></span>
                        : <button onClick={()=>setDelConfirm(mov.id)} style={{ background:"transparent", border:"none", color:"#334155", cursor:"pointer", fontSize:13, padding:"2px 5px" }}>✕</button>)}
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>}

        {/* ══ FACTURAS IVA/IRPF ══ */}
        {tab==="facturas" && <div>
          <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:20 }}>
            {[["Base imponible",totalBaseIVA,"#60a5fa"],["IVA soportado",totalIVASop,"#fbbf24"],["Retenciones",totalRet,"#f59e0b"],["Neto",totalBaseIVA+totalIVASop+totalRet,"#f87171"]].map(([l,v,c]) =>
              <div key={l} style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:10, padding:"12px 18px", flex:"1 1 160px", minWidth:140 }}>
                <div style={{ fontSize:10, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>{l}</div>
                <div style={{ fontSize:18, fontWeight:700, color:c }}>{fmt(v)}</div>
              </div>)}
          </div>
          <div style={{ fontSize:12, color:"#475569", marginBottom:12 }}>{facturasIVA.length} facturas con IVA y/o retención</div>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
              <thead><tr style={{ background:"#0d1f35" }}>
                {["Nº","Fecha","Proveedor","Concepto","Activo","Categoría","Base","IVA","Retención","Total"].map(h => <th key={h} style={{ padding:"9px 10px", textAlign:["Base","IVA","Retención","Total"].includes(h)?"right":"left", color:"#475569", fontWeight:600, fontSize:10, letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #1e3a5f", whiteSpace:"nowrap" }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {facturasIVA.map((inv,i) => <tr key={inv.id} style={{ background:i%2===0?"#0a1628":"#080f1a" }} onMouseEnter={e=>e.currentTarget.style.background="#0d1f35"} onMouseLeave={e=>e.currentTarget.style.background=i%2===0?"#0a1628":"#080f1a"}>
                  <td style={{ padding:"8px 10px", color:"#475569", fontSize:11, whiteSpace:"nowrap" }}>{inv.numero||"—"}</td>
                  <td style={{ padding:"8px 10px", color:"#94a3b8", whiteSpace:"nowrap" }}>{inv.fecha}</td>
                  <td style={{ padding:"8px 10px", color:"#cbd5e1", maxWidth:130, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{inv.proveedor}</td>
                  <td style={{ padding:"8px 10px", color:"#94a3b8", maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{inv.concepto}</td>
                  <td style={{ padding:"8px 10px" }}><span style={{ background:"#0f2942", color:"#60a5fa", padding:"2px 7px", borderRadius:4, fontSize:11, fontWeight:700 }}>{inv.activo}</span></td>
                  <td style={{ padding:"8px 10px", color:"#64748b", fontSize:11, maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{inv.categoria}</td>
                  <td style={{ padding:"8px 10px", textAlign:"right", color:"#e2e8f0" }}>{fmt(inv.cuantia||0)}</td>
                  <td style={{ padding:"8px 10px", textAlign:"right", color:"#fbbf24", fontWeight:600 }}>{fmt(inv.iva||0)}</td>
                  <td style={{ padding:"8px 10px", textAlign:"right", color:inv.otros?"#f59e0b":"#334155" }}>{inv.otros?fmt(inv.otros):"—"}</td>
                  <td style={{ padding:"8px 10px", textAlign:"right", color:"#f87171", fontWeight:600 }}>{fmt((inv.cuantia||0)+(inv.iva||0)+(inv.otros||0))}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </div>}

        {/* ══ DASHBOARD ══ */}
        {tab==="dashboard" && <DashboardTab invoices={invoices} />}

        {/* ══ G. FINANCIEROS ══ */}
        {tab==="gf" && <div>
          <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
            {cats.map(c => <button key={c} onClick={()=>setFilterCat(c)} style={{ background:filterCat===c?"#1e3a5f":"transparent", border:`1px solid ${filterCat===c?"#3b82f6":"#1e3a5f"}`, color:filterCat===c?"#93c5fd":"#64748b", padding:"5px 12px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>{c}</button>)}
          </div>
          {filtered.length === 0
            ? <div style={{ textAlign:"center", color:"#334155", padding:"60px 0", fontSize:14 }}>No hay movimientos. Ve a <span style={{ color:"#3b82f6", cursor:"pointer" }} onClick={()=>setTab("importar")}>Importar</span>.</div>
            : <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                  <thead><tr style={{ background:"#0d1f35" }}>
                    {["Fecha","Concepto","Cta.","Categoría","Subcategoría","Importe",""].map(h => <th key={h} style={{ padding:"10px 12px", textAlign:h==="Importe"?"right":"left", color:"#475569", fontWeight:600, fontSize:11, letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #1e3a5f", whiteSpace:"nowrap" }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {filtered.map((e,i) => { const col = CAT_COLORS[e.cat]||{bg:"#111",accent:"#888"}; return <tr key={e.id} style={{ background:i%2===0?"#0a1628":"#080f1a" }} onMouseEnter={ev=>ev.currentTarget.style.background="#0d1f35"} onMouseLeave={ev=>ev.currentTarget.style.background=i%2===0?"#0a1628":"#080f1a"}>
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
              </div>}
          {entries.length > 0 && <div style={{ marginTop:32, maxWidth:540 }}>
            <div style={{ fontSize:13, fontWeight:700, color:"#94a3b8", marginBottom:16, letterSpacing:1, textTransform:"uppercase" }}>Resumen acumulado</div>
            {Object.entries(summary).map(([cat,val]) => { const col = CAT_COLORS[cat]||{accent:"#888"}; const pct = total!==0?(val/total)*100:0; const subs = entries.filter(e=>e.cat===cat).reduce((acc,e)=>{ acc[e.sub]=(acc[e.sub]||0)+e.amount; return acc; }, {}); return <div key={cat} style={{ marginBottom:20 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}><span style={{ color:col.accent, fontSize:13 }}>{cat}</span><span style={{ color:"#f87171", fontWeight:700 }}>{fmt(val)}</span></div>
              <div style={{ background:"#0d1f35", borderRadius:4, height:6, overflow:"hidden" }}><div style={{ background:col.accent, width:`${Math.abs(pct)}%`, height:"100%", borderRadius:4 }} /></div>
              <div style={{ marginTop:8, paddingLeft:12, borderLeft:`2px solid ${col.accent}30` }}>{Object.entries(subs).map(([sub,v]) => <div key={sub} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#475569", padding:"3px 0" }}><span>{sub}</span><span>{fmt(v)}</span></div>)}</div>
            </div>; })}
            <div style={{ borderTop:"1px solid #1e3a5f", paddingTop:16, display:"flex", justifyContent:"space-between", marginTop:8 }}><span style={{ fontSize:14, fontWeight:700, color:"#94a3b8" }}>TOTAL</span><span style={{ fontSize:18, fontWeight:700, color:"#f87171" }}>{fmt(total)}</span></div>
            <div style={{ marginTop:16, padding:14, background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:8, fontSize:12, color:"#475569" }}>Período: <span style={{ color:"#94a3b8" }}>{entries[0]?.date}</span> → <span style={{ color:"#94a3b8" }}>{entries[entries.length-1]?.date}</span> · {entries.length} movimientos</div>
          </div>}
        </div>}

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
