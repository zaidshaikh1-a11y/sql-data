# 🚀 Live Collaborative SQL Query Library

A modern, production-grade web application for teams to store, search, auto-detect schemas, format, and collaborate on SQL queries in real-time.

![SQL Query Library Banner](https://img.shields.io/badge/Status-Live%20Ready-success?style=for-the-badge)
![Tech Stack](https://img.shields.io/badge/Frontend-HTML5%20%7C%20Vanilla%20CSS%20%7C%20JS-blue?style=for-the-badge)
![Realtime](https://img.shields.io/badge/Sync-BroadcastChannel%20%2B%20Supabase-purple?style=for-the-badge)

---

## ✨ Key Features

- **🌐 Live Real-Time Sync**: Synchronizes queries instantly across browser tabs (BroadcastChannel) and across remote team members via **Supabase**.
- **⚡ Automatic SQL Schema Detector**: Parses CTEs, `JOIN`s, `FROM` clauses, and table aliases to automatically extract referenced base tables and columns.
- **🎨 Modern Aesthetic Design**: Supports Light & Dark themes with smooth glassmorphism, responsive controls, and JetBrains Mono code syntax highlighting.
- **📊 Excel & JSON Export / Import**: Export your entire query library to `.xlsx` (Excel) or `.json` in 1 click, or batch import queries from existing spreadsheet files.
- **🔗 Deep Link Sharing**: Each query generates a shareable URL hash (`#query=xyz`) so teammates can open and jump directly to a specific query.
- **👥 Team Management**: Assign authors, filter by teammates or tags, and track last modified dates.

---

## 🛠️ How to Deploy & Make It Live for Everyone

### Option 1: Deploy on Vercel (1 Minute - Free)
1. Go to [vercel.com](https://vercel.com) and click **Add New Project**.
2. Upload this `sql-library-app` folder or connect your GitHub repository.
3. Click **Deploy**. Vercel will give you a live production URL (e.g. `https://your-team-sql-library.vercel.app`) accessible worldwide!

### Option 1: Deploy on Netlify (Fastest Drag & Drop - Free)
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop) and sign in.
2. Drag and drop the `sql-library-app` folder directly into the Netlify drop zone.
3. Netlify will generate your live production URL (e.g., `https://your-app-name.netlify.app`) instantly!

### Option 2: Deploy on Netlify via Netlify CLI
Run from terminal in the project directory:
```bash
npx netlify-cli deploy --prod --dir=.
```

### Option 3: Deploy on Netlify via GitHub
1. Push this project folder to a GitHub repository.
2. Log into Netlify, click **Add new site** -> **Import an existing project** -> **GitHub**.
3. Choose your repository and click **Deploy site**. Every future `git push` will auto-deploy your app.

---

## ☁️ Setting Up Real-Time Cloud Database (Supabase)

To enable live shared database synchronization so that any team member adding, editing, or deleting queries updates everyone's browser in real-time:

1. Create a free account at [supabase.com](https://supabase.com).
2. Create a new project (e.g. `sql-library`).
3. In Supabase, open the **SQL Editor** tab and execute this script:

```sql
-- Create queries table
create table queries (
  id text primary key,
  title text not null,
  sql_code text not null,
  description text,
  author text,
  tags jsonb,
  tool_notes text,
  schema jsonb,
  date_created text,
  last_modified text
);

-- Enable Row Level Security & Public access
alter table queries enable row level security;
create policy "Public Select" on queries for select using (true);
create policy "Public Insert" on queries for insert with check (true);
create policy "Public Update" on queries for update using (true);
create policy "Public Delete" on queries for delete using (true);

-- Enable Realtime broadcast
alter publication supabase_realtime add table queries;
```

4. In Supabase, navigate to **Project Settings** -> **API** and copy your **Project URL** and **anon public Key**.
5. Open your live Netlify app URL in your browser, click **Cloud Sync** in the header, paste the **URL** and **Anon Key**, and click **Save & Connect**.
6. All team members accessing the link will now share the same live database! 🎉

