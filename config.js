// ====== À REMPLIR (Supabase > Project Settings > API) ======
const SUPABASE_URL = "https://ovuwnregurfgqtbibnjz.supabase.co";
const SUPABASE_KEY = "sb_publishable_5fV4vHA3PDfNJv4TwMYnTQ_jVubGjII";
// ===========================================================
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(t, bad) { const d = document.createElement("div"); d.className = "toast" + (bad ? " bad" : ""); d.textContent = t; document.body.append(d); setTimeout(() => d.remove(), 3500); }
