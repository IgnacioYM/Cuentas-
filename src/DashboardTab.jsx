import { useState } from "react";
import { ESCRITURAS, TOTAL_PRECIO_ADQUISICION } from "./escrituras";

const fmt = (n) =>
  new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);

const fmt2 = (n) =>
  new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(n);

// Categorías que van contra AN (holding)
const CAT_GENERALES = [
  "Costes de implementación (SPV, abogados, etc.)",
  "Opex",
  "Comisión de gestión",
];

// Categorías que van contra activos inmobiliarios
const CAT_ACTIVOS = [
  "Adquisición (incluye gastos e impuestos)",
  "Costes legales",
  "Capex",
  "Costes de posesión",
];

// Colores por activo (matching a warm brown palette like the Excel)
const ASSET_COLORS = {
  BB5:  "#b45309",
  FMM3: "#92400e",
  PR30: "#78350f",
  PB27: "#a16207",
  E65:  "#854d0e",
  M1:   "#713f12",
  AG55: "#9a3412",
};

function computeData(invoices) {
  // Group invoices by activo → categoría → sum of (cuantia + iva + otros)
  const byActivo = {};
  let totalGeneral = 0;
  let totalActivos = 0;

  invoices.forEach((inv) => {
    const activo = inv.activo || "SIN_ASIGNAR";
    const cat = inv.categoria || "Sin categoría";
    const total = (inv.cuantia || 0) + (inv.iva || 0) + (inv.otros || 0);

    if (!byActivo[activo]) byActivo[activo] = {};
    if (!byActivo[activo][cat]) byActivo[activo][cat] = 0;
    byActivo[activo][cat] += total;
  });

  // AN totals (costes generales)
  const anData = byActivo["AN"] || {};
  CAT_GENERALES.forEach((c) => {
    totalGeneral += anData[c] || 0;
  });

  // Asset totals — include escritura price in Adquisición
  const assetData = {};
  const ADQ_CAT = "Adquisición (incluye gastos e impuestos)";
  Object.keys(ESCRITURAS).forEach((code) => {
    const data = { ...(byActivo[code] || {}) };
    // Add purchase price from escritura to Adquisición
    data[ADQ_CAT] = (data[ADQ_CAT] || 0) + ESCRITURAS[code].precio;
    let assetTotal = 0;
    CAT_ACTIVOS.forEach((c) => {
      assetTotal += data[c] || 0;
    });
    assetData[code] = { cats: data, total: assetTotal };
    totalActivos += assetTotal;
  });

  // Summary by category across all
  const summaryByCat = {};
  invoices.forEach((inv) => {
    const cat = inv.categoria || "Sin categoría";
    const total = (inv.cuantia || 0) + (inv.iva || 0) + (inv.otros || 0);
    summaryByCat[cat] = (summaryByCat[cat] || 0) + total;
  });
  // Add escritura prices to Adquisición summary
  summaryByCat[ADQ_CAT] = (summaryByCat[ADQ_CAT] || 0) + TOTAL_PRECIO_ADQUISICION;

  return {
    anData,
    totalGeneral,
    assetData,
    totalActivos,
    grandTotal: totalGeneral + totalActivos,
    summaryByCat,
  };
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent = "#3b82f6" }) {
  return (
    <div
      style={{
        background: "#0a1628",
        border: "1px solid #1e3a5f",
        borderRadius: 10,
        padding: "16px 20px",
        flex: "1 1 180px",
        minWidth: 160,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "#475569",
          letterSpacing: 1,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent }}>
        {fmt(value)}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "#334155", marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function CatRow({ label, value, indent = false, dimIfZero = true }) {
  const zero = !value || value === 0;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: `4px ${indent ? "0 4px 14px" : "0"}`,
        fontSize: 13,
        color: zero && dimIfZero ? "#334155" : "#94a3b8",
      }}
    >
      <span>{label}</span>
      <span
        style={{
          fontWeight: zero ? 400 : 600,
          color: zero && dimIfZero ? "#334155" : "#e2e8f0",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {zero ? "–" : fmt2(value)}
      </span>
    </div>
  );
}

function AssetCard({ code, data, escritura }) {
  const color = ASSET_COLORS[code] || "#64748b";
  const total = data.total;
  const precio = escritura?.precio || 0;

  return (
    <div
      style={{
        background: "#0a1628",
        border: "1px solid #1e3a5f",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          background: `${color}18`,
          borderBottom: `1px solid ${color}40`,
          padding: "12px 18px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              background: color,
              color: "#fff",
              padding: "3px 10px",
              borderRadius: 5,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 1,
            }}
          >
            {code}
          </span>
          <span style={{ fontSize: 12, color: "#94a3b8" }}>
            {escritura?.nombre}
          </span>
        </div>
        <span style={{ fontSize: 18, fontWeight: 700, color: "#f87171" }}>
          {fmt(total)}
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: "12px 18px 16px" }}>
        {CAT_ACTIVOS.map((cat) => (
          <CatRow key={cat} label={shortCat(cat)} value={data.cats[cat] || 0} />
        ))}

        {/* Precio escritura reference */}
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid #1e3a5f",
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: "#475569",
          }}
        >
          <span>Precio escritura</span>
          <span style={{ color: "#64748b" }}>{fmt(precio)}</span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: "#475569",
            marginTop: 2,
          }}
        >
          <span>Gastos s/ precio</span>
          <span style={{ color: precio ? "#64748b" : "#334155" }}>
            {precio
              ? `+${fmt2(total - precio)} (${(((total - precio) / precio) * 100).toFixed(1)}%)`
              : "–"}
          </span>
        </div>
      </div>
    </div>
  );
}

function shortCat(cat) {
  if (cat.startsWith("Adquisición")) return "Adquisición";
  if (cat.startsWith("Costes de implementación")) return "Implementación";
  if (cat.startsWith("Comisión")) return "Comisión gestión";
  return cat;
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function DashboardTab({ invoices = [] }) {
  const [view, setView] = useState("resumen"); // "resumen" | "detalle"
  const d = computeData(invoices);

  const totalPrecioAdq = TOTAL_PRECIO_ADQUISICION;
  const totalPosesion = d.summaryByCat["Costes de posesión"] || 0;
  const totalLegal = d.summaryByCat["Costes legales"] || 0;
  const totalCapex = d.summaryByCat["Capex"] || 0;

  return (
    <div>
      {/* ── Top stats ── */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 28,
        }}
      >
        <StatCard
          label="Total costes"
          value={d.grandTotal}
          accent="#f87171"
          sub={`${invoices.length} facturas`}
        />
        <StatCard
          label="Costes generales (AN)"
          value={d.totalGeneral}
          accent="#60a5fa"
        />
        <StatCard
          label="Costes activos"
          value={d.totalActivos}
          accent="#fbbf24"
          sub="7 inmuebles"
        />
        <StatCard
          label="Precio adquisición"
          value={totalPrecioAdq}
          accent="#4ade80"
          sub="Suma escrituras"
        />
      </div>

      {/* ── View toggle ── */}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 24,
          background: "#0a1628",
          borderRadius: 8,
          padding: 3,
          width: "fit-content",
          border: "1px solid #1e3a5f",
        }}
      >
        {[
          ["resumen", "Resumen por activo"],
          ["detalle", "Desglose categorías"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setView(k)}
            style={{
              background: view === k ? "#1e3a5f" : "transparent",
              border: "none",
              color: view === k ? "#93c5fd" : "#475569",
              padding: "7px 16px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "inherit",
              fontWeight: view === k ? 600 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "resumen" && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
          {/* ── Left: Costes generales (AN) ── */}
          <div style={{ flex: "0 0 320px", minWidth: 280 }}>
            <div
              style={{
                background: "#0a1628",
                border: "1px solid #1e3a5f",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  background: "#0f294220",
                  borderBottom: "1px solid #1e3a5f",
                  padding: "12px 18px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    style={{
                      background: "#1d4ed8",
                      color: "#fff",
                      padding: "3px 10px",
                      borderRadius: 5,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    AN
                  </span>
                  <span style={{ fontSize: 12, color: "#94a3b8" }}>
                    Costes generales
                  </span>
                </div>
                <span style={{ fontSize: 18, fontWeight: 700, color: "#60a5fa" }}>
                  {fmt(d.totalGeneral)}
                </span>
              </div>
              <div style={{ padding: "12px 18px 16px" }}>
                {CAT_GENERALES.map((cat) => (
                  <CatRow
                    key={cat}
                    label={shortCat(cat)}
                    value={d.anData[cat] || 0}
                  />
                ))}
              </div>
            </div>

            {/* ── Summary box ── */}
            <div
              style={{
                marginTop: 16,
                background: "#0a1628",
                border: "1px solid #1e3a5f",
                borderRadius: 10,
                padding: "16px 18px",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#475569",
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  marginBottom: 12,
                }}
              >
                Totales consolidados
              </div>
              <CatRow
                label="Adquisición (inc. precio)"
                value={d.summaryByCat["Adquisición (incluye gastos e impuestos)"] || 0}
                dimIfZero={false}
              />
              <CatRow label="Costes legales" value={totalLegal} dimIfZero={false} />
              <CatRow label="Capex" value={totalCapex} dimIfZero={false} />
              <CatRow label="Costes posesión" value={totalPosesion} dimIfZero={false} />
              <CatRow
                label="Implementación"
                value={d.summaryByCat["Costes de implementación (SPV, abogados, etc.)"] || 0}
                dimIfZero={false}
              />
              <CatRow
                label="Opex"
                value={d.summaryByCat["Opex"] || 0}
                dimIfZero={false}
              />
              <CatRow
                label="Comisión gestión"
                value={d.summaryByCat["Comisión de gestión"] || 0}
                dimIfZero={false}
              />
              <div
                style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: "1px solid #1e3a5f",
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 15,
                  fontWeight: 700,
                }}
              >
                <span style={{ color: "#94a3b8" }}>TOTAL</span>
                <span style={{ color: "#f87171" }}>{fmt2(d.grandTotal)}</span>
              </div>
            </div>
          </div>

          {/* ── Right: Asset cards grid ── */}
          <div
            style={{
              flex: 1,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 14,
              minWidth: 0,
            }}
          >
            {Object.keys(ESCRITURAS).map((code) => (
              <AssetCard
                key={code}
                code={code}
                data={d.assetData[code]}
                escritura={ESCRITURAS[code]}
              />
            ))}
          </div>
        </div>
      )}

      {view === "detalle" && (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
          >
            <thead>
              <tr style={{ background: "#0d1f35" }}>
                <th
                  style={{
                    padding: "10px 14px",
                    textAlign: "left",
                    color: "#475569",
                    fontWeight: 600,
                    fontSize: 11,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    borderBottom: "1px solid #1e3a5f",
                  }}
                >
                  Categoría
                </th>
                <th
                  style={{
                    padding: "10px 14px",
                    textAlign: "right",
                    color: "#3b82f6",
                    fontWeight: 700,
                    fontSize: 11,
                    letterSpacing: 1,
                    borderBottom: "1px solid #1e3a5f",
                  }}
                >
                  AN
                </th>
                {Object.keys(ESCRITURAS).map((code) => (
                  <th
                    key={code}
                    style={{
                      padding: "10px 14px",
                      textAlign: "right",
                      color: ASSET_COLORS[code],
                      fontWeight: 700,
                      fontSize: 11,
                      letterSpacing: 1,
                      borderBottom: "1px solid #1e3a5f",
                    }}
                  >
                    {code}
                  </th>
                ))}
                <th
                  style={{
                    padding: "10px 14px",
                    textAlign: "right",
                    color: "#f87171",
                    fontWeight: 700,
                    fontSize: 11,
                    letterSpacing: 1,
                    borderBottom: "1px solid #1e3a5f",
                  }}
                >
                  TOTAL
                </th>
              </tr>
            </thead>
            <tbody>
              {[...CAT_GENERALES, ...CAT_ACTIVOS].map((cat, i) => {
                const isGeneral = CAT_GENERALES.includes(cat);
                const rowTotal = Object.keys(ESCRITURAS).reduce(
                  (sum, code) =>
                    sum + ((d.assetData[code]?.cats[cat]) || 0),
                  (d.anData[cat] || 0)
                );
                return (
                  <tr
                    key={cat}
                    style={{
                      background: i % 2 === 0 ? "#0a1628" : "#080f1a",
                    }}
                  >
                    <td
                      style={{
                        padding: "9px 14px",
                        color: "#94a3b8",
                        whiteSpace: "nowrap",
                        maxWidth: 220,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {shortCat(cat)}
                    </td>
                    <td
                      style={{
                        padding: "9px 14px",
                        textAlign: "right",
                        color:
                          isGeneral && (d.anData[cat] || 0) > 0
                            ? "#93c5fd"
                            : "#334155",
                        fontWeight:
                          isGeneral && (d.anData[cat] || 0) > 0 ? 600 : 400,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {(d.anData[cat] || 0) > 0
                        ? fmt(d.anData[cat])
                        : "–"}
                    </td>
                    {Object.keys(ESCRITURAS).map((code) => {
                      const val = d.assetData[code]?.cats[cat] || 0;
                      return (
                        <td
                          key={code}
                          style={{
                            padding: "9px 14px",
                            textAlign: "right",
                            color: val > 0 ? "#e2e8f0" : "#334155",
                            fontWeight: val > 0 ? 600 : 400,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {val > 0 ? fmt(val) : "–"}
                        </td>
                      );
                    })}
                    <td
                      style={{
                        padding: "9px 14px",
                        textAlign: "right",
                        color: rowTotal > 0 ? "#f87171" : "#334155",
                        fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {rowTotal > 0 ? fmt(rowTotal) : "–"}
                    </td>
                  </tr>
                );
              })}
              {/* Total row */}
              <tr
                style={{
                  background: "#0d1f35",
                  borderTop: "2px solid #1e3a5f",
                }}
              >
                <td
                  style={{
                    padding: "12px 14px",
                    color: "#94a3b8",
                    fontWeight: 700,
                    fontSize: 12,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                  }}
                >
                  TOTAL
                </td>
                <td
                  style={{
                    padding: "12px 14px",
                    textAlign: "right",
                    color: "#60a5fa",
                    fontWeight: 700,
                  }}
                >
                  {fmt(d.totalGeneral)}
                </td>
                {Object.keys(ESCRITURAS).map((code) => (
                  <td
                    key={code}
                    style={{
                      padding: "12px 14px",
                      textAlign: "right",
                      color: ASSET_COLORS[code],
                      fontWeight: 700,
                    }}
                  >
                    {fmt(d.assetData[code].total)}
                  </td>
                ))}
                <td
                  style={{
                    padding: "12px 14px",
                    textAlign: "right",
                    color: "#f87171",
                    fontWeight: 700,
                    fontSize: 15,
                  }}
                >
                  {fmt(d.grandTotal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
