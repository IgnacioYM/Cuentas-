// ─── reconciliacion.js ────────────────────────────────────────────────────────
// Motor de conciliación bancaria para Arena Nexus S.L.
// Cruza movimientos bancarios con facturas usando varios algoritmos.
// ──────────────────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────

const parseDate = (d) => {
  if (!d) return new Date(0);
  const [day, mon, yr] = d.split("/");
  return new Date(`${yr}-${mon}-${day}`);
};

const daysBetween = (d1, d2) =>
  Math.abs(Math.floor((parseDate(d1) - parseDate(d2)) / (1000 * 60 * 60 * 24)));

const facturaTotal = (inv) =>
  Math.abs((inv.cuantia || 0) + (inv.iva || 0) + (inv.otros || 0));

const normalize = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[.,;:\-_/\\()'"]+/g, " ").replace(/\s+/g, " ").trim();

// ─── Proveedor matching ──────────────────────────────────────────────────────
const PROVEEDOR_ALIASES = {
  "alzai":              ["alzai", "alza i"],
  "arena asset":        ["arena asset", "arena am", "aam", "arena a.m"],
  "victor cuenca":      ["victor", "cuenca", "victo"],
  "correos":            ["correos", "burofax"],
  "ferreteria":         ["ferreteria", "central de san mag", "san magd", "ferret"],
  "llabres":            ["llabres", "comamala", "llabre"],
  "ricardo ruiz":       ["ricardo", "ruiz rubio", "r. ruiz"],
  "pedro fernandez":    ["pedro fernandez", "p. fernandez", "indemnizacion", "indemniza"],
  "air europa":         ["air europa", "aireuropa", "devolucion gastos"],
  "consell":            ["consell", "consell de mallorca", "consell mall"],
  "ajuntament":         ["ajuntament", "ajuntament de palma", "ajunt"],
  "building center":    ["building center", "buildingcenter"],
  "ramos ortiz":        ["ramos ortiz", "ramos", "ortiz"],
  "barrios":            ["barrios", "juan barrios"],
  "notarios alcala":    ["alcala 35", "notarios alcala", "notaria alcala"],
  "finutive":           ["finutive"],
  "zadal":              ["zadal"],
  "agencia tributaria": ["tributos", "c.a. madrid", "agencia tributaria", "aeat", "hacienda"],
  "mentor":             ["mentor"],
  "cerberus":           ["cerberus", "promontoria", "servihabitat"],
  "verde iberia":       ["verde iberia"],
  "icaib":              ["icaib", "colegio abogados"],
  "colegio notarios":   ["colegio notarios", "notarial"],
  "registro propiedad": ["registro", "registrador"],
};

function matchProveedor(conceptoBanco, proveedorFactura) {
  const cb = normalize(conceptoBanco);
  const pf = normalize(proveedorFactura);

  // Direct substring match (first 6+ chars)
  if (pf.length >= 6 && cb.includes(pf.slice(0, 6))) return 0.9;
  if (cb.length >= 6 && pf.includes(cb.slice(0, 6))) return 0.9;

  // Alias match
  for (const [, aliases] of Object.entries(PROVEEDOR_ALIASES)) {
    const bankMatch = aliases.some((a) => cb.includes(a));
    const invMatch = aliases.some((a) => pf.includes(a));
    if (bankMatch && invMatch) return 0.85;
  }

  // Token overlap: split into words ≥3 chars and check overlap
  const tokensBank = cb.split(" ").filter(t => t.length >= 3);
  const tokensProv = pf.split(" ").filter(t => t.length >= 3);
  if (tokensBank.length > 0 && tokensProv.length > 0) {
    const matches = tokensProv.filter(tp => tokensBank.some(tb => tb.includes(tp) || tp.includes(tb)));
    const ratio = matches.length / tokensProv.length;
    if (ratio >= 0.5 && matches.length >= 1) return 0.7;
  }

  return 0;
}

// ─── Búsqueda de nº factura en concepto bancario ────────────────────────────

function extractNumbersFromConcept(concepto) {
  const norm = normalize(concepto);
  const found = new Set();
  // "Factura .72", "FACTURA N.156/2025", "Facturas 0001313"
  const p1 = /factura[s]?\s*[n.#nº]*\s*\.?\s*(\d[\d/.:]*\d?)/gi;
  let m;
  while ((m = p1.exec(norm)) !== null) {
    const c = m[1].replace(/[^0-9]/g, "");
    if (c.length >= 2) found.add(c);
  }
  // "PR1 / 11", "L / 24"
  const p2 = /(?:pr|l)\s*\/\s*(\d+)/gi;
  while ((m = p2.exec(norm)) !== null) {
    found.add(m[1]);
  }
  // Reference-style codes: "802174R...", "0000XXXXX PRO..."
  const p3 = /\b(\d{4,})\b/g;
  while ((m = p3.exec(norm)) !== null) {
    found.add(m[1]);
  }
  return [...found];
}

function matchFacturaNumero(conceptoBanco, facturaNumero) {
  if (!facturaNumero) return 0;
  const conceptNums = extractNumbersFromConcept(conceptoBanco);
  if (conceptNums.length === 0) return 0;
  const facNum = (facturaNumero || "").replace(/[^0-9]/g, "");
  if (facNum.length < 2) return 0;
  for (const cn of conceptNums) {
    if (cn === facNum) return 0.9;
    if (cn.length >= 3 && facNum.includes(cn)) return 0.75;
    if (facNum.length >= 3 && cn.includes(facNum)) return 0.75;
  }
  return 0;
}

// ─── Algoritmo de conciliación ───────────────────────────────────────────────

const TOLERANCE_DAYS = 5;
const TOLERANCE_AMOUNT = 0.05; // 5 céntimos

/**
 * Genera sugerencias de conciliación.
 * @param {Array} movimientos - movimientos bancarios sin conciliar
 * @param {Array} facturas - facturas sin conciliar
 * @returns {Array} sugerencias
 */
export function generarSugerencias(movimientos, facturas) {
  const sugerencias = [];
  const facturasUsadas = new Set();
  const movsUsados = new Set();

  const movPagos = movimientos.filter(
    (m) => m.importe < 0 && ["pago_factura", "tributos", "devolucion"].includes(m.tipo)
  );

  // ═══ PASO 1: Match exacto (importe + fecha ±5 días) ═══
  for (const mov of movPagos) {
    if (movsUsados.has(mov.id)) continue;
    const importeMov = Math.abs(mov.importe);

    const candidates = facturas
      .filter(f => !facturasUsadas.has(f.id))
      .filter(f => Math.abs(importeMov - facturaTotal(f)) <= TOLERANCE_AMOUNT)
      .filter(f => daysBetween(mov.fecha, f.fecha) <= TOLERANCE_DAYS)
      .sort((a, b) => {
        const scoreA = matchProveedor(mov.concepto, a.proveedor) + matchFacturaNumero(mov.concepto, a.numero);
        const scoreB = matchProveedor(mov.concepto, b.proveedor) + matchFacturaNumero(mov.concepto, b.numero);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return daysBetween(mov.fecha, a.fecha) - daysBetween(mov.fecha, b.fecha);
      });

    if (candidates.length > 0) {
      const best = candidates[0];
      const provScore = matchProveedor(mov.concepto, best.proveedor);
      const numScore = matchFacturaNumero(mov.concepto, best.numero);
      const confianza = provScore > 0 || numScore > 0 ? 0.95 : 0.75;
      sugerencias.push({
        movimiento: mov,
        facturas: [{ factura: best, importe: importeMov }],
        metodo: "auto_exacto",
        confianza,
      });
      facturasUsadas.add(best.id);
      movsUsados.add(mov.id);
    }
  }

  // ═══ PASO 2: Match por proveedor + importe (fecha flexible) ═══
  for (const mov of movPagos) {
    if (movsUsados.has(mov.id)) continue;
    const importeMov = Math.abs(mov.importe);

    const candidates = facturas
      .filter(f => !facturasUsadas.has(f.id))
      .filter(f => matchProveedor(mov.concepto, f.proveedor) > 0)
      .filter(f => Math.abs(importeMov - facturaTotal(f)) <= TOLERANCE_AMOUNT)
      .sort((a, b) => daysBetween(mov.fecha, a.fecha) - daysBetween(mov.fecha, b.fecha));

    if (candidates.length > 0) {
      const best = candidates[0];
      const dias = daysBetween(mov.fecha, best.fecha);
      const confianza = dias <= 5 ? 0.9 : dias <= 15 ? 0.7 : dias <= 60 ? 0.55 : 0.4;
      sugerencias.push({
        movimiento: mov,
        facturas: [{ factura: best, importe: importeMov }],
        metodo: "auto_proveedor",
        confianza,
      });
      facturasUsadas.add(best.id);
      movsUsados.add(mov.id);
    }
  }

  // ═══ PASO 3: Match por nº factura en concepto bancario ═══
  for (const mov of movPagos) {
    if (movsUsados.has(mov.id)) continue;
    const importeMov = Math.abs(mov.importe);

    const candidates = facturas
      .filter(f => !facturasUsadas.has(f.id))
      .filter(f => f.numero && matchFacturaNumero(mov.concepto, f.numero) > 0)
      .sort((a, b) => {
        const scoreA = matchFacturaNumero(mov.concepto, a.numero);
        const scoreB = matchFacturaNumero(mov.concepto, b.numero);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return Math.abs(importeMov - facturaTotal(a)) - Math.abs(importeMov - facturaTotal(b));
      });

    if (candidates.length > 0) {
      const best = candidates[0];
      const amountMatch = Math.abs(importeMov - facturaTotal(best)) <= TOLERANCE_AMOUNT;
      const numScore = matchFacturaNumero(mov.concepto, best.numero);
      const confianza = amountMatch ? 0.9 : numScore >= 0.9 ? 0.7 : 0.5;
      if (amountMatch || Math.abs(importeMov - facturaTotal(best)) / Math.max(importeMov, 1) <= 0.1) {
        sugerencias.push({
          movimiento: mov,
          facturas: [{ factura: best, importe: amountMatch ? importeMov : facturaTotal(best) }],
          metodo: "auto_numero",
          confianza,
        });
        facturasUsadas.add(best.id);
        movsUsados.add(mov.id);
      }
    }
  }

  // ═══ PASO 4: Match agrupado (N facturas mismo proveedor = 1 movimiento) ═══
  for (const mov of movPagos) {
    if (movsUsados.has(mov.id)) continue;
    const importeMov = Math.abs(mov.importe);

    const facsPorProv = {};
    for (const f of facturas) {
      if (facturasUsadas.has(f.id)) continue;
      if (matchProveedor(mov.concepto, f.proveedor) === 0) continue;
      const prov = normalize(f.proveedor);
      if (!facsPorProv[prov]) facsPorProv[prov] = [];
      facsPorProv[prov].push(f);
    }

    let found = false;
    for (const [, facs] of Object.entries(facsPorProv)) {
      if (found) break;
      if (facs.length < 2 || facs.length > 6) continue;
      const combos = getCombinations(facs, 2, Math.min(facs.length, 6));
      for (const combo of combos) {
        const sumaCombo = combo.reduce((s, f) => s + facturaTotal(f), 0);
        if (Math.abs(importeMov - sumaCombo) <= TOLERANCE_AMOUNT) {
          sugerencias.push({
            movimiento: mov,
            facturas: combo.map(f => ({ factura: f, importe: facturaTotal(f) })),
            metodo: "auto_agrupado",
            confianza: 0.8,
          });
          combo.forEach(f => facturasUsadas.add(f.id));
          movsUsados.add(mov.id);
          found = true;
          break;
        }
      }
    }
  }

  // ═══ PASO 5: Match solo por importe (baja confianza, fecha ≤30 días) ═══
  for (const mov of movPagos) {
    if (movsUsados.has(mov.id)) continue;
    const importeMov = Math.abs(mov.importe);

    const candidates = facturas
      .filter(f => !facturasUsadas.has(f.id))
      .filter(f => Math.abs(importeMov - facturaTotal(f)) <= TOLERANCE_AMOUNT)
      .sort((a, b) => daysBetween(mov.fecha, a.fecha) - daysBetween(mov.fecha, b.fecha));

    if (candidates.length > 0) {
      const best = candidates[0];
      const dias = daysBetween(mov.fecha, best.fecha);
      if (dias <= 30) {
        sugerencias.push({
          movimiento: mov,
          facturas: [{ factura: best, importe: importeMov }],
          metodo: "auto_importe",
          confianza: dias <= 5 ? 0.6 : dias <= 15 ? 0.45 : 0.3,
        });
        facturasUsadas.add(best.id);
        movsUsados.add(mov.id);
      }
    }
  }

  return sugerencias;
}

// ─── Utilidades combinatorias ─────────────────────────────────────────────────

function getCombinations(arr, minLen, maxLen) {
  const results = [];
  const combine = (start, current) => {
    if (current.length >= minLen && current.length <= maxLen) {
      results.push([...current]);
    }
    if (current.length >= maxLen) return;
    for (let i = start; i < arr.length; i++) {
      current.push(arr[i]);
      combine(i + 1, current);
      current.pop();
    }
  };
  combine(0, []);
  return results;
}

// ─── Resumen de conciliación ─────────────────────────────────────────────────

export function resumenConciliacion(movimientos, facturas, conciliaciones) {
  const concMovIds = new Set(conciliaciones.map((c) => c.movimiento_id));
  const concFacIds = new Set(conciliaciones.map((c) => c.factura_id));

  const movPagos = movimientos.filter(
    (m) => m.importe < 0 && ["pago_factura", "tributos", "devolucion"].includes(m.tipo)
  );

  return {
    totalMovimientos: movimientos.length,
    movimientosPago: movPagos.length,
    movConciliados: movPagos.filter((m) => concMovIds.has(m.id)).length,
    movPendientes: movPagos.filter((m) => !concMovIds.has(m.id)).length,
    totalFacturas: facturas.length,
    facConciliadas: facturas.filter((f) => concFacIds.has(f.id)).length,
    facPendientes: facturas.filter((f) => !concFacIds.has(f.id)).length,
    importeConciliado: conciliaciones.reduce((s, c) => s + Math.abs(c.importe), 0),
    importePendiente: facturas
      .filter((f) => !concFacIds.has(f.id))
      .reduce((s, f) => s + facturaTotal(f), 0),
  };
}
