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
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

// ─── Proveedor matching ──────────────────────────────────────────────────────
// Mapea conceptos bancarios truncados a proveedores conocidos
const PROVEEDOR_ALIASES = {
  "alzai":           ["alzai"],
  "arena asset":     ["arena asset", "arena am", "aam"],
  "victor":          ["victor", "cuenca"],
  "correos":         ["correos"],
  "ferreteria":      ["ferreteria", "central de san mag"],
  "llabres":         ["llabres", "comamala"],
  "ricardo ruiz":    ["ricardo", "ruiz rubio"],
  "pedro fernandez": ["pedro fernandez", "indemnizacion"],
  "air europa":      ["air europa", "aireuropa", "devolucion gastos"],
  "consell":         ["consell"],
  "ajuntament":      ["ajuntament"],
  "building center": ["building center"],
  "ramos ortiz":     ["ramos ortiz"],
  "barrios":         ["barrios"],
  "notarios alcala":  ["alcala 35", "notarios alcala"],
  "finutive":        ["finutive"],
  "zadal":           ["zadal"],
  "agencia tributaria": ["tributos", "c.a. madrid"],
};

function matchProveedor(conceptoBanco, proveedorFactura) {
  const cb = normalize(conceptoBanco);
  const pf = normalize(proveedorFactura);

  // Direct substring match
  if (cb.includes(pf.slice(0, 8)) || pf.includes(cb.slice(0, 8))) return 0.9;

  // Alias match: check if both map to the same group
  for (const [, aliases] of Object.entries(PROVEEDOR_ALIASES)) {
    const bankMatch = aliases.some((a) => cb.includes(a));
    const invMatch = aliases.some((a) => pf.includes(a));
    if (bankMatch && invMatch) return 0.85;
  }

  return 0;
}

// ─── Algoritmo de conciliación ───────────────────────────────────────────────

const TOLERANCE_DAYS = 5;
const TOLERANCE_AMOUNT = 0.02; // 2 céntimos de margen

/**
 * Genera sugerencias de conciliación.
 * @param {Array} movimientos - movimientos bancarios (tipo 'pago_factura' o 'tributos')
 * @param {Array} facturas - facturas sin conciliar
 * @returns {Array} sugerencias: [{ movimiento, facturas: [{factura, importe}], metodo, confianza }]
 */
export function generarSugerencias(movimientos, facturas) {
  const sugerencias = [];
  const facturasUsadas = new Set();

  // Solo movimientos negativos (cargos) que son pagos o tributos
  const movPagos = movimientos.filter(
    (m) => m.importe < 0 && ["pago_factura", "tributos", "devolucion"].includes(m.tipo)
  );

  // ═══ PASO 1: Match exacto (importe + fecha ± 5 días) ═══
  for (const mov of movPagos) {
    const importeMov = Math.abs(mov.importe);

    for (const fac of facturas) {
      if (facturasUsadas.has(fac.id)) continue;
      const totalFac = facturaTotal(fac);
      if (Math.abs(importeMov - totalFac) > TOLERANCE_AMOUNT) continue;
      if (daysBetween(mov.fecha, fac.fecha) > TOLERANCE_DAYS) continue;

      // Match exacto por importe y fecha
      const provScore = matchProveedor(mov.concepto, fac.proveedor);
      const confianza = provScore > 0 ? 0.95 : 0.75; // más confianza si proveedor también matchea

      sugerencias.push({
        movimiento: mov,
        facturas: [{ factura: fac, importe: importeMov }],
        metodo: "auto_exacto",
        confianza,
      });
      facturasUsadas.add(fac.id);
      break; // un movimiento → una factura en match exacto
    }
  }

  // ═══ PASO 2: Match por proveedor + importe (sin restricción de fecha estricta) ═══
  const movSinMatch = movPagos.filter(
    (m) => !sugerencias.some((s) => s.movimiento.id === m.id)
  );

  for (const mov of movSinMatch) {
    const importeMov = Math.abs(mov.importe);

    const candidates = facturas
      .filter((f) => !facturasUsadas.has(f.id))
      .filter((f) => matchProveedor(mov.concepto, f.proveedor) > 0)
      .filter((f) => Math.abs(importeMov - facturaTotal(f)) <= TOLERANCE_AMOUNT)
      .sort((a, b) => daysBetween(mov.fecha, a.fecha) - daysBetween(mov.fecha, b.fecha));

    if (candidates.length > 0) {
      const best = candidates[0];
      const dias = daysBetween(mov.fecha, best.fecha);
      const confianza = dias <= 5 ? 0.9 : dias <= 15 ? 0.7 : 0.5;

      sugerencias.push({
        movimiento: mov,
        facturas: [{ factura: best, importe: importeMov }],
        metodo: "auto_proveedor",
        confianza,
      });
      facturasUsadas.add(best.id);
    }
  }

  // ═══ PASO 3: Match agrupado (N facturas mismo proveedor = 1 movimiento) ═══
  const movSinMatch2 = movPagos.filter(
    (m) => !sugerencias.some((s) => s.movimiento.id === m.id)
  );

  for (const mov of movSinMatch2) {
    const importeMov = Math.abs(mov.importe);

    // Agrupar facturas disponibles por proveedor
    const facsPorProv = {};
    for (const f of facturas) {
      if (facturasUsadas.has(f.id)) continue;
      if (matchProveedor(mov.concepto, f.proveedor) === 0) continue;
      const prov = normalize(f.proveedor);
      if (!facsPorProv[prov]) facsPorProv[prov] = [];
      facsPorProv[prov].push(f);
    }

    // Intentar combinaciones (solo hasta 4 facturas por eficiencia)
    for (const [, facs] of Object.entries(facsPorProv)) {
      if (facs.length < 2 || facs.length > 4) continue;

      // Probar todas las combinaciones de 2-4 facturas
      const combos = getCombinations(facs, 2, Math.min(facs.length, 4));
      for (const combo of combos) {
        const sumaCombo = combo.reduce((s, f) => s + facturaTotal(f), 0);
        if (Math.abs(importeMov - sumaCombo) <= TOLERANCE_AMOUNT) {
          sugerencias.push({
            movimiento: mov,
            facturas: combo.map((f) => ({
              factura: f,
              importe: facturaTotal(f),
            })),
            metodo: "auto_agrupado",
            confianza: 0.8,
          });
          combo.forEach((f) => facturasUsadas.add(f.id));
          break;
        }
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

/**
 * Calcula estadísticas de conciliación.
 * @param {Array} movimientos - todos los movimientos bancarios
 * @param {Array} facturas - todas las facturas
 * @param {Array} conciliaciones - vínculos existentes
 */
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
