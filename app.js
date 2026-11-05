const LABEL = { pending: "En attente", accepted: "Acceptée", refused: "Refusée" };
let me = null, file = null, all = [], filter = "all", scene, cam, ren, ctl, obj;

$("#logout").onclick = async () => { await sb.auth.signOut(); location.href = "login.html"; };
async function start() {
  let { data: { session } } = await sb.auth.getSession();
  if (!session) { await new Promise(r => setTimeout(r, 700)); ({ data: { session } } = await sb.auth.getSession()); } // 2e essai : la session peut arriver en retard
  if (!session) { sessionStorage.setItem("bounce", Date.now()); sessionStorage.setItem("why", "aucune session trouvée par index.html"); return location.replace("login.html"); } // anti-boucle
  const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
  if (!data) { // plus de redirection automatique : on affiche la vraie cause au lieu de boucler
    console.error("Profil introuvable :", error);
    document.body.innerHTML = `<main style="margin-top:15vh"><section class="card"><h2>Profil introuvable</h2>
      <p class="muted" style="margin:8px 0 16px">Ton compte est connecté mais la table « profiles » ne renvoie rien pour lui.<br>
      <small>${esc(error?.message || "Aucune ligne pour cet utilisateur")}${error?.code ? " (" + esc(error.code) + ")" : ""}</small></p>
      <button class="btn" id="out">Se déconnecter</button></section></main>`;
    document.getElementById("out").onclick = async () => { await sb.auth.signOut(); location.replace("login.html"); };
    return;
  }
  me = data; $("#pseudo").textContent = me.pseudo; $("#badge").hidden = me.role !== "admin";
  $("#listTitle").textContent = me.role === "admin" ? "Toutes les demandes" : "Mes demandes";
  $("#csv").hidden = $("#fsup").hidden = me.role !== "admin"; loadSettings();
  if (me.role === "admin") { $(".stats").hidden = true; document.body.classList.add("is-admin"); } // le tableau de bord remplace les stats
  initViewer(); refresh(); setInterval(refresh, 20000); loadApp(); loadFils();
}
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  filter = t.dataset.f; document.querySelectorAll(".tab").forEach(x => x.classList.toggle("on", x === t)); render();
});

// ---------- Viewer 3D ----------
function initViewer() {
  if (ren) return;
  const c = $("#viewer");
  scene = new THREE.Scene(); cam = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  ren = new THREE.WebGLRenderer({ antialias: true, alpha: true }); c.prepend(ren.domElement);
  ctl = new THREE.OrbitControls(cam, ren.domElement); ctl.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1));
  const d = new THREE.DirectionalLight(0xffffff, 0.8); d.position.set(1, 2, 3); scene.add(d);
  scene.add(new THREE.GridHelper(220, 22, 0x00ae42, 0xbbbbbb)); // plateau Ender 3 : 220 x 220 mm
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(220, 250, 220)), new THREE.LineBasicMaterial({ color: 0x00ae42, transparent: true, opacity: 0.35 }));
  box.position.y = 125; scene.add(box); // volume d'impression 250 mm de haut
  const fit = () => { ren.setSize(c.clientWidth, c.clientHeight); cam.aspect = c.clientWidth / c.clientHeight; cam.updateProjectionMatrix(); };
  addEventListener("resize", fit); fit(); cam.position.set(300, 260, 380);
  (function loop() { requestAnimationFrame(loop); ctl.update(); ren.render(scene, cam); })();
}
const REASONS = ["Pièce trop grande pour le plateau", "Fichier non imprimable (maillage ouvert)", "Supports impossibles à retirer", "Pas de matériau disponible"];
const sel = new Set(); let reviewing = null;
let quote = { price: 0, seconds: 0, grams: 0, qty: 1 }, verdict = { lvl: "ok", text: "OK" };
let meshes = [], supports = null, ana = null, home = null, wire = false;
function showModel(buf, name) {
  if (obj) scene.remove(obj);
  if (supports) { scene.remove(supports); supports = null; }
  if (/\.stl$/i.test(name)) {
    obj = new THREE.Mesh(new THREE.STLLoader().parse(buf)); obj.rotation.x = -Math.PI / 2;
  } else if (/\.3mf$/i.test(name)) {
    obj = new THREE.ThreeMFLoader().parse(buf); obj.rotation.x = -Math.PI / 2; // 3MF : axe Z vers le haut, comme STL
  } else obj = new THREE.OBJLoader().parse(new TextDecoder().decode(buf));
  scene.add(obj); $("#scale").value = 100; refit(true);
}
// Place la pièce sur le plateau puis relance l'analyse (appelé au chargement, après un changement d'échelle ou d'orientation)
function refit(first) {
  if (supports) { scene.remove(supports); supports = null; }
  obj.position.set(0, 0, 0); obj.updateMatrixWorld(true);
  let bx = new THREE.Box3().setFromObject(obj), cen = bx.getCenter(new THREE.Vector3());
  obj.position.set(-cen.x, -bx.min.y, -cen.z); obj.updateMatrixWorld(true);
  bx = new THREE.Box3().setFromObject(obj);
  const s = bx.getSize(new THREE.Vector3()), m = Math.max(s.x, s.y, s.z);
  if (first) {
    cam.position.set(Math.max(m, 150) * 1.4, Math.max(m, 150) * 1.1, Math.max(m, 150) * 1.6); ctl.target.set(0, s.y / 2, 0);
    home = { p: cam.position.clone(), t: ctl.target.clone() }; wire = false;
    $("#vWire").setAttribute("aria-pressed", "false"); $("#vtools").hidden = false;
  }
  analyze(s); $("#hint").hidden = true;
  obj.traverse(o => { if (o.isMesh) o.material.wireframe = wire; });
  $("#dims").textContent = `${s.x.toFixed(1)} × ${s.z.toFixed(1)} × ${s.y.toFixed(1)} mm`;
  const ok = s.x <= 220 && s.z <= 220 && s.y <= 250;
  $("#fit").textContent = ok ? "✔ Rentre sur le plateau (220×220×250)" : "⚠ Dépasse le plateau (220×220×250)"; $("#fit").className = "chip " + (ok ? "accepted" : "refused");
  $("#est").hidden = false; estimate();
}
function rescale() {
  if (!obj) return; const k = Math.max(0.01, (parseFloat($("#scale").value) || 100) / 100);
  obj.scale.setScalar(k); refit(false);
}
// Arêtes ouvertes : une arête d'un maillage étanche est partagée par exactement 2 triangles
function openEdges(p) {
  const ids = new Map(), cnt = new Map(), id = i => { const k = Math.round(p.getX(i) * 1000) + "," + Math.round(p.getY(i) * 1000) + "," + Math.round(p.getZ(i) * 1000); let v = ids.get(k); if (v === undefined) ids.set(k, v = ids.size); return v; };
  for (let i = 0; i < p.count; i += 3) {
    const t = [id(i), id(i + 1), id(i + 2)];
    for (let j = 0; j < 3; j++) { const x = t[j], y = t[(j + 1) % 3]; if (x === y) continue; const k = x < y ? x + "_" + y : y + "_" + x; cnt.set(k, (cnt.get(k) || 0) + 1); }
  }
  let n = 0; cnt.forEach(c => { if (c !== 2) n++; }); return n;
}
// Analyse : volume, surface, zones en porte-à-faux (> 45°) et supports estimés
function analyze(size) {
  obj.updateMatrixWorld(true); meshes = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  let vol = 0, area = 0, overA = 0, triTotal = 0, openE = 0; const cells = new Map();
  obj.traverse(m => {
    if (!m.isMesh) return;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry, p = g.attributes.position;
    triTotal += p.count / 3; if (triTotal <= 120000) openE += openEdges(p);
    const red = new Float32Array(p.count * 3), plain = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); b.fromBufferAttribute(p, i + 1).applyMatrix4(m.matrixWorld); c.fromBufferAttribute(p, i + 2).applyMatrix4(m.matrixWorld);
      vol += a.dot(n.crossVectors(b, c)) / 6;
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)); const ta = n.length() / 2; area += ta; n.normalize();
      const cy = (a.y + b.y + c.y) / 3, over = n.y < -0.7071 && cy > 0.3;
      if (over) {
        overA += ta;
        const k = Math.round((a.x + b.x + c.x) / 12) + "," + Math.round((a.z + b.z + c.z) / 12);
        cells.set(k, Math.min(cells.get(k) ?? 1e9, Math.min(a.y, b.y, c.y)));
      }
      for (let j = 0; j < 3; j++) { red.set(over ? [1, 0.2, 0.2] : [0, 0.68, 0.26], (i + j) * 3); plain.set([0, 0.68, 0.26], (i + j) * 3); }
    }
    g.setAttribute("color", new THREE.BufferAttribute(red.slice(), 3)); m.geometry = g;
    m.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 });
    meshes.push({ g, red, plain });
  });
  const list = [...cells].filter(([, h]) => h > 0.5);
  supports = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff9500, transparent: true, opacity: 0.45 }), Math.max(list.length, 1));
  let sv = 0; const mx = new THREE.Matrix4();
  list.forEach(([k, h], i) => {
    const [x, z] = k.split(",").map(v => v * 4); mx.compose(new THREE.Vector3(x, h / 2, z), new THREE.Quaternion(), new THREE.Vector3(3, h, 3)); supports.setMatrixAt(i, mx); sv += 16 * h;
  });
  supports.count = list.length; scene.add(supports);
  ana = { vol: Math.abs(vol), area, supVol: sv * 0.2, nSup: list.length, h: size.y, sx: size.x, sz: size.z, overRatio: area ? overA / area : 0, tris: triTotal, open: triTotal > 120000 ? null : openE };
  toggleSup();
}
function toggleSup() {
  const on = $("#showSup").checked;
  meshes.forEach(o => { o.g.attributes.color.array.set(on ? o.red : o.plain); o.g.attributes.color.needsUpdate = true; });
  if (supports) supports.visible = on;
}
// Matériau du filament choisi (PLA par défaut) : densité, vitesse et températures de l'Ender 3
function curMat() {
  const f = fils.find(x => x.name === $("#color").value);
  return MATERIALS.find(m => m.name === f?.material) || MATERIALS[0];
}
// Estimation temps / filament / électricité (Creality Ender 3)
function estimate() {
  if (!ana) return;
  const kg = 20;      // 20 € / kg
  const kwh = 0.25;   // 0,25 € / kWh
  const w = 120;      // 120 Watts de consommation moyenne Ender 3

  // Paramètres laissés à l'utilisateur si souhaité
  const v = id => parseFloat($(id).value) || 0;
  const infill = v("#infill"), lh = v("#lh") || 0.2;
  
  const mat = curMat(), withSup = $("#useSup").checked, shell = Math.min(ana.vol, ana.area * 1.2);
  const printed = shell + (ana.vol - shell) * infill / 100 + (withSup ? ana.supVol : 0);
  
  const sec = (printed / (14 * lh) + (ana.h / lh) * 4) * 50 / mat.spd + 300; // 50 mm/s = référence PLA
  const g = printed * mat.dens / 1000, cf = g / 1000 * kg, ce = w / 1000 * sec / 3600 * kwh;
  
  const h = Math.floor(sec / 3600), mn = Math.round(sec % 3600 / 60), e = x => x.toFixed(2) + " €";
  
  // Coût brut matériel + électricité
  const baseCost = cf + ce;
  
  // Marge et usure de machine ajustées à 25%
  const marginMultiplier = 1.25;
  const marginAmount = baseCost * 0.25;
  const finalPrice = baseCost * marginMultiplier;

  $("#r-time").textContent = `${h} h ${String(mn).padStart(2, "0")} min`; 
  $("#r-g").textContent = g.toFixed(0) + " g"; $("#r-gl").textContent = "Filament " + mat.name.split(" ")[0];
  $("#r-temp").textContent = `Buse ${mat.nozzle} · Plateau ${mat.bed} · ${mat.spd} mm/s`;
  $("#r-sup").textContent = ana.nSup ? `~${(ana.supVol * mat.dens / 1000).toFixed(0)} g` : "aucun";
  $("#r-fil").textContent = e(cf); 
  $("#r-elec").textContent = e(ce); 
  
  // Affichage mis à jour pour les 25%
  $("#r-margin").textContent = e(marginAmount);
  const qty = Math.max(1, Math.min(100, Math.round(v("#qty")) || 1)), totalQty = finalPrice * qty;
  $("#r-vol").textContent = (ana.vol / 1000).toFixed(1) + " cm³";
  quote = { price: totalQty, seconds: sec * qty, grams: g * qty, qty };
  saveSettings(); renderChecks(sec);
  const vt = $("#vtotal"); vt.textContent = (qty > 1 ? `Total × ${qty} · ` : "Total ") + e(totalQty); vt.hidden = false; // bulle de prix flottante sur la 3D
}
document.addEventListener("input", e => { if (e.target.closest("#est")) { e.target.id === "showSup" ? toggleSup() : e.target.id === "scale" ? rescale() : estimate(); } });
async function pick(f) {
  if (!f) return;
  if (!/\.(stl|obj|3mf)$/i.test(f.name)) return toast("Format non supporté (STL, OBJ ou 3MF).", 1);
  if (f.size > 50 * 1024 * 1024) return toast("Fichier trop gros (50 Mo max).", 1);
  try { showModel(await f.arrayBuffer(), f.name); } catch { return toast("Impossible de lire ce fichier.", 1); }
  file = f; $("#send").hidden = false; $("#title").value = f.name.replace(/\.[^.]+$/, "");
}
$("#f").onchange = e => pick(e.target.files[0]);
const vw = $("#viewer");
vw.ondragover = e => { e.preventDefault(); vw.classList.add("drop"); };
vw.ondragleave = () => vw.classList.remove("drop");
vw.ondrop = e => { e.preventDefault(); vw.classList.remove("drop"); pick(e.dataTransfer.files[0]); };

// ---------- Envoi ----------
$("#submit").onclick = async () => {
  if (!file) return;
  if (appCfg.accepting === false && me.role !== "admin") return toast("Les demandes sont en pause pour le moment.", 1);
  $("#submit").disabled = true;
  const path = `${me.id}/${Date.now()}_${file.name.replace(/[^\w.-]/g, "_")}`;
  let r = await sb.storage.from("models").upload(path, file);
  if (!r.error) {
    const row = { user_id: me.id, title: $("#title").value.trim() || file.name, file_name: file.name, file_path: path };
    const extra = { use_supports: $("#useSup").checked, price: Math.round(quote.price * 100) / 100, est_seconds: Math.round(quote.seconds), est_grams: Math.round(quote.grams * 10) / 10,
      qty: quote.qty, comment: $("#comment").value.trim() || null, color: $("#color").value || null };
    r = await sb.from("requests").insert({ ...row, ...extra });
    if (r.error && /column|schema cache|use_supports|price|est_|qty|comment|color/i.test(r.error.message)) r = await sb.from("requests").insert(row); // colonnes pas encore créées (migration.sql)
  }
  $("#submit").disabled = false;
  if (r.error) return toast(r.error.message, 1);
  toast("Demande envoyée ! Elle est en attente de validation.");
  $("#send").hidden = true; file = null; $("#f").value = ""; $("#comment").value = ""; refresh();
};

// ---------- Liste + admin ----------
async function refresh() {
  const { data, error } = await sb.from("requests").select("*, profiles(pseudo)").order("created_at", { ascending: false });
  if (error) return; notify(data); all = data; render();
}
function render() {
  const admin = me.role === "admin", c = s => all.filter(r => r.status === s).length;
  if (admin) { renderAdmin(); $("#bulk").hidden = false; updateBulk(); if (reviewing) { const cur = all.find(x => x.id === reviewing.id); cur ? openReview(cur) : closeReview(); } }
  $("#s-all").textContent = all.length; ["pending", "accepted", "refused"].forEach(s => $("#s-" + s).textContent = c(s));
  if (admin) fillUsers();
  const q = $("#q").value.trim().toLowerCase(), so = $("#sort").value, fu = admin ? $("#fuser").value : "", fs = admin ? $("#fsup").value : "";
  const data = all.filter(r => (filter === "all" || r.status === filter) && (!q || (r.title + " " + (r.profiles?.pseudo || "")).toLowerCase().includes(q)) && (!fu || r.profiles?.pseudo === fu) && (!fs || String(r.use_supports) === fs))
    .sort((x, y) => so === "title" ? x.title.localeCompare(y.title, "fr") : so === "old" ? new Date(x.created_at) - new Date(y.created_at) : new Date(y.created_at) - new Date(x.created_at));
  $("#list").innerHTML = data.length ? data.map(r => `
   <div class="item"><div class="lead">${admin && r.status === "pending" ? `<input type="checkbox" class="sel" data-id="${r.id}" aria-label="Sélectionner ${esc(r.title)}" ${sel.has(String(r.id)) ? "checked" : ""}>` : ""}<div><b>${esc(r.title)}</b> <span class="chip ${r.status}">${LABEL[r.status]}</span>${admin ? supChip(r) : ""}${stageChip(r)}${payChip(r)}${changed.has(String(r.id)) ? ' <span class="chip new">Mis à jour</span>' : ""}
    <small>${admin ? esc(r.profiles?.pseudo) + " · " : ""}${new Date(r.created_at).toLocaleString("fr-FR")}${r.admin_note ? " · Motif : " + esc(r.admin_note) : ""}${esc(extraText(r))}${waiting(r)}</small></div></div>
    <div class="acts" data-id="${r.id}" data-path="${esc(r.file_path)}" data-name="${esc(r.file_name)}">
     <button class="btn sm out" data-a="view">Voir en 3D</button>
     ${admin ? `<button class="btn sm out" data-a="dl">Télécharger</button>` : ""}
     ${admin && r.status === "pending" ? `<button class="btn sm" data-a="accepted">Accepter</button><button class="btn sm red" data-a="refused">Refuser</button>` : ""}
     ${admin && r.status !== "pending" ? `<button class="btn sm out" data-a="pending">Remettre en attente</button>` : ""}
     ${admin && r.status === "accepted" ? (!r.stage ? `<button class="btn sm out" data-a="stage:printing">Lancer l'impression</button>` : r.stage === "printing" ? `<button class="btn sm out" data-a="stage:ready">Marquer prête</button>` : r.stage === "ready" ? `<button class="btn sm out" data-a="stage:picked">Récupérée</button>` : "") : ""}
     ${admin && r.status === "accepted" ? (r.paid ? `<button class="btn sm out" data-a="unpay">Annuler le paiement</button>` : r.price != null ? `<button class="btn sm" data-a="pay">Encaisser ${eur(r.price)}</button>` : `<button class="btn sm out" data-a="setprice">Fixer le prix</button>`) : ""}
     ${admin || r.status === "pending" ? `<button class="btn sm out" data-a="del">Supprimer</button>` : ""}
    </div></div>`).join("") : `<p class="muted empty">Rien ici pour l'instant. Importe une pièce pour commencer.</p>`;
}
$("#list").onclick = async e => {
  const b = e.target.closest("button"); if (!b) return;
  const { id, path, name } = b.parentElement.dataset, a = b.dataset.a;
  if (a === "view" || a === "dl") {
    const { data, error } = await sb.storage.from("models").download(path);
    if (error) return toast(error.message, 1);
    if (a === "dl") { const l = document.createElement("a"); l.href = URL.createObjectURL(data); l.download = name; l.click(); }
    else { showModel(await data.arrayBuffer(), name); if (me.role === "admin") openReview(all.find(x => String(x.id) === id)); $("#viewer").scrollIntoView({ behavior: "smooth" }); }
  } else if (a === "del") {
    if (!await ask({ title: "Supprimer cette demande ?", text: "Le fichier sera aussi effacé du serveur. Cette action est définitive.", ok: "Supprimer", danger: true })) return;
    await sb.storage.from("models").remove([path]); await sb.from("requests").delete().eq("id", id); refresh();
  } else if (a.startsWith("stage:")) await setFields([id], { stage: a.slice(6) }, "Avancement mis à jour.");
  else if (a === "pay") await payOne(id);
  else if (a === "unpay") await setFields([id], { paid: false, paid_at: null }, "Paiement annulé.");
  else if (a === "setprice") await setPrice(id);
  else await setStatus([id], a);
};

// ---------- Thème, réglages, outils 3D, dialogue, export ----------
const themeBtn = $("#theme"), isDark = () => document.documentElement.dataset.theme === "dark";
const syncTheme = () => themeBtn.textContent = isDark() ? "Clair" : "Sombre";
themeBtn.onclick = () => {
  if (isDark()) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = "dark";
  try { localStorage.setItem("theme", isDark() ? "dark" : "light"); } catch {}
  syncTheme();
};
syncTheme();

function saveSettings() {
  try { localStorage.setItem("swim_set", JSON.stringify({ infill: $("#infill").value, lh: $("#lh").value, sup: $("#useSup").checked })); } catch {}
}
function loadSettings() {
  try { const s = JSON.parse(localStorage.getItem("swim_set") || "null"); if (!s) return;
    if (s.infill) $("#infill").value = s.infill; if (s.lh) $("#lh").value = s.lh; $("#useSup").checked = s.sup !== false; } catch {}
}

$("#vReset").onclick = () => { if (home) { cam.position.copy(home.p); ctl.target.copy(home.t); ctl.update(); } };
$("#vRot").onclick = e => { ctl.autoRotate = !ctl.autoRotate; ctl.autoRotateSpeed = 2; e.currentTarget.setAttribute("aria-pressed", ctl.autoRotate); };
$("#vWire").onclick = e => {
  wire = !wire; e.currentTarget.setAttribute("aria-pressed", wire);
  obj && obj.traverse(m => { if (m.isMesh) m.material.wireframe = wire; });
};


["input", "change"].forEach(ev => { $("#q").addEventListener(ev, () => me && render()); $("#sort").addEventListener(ev, () => me && render()); });

$("#csv").onclick = () => {
  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Titre", "Pseudo", "Statut", "Date", "Fichier", "Motif", "Supports", "Quantité", "Prix (€)", "Payé", "Couleur", "Avancement", "Commentaire"], ...all.map(r => [r.title, r.profiles?.pseudo, LABEL[r.status], new Date(r.created_at).toLocaleString("fr-FR"), r.file_name, r.admin_note, r.use_supports === true ? "oui" : r.use_supports === false ? "non" : "", r.qty, r.price, r.paid ? "oui" : "non", r.color, STAGE[r.stage] || "", r.comment])];
  const blob = new Blob(["\ufeff" + rows.map(r => r.map(cell).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const l = document.createElement("a"); l.href = URL.createObjectURL(blob); l.download = "demandes-swimpress.csv"; l.click();
};

// Boîte de dialogue : renvoie true / le texte saisi / null si annulé
function ask({ title, text, input, ok = "OK", danger, chips }) {
  const d = $("#dlg"), f = $("#dInput"), c = $("#dChips");
  c.hidden = !chips; c.innerHTML = (chips || []).map(t => `<button type="button" class="vbtn">${esc(t)}</button>`).join("");
  c.onclick = e => { const b = e.target.closest("button"); if (b) { f.value = b.textContent; f.focus(); } };
  $("#dTitle").textContent = title; $("#dText").textContent = text || "";
  f.hidden = !input; f.value = ""; $("#dOk").textContent = ok; $("#dOk").className = "btn" + (danger ? " red" : "");
  return new Promise(res => {
    d.addEventListener("close", () => res(d.returnValue === "ok" ? (input ? f.value.trim() : true) : null), { once: true });
    d.returnValue = "cancel"; d.showModal(); if (input) f.focus();
  });
}


// ---------- Espace admin ----------
const days = r => Math.floor((Date.now() - new Date(r.created_at)) / 864e5);
function supChip(r) {
  if (typeof r.use_supports !== "boolean") return "";
  return ` <span class="chip dim" title="Choix de l'utilisateur à l'envoi">${r.use_supports ? "Avec supports" : "Sans supports"}</span>`;
}
function waiting(r) { if (r.status !== "pending" || me.role !== "admin") return ""; const d = days(r); return ` · <span class="${d >= 3 ? "late" : ""}">en attente depuis ${d < 1 ? "moins d'1 jour" : d + " j"}</span>`; }
function fillUsers() {
  const f = $("#fuser"), cur = f.value, names = [...new Set(all.map(r => r.profiles?.pseudo).filter(Boolean))].sort((x, y) => x.localeCompare(y, "fr"));
  f.innerHTML = `<option value="">Tous les utilisateurs</option>` + names.map(n => `<option ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join(""); f.hidden = false;
}
$("#fuser").onchange = $("#fsup").onchange = () => render();
function renderAdmin() {
  $("#admin").hidden = false;
  const pend = all.filter(r => r.status === "pending"), acc = all.filter(r => r.status === "accepted").length, ref = all.filter(r => r.status === "refused").length;
  $("#k-wait").textContent = pend.length;
  $("#k-old").textContent = pend.length ? `La plus ancienne : ${Math.max(...pend.map(days))} j` : "File vide";
  $("#k-rate").textContent = acc + ref ? Math.round(acc / (acc + ref) * 100) + " %" : "–";
  $("#k-week").textContent = all.filter(r => days(r) < 7).length;
  $("#k-users").textContent = new Set(all.map(r => r.user_id)).size;
  const n = 14, counts = Array(n).fill(0), now = new Date(); now.setHours(0, 0, 0, 0);
  all.forEach(r => { const d = new Date(r.created_at); d.setHours(0, 0, 0, 0); const k = Math.round((now - d) / 864e5); if (k >= 0 && k < n) counts[n - 1 - k]++; });
  const max = Math.max(1, ...counts);
  $("#bars").setAttribute("aria-label", "Demandes par jour sur 14 jours : " + counts.join(", "));
  $("#bars").innerHTML = counts.map((c, i) => { const d = new Date(now); d.setDate(d.getDate() - (n - 1 - i));
    return `<div class="col ${c ? "" : "zero"}" title="${c} demande(s) le ${d.toLocaleDateString("fr-FR")}"><i style="height:${Math.max(3, c / max * 80)}%"></i><span>${d.getDate()}</span></div>`; }).join("");
  const todo = all.filter(r => r.status === "accepted" && r.stage !== "ready" && r.stage !== "picked"), wait = all.filter(r => r.status === "pending");
  const sumS = l => l.reduce((t, r) => t + (r.est_seconds || 0), 0);
  $("#k-queue").textContent = hm(sumS(todo)); $("#k-queue-n").textContent = `${todo.length} pièce(s) acceptée(s)` + (wait.length && sumS(wait) ? ` · +${hm(sumS(wait))} en attente` : "");
  renderBank(); renderStock();
  const by = {}; all.forEach(r => { const p = r.profiles?.pseudo || "?"; by[p] = (by[p] || 0) + 1; });
  $("#top").innerHTML = Object.entries(by).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([p, c]) => `<li><span>${esc(p)}</span><b>${c}</b></li>`).join("") || `<li class="muted">Aucune donnée</li>`;
}

// Changement de statut (un ou plusieurs ids) avec motifs rapides
async function setStatus(ids, status) {
  let note = null;
  if (status === "refused") {
    note = await ask({ title: ids.length > 1 ? `Refuser ${ids.length} demandes` : "Refuser la demande", text: "Choisis un motif rapide ou écris le tien (optionnel).", input: true, chips: REASONS, ok: "Refuser", danger: true });
    if (note === null) return false;
  }
  const { error } = await sb.from("requests").update({ status, admin_note: note || null }).in("id", ids);
  if (error) { toast(error.message, 1); return false; }
  ids.forEach(i => sel.delete(String(i)));
  toast(ids.length > 1 ? `${ids.length} demandes mises à jour.` : "Demande mise à jour."); await refresh(); return true;
}

// Sélection groupée
$("#list").addEventListener("change", e => {
  if (!e.target.classList.contains("sel")) return;
  e.target.checked ? sel.add(e.target.dataset.id) : sel.delete(e.target.dataset.id); updateBulk();
});
function updateBulk() {
  const n = sel.size; $("#bn").textContent = n ? `${n} sélectionnée${n > 1 ? "s" : ""}` : "Aucune sélection";
  $("#bulkOk").disabled = $("#bulkNo").disabled = !n;
}
$("#selPend").onclick = () => { all.filter(r => r.status === "pending").forEach(r => sel.add(String(r.id))); render(); };
$("#bulkOk").onclick = () => setStatus([...sel], "accepted");
$("#bulkNo").onclick = () => setStatus([...sel], "refused");

// Mode revue : voir, accepter/refuser, passer à la suivante sans quitter la visionneuse
function openReview(r) {
  if (!r) return; reviewing = r; $("#title").value = r.title;
  if ($("#color").value !== (r.color || "")) { $("#color").value = r.color || ""; if (ana) estimate(); }
  $("#rv-title").textContent = r.title; $("#rv-meta").textContent = `${r.profiles?.pseudo || ""} · ${LABEL[r.status]}${r.admin_note ? " · " + r.admin_note : ""}${r.use_supports === true ? " · Supports : oui" : r.use_supports === false ? " · Supports : non" : ""}${extraText(r)}`; paintVerdict();
  const p = r.status === "pending"; $("#rv-ok").hidden = $("#rv-no").hidden = !p; $("#review").hidden = false;
}
const closeReview = () => { reviewing = null; $("#review").hidden = true; };
const queue = () => all.filter(r => r.status === "pending").sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
async function openNext() {
  const q = queue().filter(r => !reviewing || r.id !== reviewing.id), n = q[0];
  if (!n) { closeReview(); return toast("Plus aucune demande en attente."); }
  const { data, error } = await sb.storage.from("models").download(n.file_path);
  if (error) return toast(error.message, 1);
  showModel(await data.arrayBuffer(), n.file_name); openReview(n);
}
async function decide(status) {
  if (!reviewing || reviewing.status !== "pending") return;
  if (await setStatus([reviewing.id], status)) openNext();
}
$("#rv-ok").onclick = () => decide("accepted"); $("#rv-no").onclick = () => decide("refused");
$("#rv-next").onclick = openNext; $("#rv-close").onclick = closeReview;
document.addEventListener("keydown", e => {
  if (!reviewing || e.ctrlKey || e.metaKey || e.altKey || $("#dlg").open || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase(); if (k === "a") decide("accepted"); else if (k === "r") decide("refused"); else if (k === "n") openNext();
});


// ---------- Outils de formatage ----------
const STAGE = { printing: "En impression", ready: "Prête à récupérer", picked: "Récupérée" };
const eur = x => Number(x || 0).toFixed(2).replace(".", ",") + " €";
const hm = s => { const m = Math.round((s || 0) / 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };
function extraText(r) {
  return (r.qty > 1 ? ` · ×${r.qty}` : "") + (r.price != null ? ` · ${eur(r.price)}` : "") + (r.color ? ` · ${r.color}` : "") + (r.comment ? ` · « ${r.comment} »` : "");
}
const stageChip = r => r.stage && STAGE[r.stage] ? ` <span class="chip ${r.stage === "printing" ? "dim" : "accepted"}">${STAGE[r.stage]}</span>` : "";
const payChip = r => r.status !== "accepted" || r.price == null ? "" : r.paid ? ` <span class="chip accepted">Payé</span>` : ` <span class="chip pending">À régler ${eur(r.price)}</span>`;

// ---------- Contrôles de printabilité ----------
function renderChecks(sec) {
  if (!ana) return;
  const L = [], A = ana, mx = Math.max(A.sx, A.sz, A.h), pct = parseFloat($("#scale").value) || 100, pc = x => Math.round(x * 100);
  if (!(A.sx <= 220 && A.sz <= 220 && A.h <= 250)) L.push(["bad", "Trop grande", `Dépasse le plateau : réduis l'échelle à ${Math.floor(pct * Math.min(220 / A.sx, 220 / A.sz, 250 / A.h))} % ou moins.`]);
  if (mx < 5) L.push(["warn", "Unité ?", `Pièce minuscule (${mx.toFixed(1)} mm) : le fichier est peut-être en mètres ou en pouces. Ajuste l'échelle.`]);
  else if (mx > 1000) L.push(["warn", "Unité ?", `Pièce énorme (${(mx / 10).toFixed(0)} cm) : le fichier est peut-être dans une autre unité.`]);
  if (A.open > 0) L.push(["bad", "Maillage", `Maillage non étanche (${A.open} arêtes ouvertes) : le slicer risque de laisser des trous.`]);
  if (A.overRatio > 0.12) L.push(["warn", "Porte-à-faux", `${pc(A.overRatio)} % de la surface est en porte-à-faux. Essaie « Optimiser l'orientation ».`]);
  const mat = curMat(), supG = A.supVol * mat.dens / 1000; if (supG > 30) L.push(["warn", "Supports", `Supports importants (~${supG.toFixed(0)} g) : plus de filament et de finition.`]);
  const lh = parseFloat($("#lh").value) || 0.2;
  if (lh > 0.32) L.push(["warn", "Couches", `Couches de ${lh} mm trop épaisses pour la buse de 0,4 mm de l'Ender 3 (max ~0,3 mm) : mauvaise adhérence entre couches.`]);
  else if (lh < 0.08) L.push(["warn", "Couches", `Couches de ${lh} mm : très fin, impression très longue pour un gain peu visible sur l'Ender 3.`]);
  if (mat.lvl === "care") L.push(["warn", mat.name.split(" ")[0], mat.note]);
  if (sec > 43200) L.push(["warn", "Durée", `Impression longue (${hm(sec)}).`]);
  if (!L.length) L.push(["ok", "OK", "Rien à signaler : la pièce a l'air imprimable."]);
  const lvl = L.some(x => x[0] === "bad") ? "bad" : L.some(x => x[0] === "warn") ? "warn" : "ok";
  verdict = { lvl, text: lvl === "bad" ? "Risque" : lvl === "warn" ? "Attention" : "OK" };
  const cls = { ok: "accepted", warn: "pending", bad: "refused" };
  $("#checks").innerHTML = L.map(([l, t, x]) => `<li><span class="chip ${cls[l]}">${esc(t)}</span><span>${esc(x)}</span></li>`).join("");
  if (reviewing) paintVerdict();
}
function paintVerdict() {
  const v = $("#rv-verdict"), cls = { ok: "accepted", warn: "pending", bad: "refused" };
  v.textContent = "Printabilité : " + verdict.text; v.className = "chip " + cls[verdict.lvl];
}

// ---------- Optimiser l'orientation (6 poses à angle droit, on garde celle qui demande le moins de supports) ----------
function supportScore(R) {
  const v = new THREE.Vector3(), M = new THREE.Matrix4(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const ms = []; obj.updateMatrixWorld(true); obj.traverse(m => m.isMesh && ms.push(m));
  let minY = Infinity;
  ms.forEach(m => { M.multiplyMatrices(R, m.matrixWorld); const p = m.geometry.attributes.position; for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(M); if (v.y < minY) minY = v.y; } });
  const cells = new Map();
  ms.forEach(m => {
    M.multiplyMatrices(R, m.matrixWorld); const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i).applyMatrix4(M); b.fromBufferAttribute(p, i + 1).applyMatrix4(M); c.fromBufferAttribute(p, i + 2).applyMatrix4(M);
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)); if (!n.lengthSq()) continue; n.normalize();
      if (n.y < -0.7071 && (a.y + b.y + c.y) / 3 - minY > 0.3) {
        const k = Math.round((a.x + b.x + c.x) / 12) + "," + Math.round((a.z + b.z + c.z) / 12);
        cells.set(k, Math.min(cells.get(k) ?? 1e9, Math.min(a.y, b.y, c.y) - minY));
      }
    }
  });
  let sv = 0; cells.forEach(h => { if (h > 0.5) sv += 16 * h; }); return sv;
}
$("#orient").onclick = () => {
  if (!obj) return;
  const X = t => new THREE.Matrix4().makeRotationX(t), Z = t => new THREE.Matrix4().makeRotationZ(t), P = Math.PI;
  const cands = [["", new THREE.Matrix4()], ["pivoter de 90° autour de l'axe gauche-droite", X(P / 2)], ["pivoter de −90° autour de l'axe gauche-droite", X(-P / 2)],
    ["retourner la pièce (180°)", X(P)], ["pivoter de 90° autour de l'axe avant-arrière", Z(P / 2)], ["pivoter de −90° autour de l'axe avant-arrière", Z(-P / 2)]];
  const sc = cands.map(([, R]) => supportScore(R)); let best = 0; sc.forEach((s, i) => { if (s < sc[best]) best = i; });
  if (best === 0 || sc[best] > sc[0] * 0.9) return toast("L'orientation actuelle est déjà la plus économe en supports.");
  obj.applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cands[best][1])); refit(false);
  const c = $("#comment"), note = "Orientation conseillée : " + cands[best][0];
  if (!c.value.includes("Orientation conseillée")) c.value = (c.value ? c.value + " · " : "") + note;
  toast(`Orientation optimisée : supports réduits d'environ ${Math.round((1 - sc[best] / sc[0]) * 100)} %.`);
};

// ---------- Alertes : changements de statut (amis) / nouvelles demandes (admin) ----------
const changed = new Set(); let known = null;
function notify(data) {
  try {
    const key = "seen_" + me.id, prev = JSON.parse(localStorage.getItem(key) || "null"), cur = {};
    data.forEach(r => cur[r.id] = [r.status, r.stage || "", r.paid ? 1 : 0].join("|"));
    if (me.role === "admin") {
      if (known) data.filter(r => !known.has(r.id)).forEach(r => toast(`Nouvelle demande : ${r.title} (${r.profiles?.pseudo || "?"})`));
      known = new Set(data.map(r => r.id));
    } else if (prev) {
      let n = 0; data.forEach(r => { if (prev[r.id] && prev[r.id] !== cur[r.id]) { changed.add(String(r.id)); n++; } });
      if (n) toast(n > 1 ? `${n} de tes demandes ont changé.` : "Une de tes demandes a changé.");
    }
    localStorage.setItem(key, JSON.stringify(cur));
  } catch {}
}

// ---------- Mises à jour génériques (avancement, paiement, prix) ----------
async function setFields(ids, fields, msg) {
  const { error } = await sb.from("requests").update(fields).in("id", ids);
  if (error) { toast(/column|schema cache/i.test(error.message) ? "Colonnes manquantes : lance migration.sql dans Supabase." : error.message, 1); return false; }
  toast(msg); await refresh(); return true;
}
async function payOne(id) {
  const r = all.find(x => String(x.id) === String(id)); if (!r) return;
  if (!await ask({ title: `Encaisser ${eur(r.price)} ?`, text: `Paiement en espèces de ${r.profiles?.pseudo || "?"} pour « ${r.title} ».`, ok: "Encaisser" })) return;
  setFields([id], { paid: true, paid_at: new Date().toISOString() }, `${eur(r.price)} encaissés.`);
}
async function setPrice(id) {
  const v = await ask({ title: "Prix de cette pièce (€)", text: "Cette demande n'a pas de prix enregistré.", input: true, ok: "Enregistrer" });
  const p = parseFloat(String(v || "").replace(",", ".")); if (!(p >= 0)) return;
  setFields([id], { price: Math.round(p * 100) / 100 }, "Prix enregistré.");
}

// ---------- Caisse ----------
function renderBank() {
  $("#bank").hidden = false;
  const sum = l => l.reduce((t, r) => t + Number(r.price || 0), 0), paid = all.filter(r => r.paid && r.price != null);
  const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0);
  const due = all.filter(r => r.status === "accepted" && !r.paid && r.price != null), noPrice = all.filter(r => r.status === "accepted" && !r.paid && r.price == null).length;
  $("#b-total").textContent = eur(sum(paid)); $("#b-month").textContent = eur(sum(paid.filter(r => new Date(r.paid_at || r.created_at) >= m0)));
  $("#b-due").textContent = eur(sum(due)); $("#b-due-n").textContent = `${due.length} pièce(s)` + (noPrice ? ` · ${noPrice} sans prix` : "");
  const by = {}; all.forEach(r => { if (r.price == null || r.status !== "accepted") return; const o = by[r.user_id] ||= { pseudo: r.profiles?.pseudo || "?", due: 0, paid: 0 }; r.paid ? o.paid += Number(r.price) : o.due += Number(r.price); });
  const rows = Object.entries(by).sort((x, y) => y[1].due - x[1].due);
  $("#b-friends").innerHTML = rows.map(([uid, o]) => `<div class="rowline"><span><b>${esc(o.pseudo)}</b><small>Déjà payé : ${eur(o.paid)}</small></span>${o.due > 0 ? `<button class="btn sm" data-uid="${esc(uid)}">Encaisser ${eur(o.due)}</button>` : `<span class="chip accepted">À jour</span>`}</div>`).join("") || `<p class="muted">Aucune pièce acceptée avec un prix.</p>`;
  $("#b-last").innerHTML = paid.sort((x, y) => new Date(y.paid_at || 0) - new Date(x.paid_at || 0)).slice(0, 8).map(r => `<li class="rowline"><span><b>${esc(r.title)}</b><small>${esc(r.profiles?.pseudo)} · ${r.paid_at ? new Date(r.paid_at).toLocaleDateString("fr-FR") : ""}</small></span><span>${eur(r.price)} <button class="btn sm out" data-id="${r.id}">Annuler</button></span></li>`).join("") || `<li class="muted">Aucun paiement pour l'instant.</li>`;
}
$("#b-friends").onclick = async e => {
  const b = e.target.closest("button[data-uid]"); if (!b) return;
  const rows = all.filter(r => String(r.user_id) === b.dataset.uid && r.status === "accepted" && !r.paid && r.price != null), tot = rows.reduce((t, r) => t + Number(r.price), 0);
  if (!rows.length || !await ask({ title: `Encaisser ${eur(tot)} ?`, text: `Paiement en espèces de ${rows[0].profiles?.pseudo || "?"} pour ${rows.length} pièce(s).`, ok: "Encaisser" })) return;
  setFields(rows.map(r => r.id), { paid: true, paid_at: new Date().toISOString() }, `${eur(tot)} encaissés.`);
};
$("#b-last").onclick = e => { const b = e.target.closest("button[data-id]"); if (b) setFields([b.dataset.id], { paid: false, paid_at: null }, "Paiement annulé."); };

// ---------- Stock de filament + couleurs ----------
let fils = [], filsOk = false;
async function loadFils() {
  const keep = $("#color").value;
  const { data, error } = await sb.from("filaments").select("*").order("name"); filsOk = !error; fils = data || [];
  const act = fils.filter(f => f.in_stock);
  $("#color").innerHTML = `<option value="">Au choix</option>` + act.map(f => `<option value="${esc(f.name)}">${esc(f.name)}${f.material ? " · " + esc(f.material) : ""}</option>`).join(""); $("#color").value = keep; $("#colorWrap").hidden = !act.length; renderAvail(); if (ana) estimate();
  if (me.role === "admin") renderStock();
}
function renderStock() {
  $("#stock").hidden = !filsOk; if (!filsOk) return;
  const need = n => all.filter(r => r.status === "accepted" && r.stage !== "ready" && r.stage !== "picked" && r.color === n).reduce((t, r) => t + (r.est_grams || 0), 0);
  $("#stock-list").innerHTML = fils.map(f => { const nd = need(f.name), low = nd > f.grams_left;
    return `<div class="rowline"><span><span class="swatch" style="background:${/^#[0-9a-f]{6}$/i.test(f.hex) ? f.hex : "#888"}"></span><b>${esc(f.name)}</b>${f.material ? ` <span class="chip dim">${esc(f.material)}</span>` : ""}<small class="${low ? "over" : ""}">À imprimer : ${nd.toFixed(0)} g${low ? " : stock insuffisant" : ""}</small></span>
     <span class="acts"><input class="gr" type="number" min="0" value="${f.grams_left ?? 0}" data-id="${f.id}" data-k="grams_left" aria-label="Grammes restants"> g
     <label class="chk"><input type="checkbox" data-id="${f.id}" data-k="in_stock" ${f.in_stock ? "checked" : ""}> En stock</label>
     <button class="btn sm out" data-del="${f.id}">Supprimer</button></span></div>`; }).join("") || `<p class="muted">Aucun filament. Ajoute ceux que tu as en stock.</p>`;
}
$("#stock-list").addEventListener("change", async e => {
  const t = e.target; if (!t.dataset.k) return;
  const { error } = await sb.from("filaments").update({ [t.dataset.k]: t.type === "checkbox" ? t.checked : Math.max(0, parseInt(t.value) || 0) }).eq("id", t.dataset.id);
  if (error) toast(error.message, 1); loadFils();
});
$("#stock-list").addEventListener("click", async e => {
  const b = e.target.closest("button[data-del]"); if (!b || !await ask({ title: "Supprimer ce filament ?", ok: "Supprimer", danger: true })) return;
  await sb.from("filaments").delete().eq("id", b.dataset.del); loadFils();
});
$("#fadd").onclick = async () => {
  const name = $("#fn").value.trim(); if (!name) return toast("Donne un nom au filament.", 1);
  const row = { name, hex: $("#fh").value, grams_left: parseInt($("#fg").value) || 0 }, mat = $("#fm").value;
  let { error } = await sb.from("filaments").insert(mat ? { ...row, material: mat } : row);
  if (error && /material|schema cache/i.test(error.message)) ({ error } = await sb.from("filaments").insert(row)); // colonne pas encore créée
  if (error) return toast(error.message, 1); $("#fn").value = ""; loadFils();
};

// ---------- Interrupteur « j'accepte les demandes » ----------
let appCfg = { accepting: true, message: "" };
async function loadApp() {
  const { data, error } = await sb.from("app_settings").select("*").eq("id", 1).maybeSingle(); if (!error && data) appCfg = data;
  const off = appCfg.accepting === false, b = $("#banner"); b.hidden = !off;
  b.textContent = off ? (me.role === "admin" ? "Les demandes sont en pause (message visible par les utilisateurs) : " : "") + (appCfg.message || "Les demandes sont en pause pour le moment.") : "";
  if (me.role === "admin") { $("#acc").checked = !off; $("#accMsg").value = appCfg.message || ""; }
}
$("#accSave").onclick = async () => {
  const { error } = await sb.from("app_settings").update({ accepting: $("#acc").checked, message: $("#accMsg").value.trim() }).eq("id", 1);
  if (error) return toast(/relation|schema cache|does not exist/i.test(error.message) ? "Table manquante : lance migration.sql dans Supabase." : error.message, 1);
  toast("Réglage enregistré."); loadApp();
};


// ---------- Matériaux compatibles (Creality Ender 3 / V2 : buse 255 °C max, plateau 110 °C max, Bowden, buse laiton 0,4 mm) ----------
const MATERIALS = [
  { name: "PLA", dens: 1.24, spd: 50, lvl: "ok", nozzle: "190–220 °C", bed: "50–60 °C", note: "Le plus simple et le plus fiable : déco, figurines, prototypes. Ramollit vers 55–60 °C (à éviter dans une voiture au soleil)." },
  { name: "PLA+ / Silk / Mat / Bois", dens: 1.24, spd: 50, lvl: "ok", nozzle: "190–225 °C", bed: "50–65 °C", note: "Variantes du PLA, mêmes réglages. Les PLA à paillettes ou « bois » peuvent boucher une buse trop fine." },
  { name: "PETG", dens: 1.27, spd: 45, lvl: "ok", nozzle: "230–250 °C", bed: "70–85 °C", note: "Plus solide, plus résistant à l'eau et à la chaleur (environ 70 °C) que le PLA. Fait facilement des fils : prévoir un peu de finition." },
  { name: "TPU / TPE (flexible)", dens: 1.21, spd: 25, lvl: "care", nozzle: "210–230 °C", bed: "40–60 °C", note: "Imprimable mais lent (15 à 30 mm/s) : l'extrudeur Bowden rend le filament souple capricieux. À voir au cas par cas." },
  { name: "ABS", dens: 1.05, spd: 50, lvl: "care", nozzle: "230–250 °C", bed: "90–110 °C", note: "Dans les limites de la machine, mais se déforme sans caisson fermé et dégage des vapeurs : à imprimer dans une pièce ventilée, plutôt de petites pièces." },
  { name: "ASA", dens: 1.07, spd: 50, lvl: "care", nozzle: "240–255 °C", bed: "90–110 °C", note: "Comme l'ABS, avec une meilleure tenue au soleil. Il faut chauffer tout en haut de la plage de la buse (255 °C max). Caisson conseillé." },
  { name: "Chargé (fibre de carbone, verre, phosphorescent)", dens: 1.3, spd: 40, lvl: "care", nozzle: "selon la base", bed: "selon la base", note: "Abrasifs : la buse en laiton d'origine s'use vite, il faut une buse en acier trempé." },
  { name: "Nylon (PA)", dens: 1.14, spd: 40, lvl: "no", nozzle: "240–270 °C", bed: "70–100 °C", note: "Frôle ou dépasse les 255 °C de la machine et absorbe l'humidité : pas adapté à l'Ender 3 d'origine." },
  { name: "Polycarbonate (PC)", dens: 1.2, spd: 40, lvl: "no", nozzle: "260–310 °C", bed: "100–120 °C", note: "Trop chaud pour la buse (255 °C max) et demande un caisson fermé." },
  { name: "PEEK / PEI / hautes performances", dens: 1.3, spd: 30, lvl: "no", nozzle: "350 °C et plus", bed: "120 °C et plus", note: "Hors de portée : températures bien au-delà des limites de la machine." },
];
function renderMats() {
  $("#fm").innerHTML = `<option value="">Matériau…</option>` + MATERIALS.filter(m => m.lvl !== "no").map(m => `<option>${esc(m.name)}</option>`).join("");
}
// Matériaux visibles par tous : uniquement les filaments marqués « En stock » par l'admin
function renderAvail() {
  const box = $("#mats");
  if (!filsOk) { box.innerHTML = `<p class="muted">Liste indisponible pour le moment.</p>`; return; }
  const act = fils.filter(f => f.in_stock), groups = {};
  act.forEach(f => (groups[f.material || "Autre"] = groups[f.material || "Autre"] || []).push(f));
  box.innerHTML = Object.keys(groups).sort((x, y) => x === "Autre" ? 1 : y === "Autre" ? -1 : x.localeCompare(y)).map(m =>
    `<div class="matgroup"><h3><span class="chip accepted">${esc(m)}</span></h3>` +
    groups[m].map(f => `<div class="mat"><span class="swatch" style="background:${/^#[0-9a-f]{6}$/i.test(f.hex) ? f.hex : "#888"}"></span><b style="display:inline">${esc(f.name)}</b></div>`).join("") + `</div>`).join("")
    || `<p class="muted">Aucun filament disponible pour le moment.</p>`;
}
renderMats();

start().catch(e => { console.error(e); const d = document.getElementById("errbar"); if (d) d.textContent += "start() a échoué : " + (e.message || e) + "\n"; });
