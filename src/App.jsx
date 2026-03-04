import { useState, useEffect } from "react";

// ─── Clasificación automática ────────────────────────────────────────────────
const RULES = [
  { match: /LIQUIDACION CTA\.?CTO/i,  cat: "G. Financiero – Póliza",    sub: "Intereses póliza" },
  { match: /MANTENIMIENTO/i,          cat: "G. Financiero – Póliza",    sub: "Mantenimiento" },
  { match: /ADMINISTRACI[OÓ]N DEP/i,  cat: "G. Financiero – Póliza",    sub: "Administración depósito" },
  { match: /PRECIO ED\.? EXTRACTO/i,  cat: "G. Financiero – Póliza",    sub: "Precio extracto" },
  { match: /F0000005620267/i,         cat: "G. Financiero – Póliza",    sub: "Comisión apertura" },
  { match: /^PRES\./i,                cat: "G. Financiero – Préstamo",  sub: "Intereses préstamo" },
  { match: /SEGUR.*CAIXA/i,          cat: "G. Financiero – Préstamo",  sub: "Seguro vinculado" },
  { match: /MYBOX/i,                  cat: "G. Financiero – Póliza",   sub: "Fidelización MYBOX" },
  { match: /SEVIAM/i,                 cat: "G. Financiero – Préstamo",   sub: "FIdelización SEVIAM" },
];

function classify(concept) {
  for (const r of RULES) {
    if (r.match.test(concept)) return { cat: r.cat, sub: r.sub };
  }
  return null;
}

function parseCSV(text, account) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const sep = lines[0]?.includes("\t") ? "\t" : ";";
  const results = [];
  for (const line of lines) {
    const parts = line.split(sep);
    if (parts.length < 3) continue;
    const concept = parts[0].trim();
    const dateRaw = parts[1].trim();
    const amountRaw = parts[2].replace("EUR", "").replace(/\./g, "").replace(",", ".").trim();
    const amount = parseFloat(amountRaw);
    if (isNaN(amount) || concept.toLowerCase() === "concepto") continue;
    const cls = classify(concept);
    if (!cls) continue;
    if (amount >= 0) continue;
    const id = `${account}-${dateRaw}-${concept}-${amount}`;
    results.push({ id, date: dateRaw, concept, account, amount, cat: cls.cat, sub: cls.sub });
  }
  return results;
}

// ─── Colores ──────────────────────────────────────────────────────────────────
const CAT_COLORS = {
  "G. Financiero – Póliza":    { bg: "#0f2942", accent: "#3b82f6" },
  "G. Financiero – Préstamo":  { bg: "#1a1a2e", accent: "#8b5cf6" },
};

const fmt = (n) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(n);

const parseDate = (d) => {
  const [day, month, year] = d.split("/");
  return new Date(`${year}-${month}-${day}`);
};

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [entries, setEntries] = useState([]);
  const [ccText, setCcText] = useState("");
  const [cpText, setCpText] = useState("");
  const [tab, setTab] = useState("tabla");
  const [flash, setFlash] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [filterCat, setFilterCat] = useState("Todas");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("gf-entries-arena-nexus");
      if (saved) setEntries(JSON.parse(saved));
    } catch (_) {}
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem("gf-entries-arena-nexus", JSON.stringify(entries));
    } catch (_) {}
  }, [entries, loaded]);

  const showFlash = (msg, type = "ok") => {
    setFlash({ msg, type });
    setTimeout(() => setFlash(null), 3000);
  };

  const handleImport = () => {
    const newCC = parseCSV(ccText, "CC");
    const newCP = parseCSV(cpText, "CP");
    const all = [...newCC, ...newCP];
    if (!all.length) { showFlash("No se encontraron gastos financieros en los datos pegados.", "err"); return; }
    const existingIds = new Set(entries.map((e) => e.id));
    const fresh = all.filter((e) => !existingIds.has(e.id));
    if (!fresh.length) { showFlash("Todos los movimientos ya estaban registrados.", "warn"); return; }
    setEntries((prev) => [...prev, ...fresh].sort((a, b) => parseDate(a.date) - parseDate(b.date)));
    setCcText(""); setCpText("");
    showFlash(`✓ ${fresh.length} nuevo${fresh.length > 1 ? "s" : ""} movimiento${fresh.length > 1 ? "s" : ""} importado${fresh.length > 1 ? "s" : ""}.`);
    setTab("tabla");
  };

  const handleDelete = (id) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setDeleteConfirm(null);
    showFlash("Movimiento eliminado.", "warn");
  };

  const handleClear = () => {
    setEntries([]);
    showFlash("Todos los datos eliminados.", "err");
  };

  const summary = entries.reduce((acc, e) => {
    acc[e.cat] = (acc[e.cat] || 0) + e.amount;
    return acc;
  }, {});
  const total = Object.values(summary).reduce((a, b) => a + b, 0);

  const cats = ["Todas", ...Object.keys(CAT_COLORS)];
  const filtered = filterCat === "Todas" ? entries : entries.filter((e) => e.cat === filterCat);

  const exportCSV = () => {
    const header = "Fecha;Concepto;Cuenta;Categoría;Subcategoría;Importe\n";
    const rows = entries.map((e) =>
      [e.date, e.concept, e.account, e.cat, e.sub, e.amount.toFixed(2).replace(".", ",")].join(";")
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "gastos_financieros.csv"; a.click();
  };

  if (!loaded) return <div style={{ background: "#080f1a", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#3b82f6", fontFamily: "monospace", fontSize: 14 }}>Cargando…</div>;

  return (
    <div style={{ background: "#080f1a", minHeight: "100vh", fontFamily: "'DM Mono', 'Fira Code', monospace", color: "#e2e8f0" }}>
      {flash && (
        <div style={{
          position: "fixed", top: 20, right: 20, zIndex: 999,
          background: flash.type === "ok" ? "#052e16" : flash.type === "warn" ? "#1c1917" : "#1f0a0a",
          border: `1px solid ${flash.type === "ok" ? "#22c55e" : flash.type === "warn" ? "#f59e0b" : "#ef4444"}`,
          color: flash.type === "ok" ? "#4ade80" : flash.type === "warn" ? "#fbbf24" : "#f87171",
          padding: "10px 18px", borderRadius: 8, fontSize: 13, maxWidth: 340,
          boxShadow: "0 4px 20px rgba(0,0,0,0.5)"
        }}>{flash.msg}</div>
      )}

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1e3a5f", padding: "22px 32px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 11, color: "#3b82f6", letterSpacing: 3, textTransform: "uppercase", marginBottom: 4 }}>Arena Nexus · Seguimiento</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", letterSpacing: -0.5 }}>Gastos Financieros</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>{entries.length} movimientos</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#f87171" }}>{fmt(total)}</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #1e3a5f", padding: "0 32px" }}>
        {[["tabla", "📋 Tabla"], ["resumen", "📊 Resumen"], ["importar", "⬆ Importar"]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            background: "none", border: "none", cursor: "pointer",
            padding: "12px 20px", fontSize: 13, fontFamily: "inherit",
            color: tab === key ? "#3b82f6" : "#64748b",
            borderBottom: tab === key ? "2px solid #3b82f6" : "2px solid transparent",
            marginBottom: -1, transition: "color 0.2s"
          }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "24px 32px" }}>

        {/* ── TABLA ── */}
        {tab === "tabla" && (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
              {cats.map((c) => (
                <button key={c} onClick={() => setFilterCat(c)} style={{
                  background: filterCat === c ? "#1e3a5f" : "transparent",
                  border: `1px solid ${filterCat === c ? "#3b82f6" : "#1e3a5f"}`,
                  color: filterCat === c ? "#93c5fd" : "#64748b",
                  padding: "5px 12px", borderRadius: 20, cursor: "pointer",
                  fontSize: 12, fontFamily: "inherit", transition: "all 0.15s"
                }}>{c}</button>
              ))}
              <div style={{ marginLeft: "auto" }}>
                <button onClick={exportCSV} style={{
                  background: "#0f2942", border: "1px solid #1e3a5f", color: "#93c5fd",
                  padding: "5px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit"
                }}>Exportar CSV</button>
              </div>
            </div>

            {filtered.length === 0 ? (
              <div style={{ textAlign: "center", color: "#334155", padding: "60px 0", fontSize: 14 }}>
                No hay movimientos. Ve a <span style={{ color: "#3b82f6", cursor: "pointer" }} onClick={() => setTab("importar")}>Importar</span> para añadir extractos.
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#0d1f35" }}>
                      {["Fecha", "Concepto", "Cta.", "Categoría", "Subcategoría", "Importe", ""].map((h) => (
                        <th key={h} style={{ padding: "10px 12px", textAlign: h === "Importe" ? "right" : "left", color: "#475569", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #1e3a5f", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((e, i) => {
                      const colors = CAT_COLORS[e.cat] || { bg: "#111", accent: "#888" };
                      return (
                        <tr key={e.id} style={{ background: i % 2 === 0 ? "#0a1628" : "#080f1a" }}
                          onMouseEnter={(ev) => ev.currentTarget.style.background = "#0d1f35"}
                          onMouseLeave={(ev) => ev.currentTarget.style.background = i % 2 === 0 ? "#0a1628" : "#080f1a"}>
                          <td style={{ padding: "9px 12px", color: "#94a3b8", whiteSpace: "nowrap" }}>{e.date}</td>
                          <td style={{ padding: "9px 12px", color: "#cbd5e1", maxWidth: 260 }}>{e.concept}</td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ background: "#0f2942", color: "#60a5fa", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>{e.account}</span>
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ background: colors.bg, color: colors.accent, border: `1px solid ${colors.accent}30`, padding: "2px 8px", borderRadius: 4, fontSize: 11 }}>{e.cat}</span>
                          </td>
                          <td style={{ padding: "9px 12px", color: "#64748b", fontSize: 12 }}>{e.sub}</td>
                          <td style={{ padding: "9px 12px", textAlign: "right", color: "#f87171", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(e.amount)}</td>
                          <td style={{ padding: "9px 8px", textAlign: "center" }}>
                            {deleteConfirm === e.id ? (
                              <span style={{ fontSize: 11 }}>
                                <button onClick={() => handleDelete(e.id)} style={{ background: "#450a0a", border: "1px solid #ef4444", color: "#f87171", padding: "2px 8px", borderRadius: 4, cursor: "pointer", fontSize: 11, fontFamily: "inherit", marginRight: 4 }}>Sí</button>
                                <button onClick={() => setDeleteConfirm(null)} style={{ background: "transparent", border: "1px solid #334155", color: "#64748b", padding: "2px 8px", borderRadius: 4, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>No</button>
                              </span>
                            ) : (
                              <button onClick={() => setDeleteConfirm(e.id)} style={{ background: "transparent", border: "none", color: "#334155", cursor: "pointer", fontSize: 14, padding: "2px 6px" }} title="Eliminar">✕</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── RESUMEN ── */}
        {tab === "resumen" && (
          <div style={{ maxWidth: 540 }}>
            <div style={{ marginBottom: 20, fontSize: 12, color: "#475569" }}>Acumulado total del período</div>
            {Object.entries(summary).map(([cat, val]) => {
              const colors = CAT_COLORS[cat] || { accent: "#888" };
              const pct = total !== 0 ? (val / total) * 100 : 0;
              return (
                <div key={cat} style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ color: colors.accent, fontSize: 13 }}>{cat}</span>
                    <span style={{ color: "#f87171", fontWeight: 700 }}>{fmt(val)}</span>
                  </div>
                  <div style={{ background: "#0d1f35", borderRadius: 4, height: 6, overflow: "hidden" }}>
                    <div style={{ background: colors.accent, width: `${Math.abs(pct)}%`, height: "100%", borderRadius: 4, transition: "width 0.5s ease" }} />
                  </div>
                  <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: `2px solid ${colors.accent}30` }}>
                    {Object.entries(
                      entries.filter((e) => e.cat === cat).reduce((acc, e) => {
                        acc[e.sub] = (acc[e.sub] || 0) + e.amount;
                        return acc;
                      }, {})
                    ).map(([sub, v]) => (
                      <div key={sub} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#475569", padding: "3px 0" }}>
                        <span>{sub}</span><span>{fmt(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            <div style={{ borderTop: "1px solid #1e3a5f", paddingTop: 16, display: "flex", justifyContent: "space-between", marginTop: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#94a3b8" }}>TOTAL</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: "#f87171" }}>{fmt(total)}</span>
            </div>
            {entries.length > 0 && (
              <div style={{ marginTop: 24, padding: 14, background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: 8, fontSize: 12, color: "#475569" }}>
                Período: <span style={{ color: "#94a3b8" }}>{entries[0]?.date}</span> → <span style={{ color: "#94a3b8" }}>{entries[entries.length - 1]?.date}</span>
                &nbsp;·&nbsp; {entries.length} movimientos
              </div>
            )}
          </div>
        )}

        {/* ── IMPORTAR ── */}
        {tab === "importar" && (
          <div style={{ maxWidth: 720 }}>
            <div style={{ fontSize: 13, color: "#475569", marginBottom: 20, lineHeight: 1.7 }}>
              Copia las filas del Excel del extracto (Ctrl+C) y pégalas aquí (Ctrl+V). La app detecta automáticamente el formato, identifica los gastos financieros e ignora duplicados.
            </div>
            {[["CC", ccText, setCcText, "Cuenta Corriente"], ["CP", cpText, setCpText, "Póliza de Crédito"]].map(([label, val, setter, name]) => (
              <div key={label} style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ background: "#0f2942", color: "#60a5fa", padding: "3px 10px", borderRadius: 4, fontSize: 12, fontWeight: 700 }}>{label}</span>
                  <span style={{ color: "#475569", fontSize: 12 }}>{name}</span>
                </div>
                <textarea
                  value={val}
                  onChange={(e) => setter(e.target.value)}
                  placeholder={`Copia las filas del Excel de ${name} y pégalas aquí…`}
                  style={{
                    width: "100%", height: 140, background: "#0a1628", border: "1px solid #1e3a5f",
                    borderRadius: 8, color: "#94a3b8", fontFamily: "inherit", fontSize: 12,
                    padding: 12, resize: "vertical", outline: "none", boxSizing: "border-box", lineHeight: 1.6
                  }}
                />
              </div>
            ))}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button onClick={handleImport}
                onMouseEnter={(e) => e.target.style.background = "#2563eb"}
                onMouseLeave={(e) => e.target.style.background = "#1d4ed8"}
                style={{ background: "#1d4ed8", border: "none", color: "#fff", padding: "10px 24px", borderRadius: 8, cursor: "pointer", fontSize: 14, fontFamily: "inherit", fontWeight: 600 }}>
                Importar movimientos
              </button>
              {entries.length > 0 && (
                <button onClick={handleClear} style={{ background: "transparent", border: "1px solid #450a0a", color: "#f87171", padding: "9px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>
                  Borrar todo
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
