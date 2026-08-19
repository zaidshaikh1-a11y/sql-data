import React, { useState, useEffect, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { Plus, Download, Search, Trash2, Pencil, X, Database, ChevronDown, ChevronRight, UserRound, Table2, Columns3, Loader2, Wand2, RefreshCw } from "lucide-react";

const SQL_KEYWORDS = ["SELECT","FROM","WHERE","JOIN","LEFT","RIGHT","INNER","OUTER","FULL","CROSS","ON","AS","AND","OR","NOT","IN","IS","NULL","LIMIT","OFFSET","INSERT","INTO","VALUES","UPDATE","SET","DELETE","CREATE","TABLE","WITH","RECURSIVE","UNION","ALL","DISTINCT","CASE","WHEN","THEN","ELSE","END","GROUP","BY","ORDER","HAVING","OVER","PARTITION","ASC","DESC","BETWEEN","LIKE","ILIKE","EXISTS","ANY","SOME","USING","NATURAL","LATERAL","WINDOW","FILTER","TRUE","FALSE","ROW","ROWS","RANGE","UNBOUNDED","PRECEDING","FOLLOWING","CURRENT","QUALIFY","INTERVAL"];
const SQL_FUNCTIONS = ["COUNT","SUM","AVG","MIN","MAX","CAST","COALESCE","NULLIF","EXTRACT","ROW_NUMBER","RANK","DENSE_RANK","LAG","LEAD","NTILE","ARRAY","STRUCT","UNNEST","DATE_TRUNC","DATEADD","DATEDIFF","NOW","CURRENT_DATE","CURRENT_TIMESTAMP","UPPER","LOWER","TRIM","SUBSTRING","CONCAT","ROUND","FLOOR","CEIL","ABS","LENGTH","REPLACE","SPLIT_PART","TO_CHAR","TO_DATE"];
const RESERVED = new Set([...SQL_KEYWORDS, ...SQL_FUNCTIONS]);

function highlightSql(code) {
  const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pattern = new RegExp(`\\b(${SQL_KEYWORDS.join("|")})\\b`, "gi");
  return escaped.replace(pattern, (m) => `<span style="color:#3B5BDB;font-weight:600">${m}</span>`);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- Lightweight SQL schema detector ----------
// Best-effort static analysis: finds base tables (FROM/JOIN) and the raw
// columns referenced against them, including inside CTE bodies. It resolves
// table aliases back to real table names and skips SELECT-list aliases
// (anything after AS) and CTE names, since those aren't real base columns.
function stripStringsAndComments(sql) {
  return sql
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

function findBalancedParen(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === "(") depth++;
    else if (str[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractCTEs(sql) {
  const ctes = [];
  const leadMatch = sql.match(/^\s*WITH\s+(RECURSIVE\s+)?/i);
  if (!leadMatch) return { ctes, mainQuery: sql };
  let idx = leadMatch[0].length;
  while (true) {
    const nameMatch = sql.slice(idx).match(/^\s*([A-Za-z_][\w]*)\s+AS\s*\(/i);
    if (!nameMatch) break;
    const parenStart = idx + nameMatch[0].length - 1;
    const parenEnd = findBalancedParen(sql, parenStart);
    if (parenEnd === -1) break;
    ctes.push({ name: nameMatch[1], body: sql.slice(parenStart + 1, parenEnd) });
    idx = parenEnd + 1;
    const commaMatch = sql.slice(idx).match(/^\s*,/);
    if (commaMatch) {
      idx += commaMatch[0].length;
      continue;
    }
    break;
  }
  return { ctes, mainQuery: sql.slice(idx) };
}

function extractTableRefs(block) {
  const refs = [];
  const re = /\b(FROM|JOIN)\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)(?:\s+(?:AS\s+)?([A-Za-z_][\w]*))?/gi;
  let m;
  let cleaned = block;
  while ((m = re.exec(block))) {
    let tbl = m[2];
    if (tbl.includes(".")) tbl = tbl.split(".").pop();
    let alias = m[3];
    if (alias && RESERVED.has(alias.toUpperCase())) alias = null;
    refs.push({ table: tbl, alias: alias || tbl });
    cleaned = cleaned.slice(0, m.index) + " ".repeat(m[0].length) + cleaned.slice(m.index + m[0].length);
  }
  return { refs, cleaned };
}

function extractOutputAliases(block) {
  const aliases = new Set();
  const re = /\bAS\s+([A-Za-z_][\w]*)/gi;
  let m;
  while ((m = re.exec(block))) aliases.add(m[1].toLowerCase());
  return aliases;
}

function extractQualifiedColumns(cleanedBlock, aliasMap) {
  const results = {};
  const re = /\b([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\b/g;
  let m;
  while ((m = re.exec(cleanedBlock))) {
    const table = aliasMap[m[1].toLowerCase()];
    if (!table) continue;
    const key = table.toLowerCase();
    if (!results[key]) results[key] = { name: table, cols: new Set() };
    results[key].cols.add(m[2]);
  }
  return results;
}

function extractUnqualifiedColumns(cleanedBlock, outputAliases, tableTokens) {
  const cols = new Set();
  const withoutQualified = cleanedBlock.replace(/\b[A-Za-z_][\w]*\.[A-Za-z_][\w]*\b/g, " ");
  const withoutFuncCalls = withoutQualified.replace(/\b[A-Za-z_][\w]*\s*\(/g, "(");
  const tokens = withoutFuncCalls.match(/\b[A-Za-z_][\w]*\b/g) || [];
  for (const t of tokens) {
    const low = t.toLowerCase();
    if (RESERVED.has(t.toUpperCase())) continue;
    if (outputAliases.has(low)) continue;
    if (tableTokens.has(low)) continue;
    cols.add(t);
  }
  return cols;
}

function parseSqlSchema(rawSql) {
  try {
    if (!rawSql || !rawSql.trim()) return [];
    const sql = stripStringsAndComments(rawSql);
    const { ctes, mainQuery } = extractCTEs(sql.trim());
    const cteNames = new Set(ctes.map((c) => c.name.toLowerCase()));
    const merged = {};

    function processBlock(block) {
      const { refs, cleaned } = extractTableRefs(block);
      const realRefs = refs.filter((r) => !cteNames.has(r.table.toLowerCase()));
      const aliasMap = {};
      const tableTokens = new Set();
      refs.forEach((r) => {
        aliasMap[r.alias.toLowerCase()] = r.table;
        aliasMap[r.table.toLowerCase()] = r.table;
        tableTokens.add(r.alias.toLowerCase());
        tableTokens.add(r.table.toLowerCase());
      });
      const outputAliases = extractOutputAliases(block);
      const qualified = extractQualifiedColumns(cleaned, aliasMap);
      Object.entries(qualified).forEach(([key, val]) => {
        if (cteNames.has(key)) return;
        if (!merged[key]) merged[key] = { name: val.name, columns: new Set() };
        val.cols.forEach((c) => merged[key].columns.add(c));
      });
      if (refs.length === 1 && realRefs.length === 1) {
        const tbl = realRefs[0].table;
        const key = tbl.toLowerCase();
        const cols = extractUnqualifiedColumns(cleaned, outputAliases, tableTokens);
        if (cols.size) {
          if (!merged[key]) merged[key] = { name: tbl, columns: new Set() };
          cols.forEach((c) => merged[key].columns.add(c));
        }
      }
    }

    ctes.forEach((c) => processBlock(c.body));
    processBlock(mainQuery);

    return Object.values(merged)
      .map((t) => ({ table: t.name, columns: Array.from(t.columns).sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => a.table.localeCompare(b.table));
  } catch (err) {
    return [];
  }
}

function mergeSchemas(base, extra) {
  const map = {};
  base.forEach((t) => (map[t.table.toLowerCase()] = { table: t.table, columns: new Set(t.columns) }));
  extra.forEach((t) => {
    const key = t.table.toLowerCase();
    if (!map[key]) map[key] = { table: t.table, columns: new Set() };
    t.columns.forEach((c) => map[key].columns.add(c));
  });
  return Object.values(map).map((t) => ({ table: t.table, columns: Array.from(t.columns).sort((a, b) => a.localeCompare(b)) }));
}

const EMPTY_FORM = { title: "", sql_code: "", schema: [], description: "", author: "", tags: "", tool_notes: "" };

export default function SqlLibrary() {
  const [entries, setEntries] = useState([]);
  const [authors, setAuthors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [authorFilter, setAuthorFilter] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [newAuthorName, setNewAuthorName] = useState("");
  const [expanded, setExpanded] = useState({});
  const [exportOpen, setExportOpen] = useState(false);
  const [manualTable, setManualTable] = useState("");
  const exportRef = useRef(null);
  const detectTimer = useRef(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError("");
      try {
        let e = [];
        try {
          const res = await window.storage.get("sql-library:entries", true);
          e = res ? JSON.parse(res.value) : [];
        } catch (_) {
          e = [];
        }
        let a = [];
        try {
          const res = await window.storage.get("sql-library:authors", true);
          a = res ? JSON.parse(res.value) : [];
        } catch (_) {
          a = [];
        }
        setEntries(Array.isArray(e) ? e : []);
        setAuthors(Array.isArray(a) ? a : []);
      } catch (err) {
        setError("Couldn't load the library. Try refreshing.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  useEffect(() => {
    function onClick(e) {
      if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function persistEntries(next) {
    setEntries(next);
    setSaving(true);
    try {
      const result = await window.storage.set("sql-library:entries", JSON.stringify(next), true);
      if (!result) setError("Save didn't go through. Try again.");
      else setError("");
    } catch (err) {
      setError("Save failed. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function persistAuthors(next) {
    setAuthors(next);
    try {
      await window.storage.set("sql-library:authors", JSON.stringify(next), true);
    } catch (err) {
      setError("Couldn't save the team list.");
    }
  }

  function openNewPanel() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setManualTable("");
    setPanelOpen(true);
  }

  function openEditPanel(entry) {
    setForm({
      title: entry.title,
      sql_code: entry.sql_code,
      schema: entry.schema || [],
      description: entry.description || "",
      author: entry.author,
      tags: (entry.tags || []).join(", "),
      tool_notes: entry.tool_notes || "",
    });
    setEditingId(entry.id);
    setManualTable("");
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function handleSqlChange(value) {
    setForm((f) => ({ ...f, sql_code: value }));
    if (detectTimer.current) clearTimeout(detectTimer.current);
    detectTimer.current = setTimeout(() => {
      const detected = parseSqlSchema(value);
      if (detected.length) {
        setForm((f) => ({ ...f, schema: mergeSchemas(f.schema, detected) }));
      }
    }, 700);
  }

  function rescanSql() {
    const detected = parseSqlSchema(form.sql_code);
    setForm((f) => ({ ...f, schema: mergeSchemas(f.schema, detected) }));
  }

  function removeTableFromSchema(tableName) {
    setForm((f) => ({ ...f, schema: f.schema.filter((t) => t.table !== tableName) }));
  }

  function removeColumnFromSchema(tableName, col) {
    setForm((f) => ({
      ...f,
      schema: f.schema.map((t) => (t.table === tableName ? { ...t, columns: t.columns.filter((c) => c !== col) } : t)),
    }));
  }

  function addManualTable() {
    const name = manualTable.trim();
    if (!name) return;
    if (form.schema.some((t) => t.table.toLowerCase() === name.toLowerCase())) {
      setManualTable("");
      return;
    }
    setForm((f) => ({ ...f, schema: [...f.schema, { table: name, columns: [] }] }));
    setManualTable("");
  }

  function addManualColumn(tableName, colInputValue, resetFn) {
    const col = colInputValue.trim();
    if (!col) return;
    setForm((f) => ({
      ...f,
      schema: f.schema.map((t) =>
        t.table === tableName && !t.columns.includes(col) ? { ...t, columns: [...t.columns, col] } : t
      ),
    }));
    resetFn("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.sql_code.trim()) {
      setError("Add a title and the SQL code before saving.");
      return;
    }
    const now = new Date().toISOString();
    const schema = form.schema;
    const tables_used = schema.map((t) => t.table);
    if (editingId) {
      const next = entries.map((en) =>
        en.id === editingId
          ? {
              ...en,
              title: form.title.trim(),
              sql_code: form.sql_code,
              schema,
              tables_used,
              description: form.description,
              author: form.author || en.author,
              tags: form.tags.split(",").map((s) => s.trim()).filter(Boolean),
              tool_notes: form.tool_notes,
              last_modified: now,
            }
          : en
      );
      await persistEntries(next);
    } else {
      const entry = {
        id: uid(),
        title: form.title.trim(),
        sql_code: form.sql_code,
        schema,
        tables_used,
        description: form.description,
        author: form.author || (authors[0] || "Unassigned"),
        tags: form.tags.split(",").map((s) => s.trim()).filter(Boolean),
        tool_notes: form.tool_notes,
        date_created: now,
        last_modified: now,
      };
      await persistEntries([entry, ...entries]);
    }
    closePanel();
  }

  async function handleDelete(id) {
    const next = entries.filter((e) => e.id !== id);
    await persistEntries(next);
  }

  async function addAuthor() {
    const name = newAuthorName.trim();
    if (!name || authors.includes(name)) return;
    await persistAuthors([...authors, name]);
    setNewAuthorName("");
  }

  async function removeAuthor(name) {
    await persistAuthors(authors.filter((a) => a !== name));
  }

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      const matchesAuthor = !authorFilter || e.author === authorFilter;
      const q = query.trim().toLowerCase();
      const schemaText = (e.schema || []).map((t) => t.table + " " + t.columns.join(" ")).join(" ").toLowerCase();
      const matchesQuery =
        !q ||
        e.title.toLowerCase().includes(q) ||
        e.sql_code.toLowerCase().includes(q) ||
        schemaText.includes(q) ||
        (e.tags || []).join(" ").toLowerCase().includes(q);
      return matchesAuthor && matchesQuery;
    });
  }, [entries, query, authorFilter]);

  function exportJson() {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sql-query-library.json";
    a.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  }

  function exportExcel() {
    const rows = entries.map((e) => ({
      Title: e.title,
      "SQL code": e.sql_code,
      "Tables & columns": (e.schema || []).map((t) => `${t.table}(${t.columns.join(", ")})`).join(" | "),
      Description: e.description || "",
      Author: e.author,
      Tags: (e.tags || []).join(", "),
      "Tool / query notes": e.tool_notes || "",
      "Date created": e.date_created ? new Date(e.date_created).toLocaleString() : "",
      "Last modified": e.last_modified ? new Date(e.last_modified).toLocaleString() : "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 24 }, { wch: 50 }, { wch: 40 }, { wch: 30 }, { wch: 14 }, { wch: 18 }, { wch: 30 }, { wch: 18 }, { wch: 18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Query library");
    XLSX.writeFile(wb, "sql-query-library.xlsx");
    setExportOpen(false);
  }

  const ink = "#12181F";
  const muted = "#62707D";
  const border = "#DFE4E9";
  const surface = "#FFFFFF";
  const bg = "#F2F5F7";
  const accent = "#2A5CDB";
  const accentDark = "#193E9C";
  const amber = "#B05F0A";
  const amberBg = "#FBEEDD";
  const accentBg = "#E7EDFC";

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 320, fontFamily: "Inter, sans-serif", color: muted, gap: 8 }}>
        <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
        <span>Loading the team's library…</span>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "Inter, sans-serif", background: bg, minHeight: 600, padding: "28px 28px 60px", color: ink, position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        .sql-input, .sql-select, .sql-textarea { width:100%; box-sizing:border-box; border:1px solid ${border}; border-radius:8px; padding:9px 11px; font-family:'Inter',sans-serif; font-size:13.5px; color:${ink}; background:#fff; outline:none; }
        .sql-input:focus, .sql-select:focus, .sql-textarea:focus { border-color:${accent}; box-shadow:0 0 0 3px ${accentBg}; }
        .sql-textarea { font-family:'IBM Plex Mono', monospace; font-size:13px; line-height:1.6; resize:vertical; }
        .sql-btn { display:inline-flex; align-items:center; gap:6px; border-radius:8px; font-size:13.5px; font-weight:500; cursor:pointer; border:1px solid ${border}; background:#fff; color:${ink}; padding:9px 14px; transition:background .12s; }
        .sql-btn:hover { background:#F7F9FA; }
        .sql-btn-primary { background:${accent}; border-color:${accent}; color:#fff; }
        .sql-btn-primary:hover { background:${accentDark}; }
        .chip { display:inline-flex; align-items:center; font-size:12px; padding:3px 9px; border-radius:100px; font-weight:500; }
      `}</style>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22, flexWrap: "wrap", gap: 14 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <Database size={20} color={accent} />
            <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 21, fontWeight: 600, margin: 0 }}>Query library</h1>
          </div>
          <p style={{ color: muted, fontSize: 13.5, margin: "4px 0 0 29px" }}>
            {entries.length} {entries.length === 1 ? "query" : "queries"} · shared with your team · {saving ? "saving…" : "synced"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, position: "relative" }}>
          <div ref={exportRef} style={{ position: "relative" }}>
            <button className="sql-btn" onClick={() => setExportOpen((v) => !v)}>
              <Download size={15} /> Export <ChevronDown size={14} />
            </button>
            {exportOpen && (
              <div style={{ position: "absolute", right: 0, top: 42, background: "#fff", border: `1px solid ${border}`, borderRadius: 10, boxShadow: "0 8px 20px rgba(20,30,40,0.12)", zIndex: 20, overflow: "hidden", minWidth: 160 }}>
                <div onClick={exportJson} style={{ padding: "10px 14px", fontSize: 13.5, cursor: "pointer" }} onMouseEnter={(e) => (e.currentTarget.style.background = "#F7F9FA")} onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}>
                  Export as JSON
                </div>
                <div onClick={exportExcel} style={{ padding: "10px 14px", fontSize: 13.5, cursor: "pointer", borderTop: `1px solid ${border}` }} onMouseEnter={(e) => (e.currentTarget.style.background = "#F7F9FA")} onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}>
                  Export as Excel
                </div>
              </div>
            )}
          </div>
          <button className="sql-btn sql-btn-primary" onClick={openNewPanel}>
            <Plus size={15} /> Add query
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: "#FCEBEB", color: "#791F1F", border: "1px solid #F0C2C2", padding: "9px 13px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 12, padding: "14px 16px", marginBottom: 18, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: muted, fontWeight: 500, display: "flex", alignItems: "center", gap: 5 }}>
          <UserRound size={14} /> Team
        </span>
        {authors.map((a) => (
          <span key={a} className="chip" style={{ background: amberBg, color: amber, gap: 6 }}>
            {a}
            <X size={11} style={{ cursor: "pointer" }} onClick={() => removeAuthor(a)} />
          </span>
        ))}
        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          <input
            className="sql-input"
            style={{ width: 150, padding: "6px 10px" }}
            placeholder="Add teammate name"
            value={newAuthorName}
            onChange={(e) => setNewAuthorName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addAuthor()}
          />
          <button className="sql-btn" style={{ padding: "6px 12px" }} onClick={addAuthor}>Add</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 260px" }}>
          <Search size={15} color={muted} style={{ position: "absolute", left: 11, top: 11 }} />
          <input
            className="sql-input"
            style={{ paddingLeft: 32 }}
            placeholder="Search title, SQL, tables, columns, tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select className="sql-select" style={{ width: 170 }} value={authorFilter} onChange={(e) => setAuthorFilter(e.target.value)}>
          <option value="">All authors</option>
          {authors.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: muted, border: `1px dashed ${border}`, borderRadius: 12, background: surface }}>
          <Database size={26} color={muted} style={{ marginBottom: 8 }} />
          <p style={{ margin: 0, fontSize: 14 }}>{entries.length === 0 ? "No queries saved yet. Add the first one." : "No queries match your search."}</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filtered.map((e) => {
            const isOpen = !!expanded[e.id];
            const schema = e.schema || [];
            return (
              <div key={e.id} style={{ background: surface, border: `1px solid ${border}`, borderRadius: 12, overflow: "hidden" }}>
                <div style={{ padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, cursor: "pointer" }} onClick={() => setExpanded((s) => ({ ...s, [e.id]: !isOpen }))}>
                  <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
                    {isOpen ? <ChevronDown size={16} color={muted} style={{ marginTop: 3, flexShrink: 0 }} /> : <ChevronRight size={16} color={muted} style={{ marginTop: 3, flexShrink: 0 }} />}
                    <div style={{ minWidth: 0 }}>
                      <p style={{ margin: 0, fontWeight: 600, fontSize: 14.5, fontFamily: "'Space Grotesk', sans-serif" }}>{e.title}</p>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                        {schema.map((t) => (
                          <span key={t.table} className="chip" style={{ background: accentBg, color: accentDark }}>
                            <Table2 size={11} style={{ marginRight: 4 }} />{t.table}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    <span className="chip" style={{ background: amberBg, color: amber }}>{e.author}</span>
                    <button className="sql-btn" style={{ padding: "6px 9px" }} onClick={(ev) => { ev.stopPropagation(); openEditPanel(e); }} aria-label="Edit">
                      <Pencil size={13} />
                    </button>
                    <button className="sql-btn" style={{ padding: "6px 9px", color: "#A32D2D" }} onClick={(ev) => { ev.stopPropagation(); handleDelete(e.id); }} aria-label="Delete">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <div style={{ borderTop: `1px solid ${border}`, padding: "14px 16px", background: "#FAFBFC", display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ background: "#fff", border: `1px solid ${border}`, borderRadius: 10, padding: "10px 12px" }}>
                      <span style={{ fontSize: 11.5, color: muted, fontWeight: 500 }}>SQL code</span>
                      <pre
                        style={{ background: "#0F1720", color: "#E7ECF2", padding: "12px 14px", borderRadius: 8, overflowX: "auto", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, lineHeight: 1.6, margin: "8px 0 0" }}
                        dangerouslySetInnerHTML={{ __html: highlightSql(e.sql_code) }}
                      />
                    </div>

                    <div style={{ background: "#fff", border: `1px solid ${border}`, borderRadius: 10, padding: "10px 12px" }}>
                      <span style={{ fontSize: 11.5, color: muted, fontWeight: 500 }}>Tables & their columns</span>
                      {schema.length === 0 ? (
                        <p style={{ fontSize: 12.5, color: muted, margin: "8px 0 0" }}>No base tables detected.</p>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
                          {schema.map((t) => (
                            <div key={t.table} style={{ border: `1px solid ${border}`, borderRadius: 8, padding: "8px 10px" }}>
                              <span className="chip" style={{ background: accentBg, color: accentDark }}>
                                <Table2 size={11} style={{ marginRight: 4 }} />{t.table}
                              </span>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                                {t.columns.length ? t.columns.map((c) => (
                                  <span key={c} className="chip" style={{ background: "#EAF3DE", color: "#3B6D11" }}>{c}</span>
                                )) : <span style={{ fontSize: 12, color: muted }}>No columns detected</span>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style={{ background: "#fff", border: `1px solid ${border}`, borderRadius: 10, padding: "10px 12px" }}>
                      <span style={{ fontSize: 11.5, color: muted, fontWeight: 500 }}>Description</span>
                      <p style={{ fontSize: 13, margin: "8px 0 0" }}>{e.description ? e.description : <span style={{ color: muted }}>—</span>}</p>
                    </div>

                    {e.tool_notes && (
                      <div style={{ background: "#fff", border: `1px solid ${border}`, borderRadius: 10, padding: "10px 12px" }}>
                        <span style={{ fontSize: 11.5, color: muted, fontWeight: 500 }}>Tool / query notes</span>
                        <p style={{ fontSize: 13, margin: "8px 0 0", whiteSpace: "pre-wrap" }}>{e.tool_notes}</p>
                      </div>
                    )}

                    {e.tags && e.tags.length > 0 && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {e.tags.map((t) => (
                          <span key={t} className="chip" style={{ background: "#F1EFE8", color: "#444441" }}>{t}</span>
                        ))}
                      </div>
                    )}

                    <p style={{ fontSize: 11.5, color: muted, margin: 0 }}>
                      Created {e.date_created ? new Date(e.date_created).toLocaleDateString() : "—"}
                      {e.last_modified && e.last_modified !== e.date_created ? ` · updated ${new Date(e.last_modified).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {panelOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,20,26,0.35)", display: "flex", justifyContent: "flex-end", zIndex: 30 }} onClick={closePanel}>
          <div style={{ width: 440, maxWidth: "92%", background: "#fff", height: "100%", overflowY: "auto", padding: "22px 22px 40px", boxShadow: "-8px 0 24px rgba(0,0,0,0.12)" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 17, fontWeight: 600, margin: 0 }}>{editingId ? "Edit query" : "Add query"}</h2>
              <X size={18} style={{ cursor: "pointer" }} onClick={closePanel} />
            </div>
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12.5, fontWeight: 500, color: muted }}>Author</label>
                <select className="sql-select" style={{ marginTop: 5 }} value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })}>
                  <option value="">Select teammate</option>
                  {authors.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
                {authors.length === 0 && <p style={{ fontSize: 11.5, color: "#A32D2D", margin: "5px 0 0" }}>Add your team's names above first so you can pick one here.</p>}
              </div>

              <div style={{ background: "#F7F9FA", border: `1px solid ${border}`, borderRadius: 10, padding: 12 }}>
                <label style={{ fontSize: 12.5, fontWeight: 500, color: muted }}>Title</label>
                <input className="sql-input" style={{ marginTop: 5 }} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Monthly active users" />
              </div>

              <div style={{ background: "#F7F9FA", border: `1px solid ${border}`, borderRadius: 10, padding: 12 }}>
                <label style={{ fontSize: 12.5, fontWeight: 500, color: muted, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>SQL code</span>
                  <span style={{ fontSize: 11, color: accent, display: "flex", alignItems: "center", gap: 4 }}><Wand2 size={12} /> auto-detects tables & columns</span>
                </label>
                <textarea className="sql-textarea" style={{ marginTop: 5 }} rows={8} value={form.sql_code} onChange={(e) => handleSqlChange(e.target.value)} placeholder={"WITH recent AS (\n  SELECT o.id, o.user_id, o.total\n  FROM orders o\n  WHERE o.created_at > NOW() - interval '30 days'\n)\nSELECT r.user_id, u.email, r.total\nFROM recent r\nJOIN users u ON r.user_id = u.id"} />
              </div>

              <div style={{ background: "#F7F9FA", border: `1px solid ${border}`, borderRadius: 10, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label style={{ fontSize: 12.5, fontWeight: 500, color: muted }}>Tables & columns detected</label>
                  <button type="button" className="sql-btn" style={{ padding: "5px 9px", fontSize: 12 }} onClick={rescanSql}>
                    <RefreshCw size={12} /> Re-scan
                  </button>
                </div>
                <p style={{ fontSize: 11.5, color: muted, margin: "4px 0 10px" }}>
                  Best-effort detection from the SQL above — only real base-table columns, not aliases or CTE output names. Review and adjust if needed.
                </p>
                {form.schema.length === 0 ? (
                  <p style={{ fontSize: 12.5, color: muted, margin: 0 }}>Nothing detected yet — paste SQL above, or add a table manually below.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {form.schema.map((t) => (
                      <SchemaTableBlock
                        key={t.table}
                        tableInfo={t}
                        border={border}
                        onRemoveTable={() => removeTableFromSchema(t.table)}
                        onRemoveColumn={(c) => removeColumnFromSchema(t.table, c)}
                        onAddColumn={(val, reset) => addManualColumn(t.table, val, reset)}
                      />
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                  <input
                    className="sql-input"
                    style={{ padding: "6px 10px" }}
                    placeholder="Add a table manually"
                    value={manualTable}
                    onChange={(e) => setManualTable(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addManualTable())}
                  />
                  <button type="button" className="sql-btn" style={{ padding: "6px 12px" }} onClick={addManualTable}>Add</button>
                </div>
              </div>

              <div style={{ background: "#F7F9FA", border: `1px solid ${border}`, borderRadius: 10, padding: 12 }}>
                <label style={{ fontSize: 12.5, fontWeight: 500, color: muted }}>Description</label>
                <textarea className="sql-textarea" style={{ marginTop: 5, fontFamily: "Inter, sans-serif" }} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What this query does and when to use it" />
              </div>

              <div>
                <label style={{ fontSize: 12.5, fontWeight: 500, color: muted }}>Tags (comma separated, optional)</label>
                <input className="sql-input" style={{ marginTop: 5 }} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="reporting, weekly" />
              </div>

              <div>
                <label style={{ fontSize: 12.5, fontWeight: 500, color: muted }}>Tool / query notes (optional)</label>
                <textarea className="sql-textarea" style={{ marginTop: 5, fontFamily: "Inter, sans-serif" }} rows={3} value={form.tool_notes} onChange={(e) => setForm({ ...form, tool_notes: e.target.value })} placeholder="Which tool this runs in (dbt, BigQuery console, Metabase...), scheduling, gotchas, etc." />
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                <button type="submit" className="sql-btn sql-btn-primary" style={{ flex: 1, justifyContent: "center" }}>{editingId ? "Save changes" : "Add to library"}</button>
                <button type="button" className="sql-btn" onClick={closePanel}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function SchemaTableBlock({ tableInfo, border, onRemoveTable, onRemoveColumn, onAddColumn }) {
  const [newCol, setNewCol] = useState("");
  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 8, padding: "8px 10px", background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="chip" style={{ background: "#E7EDFC", color: "#193E9C", gap: 6 }}>
          <Table2 size={11} />{tableInfo.table}
          <X size={11} style={{ cursor: "pointer" }} onClick={onRemoveTable} />
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        {tableInfo.columns.map((c) => (
          <span key={c} className="chip" style={{ background: "#EAF3DE", color: "#3B6D11", gap: 5 }}>
            {c}
            <X size={10} style={{ cursor: "pointer" }} onClick={() => onRemoveColumn(c)} />
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <input
          className="sql-input"
          style={{ padding: "5px 9px", fontSize: 12.5 }}
          placeholder="Add column"
          value={newCol}
          onChange={(e) => setNewCol(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onAddColumn(newCol, setNewCol))}
        />
        <button type="button" className="sql-btn" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => onAddColumn(newCol, setNewCol)}>Add</button>
      </div>
    </div>
  );
}
