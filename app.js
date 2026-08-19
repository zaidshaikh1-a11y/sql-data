/**
 * Live Collaborative SQL Query Library
 * Real-time synchronization, Schema detection, Excel/JSON export & import, Deep-linking
 */

// SQL Keywords & Functions for static analysis & syntax highlighting
const SQL_KEYWORDS = ["SELECT","FROM","WHERE","JOIN","LEFT","RIGHT","INNER","OUTER","FULL","CROSS","ON","AS","AND","OR","NOT","IN","IS","NULL","LIMIT","OFFSET","INSERT","INTO","VALUES","UPDATE","SET","DELETE","CREATE","TABLE","WITH","RECURSIVE","UNION","ALL","DISTINCT","CASE","WHEN","THEN","ELSE","END","GROUP","BY","ORDER","HAVING","OVER","PARTITION","ASC","DESC","BETWEEN","LIKE","ILIKE","EXISTS","ANY","SOME","USING","NATURAL","LATERAL","WINDOW","FILTER","TRUE","FALSE","ROW","ROWS","RANGE","UNBOUNDED","PRECEDING","FOLLOWING","CURRENT","QUALIFY","INTERVAL"];
const SQL_FUNCTIONS = ["COUNT","SUM","AVG","MIN","MAX","CAST","COALESCE","NULLIF","EXTRACT","ROW_NUMBER","RANK","DENSE_RANK","LAG","LEAD","NTILE","ARRAY","STRUCT","UNNEST","DATE_TRUNC","DATEADD","DATEDIFF","NOW","CURRENT_DATE","CURRENT_TIMESTAMP","UPPER","LOWER","TRIM","SUBSTRING","CONCAT","ROUND","FLOOR","CEIL","ABS","LENGTH","REPLACE","SPLIT_PART","TO_CHAR","TO_DATE"];
const RESERVED = new Set([...SQL_KEYWORDS, ...SQL_FUNCTIONS]);

// Utility: Unique ID Generator
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Default Seed Queries if Library is empty
const INITIAL_DEMO_QUERIES = [
  {
    id: "q_demo_1",
    title: "Monthly Active Users & Retention Cohort",
    sql_code: `WITH monthly_activity AS (
  SELECT 
    user_id, 
    DATE_TRUNC('month', created_at) AS activity_month
  FROM user_events
  WHERE event_name = 'page_view'
),
cohorts AS (
  SELECT 
    user_id,
    MIN(activity_month) AS first_month
  FROM monthly_activity
  GROUP BY user_id
)
SELECT 
  c.first_month,
  m.activity_month,
  COUNT(DISTINCT m.user_id) AS active_users,
  u.country
FROM cohorts c
JOIN monthly_activity m ON c.user_id = m.user_id
JOIN users u ON c.user_id = u.id
GROUP BY 1, 2, 4
ORDER BY 1 DESC, 2 DESC;`,
    description: "Calculates monthly active users grouped by country and first signup cohort month.",
    author: "Alex Morgan",
    tags: ["analytics", "cohorts", "retention"],
    tool_notes: "Runs on Snowflake & PostgreSQL console. Standard execution time ~2.4s.",
    date_created: new Date().toISOString(),
    last_modified: new Date().toISOString(),
    schema: [
      { table: "user_events", columns: ["created_at", "event_name", "user_id"] },
      { table: "users", columns: ["country", "id"] }
    ]
  },
  {
    id: "q_demo_2",
    title: "High Value Customer Churn Risk Analysis",
    sql_code: `SELECT 
  c.customer_id,
  c.email,
  c.company_name,
  SUM(o.total_amount) AS lifetime_value,
  MAX(o.order_date) AS last_order_date,
  DATEDIFF('day', MAX(o.order_date), CURRENT_DATE) AS days_since_last_order
FROM customers c
INNER JOIN orders o ON c.customer_id = o.customer_id
WHERE c.status = 'active'
GROUP BY c.customer_id, c.email, c.company_name
HAVING DATEDIFF('day', MAX(o.order_date), CURRENT_DATE) > 60
ORDER BY lifetime_value DESC;`,
    description: "Identifies active high-value accounts that haven't placed an order in over 60 days.",
    author: "Sarah Jenkins",
    tags: ["sales", "churn", "vip-customers"],
    tool_notes: "Used in weekly revenue sync with Metabase dashboard.",
    date_created: new Date(Date.now() - 86400000 * 2).toISOString(),
    last_modified: new Date(Date.now() - 86400000 * 2).toISOString(),
    schema: [
      { table: "customers", columns: ["company_name", "customer_id", "email", "status"] },
      { table: "orders", columns: ["customer_id", "order_date", "total_amount"] }
    ]
  }
];

const INITIAL_AUTHORS = ["Alex Morgan", "Sarah Jenkins", "David Chen", "Emily Taylor"];

// ---------- SQL Schema Detector ----------
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

function parseSqlSchema(rawSql) {
  try {
    if (!rawSql || !rawSql.trim()) return [];
    const sql = stripStringsAndComments(rawSql);
    const { ctes, mainQuery } = extractCTEs(sql.trim());
    const cteNames = new Set(ctes.map(c => c.name.toLowerCase()));
    const merged = {};

    function processBlock(block) {
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

      const aliasMap = {};
      refs.forEach(r => {
        aliasMap[r.alias.toLowerCase()] = r.table;
        aliasMap[r.table.toLowerCase()] = r.table;
      });

      const colRe = /\b([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\b/g;
      while ((m = colRe.exec(cleaned))) {
        const table = aliasMap[m[1].toLowerCase()];
        if (!table || cteNames.has(table.toLowerCase())) continue;
        const key = table.toLowerCase();
        if (!merged[key]) merged[key] = { name: table, cols: new Set() };
        merged[key].cols.add(m[2]);
      }

      const realRefs = refs.filter(r => !cteNames.has(r.table.toLowerCase()));
      if (refs.length === 1 && realRefs.length === 1) {
        const tbl = realRefs[0].table;
        const key = tbl.toLowerCase();
        const tokens = cleaned.match(/\b[A-Za-z_][\w]*\b/g) || [];
        tokens.forEach(t => {
          if (!RESERVED.has(t.toUpperCase()) && t.toLowerCase() !== key) {
            if (!merged[key]) merged[key] = { name: tbl, cols: new Set() };
            merged[key].cols.add(t);
          }
        });
      }
    }

    ctes.forEach(c => processBlock(c.body));
    processBlock(mainQuery);

    return Object.values(merged).map(t => ({
      table: t.name,
      columns: Array.from(t.cols).sort((a, b) => a.localeCompare(b))
    })).sort((a, b) => a.table.localeCompare(b.table));
  } catch (err) {
    return [];
  }
}

// ---------- Syntax Highlighting & Formatter ----------
function highlightSql(code) {
  const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pattern = new RegExp(`\\b(${SQL_KEYWORDS.join("|")})\\b`, "gi");
  return escaped.replace(pattern, (m) => `<span style="color:var(--code-keyword);font-weight:600">${m}</span>`);
}

function formatSql(code) {
  return code
    .replace(/\bSELECT\b/gi, "\nSELECT")
    .replace(/\bFROM\b/gi, "\nFROM")
    .replace(/\bWHERE\b/gi, "\nWHERE")
    .replace(/\bJOIN\b/gi, "\nJOIN")
    .replace(/\bLEFT JOIN\b/gi, "\nLEFT JOIN")
    .replace(/\bGROUP BY\b/gi, "\nGROUP BY")
    .replace(/\bORDER BY\b/gi, "\nORDER BY")
    .replace(/\bHAVING\b/gi, "\nHAVING")
    .trim();
}

// ---------- Application State & Sync Engine ----------
class SqlAppManager {
  constructor() {
    this.entries = [];
    this.authors = [];
    this.editingId = null;
    this.supabase = null;
    this.broadcastChannel = null;
    
    // UI References
    this.queryContainer = document.getElementById("queryListContainer");
    this.emptyState = document.getElementById("emptyState");
    this.queryCountText = document.getElementById("queryCountText");
    this.searchInput = document.getElementById("searchInput");
    this.authorFilterSelect = document.getElementById("authorFilterSelect");
    this.tagFilterSelect = document.getElementById("tagFilterSelect");
    this.teamChipsContainer = document.getElementById("teamChipsContainer");
    
    // Panel & Modals
    this.queryPanel = document.getElementById("queryPanel");
    this.queryForm = document.getElementById("queryForm");
    this.cloudModal = document.getElementById("cloudModal");
    this.exportModal = document.getElementById("exportModal");

    this.initBroadcastChannel();
    this.loadState();
    this.bindEvents();
  }

  initBroadcastChannel() {
    if ('BroadcastChannel' in window) {
      this.broadcastChannel = new BroadcastChannel("sql_library_sync_channel");
      this.broadcastChannel.onmessage = (event) => {
        if (event.data && event.data.type === "DATA_UPDATED") {
          this.loadState(false); // Reload without broadcasting back
          this.showToast("Library updated live from another tab");
        }
      };
    }
  }

  broadcastUpdate() {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({ type: "DATA_UPDATED", timestamp: Date.now() });
    }
  }

  loadState(shouldBroadcast = true) {
    try {
      const storedEntries = localStorage.getItem("sql_library_entries");
      const storedAuthors = localStorage.getItem("sql_library_authors");
      const cloudSettings = localStorage.getItem("sql_library_cloud");

      this.entries = storedEntries ? JSON.parse(storedEntries) : INITIAL_DEMO_QUERIES;
      this.authors = storedAuthors ? JSON.parse(storedAuthors) : INITIAL_AUTHORS;

      if (!storedEntries) {
        localStorage.setItem("sql_library_entries", JSON.stringify(this.entries));
      }
      if (!storedAuthors) {
        localStorage.setItem("sql_library_authors", JSON.stringify(this.authors));
      }

      if (cloudSettings) {
        const config = JSON.parse(cloudSettings);
        this.initSupabase(config.url, config.key);
      }

      this.render();
      if (shouldBroadcast) this.broadcastUpdate();
      this.checkDeepLink();
    } catch (err) {
      console.error("Failed to load library state:", err);
      this.showToast("Error loading library state", true);
    }
  }

  saveEntries(newEntries, syncRemote = true) {
    this.entries = newEntries;
    localStorage.setItem("sql_library_entries", JSON.stringify(newEntries));
    this.render();
    this.broadcastUpdate();
    if (syncRemote && this.supabase) {
      this.syncAllToSupabase(newEntries);
    }
  }

  saveAuthors(newAuthors) {
    this.authors = newAuthors;
    localStorage.setItem("sql_library_authors", JSON.stringify(newAuthors));
    this.renderTeamBar();
    this.renderFormAuthors();
    this.broadcastUpdate();
  }

  async initSupabase(url, key) {
    if (!url || !key || !window.supabase) return;
    try {
      this.supabase = window.supabase.createClient(url, key);
      const label = document.getElementById("syncStatusLabel");
      if (label) label.innerText = "Cloud Synced (Supabase)";
      const urlInput = document.getElementById("supabaseUrlInput");
      const keyInput = document.getElementById("supabaseKeyInput");
      if (urlInput) urlInput.value = url;
      if (keyInput) keyInput.value = key;

      // Initial Fetch from remote DB
      await this.fetchFromSupabase();

      // Subscribe to Realtime Postgres Changes
      this.supabase
        .channel('public:queries')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'queries' }, () => {
          this.fetchFromSupabase();
        })
        .subscribe();
    } catch (err) {
      console.error("Supabase connect error:", err);
    }
  }

  async fetchFromSupabase() {
    if (!this.supabase) return;
    try {
      const { data, error } = await this.supabase.from('queries').select('*').order('last_modified', { ascending: false });
      if (!error && Array.isArray(data) && data.length > 0) {
        this.entries = data;
        localStorage.setItem("sql_library_entries", JSON.stringify(data));
        this.render();
      }
    } catch (err) {
      console.error("Error fetching from Supabase:", err);
    }
  }

  async syncAllToSupabase(entries) {
    if (!this.supabase) return;
    try {
      await this.supabase.from('queries').upsert(entries);
    } catch (err) {
      console.error("Error upserting to Supabase:", err);
    }
  }

  async deleteFromSupabase(id) {
    if (!this.supabase) return;
    try {
      await this.supabase.from('queries').delete().eq('id', id);
    } catch (err) {
      console.error("Error deleting from Supabase:", err);
    }
  }

  bindEvents() {
    // Search & Filters
    this.searchInput.addEventListener("input", () => this.renderQueries());
    this.authorFilterSelect.addEventListener("change", () => this.renderQueries());
    this.tagFilterSelect.addEventListener("change", () => this.renderQueries());
    document.getElementById("clearFiltersBtn").addEventListener("click", () => {
      this.searchInput.value = "";
      this.authorFilterSelect.value = "";
      this.tagFilterSelect.value = "";
      this.renderQueries();
    });

    // Theme Toggle
    document.getElementById("themeToggleBtn").addEventListener("click", () => {
      const html = document.documentElement;
      const current = html.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      html.setAttribute("data-theme", next);
      localStorage.setItem("sql_library_theme", next);
    });

    if (localStorage.getItem("sql_library_theme") === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    }

    // Add Teammate
    document.getElementById("addTeammateBtn").addEventListener("click", () => {
      const input = document.getElementById("newTeammateInput");
      const name = input.value.trim();
      if (name && !this.authors.includes(name)) {
        this.saveAuthors([...this.authors, name]);
        input.value = "";
        this.showToast(`Teammate "${name}" added`);
      }
    });

    // Add Query Panel
    document.getElementById("addQueryBtn").addEventListener("click", () => this.openQueryPanel());
    document.getElementById("closePanelBtn").addEventListener("click", () => this.closeQueryPanel());
    document.getElementById("cancelFormBtn").addEventListener("click", () => this.closeQueryPanel());
    this.queryForm.addEventListener("submit", (e) => this.handleFormSubmit(e));

    // Form SQL auto format & schema detection
    document.getElementById("formatSqlBtn").addEventListener("click", () => {
      const textarea = document.getElementById("formSql");
      textarea.value = formatSql(textarea.value);
      this.updateSchemaDetectorList();
    });

    document.getElementById("formSql").addEventListener("input", () => {
      this.updateSchemaDetectorList();
    });
    document.getElementById("rescanSchemaBtn").addEventListener("click", () => {
      this.updateSchemaDetectorList();
    });

    // Cloud Modal
    document.getElementById("cloudConfigBtn").addEventListener("click", () => {
      this.cloudModal.classList.remove("hidden");
    });
    document.getElementById("closeCloudModalBtn").addEventListener("click", () => {
      this.cloudModal.classList.add("hidden");
    });
    document.getElementById("saveCloudSettingsBtn").addEventListener("click", () => {
      const url = document.getElementById("supabaseUrlInput").value.trim();
      const key = document.getElementById("supabaseKeyInput").value.trim();
      if (url && key) {
        localStorage.setItem("sql_library_cloud", JSON.stringify({ url, key }));
        this.initSupabase(url, key);
        this.showToast("Cloud connection saved!");
      }
      this.cloudModal.classList.add("hidden");
    });
    document.getElementById("clearCloudSettingsBtn").addEventListener("click", () => {
      localStorage.removeItem("sql_library_cloud");
      this.supabase = null;
      document.getElementById("syncStatusLabel").innerText = "Live Synced (Local)";
      this.showToast("Cloud connection cleared");
      this.cloudModal.classList.add("hidden");
    });

    // Export & Import Modal
    document.getElementById("exportBtn").addEventListener("click", () => {
      this.exportModal.classList.remove("hidden");
    });
    document.getElementById("closeExportModalBtn").addEventListener("click", () => {
      this.exportModal.classList.add("hidden");
    });
    document.getElementById("exportJsonBtn").addEventListener("click", () => this.exportJson());
    document.getElementById("exportExcelBtn").addEventListener("click", () => this.exportExcel());
    document.getElementById("importFileInput").addEventListener("change", (e) => this.importFile(e));
  }

  render() {
    this.renderTeamBar();
    this.renderFormAuthors();
    this.renderTagSelect();
    this.renderQueries();
  }

  renderTeamBar() {
    this.teamChipsContainer.innerHTML = this.authors.map(a => `
      <span class="chip chip-amber">
        ${a}
        <button onclick="app.removeAuthor('${a}')" style="background:none;border:none;cursor:pointer;color:inherit;padding:0 2px;">×</button>
      </span>
    `).join("");

    this.authorFilterSelect.innerHTML = `<option value="">All authors</option>` + 
      this.authors.map(a => `<option value="${a}">${a}</option>`).join("");
  }

  renderFormAuthors() {
    const select = document.getElementById("formAuthor");
    select.innerHTML = `<option value="">Select teammate</option>` + 
      this.authors.map(a => `<option value="${a}">${a}</option>`).join("");
  }

  renderTagSelect() {
    const tagSet = new Set();
    this.entries.forEach(e => (e.tags || []).forEach(t => tagSet.add(t)));
    this.tagFilterSelect.innerHTML = `<option value="">All tags</option>` + 
      Array.from(tagSet).sort().map(t => `<option value="${t}">${t}</option>`).join("");
  }

  removeAuthor(name) {
    this.saveAuthors(this.authors.filter(a => a !== name));
    this.showToast(`Removed "${name}"`);
  }

  renderQueries() {
    const search = this.searchInput.value.trim().toLowerCase();
    const selectedAuthor = this.authorFilterSelect.value;
    const selectedTag = this.tagFilterSelect.value;

    const filtered = this.entries.filter(e => {
      const matchAuthor = !selectedAuthor || e.author === selectedAuthor;
      const matchTag = !selectedTag || (e.tags || []).includes(selectedTag);
      
      const schemaText = (e.schema || []).map(t => t.table + " " + (t.columns || []).join(" ")).join(" ").toLowerCase();
      const matchSearch = !search ||
        e.title.toLowerCase().includes(search) ||
        e.sql_code.toLowerCase().includes(search) ||
        (e.description || "").toLowerCase().includes(search) ||
        schemaText.includes(search) ||
        (e.tags || []).join(" ").toLowerCase().includes(search);

      return matchAuthor && matchTag && matchSearch;
    });

    this.queryCountText.innerText = `${filtered.length} ${filtered.length === 1 ? 'query' : 'queries'}`;

    if (filtered.length === 0) {
      this.queryContainer.innerHTML = "";
      this.emptyState.classList.remove("hidden");
      return;
    }

    this.emptyState.classList.add("hidden");
    this.queryContainer.innerHTML = filtered.map(e => this.createQueryCardHtml(e)).join("");
  }

  createQueryCardHtml(e) {
    const schema = e.schema || [];
    const dateFormatted = new Date(e.last_modified || e.date_created).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    return `
      <div class="query-card" id="card-${e.id}">
        <div class="query-card-header" onclick="app.toggleCardExpanded('${e.id}')">
          <div class="query-meta-left">
            <div style="margin-top: 2px;">
              <svg id="chevron-${e.id}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition: transform 0.2s;">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </div>
            <div>
              <h3 class="query-title">${this.escapeHtml(e.title)}</h3>
              <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
                <span class="chip chip-amber">${this.escapeHtml(e.author)}</span>
                ${schema.map(t => `<span class="chip chip-blue">📊 ${this.escapeHtml(t.table)}</span>`).join("")}
                ${(e.tags || []).map(t => `<span class="chip chip-gray">#${this.escapeHtml(t)}</span>`).join("")}
              </div>
            </div>
          </div>

          <div class="query-card-actions" onclick="event.stopPropagation();">
            <button class="btn btn-sm" onclick="app.copyQueryUrl('${e.id}')" title="Copy Shareable Link">
              🔗 Share
            </button>
            <button class="btn btn-sm" onclick="app.openQueryPanel('${e.id}')" title="Edit Query">
              ✏️ Edit
            </button>
            <button class="btn btn-sm" onclick="app.deleteQuery('${e.id}')" style="color: var(--danger-text);" title="Delete Query">
              🗑️
            </button>
          </div>
        </div>

        <div id="body-${e.id}" class="query-card-body hidden">
          <div class="code-box">
            <button class="code-copy-btn" onclick="app.copySql('${e.id}')">
              📋 Copy SQL
            </button>
            <pre><code>${highlightSql(e.sql_code)}</code></pre>
          </div>

          ${schema.length > 0 ? `
            <div style="background: var(--surface-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px;">
              <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted); text-transform: uppercase;">Tables & Columns</span>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
                ${schema.map(t => `
                  <div class="schema-block">
                    <span class="chip chip-blue">📊 ${this.escapeHtml(t.table)}</span>
                    <div class="schema-cols">
                      ${(t.columns || []).map(c => `<span class="chip chip-emerald">${this.escapeHtml(c)}</span>`).join("")}
                    </div>
                  </div>
                `).join("")}
              </div>
            </div>
          ` : ''}

          ${e.description ? `
            <div style="background: var(--surface-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px;">
              <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted); text-transform: uppercase;">Description</span>
              <p style="font-size: 13.5px; margin-top: 4px; color: var(--text-secondary);">${this.escapeHtml(e.description)}</p>
            </div>
          ` : ''}

          ${e.tool_notes ? `
            <div style="background: var(--surface-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px;">
              <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted); text-transform: uppercase;">Execution / Tool Notes</span>
              <p style="font-size: 13px; margin-top: 4px; color: var(--text-secondary); white-space: pre-wrap;">${this.escapeHtml(e.tool_notes)}</p>
            </div>
          ` : ''}

          <div style="font-size: 11.5px; color: var(--text-muted);">
            Last modified: ${dateFormatted}
          </div>
        </div>
      </div>
    `;
  }

  toggleCardExpanded(id) {
    const body = document.getElementById(`body-${id}`);
    const chevron = document.getElementById(`chevron-${id}`);
    if (body) {
      const isHidden = body.classList.contains("hidden");
      if (isHidden) {
        body.classList.remove("hidden");
        if (chevron) chevron.style.transform = "rotate(90deg)";
      } else {
        body.classList.add("hidden");
        if (chevron) chevron.style.transform = "rotate(0deg)";
      }
    }
  }

  openQueryPanel(id = null) {
    this.editingId = id;
    const titleEl = document.getElementById("panelTitle");
    if (id) {
      const entry = this.entries.find(e => e.id === id);
      if (!entry) return;
      titleEl.innerText = "Edit Query";
      document.getElementById("formAuthor").value = entry.author || "";
      document.getElementById("formTitle").value = entry.title || "";
      document.getElementById("formSql").value = entry.sql_code || "";
      document.getElementById("formDescription").value = entry.description || "";
      document.getElementById("formTags").value = (entry.tags || []).join(", ");
      document.getElementById("formNotes").value = entry.tool_notes || "";
    } else {
      titleEl.innerText = "Add Query";
      this.queryForm.reset();
    }
    this.updateSchemaDetectorList();
    this.queryPanel.classList.remove("hidden");
  }

  closeQueryPanel() {
    this.queryPanel.classList.add("hidden");
    this.editingId = null;
  }

  updateSchemaDetectorList() {
    const sql = document.getElementById("formSql").value;
    const detected = parseSqlSchema(sql);
    const container = document.getElementById("schemaDetectorList");
    if (detected.length === 0) {
      container.innerHTML = `<span style="font-size: 12px; color: var(--text-muted);">No base tables detected in SQL.</span>`;
      return;
    }
    container.innerHTML = detected.map(t => `
      <div style="background: var(--surface-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 8px 10px;">
        <span class="chip chip-blue">📊 ${this.escapeHtml(t.table)}</span>
        <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px;">
          ${t.columns.map(c => `<span class="chip chip-emerald">${this.escapeHtml(c)}</span>`).join("")}
        </div>
      </div>
    `).join("");
  }

  handleFormSubmit(e) {
    e.preventDefault();
    const author = document.getElementById("formAuthor").value;
    const title = document.getElementById("formTitle").value.trim();
    const sql_code = document.getElementById("formSql").value;
    const description = document.getElementById("formDescription").value.trim();
    const tags = document.getElementById("formTags").value.split(",").map(s => s.trim()).filter(Boolean);
    const tool_notes = document.getElementById("formNotes").value.trim();
    const schema = parseSqlSchema(sql_code);
    const now = new Date().toISOString();

    if (!title || !sql_code) {
      this.showToast("Title and SQL code are required", true);
      return;
    }

    if (this.editingId) {
      const updated = this.entries.map(item => item.id === this.editingId ? {
        ...item,
        author, title, sql_code, description, tags, tool_notes, schema, last_modified: now
      } : item);
      this.saveEntries(updated);
      this.showToast("Query updated successfully");
    } else {
      const newQuery = {
        id: uid(),
        author, title, sql_code, description, tags, tool_notes, schema,
        date_created: now, last_modified: now
      };
      this.saveEntries([newQuery, ...this.entries]);
      this.showToast("New query added to library");
    }

    this.closeQueryPanel();
  }

  deleteQuery(id) {
    if (confirm("Are you sure you want to delete this query?")) {
      const next = this.entries.filter(e => e.id !== id);
      this.saveEntries(next, false);
      if (this.supabase) {
        this.deleteFromSupabase(id);
      }
      this.showToast("Query deleted");
    }
  }

  copySql(id) {
    const entry = this.entries.find(e => e.id === id);
    if (entry && entry.sql_code) {
      navigator.clipboard.writeText(entry.sql_code);
      this.showToast("SQL code copied to clipboard!");
    }
  }

  copyQueryUrl(id) {
    const url = `${window.location.origin}${window.location.pathname}#query=${id}`;
    navigator.clipboard.writeText(url);
    this.showToast("Direct shareable link copied!");
  }

  checkDeepLink() {
    const hash = window.location.hash;
    if (hash.startsWith("#query=")) {
      const queryId = hash.replace("#query=", "");
      setTimeout(() => {
        const card = document.getElementById(`card-${queryId}`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth' });
          this.toggleCardExpanded(queryId);
          card.style.borderColor = 'var(--primary)';
        }
      }, 300);
    }
  }

  exportJson() {
    const blob = new Blob([JSON.stringify(this.entries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sql-query-library-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast("Library exported as JSON");
    this.exportModal.classList.add("hidden");
  }

  exportExcel() {
    if (!window.XLSX) {
      this.showToast("XLSX export library loading...", true);
      return;
    }
    const rows = this.entries.map(e => ({
      Title: e.title,
      "SQL Code": e.sql_code,
      "Tables & Columns": (e.schema || []).map(t => `${t.table}(${(t.columns || []).join(", ")})`).join(" | "),
      Description: e.description || "",
      Author: e.author || "",
      Tags: (e.tags || []).join(", "),
      "Execution Notes": e.tool_notes || "",
      "Last Modified": e.last_modified || ""
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Queries");
    XLSX.writeFile(wb, `sql-query-library-${new Date().toISOString().slice(0,10)}.xlsx`);
    this.showToast("Library exported as Excel");
    this.exportModal.classList.add("hidden");
  }

  importFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    if (file.name.endsWith(".json")) {
      reader.onload = (evt) => {
        try {
          const imported = JSON.parse(evt.target.result);
          if (Array.isArray(imported)) {
            this.saveEntries([...imported, ...this.entries]);
            this.showToast(`Imported ${imported.length} queries!`);
            this.exportModal.classList.add("hidden");
          }
        } catch (err) {
          this.showToast("Invalid JSON file", true);
        }
      };
      reader.readAsText(file);
    } else if (file.name.endsWith(".xlsx") || file.name.endsWith(".xls")) {
      reader.onload = (evt) => {
        try {
          const data = new Uint8Array(evt.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(firstSheet);
          
          const imported = rows.map(r => ({
            id: uid(),
            title: r.Title || r.title || "Imported Query",
            sql_code: r["SQL Code"] || r.sql_code || "",
            description: r.Description || r.description || "",
            author: r.Author || r.author || "Unassigned",
            tags: (r.Tags || "").split(",").map(s => s.trim()).filter(Boolean),
            tool_notes: r["Execution Notes"] || r.tool_notes || "",
            schema: parseSqlSchema(r["SQL Code"] || r.sql_code || ""),
            date_created: new Date().toISOString(),
            last_modified: new Date().toISOString()
          }));

          this.saveEntries([...imported, ...this.entries]);
          this.showToast(`Imported ${imported.length} queries from Excel!`);
          this.exportModal.classList.add("hidden");
        } catch (err) {
          this.showToast("Failed to parse Excel file", true);
        }
      };
      reader.readAsArrayBuffer(file);
    }
  }

  showToast(message, isError = false) {
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = "toast";
    if (isError) toast.style.borderLeft = "4px solid var(--danger)";
    else toast.style.borderLeft = "4px solid var(--accent-emerald)";
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  escapeHtml(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

// Initialize Application on DOM Ready
let app;
document.addEventListener("DOMContentLoaded", () => {
  app = new SqlAppManager();
});
