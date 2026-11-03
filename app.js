const LABEL = { pending: "En attente", accepted: "Acceptée", refused: "Refusée" };
let me = null, file = null, all = [], filter = "all", scene, cam, ren, ctl, obj;

$("#logout").onclick = async () => { await sb.auth.signOut(); location.href = "login.html"; };
async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return location.replace("login.html");
  const { data } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
  if (!data) { await sb.auth.signOut(); return location.replace("login.html"); }
  me = data; $("#pseudo").textContent = me.pseudo; $("#badge").hidden = me.role !== "admin";
  $("#listTitle").textContent = me.role === "admin" ? "Toutes les demandes" : "Mes demandes";
  initViewer(); refresh(); setInterval(refresh, 20000);
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
let meshes = [], supports = null, ana = null;
function showModel(buf, name) {
  if (obj) scene.remove(obj);
  if (supports) scene.remove(supports);
  if (/\.stl$/i.test(name)) {
    obj = new THREE.Mesh(new THREE.STLLoader().parse(buf)); obj.rotation.x = -Math.PI / 2;
  } else obj = new THREE.OBJLoader().parse(new TextDecoder().decode(buf));
  scene.add(obj);
  let bx = new THREE.Box3().setFromObject(obj), cen = bx.getCenter(new THREE.Vector3());
  obj.position.set(-cen.x, -bx.min.y, -cen.z);
  bx = new THREE.Box3().setFromObject(obj);
  const s = bx.getSize(new THREE.Vector3()), m = Math.max(s.x, s.y, s.z);
  cam.position.set(Math.max(m, 150) * 1.4, Math.max(m, 150) * 1.1, Math.max(m, 150) * 1.6); ctl.target.set(0, s.y / 2, 0);
  analyze(s); $("#hint").hidden = true;
  $("#dims").textContent = `${s.x.toFixed(1)} × ${s.z.toFixed(1)} × ${s.y.toFixed(1)} mm`;
  const ok = s.x <= 220 && s.z <= 220 && s.y <= 250;
  $("#fit").textContent = ok ? "✔ Rentre sur le plateau (220×220×250)" : "⚠ Dépasse le plateau (220×220×250)"; $("#fit").className = "chip " + (ok ? "accepted" : "refused");
  $("#est").hidden = false; estimate();
}
// Analyse : volume, surface, zones en porte-à-faux (> 45°) et supports estimés
function analyze(size) {
  obj.updateMatrixWorld(true); meshes = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  let vol = 0, area = 0; const cells = new Map();
  obj.traverse(m => {
    if (!m.isMesh) return;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry, p = g.attributes.position;
    const red = new Float32Array(p.count * 3), plain = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); b.fromBufferAttribute(p, i + 1).applyMatrix4(m.matrixWorld); c.fromBufferAttribute(p, i + 2).applyMatrix4(m.matrixWorld);
      vol += a.dot(n.crossVectors(b, c)) / 6;
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)); area += n.length() / 2; n.normalize();
      const cy = (a.y + b.y + c.y) / 3, over = n.y < -0.7071 && cy > 0.3;
      if (over) {
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
  ana = { vol: Math.abs(vol), area, supVol: sv * 0.2, nSup: list.length, h: size.y };
  toggleSup();
}
function toggleSup() {
  const on = $("#showSup").checked;
  meshes.forEach(o => { o.g.attributes.color.array.set(on ? o.red : o.plain); o.g.attributes.color.needsUpdate = true; });
  if (supports) supports.visible = on;
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
  
  const withSup = $("#useSup").checked, shell = Math.min(ana.vol, ana.area * 1.2);
  const printed = shell + (ana.vol - shell) * infill / 100 + (withSup ? ana.supVol : 0);
  
  const sec = printed / (14 * lh) + (ana.h / lh) * 4 + 300;
  const g = printed * 1.24 / 1000, cf = g / 1000 * kg, ce = w / 1000 * sec / 3600 * kwh;
  
  const h = Math.floor(sec / 3600), mn = Math.round(sec % 3600 / 60), e = x => x.toFixed(2) + " €";
  
  // Coût brut matériel + électricité
  const baseCost = cf + ce;
  
  // Marge et usure de machine ajustées à 25%
  const marginMultiplier = 1.25;
  const marginAmount = baseCost * 0.25;
  const finalPrice = baseCost * marginMultiplier;

  $("#r-time").textContent = `${h} h ${String(mn).padStart(2, "0")} min`; 
  $("#r-g").textContent = g.toFixed(0) + " g";
  $("#r-sup").textContent = ana.nSup ? `~${(ana.supVol * 1.24 / 1000).toFixed(0)} g` : "aucun";
  $("#r-fil").textContent = e(cf); 
  $("#r-elec").textContent = e(ce); 
  
  // Affichage mis à jour pour les 25%
  $("#r-margin").textContent = e(marginAmount);
  $("#r-total").textContent = e(finalPrice);
}
document.addEventListener("input", e => { if (e.target.closest("#est")) { e.target.id === "showSup" ? toggleSup() : estimate(); } });
async function pick(f) {
  if (!f) return;
  if (!/\.(stl|obj)$/i.test(f.name)) return toast("Format non supporté (STL ou OBJ).", 1);
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
  $("#submit").disabled = true;
  const path = `${me.id}/${Date.now()}_${file.name.replace(/[^\w.-]/g, "_")}`;
  let r = await sb.storage.from("models").upload(path, file);
  if (!r.error) r = await sb.from("requests").insert({ user_id: me.id, title: $("#title").value.trim() || file.name, file_name: file.name, file_path: path });
  $("#submit").disabled = false;
  if (r.error) return toast(r.error.message, 1);
  toast("Demande envoyée ! Elle est en attente de validation.");
  $("#send").hidden = true; file = null; $("#f").value = ""; refresh();
};

// ---------- Liste + admin ----------
async function refresh() {
  const { data, error } = await sb.from("requests").select("*, profiles(pseudo)").order("created_at", { ascending: false });
  if (error) return; all = data; render();
}
function render() {
  const admin = me.role === "admin", c = s => all.filter(r => r.status === s).length;
  $("#s-all").textContent = all.length; ["pending", "accepted", "refused"].forEach(s => $("#s-" + s).textContent = c(s));
  const data = all.filter(r => filter === "all" || r.status === filter);
  $("#list").innerHTML = data.length ? data.map(r => `
   <div class="item"><div><b>${esc(r.title)}</b> <span class="chip ${r.status}">${LABEL[r.status]}</span>
    <small>${admin ? esc(r.profiles?.pseudo) + " · " : ""}${new Date(r.created_at).toLocaleString("fr-FR")}${r.admin_note ? " · Motif : " + esc(r.admin_note) : ""}</small></div>
    <div class="acts" data-id="${r.id}" data-path="${esc(r.file_path)}" data-name="${esc(r.file_name)}">
     <button class="btn sm out" data-a="view">Voir en 3D</button>
     ${admin ? `<button class="btn sm out" data-a="dl">Télécharger</button>` : ""}
     ${admin && r.status === "pending" ? `<button class="btn sm" data-a="accepted">Accepter</button><button class="btn sm red" data-a="refused">Refuser</button>` : ""}
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
    else { showModel(await data.arrayBuffer(), name); $("#viewer").scrollIntoView({ behavior: "smooth" }); }
  } else if (a === "del") {
    if (!confirm("Supprimer cette demande ?")) return;
    await sb.storage.from("models").remove([path]); await sb.from("requests").delete().eq("id", id); refresh();
  } else {
    const note = a === "refused" ? prompt("Motif du refus (optionnel) :") : null;
    if (a === "refused" && note === null) return;
    await sb.from("requests").update({ status: a, admin_note: note || null }).eq("id", id); refresh();
  }
};
start();
