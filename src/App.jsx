import { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";

// ─── Clasificación automática ────────────────────────────────────────────────
const RULES = [
  { match: /LIQUIDACION CTA\.?CTO/i,  cat: "G. Financiero – Póliza",    sub: "Intereses póliza" },
  { match: /MANTENIMIENTO/i,          cat: "G. Financiero – Póliza",    sub: "Mantenimiento" },
  { match: /ADMINISTRACI[OÓ]N DEP/i,  cat: "G. Financiero – Póliza",    sub: "Administración depósito" },
  { match: /PRECIO ED\.? EXTRACTO/i,  cat: "G. Financiero – Póliza",    sub: "Precio extracto" },
  { match: /F0000005620267/i,         cat: "G. Financiero – Póliza",    sub: "Comisión apertura" },
  { match: /^PRES\./i,                cat: "G. Financiero – Préstamo",  sub: "Intereses préstamo" },
  { match: /SEGUR.*CAIXA/i,          cat: "G. Financiero – Préstamo",  sub: "Seguro vinculado" },
  { match: /MYBOX/i,                  cat: "G. Financiero – Préstamo",  sub: "Fidelización MYBOX" },
  { match: /SEVIAM/i,                 cat: "G. Financiero – Préstamo",  sub: "Fidelización SEVIAM" },
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

function parseXLSX(buffer, account) {
  try {
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: "DD/MM/YYYY" });
    const results = [];
    for (const row of rows) {
      if (!row || row.length < 3) continue;
      const concept = String(row[0] || "").trim();
      const dateRaw = String(row[1] || "").trim();
      const amountRaw = String(row[2] || "").replace("EUR", "").replace(/\./g, "").replace(",", ".").trim();
      const amount = parseFloat(amountRaw);
      if (isNaN(amount) || concept.toLowerCase() === "concepto") continue;
      const cls = classify(concept);
      if (!cls) continue;
      if (amount >= 0) continue;
      const id = `${account}-${dateRaw}-${concept}-${amount}`;
      results.push({ id, date: dateRaw, concept, account, amount, cat: cls.cat, sub: cls.sub });
    }
    return results;
  } catch (e) {
    return [];
  }
}

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

// ─── Drop Zone ───────────────────────────────────────────────────────────────
function DropZone({ label, name, onFile, file }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef();

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  };

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (f) onFile(f);
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ background: "#0f2942", color: "#60a5fa", padding: "3px 10px", borderRadius: 4, fontSize: 12, fontWeight: 700 }}>{label}</span>
        <span style={{ color: "#475569", fontSize: 12 }}>{name}</span>
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current.click()}
        style={{
          border: `2px dashed ${dragging ? "#3b82f6" : file ? "#22c55e" : "#1e3a5f"}`,
          borderRadius: 8, padding: "28px 20px", textAlign: "center",
          cursor: "pointer", transition: "all 0.2s",
          background: dragging ? "#0d1f35" : file ? "#052e16" : "#0a1628",
        }}
      >
        <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{ display: "none" }} />
        {file ? (
          <div>
            <div style={{ fontSize: 20, marginBottom: 6 }}>✓</div>
            <div style={{ color: "#4ade80", fontSize: 13, fontWeight: 600 }}>{file.name}</div>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>Haz clic para cambiar</div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 24, marginBottom: 8 }}>📂</div>
            <div style={{ color: "#475569", fontSize: 13 }}>Arrastra el Excel aquí o haz clic para seleccionar</div>
            <div style={{ color: "#334155", fontSize: 11, marginTop: 4 }}>.xlsx · .xls · .csv</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [entries, setEntries] = useState([]);
  const [ccFile, setCcFile] = useState(null);
  const [cpFile, setCpFile] = useState(null);
  const [tab, setTab] = useState("tabla");
  const [flash, setFlash] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [filterCat, setFilterCat] = useState("Todas");
  const [importing, setImporting] = useState(false);

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
    setTimeout(() => setFlash(null), 3500);
  };

  const readFile = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    if (file.name.endsWith(".csv")) {
      reader.readAsText(file, "utf-8");
    } else {
      reader.readAsArrayBuffer(file);
    }
  });

  const handleImport = async () => {
    if (!ccFile && !cpFile) { showFlash("Selecciona al menos un archivo.", "err"); return; }
    setImporting(true);
    try {
      let all = [];
      for (const [file, account] of [[ccFile, "CC"], [cpFile, "CP"]]) {
        if (!file) continue;
        const data = await readFile(file);
        const results = file.name.endsWith(".csv")
          ? parseCSV(data, account)
          : parseXLSX(data, account);
        all = [...all, ...results];
      }
      if (!all.length) { showFlash("No se encontraron gastos financieros en los archivos.", "err"); setImporting(false); return; }
      const existingIds = new Set(entries.map((e) => e.id));
      const fresh = all.filter((e) => !existingIds.has(e.id));
      if (!fresh.length) { showFlash("Todos los movimientos ya estaban registrados.", "warn"); setImporting(false); return; }
      setEntries((prev) => [...prev, ...fresh].sort((a, b) => parseDate(a.date) - parseDate(b.date)));
      setCcFile(null); setCpFile(null);
      showFlash(`✓ ${fresh.length} movimiento${fresh.length > 1 ? "s" : ""} importado${fresh.length > 1 ? "s" : ""}.`);
      setTab("tabla");
    } catch (e) {
      showFlash("Error leyendo los archivos.", "err");
    }
    setImporting(false);
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

  if (!loaded) return (
    <div style={{ background: "#080f1a", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#3b82f6", fontFamily: "monospace", fontSize: 14 }}>
      Cargando…
    </div>
  );

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

        {tab === "importar" && (
          <div style={{ maxWidth: 720 }}>
            <div style={{ fontSize: 13, color: "#475569", marginBottom: 24, lineHeight: 1.7 }}>
              Arrastra los archivos Excel directamente o haz clic para seleccionarlos. La app identifica los gastos financieros automáticamente e ignora duplicados.
            </div>
            <DropZone label="CC" name="Cuenta Corriente" file={ccFile} onFile={setCcFile} />
            <DropZone label="CP" name="Póliza de Crédito" file={cpFile} onFile={setCpFile} />
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
              <button
                onClick={handleImport}
                disabled={importing}
                onMouseEnter={(e) => { if (!importing) e.target.style.background = "#2563eb"; }}
                onMouseLeave={(e) => { if (!importing) e.target.style.background = "#1d4ed8"; }}
                style={{ background: importing ? "#1e3a5f" : "#1d4ed8", border: "none", color: "#fff", padding: "10px 24px", borderRadius: 8, cursor: importing ? "default" : "pointer", fontSize: 14, fontFamily: "inherit", fontWeight: 600 }}>
                {importing ? "Procesando…" : "Importar"}
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
