// ─── reconciliacion.js ────────────────────────────────────────────────────────
// Motor de conciliación bancaria para Arena Nexus S.L.
// ──────────────────────────────────────────────────────────────────────────────

const parseDate = (d) => {
  if (!d) return new Date(0);
  const [day, mon, yr] = d.split("/");
  return new Date(`${yr}-${mon}-${day}`);
};

const daysBetween = (d1, d2) =>
  Math.abs(Math.floor((parseDate(d1) - parseDate(d2)) / (1000 * 60 * 60 * 24)));

const facturaTotal = (inv) =>
  Math.abs((inv.cuantia || 0) + (inv.iva || 0) + (inv.otros || 0));

// Multiple candidate amounts for matching — the bank pays base+IVA to the provider;
// the retención IRPF (otros) is paid separately to Hacienda.
// So bank amount could match: total, base+IVA (sin retención), or just base.
const facturaAmounts = (inv) => {
  const total  = Math.abs((inv.cuantia || 0) + (inv.iva || 0) + (inv.otros || 0));
  const sinRet = Math.abs((inv.cuantia || 0) + (inv.iva || 0));
  const base   = Math.abs(inv.cuantia || 0);
  const amounts = [{ amt: total, conf: 1 }];
  // Only add alternatives if they differ from total
  if (Math.abs(sinRet - total) > 0.01) amounts.push({ amt: sinRet, conf: 0.9 });
  if (Math.abs(base - total) > 0.01 && Math.abs(base - sinRet) > 0.01) amounts.push({ amt: base, conf: 0.8 });
  return amounts;
};

// Check if a bank amount matches any of the invoice's candidate amounts
const matchAmount = (bankAmt, inv, tolerance) => {
  const candidates = facturaAmounts(inv);
  for (const c of candidates) {
    if (Math.abs(bankAmt - c.amt) <= tolerance) {
      return { matched: true, matchedAmt: c.amt, confMult: c.conf };
    }
  }
  return { matched: false, matchedAmt: 0, confMult: 0 };
};

const normalize = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

// ─── Proveedor matching ──────────────────────────────────────────────────────

const PROVEEDOR_ALIASES = {
  "alzai":              ["alzai", "alza i"],
  "arena asset":        ["arena asset", "arena am", "aam", "arena a.m", "aam2025"],
  "victor cuenca":      ["victor", "cuenca", "victo"],
  "correos":            ["correos", "burofax"],
  "ferreteria":         ["ferreteria", "central de san mag", "san magd", "ferret"],
  "llabres":            ["llabres", "comamala", "llabre"],
  "ricardo ruiz":       ["ricardo", "ruiz rubio", "r. ruiz"],
  "pedro fernandez":    ["pedro fernandez", "p. fernandez", "indemnizacion", "indemniza"],
  "air europa":         ["air europa", "aireuropa"],
  "consell":            ["consell", "consell de mallorca"],
  "ajuntament":         ["ajuntament", "ajuntament de palma"],
  "building center":    ["building center", "buildingcenter"],
  "ramos ortiz":        ["ramos ortiz", "ramos"],
  "barrios":            ["barrios", "juan barrios"],
  "notarios alcala":    ["alcala 35", "notarios alcala"],
  "finutive":           ["finutive"],
  "zadal":              ["zadal"],
  "agencia tributaria": ["tributos", "c.a. madrid", "agencia tributaria", "i.r.p.f"],
  "mentor":             ["mentor"],
  "cerberus":           ["cerberus", "promontoria", "servihabitat"],
  "verde iberia":       ["verde iberia"],
  "registro propiedad": ["registro", "registrador"],
  "devolucion gastos":  ["devolucion gastos", "pago con cuenta p"],
};

function matchProveedor(conceptoBanco, proveedorFactura) {
  const cb = normalize(conceptoBanco);
  const pf = normalize(proveedorFactura);
  if (!cb || !pf) return 0;

  // Direct substring (first 6+ chars)
  const minLen = Math.min(6, pf.length, cb.length);
  if (minLen >= 4) {
    if (cb.includes(pf.slice(0, minLen))) return 0.9;
    if (pf.includes(cb.slice(0, minLen))) return 0.9;
  }

  // Alias match
  for (const [, aliases] of Object.entries(PROVEEDOR_ALIASES)) {
    const bankMatch = aliases.some(a => cb.includes(a));
    const invMatch  = aliases.some(a => pf.includes(a));
    if (bankMatch && invMatch) return 0.85;
  }

  // Token overlap
  const tb = cb.split(" ").filter(t => t.length >= 3);
  const tp = pf.split(" ").filter(t => t.length >= 3);
  if (tb.length > 0 && tp.length > 0) {
    const hits = tp.filter(w => tb.some(bw => bw.includes(w) || w.includes(bw)));
    if (hits.length >= 1 && hits.length / tp.length >= 0.4) return 0.7;
  }

  return 0;
}

// ─── Extracción de números de factura del concepto bancario ──────────────────
// Patrones reales:
//   "Facturas 55 y 56"         → [55, 56]
//   "Factura .72 Victo"        → [72]
//   "FACTURA N.156/202"        → [156]
//   "FACTURA Nº151/202"        → [151]
//   "Facturas 0001313"         → [1313]
//   "Factura AAM2025.4"        → [4]  (el ".4" es el nº)
//   "PR1 / 11"                 → [11]
//   "L / 24"                   → [24]
//   "802174R..."               → [802174]

function extractInvoiceNumbers(concepto) {
  const c = normalize(concepto);
  const nums = [];

  // "Facturas 55 y 56" / "Facturas 55 e 56"
  const multiMatch = c.match(/facturas?\s+(\d+)\s+[ye]\s+(\d+)/);
  if (multiMatch) {
    nums.push(multiMatch[1], multiMatch[2]);
  }

  // "Factura .72" / "Factura N.156" / "Factura Nº151" / "FACTURA N.156/202"
  const facNumMatch = [...c.matchAll(/facturas?\s*[n.nº#]*\s*\.?\s*(\d+)/gi)];
  for (const m of facNumMatch) nums.push(m[1]);

  // "Factura AAM2025.4" → extract after the dot
  const aamMatch = c.match(/aam\d{4}\.(\d+)/);
  if (aamMatch) nums.push(aamMatch[1]);

  // "PR1 / 11", "L / 24"
  const slashMatch = c.match(/(?:pr\d?|l)\s*\/\s*(\d+)/);
  if (slashMatch) nums.push(slashMatch[1]);

  // "0001313 PRO" → reference-style
  const refMatch = c.match(/(\d{4,})\s*pro/);
  if (refMatch) nums.push(refMatch[1]);

  // Clean: remove leading zeros for matching, keep originals too
  const result = new Set();
  for (const n of nums) {
    result.add(n);
    const stripped = n.replace(/^0+/, "");
    if (stripped) result.add(stripped);
  }
  return [...result];
}

// Match extracted numbers against a factura's numero field
function matchNumero(extractedNums, facturaNumero) {
  if (!facturaNumero || extractedNums.length === 0) return false;
  
  // Split factura number into numeric segments
  // "156/2025" → ["156","2025"], "0001313 PRO/2025" → ["0001313","2025"], "AAM2025.4" → ["2025","4"]
  const segments = (facturaNumero || "").match(/\d+/g) || [];
  if (segments.length === 0) return false;

  for (const n of extractedNums) {
    for (const seg of segments) {
      const segStripped = seg.replace(/^0+/, "") || seg;
      const nStripped = n.replace(/^0+/, "") || n;
      // Exact match (with or without leading zeros)
      if (n === seg || nStripped === segStripped) return true;
      // Suffix match (factura segment ends with extracted number)
      if (segStripped.endsWith(nStripped) && nStripped.length >= 2) return true;
      if (nStripped.endsWith(segStripped) && segStripped.length >= 2) return true;
    }
  }
  return false;
}

// ─── Tolerancias ─────────────────────────────────────────────────────────────

const TOL_AMT = 0.10;  // 10 céntimos (cubre redondeos de retención IRPF)
const TOL_DAYS_EXACT = 5;

// ─── Motor de conciliación ──────────────────────────────────────────────────

export function generarSugerencias(movimientos, facturas) {
  const sugerencias = [];
  const usedFac = new Set();
  const usedMov = new Set();

  // Solo cargos que son pagos / tributos / devoluciones
  const movPagos = movimientos.filter(
    m => m.importe < 0 && ["pago_factura", "tributos", "devolucion"].includes(m.tipo)
  );

  // Helper: add a suggestion
  const addSug = (mov, facs, metodo, confianza) => {
    sugerencias.push({
      movimiento: mov,
      facturas: facs.map(f => ({ factura: f, importe: facturaTotal(f) })),
      metodo,
      confianza,
    });
    facs.forEach(f => usedFac.add(f.id));
    usedMov.add(mov.id);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 1: Match exacto — importe + fecha ±5 días
  // ═══════════════════════════════════════════════════════════════════════════
  for (const mov of movPagos) {
    if (usedMov.has(mov.id)) continue;
    const imp = Math.abs(mov.importe);

    const cands = facturas
      .filter(f => !usedFac.has(f.id))
      .filter(f => matchAmount(imp, f, TOL_AMT).matched)
      .filter(f => daysBetween(mov.fecha, f.fecha) <= TOL_DAYS_EXACT);

    if (cands.length === 0) continue;

    cands.sort((a, b) => {
      const nums = extractInvoiceNumbers(mov.concepto);
      const sa = matchProveedor(mov.concepto, a.proveedor) + (matchNumero(nums, a.numero) ? 0.5 : 0);
      const sb = matchProveedor(mov.concepto, b.proveedor) + (matchNumero(nums, b.numero) ? 0.5 : 0);
      if (sb !== sa) return sb - sa;
      return daysBetween(mov.fecha, a.fecha) - daysBetween(mov.fecha, b.fecha);
    });

    const best = cands[0];
    const prov = matchProveedor(mov.concepto, best.proveedor);
    const num  = matchNumero(extractInvoiceNumbers(mov.concepto), best.numero);
    const amtInfo = matchAmount(imp, best, TOL_AMT);
    const conf = Math.min(((prov > 0 || num) ? 0.95 : 0.75) * amtInfo.confMult, 0.95);
    addSug(mov, [best], "auto_exacto", conf);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 2: Match por nº factura — concepto bancario contiene nº(s) de factura
  //         Incluye agrupado por números ("Facturas 55 y 56")
  // ═══════════════════════════════════════════════════════════════════════════
  for (const mov of movPagos) {
    if (usedMov.has(mov.id)) continue;
    const imp = Math.abs(mov.importe);
    const nums = extractInvoiceNumbers(mov.concepto);
    if (nums.length === 0) continue;

    // Find ALL facturas whose numero matches any extracted number
    const matched = facturas.filter(f =>
      !usedFac.has(f.id) && f.numero && matchNumero(nums, f.numero)
    );

    if (matched.length === 0) continue;

    // Case A: single factura matches amount
    const singleMatch = matched.find(f => matchAmount(imp, f, TOL_AMT).matched);
    if (singleMatch) {
      const amtInfo = matchAmount(imp, singleMatch, TOL_AMT);
      addSug(mov, [singleMatch], "auto_numero", 0.9 * amtInfo.confMult);
      continue;
    }

    // Case B: multiple facturas whose sum matches (e.g. "Facturas 55 y 56")
    if (matched.length >= 2 && matched.length <= 6) {
      const combos = getCombinations(matched, 2, Math.min(matched.length, 6));
      let found = false;
      for (const combo of combos) {
        const sumTotal = combo.reduce((s, f) => s + facturaTotal(f), 0);
        const sumSinRet = combo.reduce((s, f) => s + Math.abs((f.cuantia||0) + (f.iva||0)), 0);
        if (Math.abs(imp - sumTotal) <= TOL_AMT) {
          addSug(mov, combo, "auto_numero", 0.85);
          found = true; break;
        }
        if (Math.abs(imp - sumSinRet) <= TOL_AMT && Math.abs(sumSinRet - sumTotal) > 0.01) {
          addSug(mov, combo, "auto_numero", 0.75);
          found = true; break;
        }
      }
      if (found) continue;
    }

    // Case C: referenced number → find provider, then group by provider
    if (matched.length >= 1) {
      const refProv = matched[0].proveedor;
      const sameProv = facturas.filter(f =>
        !usedFac.has(f.id) &&
        normalize(f.proveedor) === normalize(refProv)
      );
      if (sameProv.length >= 2 && sameProv.length <= 8) {
        const combos = getCombinations(sameProv, 2, Math.min(sameProv.length, 6));
        let found = false;
        for (const combo of combos) {
          const sumTotal = combo.reduce((s, f) => s + facturaTotal(f), 0);
          const sumSinRet = combo.reduce((s, f) => s + Math.abs((f.cuantia||0) + (f.iva||0)), 0);
          if (Math.abs(imp - sumTotal) <= TOL_AMT) {
            addSug(mov, combo, "auto_numero", 0.8);
            found = true; break;
          }
          if (Math.abs(imp - sumSinRet) <= TOL_AMT && Math.abs(sumSinRet - sumTotal) > 0.01) {
            addSug(mov, combo, "auto_numero", 0.7);
            found = true; break;
          }
        }
        if (found) continue;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 3: Match por proveedor + importe (fecha flexible hasta 90 días)
  // ═══════════════════════════════════════════════════════════════════════════
  for (const mov of movPagos) {
    if (usedMov.has(mov.id)) continue;
    const imp = Math.abs(mov.importe);

    const cands = facturas
      .filter(f => !usedFac.has(f.id))
      .filter(f => matchProveedor(mov.concepto, f.proveedor) > 0)
      .filter(f => matchAmount(imp, f, TOL_AMT).matched)
      .sort((a, b) => daysBetween(mov.fecha, a.fecha) - daysBetween(mov.fecha, b.fecha));

    if (cands.length > 0) {
      const best = cands[0];
      const dias = daysBetween(mov.fecha, best.fecha);
      const amtInfo = matchAmount(imp, best, TOL_AMT);
      const conf = (dias <= 5 ? 0.9 : dias <= 15 ? 0.75 : dias <= 60 ? 0.55 : 0.4) * amtInfo.confMult;
      addSug(mov, [best], "auto_proveedor", conf);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 4: Match agrupado — N facturas mismo proveedor cuya suma = importe
  // ═══════════════════════════════════════════════════════════════════════════
  for (const mov of movPagos) {
    if (usedMov.has(mov.id)) continue;
    const imp = Math.abs(mov.importe);

    // Group available invoices by proveedor (using matchProveedor)
    const byProv = {};
    for (const f of facturas) {
      if (usedFac.has(f.id)) continue;
      if (matchProveedor(mov.concepto, f.proveedor) === 0) continue;
      const key = normalize(f.proveedor);
      if (!byProv[key]) byProv[key] = [];
      byProv[key].push(f);
    }

    let found = false;
    for (const [, facs] of Object.entries(byProv)) {
      if (found) break;
      if (facs.length < 2 || facs.length > 8) continue;
      const combos = getCombinations(facs, 2, Math.min(facs.length, 6));
      for (const combo of combos) {
        // Try sum using facturaTotal first, then using base+IVA (sin retención)
        const sumTotal = combo.reduce((s, f) => s + facturaTotal(f), 0);
        const sumSinRet = combo.reduce((s, f) => s + Math.abs((f.cuantia||0) + (f.iva||0)), 0);
        if (Math.abs(imp - sumTotal) <= TOL_AMT) {
          addSug(mov, combo, "auto_agrupado", 0.8);
          found = true;
          break;
        }
        if (Math.abs(imp - sumSinRet) <= TOL_AMT && Math.abs(sumSinRet - sumTotal) > 0.01) {
          addSug(mov, combo, "auto_agrupado", 0.7);
          found = true;
          break;
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PASO 5: Match solo por importe — sin proveedor, baja confianza, ≤30 días
  // ═══════════════════════════════════════════════════════════════════════════
  for (const mov of movPagos) {
    if (usedMov.has(mov.id)) continue;
    const imp = Math.abs(mov.importe);

    const cands = facturas
      .filter(f => !usedFac.has(f.id))
      .filter(f => matchAmount(imp, f, TOL_AMT).matched)
      .filter(f => daysBetween(mov.fecha, f.fecha) <= 30)
      .sort((a, b) => daysBetween(mov.fecha, a.fecha) - daysBetween(mov.fecha, b.fecha));

    if (cands.length > 0) {
      const best = cands[0];
      const dias = daysBetween(mov.fecha, best.fecha);
      const amtInfo = matchAmount(imp, best, TOL_AMT);
      addSug(mov, [best], "auto_importe", (dias <= 5 ? 0.6 : dias <= 15 ? 0.45 : 0.3) * amtInfo.confMult);
    }
  }

  return sugerencias;
}

// ─── Combinatorias ───────────────────────────────────────────────────────────

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

// ─── Resumen ─────────────────────────────────────────────────────────────────

export function resumenConciliacion(movimientos, facturas, conciliaciones) {
  const concMovIds = new Set(conciliaciones.map(c => c.movimiento_id));
  const concFacIds = new Set(conciliaciones.map(c => c.factura_id));
  const movPagos = movimientos.filter(
    m => m.importe < 0 && ["pago_factura", "tributos", "devolucion"].includes(m.tipo)
  );
  return {
    totalMovimientos: movimientos.length,
    movimientosPago: movPagos.length,
    movConciliados: movPagos.filter(m => concMovIds.has(m.id)).length,
    movPendientes: movPagos.filter(m => !concMovIds.has(m.id)).length,
    totalFacturas: facturas.length,
    facConciliadas: facturas.filter(f => concFacIds.has(f.id)).length,
    facPendientes: facturas.filter(f => !concFacIds.has(f.id)).length,
    importeConciliado: conciliaciones.reduce((s, c) => s + Math.abs(c.importe), 0),
    importePendiente: facturas
      .filter(f => !concFacIds.has(f.id))
      .reduce((s, f) => s + facturaTotal(f), 0),
  };
}
