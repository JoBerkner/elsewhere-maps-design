/* Bestelltool "Design your map": sammelt die Wuensche zur Karte und schickt sie
   an die eigene Scaleway-Funktion (function/handler.js), die sie prueft und privat ablegt.
   Kein Geheimnis in dieser Datei: alles hier ist oeffentlich. */
"use strict";

const CONFIG = Object.assign({
  // Adresse der Scaleway-Funktion (nach dem Einrichten eintragen, siehe README.md), leer = Testbetrieb
  FUNCTION_URL: "https://orderforms9bbchgwk-earth-around-you.functions.fnc.fr-par.scw.cloud",
  // Produkt dieses Formulars (weitere Karten bekommen eigene Kennungen, siehe function/handler.js PRODUCTS)
  PRODUCT: "earth-around-you",
  MAX_CITIES: 15,
  MAX_PLACES: 8,
  TITLE_MAX: 24,
  PLACE_LABEL_MAX: 15,
}, window.__TEST_CONFIG__ || {});                     // nur fuer lokale Tests (eigene Skripte erlaubt die CSP nicht)

const $ = (id) => document.getElementById(id);
// ------------------------------------------------------------------ Sprache der Seite (EN, DE, FR, ES)
const UI_LANGS = ["en", "de", "fr", "es"];
const UI_LOCALE = { en: "en-GB", de: "de-DE", fr: "fr-FR", es: "es-ES" };
let UI = "en";
/** Text der Oberflaeche, {x} aus vars */
/** Digitales Produkt (Link mit &type=digital): eigene Texte, wo es sie gibt (Schluessel + "_dig") */
const DIGITAL = new URLSearchParams(location.search).get("type") === "digital";
const t = (key, vars = {}) => {
  const k = DIGITAL && ((window.UI_STRINGS[UI] || {})[key + "_dig"] ?? window.UI_STRINGS.en[key + "_dig"]) != null ? key + "_dig" : key;
  const s = (window.UI_STRINGS[UI] || {})[k] ?? window.UI_STRINGS.en[k] ?? k;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
};
let _dn = null, _dnLang = "";
const regionName = (cc) => {
  try { if (_dnLang !== UI) { _dn = new Intl.DisplayNames([UI_LOCALE[UI]], { type: "region" }); _dnLang = UI; } return _dn.of(cc) || cc; }
  catch { return cc; }
};
const fmt = { format: (v) => new Intl.NumberFormat(UI_LOCALE[UI]).format(v) };
// Suchschluessel ohne Akzente: "München" findet auch "Munchen", "sao" findet "São Paulo"
const norm = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/ß/g, "ss");

/** Rang eines Orts fuer die Suche q, Stufen: genauer Name > Name beginnt mit q > anderer
    Name (z. B. "München") beginnt mit q > ein Wort im Namen beginnt mit q > Name enthaelt q;
    innerhalb einer Stufe nach Einwohnern (groessere Orte zuerst) */
function rank(q, k, alts, pop) {
  if (!q) return 0;
  let s = 0;
  if (k === q || alts.includes(q)) s = 50;              // genau dieser Name ("Wien" -> Vienna)
  else if (k.startsWith(q)) s = 40;
  else if (alts.some((a) => a.startsWith(q))) s = 30;
  else if (k.includes(" " + q) || k.includes("-" + q)) s = 20;
  else if (k.includes(q)) s = 10;
  return s ? s + Math.log10(pop + 10) : 0;          // log10(Einwohner) < 10, bleibt also in der Stufe
}

const sortKey = (k) => k.replace(/^[^\p{L}]+/u, "");   // fuehrende Zeichen wie ' oder * nicht mitsortieren
/** Reihenfolge ohne Suchtext als Zahl (ord): erst Grossstaedte ab 1 Mio., dann alle, je alphabetisch
 *  in der Kartensprache. Vorberechnet, weil Tom Select sonst bei jedem Oeffnen 39 000 Namen vergleicht (~1 s). */
function setOrder(ts) {
  const idx = state.cities.map((c, i) => [c[4] >= 1e6 ? 0 : 1, sortKey(state.keys[i][0]), i]);
  idx.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  idx.forEach(([, , i], n) => { const o = ts.options[String(i)]; if (o) o.ord = n; });
}

const state = {
  cities: [],            // [name, cc, lat, lon, pop, andere namen]
  keys: [],              // [name normalisiert, [andere normalisiert]]
  centre: null,          // {mode, name, country, lat, lon}
  places: [],            // {id, label, lat, lon, found, marker}
  titleTouched: false,
  altcha: "",                                         // Loesung der Bot-Aufgabe (ALTCHA)
  sending: false,
};

// ------------------------------------------------------------------ Sprache
// wie frame.HEADLINE und labels.COMPASS_NAMES im Kartenskript
const HEADLINE = {"de": "Die Erde um", "en": "The Earth Around", "es": "La Tierra alrededor de", "fr": "La Terre autour de",
  "it": "La Terra intorno a", "pt": "A Terra em torno de", "no": "Jorden sett fra", "el": "Η Γη γύρω από την",
  "tr": "Dünyanın merkezi", "ar": "الأرض حول", "ja": "世界の中心", "ko": "세계의 중심", "zh": "世界的中心", "bn": "বিশ্বের কেন্দ্র"};
const COMPASS_NAMES = {"de": ["N", "NO", "O", "SO", "S", "SW", "W", "NW"], "en": ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
  "es": ["N", "NE", "E", "SE", "S", "SO", "O", "NO"], "fr": ["N", "NE", "E", "SE", "S", "SO", "O", "NO"],
  "it": ["N", "NE", "E", "SE", "S", "SO", "O", "NO"], "pt": ["N", "NE", "L", "SE", "S", "SO", "O", "NO"],
  "no": ["N", "NØ", "Ø", "SØ", "S", "SV", "V", "NV"], "el": ["Β", "ΒΑ", "Α", "ΝΑ", "Ν", "ΝΔ", "Δ", "ΒΔ"],
  "tr": ["K", "KD", "D", "GD", "G", "GB", "B", "KB"], "ar": ["شمال", "شمال شرق", "شرق", "جنوب شرق", "جنوب", "جنوب غرب", "غرب", "شمال غرب"],
  "ja": ["北", "北東", "東", "南東", "南", "南西", "西", "北西"], "ko": ["북", "북동", "동", "남동", "남", "남서", "서", "북서"],
  "zh": ["北", "东北", "东", "东南", "南", "西南", "西", "西北"],
  "bn": ["উত্তর", "উত্তর-পূর্ব", "পূর্ব", "দক্ষিণ-পূর্ব", "দক্ষিণ", "দক্ষিণ-পশ্চিম", "পশ্চিম", "উত্তর-পশ্চিম"]};
const lang = () => $("lang").value;
/** Name eines Orts in der gewaehlten Sprache (names/<sprache>.js), sonst der Name aus cities.js */
const cityName = (i, l = lang()) => { const v = ((window.CITY_NAMES || {})[l] || [])[i]; return typeof v === "string" && v ? v : state.cities[i][0]; };
/** hat der Ort einen Namen in dieser Sprache? (0 in names/<sprache>.js = nein; Englisch immer) */
const hasName = (i, l = lang()) => { if (l === "en") return true; const a = (window.CITY_NAMES || {})[l]; return !a || typeof a[i] === "string"; };
/** Grossbuchstaben wie auf dem Poster: Griechisch ohne Akzente, Deutsch mit ẞ, Tuerkisch mit İ */
function upper(t, l = lang()) {
  if (l === "el") return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleUpperCase("el").normalize("NFC");
  if (l === "de") return t.replace(/ß/g, "ẞ").toLocaleUpperCase("de");
  return t.toLocaleUpperCase(l);
}
/** Namen einer Sprache bei Bedarf nachladen (als Script, geht auch beim Oeffnen als Datei) */
function loadNames(l) {
  if ((window.CITY_NAMES || {})[l]) return Promise.resolve();
  return new Promise((ok) => {
    const sc = document.createElement("script"); sc.src = `names/${l}.js`; sc.onload = ok; sc.onerror = ok;
    document.head.append(sc);
  });
}

// ------------------------------------------------------------------ Geometrie
function distKm(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dlat = (b.lat - a.lat) * r, dlon = (b.lon - a.lon) * r;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const NEAR_KM = 100;                                   // wie labels.DEDUP_KM: so nah an der Mitte wird nichts beschriftet
const tooClose = (p) => state.centre && distKm(state.centre, p) <= NEAR_KM;
function distText(p) {
  if (!state.centre) return "";
  const km = distKm(state.centre, p);
  const unit = document.querySelector("input[name=unit]:checked").value;
  return unit === "mi" ? t("dist", { d: fmt.format(Math.round(km / 1.609344)), u: "mi" }) : t("dist", { d: fmt.format(Math.round(km)), u: "km" });
}
const coordText = (lat, lon) =>
  `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// ------------------------------------------------------------------ Suche
function searchLocal(q, n = 5) {
  q = norm(q.trim());
  if (q.length < 2) return [];
  const hits = [];
  state.cities.forEach((c, i) => { const r = rank(q, state.keys[i][0], state.keys[i][1], c[4]); if (r >= 3) hits.push([r, c, i]); });
  hits.sort((a, b) => b[0] - a[0]);
  return hits.slice(0, n).map(([, c, i]) => ({ name: cityName(i), detail: regionName(c[1]), lat: c[2], lon: c[3], country: c[1], src: "city" }));
}

let lastNominatim = 0;
async function searchOnline(q) {
  // OpenStreetMap Nominatim: hoechstens eine Anfrage pro Sekunde, keine Suche beim Tippen
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=" + encodeURIComponent(q);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("search failed");
  const data = await res.json();
  return data.map((d) => {
    const parts = String(d.display_name || "").split(",").map((s) => s.trim());
    return { name: parts[0] || q, detail: parts.slice(1).join(", "), lat: +d.lat, lon: +d.lon, src: "map" };
  }).filter((d) => Number.isFinite(d.lat) && Number.isFinite(d.lon));
}

function showResults(ul, items, onPick, pending = false) {
  ul.replaceChildren();
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = pending ? t("searching") : t("nothing");
    li.style.cursor = "default"; ul.append(li);
  }
  for (const it of items) {
    const li = document.createElement("li");
    li.tabIndex = 0;
    const b = document.createElement("strong"); b.textContent = it.name;
    const s = document.createElement("span"); s.className = "src"; s.textContent = it.detail ? " · " + it.detail : "";
    li.append(b, s);
    const pick = () => { ul.hidden = true; onPick(it); };
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pick(); } });
    ul.append(li);
  }
  ul.hidden = false;
}

function wireSearch(input, button, ul, onPick) {
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    const local = searchLocal(q, 4);
    showResults(ul, local, onPick, true);
    button.disabled = true;
    try {
      const online = await searchOnline(q);
      const seen = new Set(local.map((l) => l.name.toLowerCase() + Math.round(l.lat) + Math.round(l.lon)));
      const more = online.filter((o) => !seen.has(o.name.toLowerCase() + Math.round(o.lat) + Math.round(o.lon)));
      showResults(ul, local.concat(more), onPick);
    } catch {
      if (!local.length) showResults(ul, [], onPick);
    } finally { button.disabled = false; }
  };
  button.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
}

// ------------------------------------------------------------------ Karten
function makeMap(el) {
  const map = L.map(el, { worldCopyJump: true, minZoom: 1, maxZoom: 16 }).setView([30, 10], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  return map;
}
const starIcon = () => L.divIcon({ className: "", html: '<div style="font-size:26px;line-height:26px;color:#182434;text-shadow:0 0 3px #fff,0 0 6px #fff">★</div>', iconSize: [26, 26], iconAnchor: [13, 14] });
const draftIcon = () => L.divIcon({ className: "", html: '<div class="draft-star">★</div>', iconSize: [34, 34], iconAnchor: [17, 18] });
const crossIcon = () => L.divIcon({ className: "", html: '<div style="width:34px;height:34px;position:relative"><div style="position:absolute;left:16px;top:0;width:3px;height:34px;background:#182434;box-shadow:0 0 0 2px #fff"></div><div style="position:absolute;top:16px;left:0;height:3px;width:34px;background:#182434;box-shadow:0 0 0 2px #fff"></div></div>', iconSize: [34, 34], iconAnchor: [17, 17] });

// ------------------------------------------------------------------ Mitte
let pinMap = null, pinMarker = null, centreTS = null;

/** Hinweis unter der Stadtwahl: welche Stadt genau gewaehlt ist, Warnung bei gleichen Namen */
function centreCheck(c) {
  const box = $("centreCheck");
  if (c && c.mode === "pin") {                        // aktuelle Mitte kommt von der Karte
    box.classList.remove("warn");
    box.textContent = t("centre_is_pin", { where: (c.name ? c.name + " · " : "") + coordText(c.lat, c.lon) });
    box.hidden = false; return;
  }
  if (!c || c.mode !== "city" || c.i === undefined) { box.hidden = true; return; }
  const k = state.cities[c.i];
  const where = [k[6], regionName(k[1])].filter(Boolean).join(", ");
  const pop = k[4] >= 1e6 ? t("million", { n: new Intl.NumberFormat(UI_LOCALE[UI], { maximumFractionDigits: 1 }).format(k[4] / 1e6) }) : fmt.format(Math.round(k[4] / 1000) * 1000);
  const same = state.nameCount.get(norm(k[0])) || 1;
  box.replaceChildren();
  const b = document.createElement("strong"); b.textContent = cityName(c.i);
  box.append(t("selected") + " ", b, ` · ${where} · ${coordText(k[2], k[3])} · ${t("inhabitants", { n: pop })}. `);
  const w = document.createElement("span");
  w.textContent = same > 1
    ? t("same_name", { n: same, name: cityName(c.i) === k[0] ? k[0] : `${cityName(c.i)} / ${k[0]}` })
    : t("check_place");
  if (same > 1) box.classList.add("warn"); else box.classList.remove("warn");
  box.append(w); box.hidden = false;
}

function setCentre(c) {
  state.centre = c;
  centreCheck(c);
  pinInfo();
  $("centreMini").hidden = !c;
  if (!state.titleTouched) $("title").value = c && c.mode === "city" && hasName(c.i) ? cityName(c.i).slice(0, CONFIG.TITLE_MAX) : "";
  updateTitleRequirement();
  renderPlaces();
}

function setPin(lat, lon, name) {
  lon = wrapLon(lon);
  if (!pinMarker) pinMarker = L.marker([lat, lon], { icon: crossIcon(), draggable: true }).addTo(pinMap)
    .on("dragend", (e) => { const p = e.target.getLatLng(); setPin(p.lat, p.lng); });
  else pinMarker.setLatLng([lat, lon]);
  if (centreTS && centreTS.getValue() !== "") centreTS.clear(true);   // die zuletzt gewaehlte Mitte gilt
  setCentre({ mode: "pin", name: name || "", country: "", lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
}

/** Zeile unter der Karte: aktuelle Mitte (auch wenn sie aus der Stadtliste kommt) */
function pinInfo() {
  const el = $("pinInfo"), c = state.centre;
  delete el.dataset.i18n;
  if (!c) el.textContent = t("pin_none");
  else if (c.mode === "pin") el.textContent = (c.name ? c.name + " · " : "") + coordText(c.lat, c.lon);
  else el.textContent = t("pin_current", { name: c.i !== undefined ? cityName(c.i) : c.name });
}

/** Stadt aus der Liste gewaehlt: sie gilt, ein Punkt auf der Karte faellt weg */
function pickCity(v) {
  if (v === "") return;                                // Leeren der Liste aendert die Mitte nicht
  if (pinMarker) { pinMap.removeLayer(pinMarker); pinMarker = null; }
  setCentre(cityToCentre(state.cities[+v], +v));
}

function centreMode() { return document.querySelector("input[name=centreMode]:checked").value; }

function onCentreMode() {
  const pin = centreMode() === "pin";
  $("centreCity").hidden = pin; $("centrePin").hidden = !pin;
  if (pin) {
    if (!pinMap) {
      pinMap = makeMap($("pinMap"));
      pinMap.on("click", (e) => setPin(e.latlng.lat, e.latlng.lng));
    }
    setTimeout(() => {                                 // Umschalten aendert die Mitte nicht, die Karte zeigt sie nur
      pinMap.invalidateSize();
      if (state.centre && !pinMarker) pinMap.setView([state.centre.lat, state.centre.lon], 4);
    }, 50);
  }
  pinInfo(); centreCheck(state.centre);
}
const cityToCentre = (c, i) => ({ mode: "city", name: c[0], country: c[1], lat: c[2], lon: c[3], i });

function updateTitleRequirement() {
  const c = state.centre;
  const pin = c ? c.mode === "pin" : centreMode() === "pin";
  const noName = !pin && c && c.i !== undefined && !hasName(c.i);
  $("titleDefault").textContent = pin ? "" : " · " + (noName ? t("title_noname") : t("title_default"));
}

// ------------------------------------------------------------------ Besondere Orte
let placeMap = null, placeSeq = 0;

/** Neuer Ort: erst als Entwurf (oranger Stern), Klick auf die Karte verschiebt ihn;
 *  auf die Liste kommt er erst mit "Ort hinzufuegen" */
function setDraft(lat, lon, found) {
  if (state.places.length >= CONFIG.MAX_PLACES) { showError(t("max_places", { n: CONFIG.MAX_PLACES })); return; }
  lon = wrapLon(lon);
  const d = state.draft || (state.draft = { label: "" });
  d.lat = +lat.toFixed(5); d.lon = +lon.toFixed(5); d.found = found || "";
  if (!d.marker) d.marker = L.marker([d.lat, d.lon], { icon: draftIcon(), draggable: true, zIndexOffset: 1000 }).addTo(placeMap)
    .on("dragend", (e) => { const q = e.target.getLatLng(); setDraft(q.lat, q.lng, ""); });
  else d.marker.setLatLng([d.lat, d.lon]);
  renderDraft();
  const inp = $("draftName"); if (!inp.value) inp.focus({ preventScroll: true });
}
function renderDraft() {
  const d = state.draft, box = $("placeDraft");
  box.hidden = !d;
  $("lmOpt").hidden = !state.places.length && !d;
  if (d) {
    $("draftMeta").textContent = [d.found, coordText(d.lat, d.lon), distText(d)].filter(Boolean).join(" · ");
    $("draftAdd").disabled = !$("draftName").value.trim();
  }
  drawPreview();
  if ($("sendMissing")) updateSend();
}
function dropDraft() {
  if (state.draft) { placeMap.removeLayer(state.draft.marker); state.draft = null; }
  $("draftName").value = ""; $("draftMax").hidden = true; renderDraft();
}
function commitDraft() {
  const d = state.draft, name = $("draftName").value.trim();
  if (!d || !name) return;
  addPlace(d.lat, d.lon, name, d.found);
  dropDraft();
}

const lmYes = () => document.querySelector("input[name=lmChoice]:checked").value === "yes";
/** Hinweis, sobald ein Name die Hoechstlaenge erreicht (das Feld nimmt dann nichts mehr an) */
function maxWarn(inp, el) {
  const full = inp.value.length >= CONFIG.PLACE_LABEL_MAX;
  el.hidden = !full; el.textContent = full ? t("max_chars", { n: CONFIG.PLACE_LABEL_MAX }) : "";
}

function addPlace(lat, lon, label, found) {
  if (state.places.length >= CONFIG.MAX_PLACES) { showError(t("max_places", { n: CONFIG.MAX_PLACES })); return; }
  lon = wrapLon(lon);
  const p = { id: ++placeSeq, label: (label || "").slice(0, CONFIG.PLACE_LABEL_MAX), lat: +lat.toFixed(5), lon: +lon.toFixed(5), found: found || "" };
  p.marker = L.marker([p.lat, p.lon], { icon: starIcon(), title: p.label }).addTo(placeMap);
  state.places.push(p);
  renderPlaces();
}

function renderPlaces() {
  const ol = $("placeList");
  ol.replaceChildren();
  for (const p of state.places) {
    const li = document.createElement("li"); li.dataset.id = p.id;
    const inp = document.createElement("input");
    inp.maxLength = CONFIG.PLACE_LABEL_MAX; inp.placeholder = t("place_name_ph"); inp.value = p.label;
    inp.required = true;
    inp.setAttribute("aria-label", t("place_aria", { n: CONFIG.PLACE_LABEL_MAX }));
    inp.addEventListener("input", () => { p.label = inp.value; inp.classList.remove("invalid"); drawPreview(); });
    const x = document.createElement("button"); x.type = "button"; x.className = "x"; x.textContent = "×"; x.title = "Remove";
    x.addEventListener("click", () => { placeMap.removeLayer(p.marker); state.places = state.places.filter((q) => q !== p); renderPlaces(); });
    const meta = document.createElement("div"); meta.className = "meta";
    meta.textContent = [p.found, coordText(p.lat, p.lon), distText(p)].filter(Boolean).join(" · ") + " · ";
    const rq = document.createElement("span"); rq.className = "req"; rq.textContent = t("name_req", { n: CONFIG.PLACE_LABEL_MAX }); meta.append(rq);
    rq.hidden = !!p.label.trim();                      // Pflichthinweis nur, solange der Name fehlt
    const mx = document.createElement("strong"); mx.className = "maxwarn"; meta.append(mx); maxWarn(inp, mx);
    inp.addEventListener("input", () => { rq.hidden = !!inp.value.trim(); maxWarn(inp, mx); });
    if (tooClose(p)) { const w = document.createElement("strong"); w.className = "near"; w.textContent = " " + t("too_close", { n: NEAR_KM }); meta.append(w); }
    li.append(inp, x, meta);
    ol.append(li);
  }
  $("lmOpt").hidden = !state.places.length && !state.draft;   // Auswahl nur, wenn es eigene Orte gibt
  nearCities();
  drawPreview();
  if ($("sendMissing")) updateSend();
}

// ------------------------------------------------------------------ Vorschau (d3-geo, vereinfachte Landflaechen)
// Skizze der Karte: Erde mittabstandstreu um die Mitte, Ringe, Richtungen, gewaehlte Staedte und Orte.
let pvLand = null;
const R_EARTH = 6371.0088, KM_PER_MI = 1.609344;
const PV = { ocean: "#1d5c9e", land: "#d9cfae", ring: "rgba(255,255,255,.75)", ray: "rgba(255,255,255,.35)",
             ink: "#182434", bg: "#fbf9f4", draft: "#f0a040", head: '"Federo SZ", Georgia, serif', body: '"Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif' };
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function pvText(g, text, x, y, font, color, { align = "center", base = "middle", spacing = 0, shadow = 0 } = {}) {
  g.save(); g.font = font; g.fillStyle = color; g.textAlign = align; g.textBaseline = base;
  if ("letterSpacing" in g) g.letterSpacing = spacing + "px";
  if (shadow) { g.shadowColor = "rgba(0,0,0,.85)"; g.shadowBlur = shadow; }
  g.fillText(text, x, y); g.restore();
}

const PV_DEFAULT = { mode: "city", name: "Berlin", country: "DE", lat: 52.52437, lon: 13.41053 };   // nur Vorschau
const PV_MS = 3000;                                    // Dauer der Verwandlung nach neuer Mitte
const pvAnim = { view: null, from: null, to: null, t0: 0, raf: 0 };
const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** Vorschau neu zeichnen; bei neuer Mitte gleitet die Ansicht in 3 s ueber die Kugel dorthin */
function drawPreview() {
  if (!window.d3 || !d3.geoInterpolate) return;
  const c = state.centre || PV_DEFAULT;
  $("pvNote").hidden = !!state.centre;
  const target = [c.lon, c.lat];
  if (!pvAnim.view) pvAnim.view = target;
  const moved = !pvAnim.to || pvAnim.to[0] !== target[0] || pvAnim.to[1] !== target[1];
  if (moved && pvAnim.to) {                            // von der aktuell gezeigten Ansicht aus starten
    pvAnim.from = pvAnim.view; pvAnim.to = target; pvAnim.t0 = performance.now();
    const interp = d3.geoInterpolate(pvAnim.from, pvAnim.to);
    cancelAnimationFrame(pvAnim.raf);
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = (now) => {
      const t = reduce ? 1 : Math.min(1, (now - pvAnim.t0) / PV_MS);
      pvAnim.view = t < 1 ? interp(easeInOut(t)) : pvAnim.to;
      pvRender(pvAnim.view, state.centre || PV_DEFAULT);
      if (t < 1) pvAnim.raf = requestAnimationFrame(step);
    };
    pvAnim.raf = requestAnimationFrame(step);
    return;
  }
  pvAnim.to = target;
  if (performance.now() - pvAnim.t0 >= PV_MS) pvAnim.view = target;
  pvRender(pvAnim.view, c);                            // waehrend der Animation zeichnet der naechste Frame ohnehin neu
}

function pvRender(view, c) {
  const cv = $("preview");
  if (!cv || !window.d3 || !d3.geoAzimuthalEquidistant || !window.topojson || !window.LAND_TOPO) return;
  const css = cv.clientWidth || 560, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(css * dpr), H = Math.round(css * 1.12 * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext("2d"), u = W / 560;
  const Rm = 0.40 * W, cx = W / 2, cy = 0.13 * W + Rm, band = 0.045 * W;
  g.fillStyle = PV.bg; g.fillRect(0, 0, W, H);
  pvText(g, upper(HEADLINE[lang()] || HEADLINE.en), cx, 0.05 * W, `${15 * u}px ${PV.head}`, PV.ink, { spacing: 4 * u });
  // Ringband mit Himmelsrichtungen
  g.strokeStyle = PV.ink; g.lineWidth = 1 * u;
  g.beginPath(); g.arc(cx, cy, Rm + band, 0, 2 * Math.PI); g.stroke();
  (COMPASS_NAMES[lang()] || COMPASS).forEach((t, i) => {
    const a = i * Math.PI / 4;
    pvText(g, t, cx + Math.sin(a) * (Rm + band / 2), cy - Math.cos(a) * (Rm + band / 2), `${10 * u}px ${PV.head}`, PV.ink);
  });
  const proj = d3.geoAzimuthalEquidistant().rotate([-view[0], -view[1]]).scale(Rm / Math.PI)
    .translate([cx, cy]).clipAngle(180 - 1e-4).precision(0.4);
  const path = d3.geoPath(proj, g);
  g.save();
  g.beginPath(); g.arc(cx, cy, Rm, 0, 2 * Math.PI); g.clip();
  g.fillStyle = PV.ocean; g.fillRect(cx - Rm, cy - Rm, 2 * Rm, 2 * Rm);
  pvLand = pvLand || topojson.feature(LAND_TOPO, LAND_TOPO.objects.land);
  g.beginPath(); path(pvLand); g.fillStyle = PV.land; g.fill();
  // Richtungen und Entfernungsringe (exakt: Abstand im Bild = Entfernung auf der Erde)
  g.strokeStyle = PV.ray; g.lineWidth = 1 * u; g.setLineDash([4 * u, 3 * u]);        // gestrichelt wie auf dem Poster
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(a) * Rm, cy - Math.cos(a) * Rm); g.stroke(); }
  const mi = document.querySelector("input[name=unit]:checked").value === "mi";
  const rings = mi ? [1000, 5000, 10000] : [1000, 5000, 10000, 15000];
  g.setLineDash([]); g.strokeStyle = PV.ring; g.lineWidth = 1.2 * u;
  for (const v of rings) {
    const r = v * (mi ? KM_PER_MI : 1) / (Math.PI * R_EARTH) * Rm;
    g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.stroke();
    if (v >= 5000) pvText(g, `${new Intl.NumberFormat(lang() + "-u-nu-latn").format(v)} ${mi ? "mi" : "km"}`, cx, cy - r, `600 ${9 * u}px ${PV.body}`, "#fff", { shadow: 3 * u });
  }
  g.setLineDash([]);
  g.restore();
  g.strokeStyle = "rgba(24,36,52,.5)"; g.lineWidth = 1 * u; g.beginPath(); g.arc(cx, cy, Rm, 0, 2 * Math.PI); g.stroke();
  // gewaehlte Staedte (Punkt) und besondere Orte (Stern)
  const pts = [];
  for (const i of $("cities").tomselect ? $("cities").tomselect.getValue() : []) {
    const k = state.cities[+i]; if (k) pts.push({ lat: k[2], lon: k[3], label: cityName(+i), star: false });
  }
  for (const p of state.places) pts.push({ lat: p.lat, lon: p.lon, label: p.label.trim() || t("special_place"), star: true });
  if (state.draft) pts.push({ lat: state.draft.lat, lon: state.draft.lon, label: $("draftName").value.trim() || t("special_place"), star: true, draft: true });
  for (const p of pts) {
    const xy = proj([p.lon, p.lat]); if (!xy) continue;
    const [x, y] = xy;
    if (p.star) pvText(g, "★", x, y, `${(p.draft ? 19 : 15) * u}px ${PV.body}`, p.draft ? PV.draft : "#fff", { shadow: 3 * u });
    else { g.fillStyle = "#fff"; g.strokeStyle = PV.ink; g.lineWidth = 1 * u; g.beginPath(); g.arc(x, y, 2.6 * u, 0, 2 * Math.PI); g.fill(); g.stroke(); }
    const left = x > cx + Rm * 0.55;                     // am rechten Rand Beschriftung nach links
    pvText(g, p.label, x + (left ? -7 : 7) * u, y, `600 ${11 * u}px ${PV.body}`, "#fff", { align: left ? "right" : "left", shadow: 3 * u });
  }
  // Mittelpunkt: Pluszeichen wie auf dem Poster
  const L_ = 8 * u, w = 2.2 * u;
  for (const [col, e] of [[PV.ink, 1.2 * u], ["#fff", 0]]) {
    g.fillStyle = col; g.fillRect(cx - L_ - e, cy - w / 2 - e, 2 * (L_ + e), w + 2 * e); g.fillRect(cx - w / 2 - e, cy - L_ - e, w + 2 * e, 2 * (L_ + e));
  }
  const title = upper($("title").value.trim() || (c.mode === "city" ? (c.i !== undefined ? cityName(c.i) : c.name) : ""));
  if (title) pvText(g, title, cx, cy + Rm + band + 0.055 * W, `${26 * u}px ${PV.head}`, PV.ink, { spacing: 6 * u });
  // kleine Kopie neben der Mitte (nur schmale Bildschirme, dort liegt die Vorschau hinter einem Knopf)
  const mini = $("centreMiniCanvas");
  if (mini && mini.offsetParent) {
    const mg = mini.getContext("2d"); mg.clearRect(0, 0, mini.width, mini.height);
    mg.drawImage(cv, 0, 0, mini.width, mini.height);
  }
}

/** Hinweis unter den Wunschstaedten, wenn eine zu nah an der Mitte liegt */
function nearCities() {
  const box = $("citiesNear"); if (!box || !$("cities").tomselect) return;
  const near = $("cities").tomselect.getValue().map((i) => +i)
    .filter((i) => tooClose({ lat: state.cities[i][2], lon: state.cities[i][3] })).map((i) => cityName(i));
  box.hidden = !near.length;
  box.textContent = near.length ? t("near_cities", { names: near.join(", "), n: NEAR_KM }) : "";
}

// ------------------------------------------------------------------ Sprache der Seite umschalten
/** alle Texte der Seite in UI setzen und die erzeugten Teile neu zeichnen */
function applyUI() {
  document.documentElement.lang = UI;
  document.title = t("page_title");
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.innerHTML = t(el.dataset.i18n); });   // eigene feste Texte
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
  document.querySelectorAll("[data-i18n-alt]").forEach((el) => { el.alt = t(el.dataset.i18nAlt); });
  document.querySelectorAll("[data-i18n-src]").forEach((el) => { el.src = t(el.dataset.i18nSrc); });
  pinInfo(); renderDraft();
  document.querySelectorAll(".uilang button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ui === UI)));
  for (const [id, key] of [["centreSelect", "city_ph"], ["cities", "cities_ph"]]) {
    const ts = $(id).tomselect; if (!ts) continue;
    ts.settings.placeholder = t(key); ts.control_input.setAttribute("placeholder", t(key));
    ts.clearCache(); ts.refreshItems(); if (ts.isOpen) ts.refreshOptions(false);
  }
  if (state.sending) $("send").textContent = t("sending");
  updateTitleRequirement(); centreCheck(state.centre); renderPlaces(); botStrings(); updateSend();
}
function setUI(l, { fromUser = false } = {}) {
  UI = UI_LANGS.includes(l) ? l : "en";
  if (fromUser) try { localStorage.setItem("ui", UI); } catch {}
  // Kartensprache folgt der Seitensprache, solange sie nicht selbst gewaehlt wurde
  if (!state.langTouched && $("lang").value !== UI) { $("lang").value = UI; $("lang").dispatchEvent(new Event("change")); }
  applyUI();
}
function initialUI() {
  const q = new URLSearchParams(location.search).get("ui");
  let saved = null; try { saved = localStorage.getItem("ui"); } catch {}
  const nav = (navigator.languages || [navigator.language || "en"]).map((x) => String(x).slice(0, 2).toLowerCase());
  return [q, saved, ...nav].find((x) => UI_LANGS.includes(x)) || "en";
}

// ------------------------------------------------------------------ Bot-Schutz (ALTCHA, laeuft ueber die eigene Funktion)
let altchaEl = null;
function initBotCheck() {
  if (!CONFIG.FUNCTION_URL) return;                    // Testbetrieb: kein Bot-Schutz
  const box = $("botcheck"); box.hidden = false;
  altchaEl = document.createElement("altcha-widget");
  altchaEl.setAttribute("challengeurl", CONFIG.FUNCTION_URL);   // GET auf die Funktion liefert die Aufgabe
  altchaEl.setAttribute("workerurl", new URL("vendor/altcha/worker.js", location.href).href);   // muss absolut sein
  altchaEl.setAttribute("hidelogo", ""); altchaEl.setAttribute("hidefooter", "");
  altchaEl.setAttribute("auto", "onload");             // rechnet sofort im Hintergrund, kein Klick noetig
  botStrings();
  altchaEl.addEventListener("statechange", (e) => {
    const d = e.detail || {};
    state.altcha = d.state === "verified" && d.payload ? d.payload : "";
    updateSend();
  });
  box.append(altchaEl);
}
function botStrings() {
  if (!altchaEl) return;
  altchaEl.setAttribute("strings", JSON.stringify({ label: t("bot_label"), verifying: t("bot_verifying"), verified: t("bot_verified"),
    error: t("bot_error"), expired: t("bot_expired"), required: t("bot_required"), verify: t("bot_verify") }));
}
function resetBotCheck() {
  state.altcha = "";
  if (altchaEl && typeof altchaEl.reset === "function") { altchaEl.reset(); if (typeof altchaEl.verify === "function") altchaEl.verify(); }
}

// ------------------------------------------------------------------ Absenden
function showError(msg) { const e = $("error"); e.textContent = msg; e.hidden = !msg; if (msg) e.scrollIntoView({ block: "center", behavior: "smooth" }); }

/** Was noch fehlt (ohne Fehlermarkierung) - solange etwas fehlt, ist der Knopf ausgegraut */
function missing() {
  const m = [];
  if (!/^\d{6,12}$/.test($("orderNo").value.replace(/\s+/g, ""))) m.push(t("m_order"));
  if (!state.centre) m.push(t("m_centre"));
  if (!$("title").value.trim()) m.push(t("m_title"));
  if (state.places.some((p) => !p.label.trim())) m.push(t("m_place"));
  if (state.draft) m.push(t("m_draft"));
  if (!$("consent").checked) m.push(t("m_consent"));
  if (CONFIG.FUNCTION_URL && !state.altcha) m.push(t("m_security"));
  return m;
}
function updateSend() {
  if (state.sending) return;
  const m = missing();
  $("send").disabled = m.length > 0;
  $("sendMissing").hidden = !m.length;
  $("sendMissing").textContent = m.length ? t("missing", { list: m.join(", ") }) : "";
}

function collect() {
  const errs = [];
  document.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
  const orderNo = $("orderNo").value.replace(/\s+/g, "");
  if (!/^\d{6,12}$/.test(orderNo)) { errs.push(t("e_order")); $("orderNo").classList.add("invalid"); }
  if (!state.centre) { errs.push(centreMode() === "pin" ? t("e_pin") : t("e_city")); }
  const title = $("title").value.trim();
  if (!title) { errs.push(t("e_title")); $("title").classList.add("invalid"); }
  for (const p of state.places) {
    if (!p.label.trim()) {
      errs.push(t("e_place"));
      const el = document.querySelector(`#placeList li[data-id="${p.id}"] input`); if (el) el.classList.add("invalid");
      break;
    }
  }
  if (state.draft) errs.push(t("m_draft"));
  if (!$("consent").checked) errs.push(t("e_consent"));
  if (CONFIG.FUNCTION_URL && !state.altcha) errs.push(t("e_security"));
  const cities = $("cities").tomselect.getValue().map((i) => state.cities[+i]).filter(Boolean)
    .map((c) => ({ name: c[0], country: c[1], lat: c[2], lon: c[3] }));
  return {
    errs,
    data: {
      product: CONFIG.PRODUCT,
      orderNo,
      centre: state.centre,
      title,
      lang: lang(),
      unit: document.querySelector("input[name=unit]:checked").value,
      cities,
      places: state.places.map((p) => ({ label: p.label.trim(), lat: p.lat, lon: p.lon, found: p.found })),
      landmarks: state.places.length ? lmYes() : true,   // ohne eigene Orte immer automatisch ergaenzte Orte
      consent: true,
      altcha: state.altcha,
    },
  };
}

async function submit(e) {
  e.preventDefault();
  if (state.sending) return;
  const { errs, data } = collect();
  if (errs.length) { showError(errs[0]); return; }
  showError("");
  if (!CONFIG.FUNCTION_URL) {                            // Testbetrieb ohne Funktion
    console.log("Payload (test mode)", data);
    return finish("TEST-" + data.orderNo);
  }
  state.sending = true; $("send").disabled = true; $("send").textContent = t("sending");
  try {
    const res = await fetch(CONFIG.FUNCTION_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || t("e_send"));
    finish(out.ref);
  } catch (err) {
    showError(err.message || t("e_send"));
    resetBotCheck();
  } finally {
    state.sending = false; $("send").textContent = t("send"); updateSend();
  }
}

function finish(ref) {
  $("order").hidden = true; $("done").hidden = false; $("refId").textContent = ref;
  document.body.classList.add("sent");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ------------------------------------------------------------------ Start
async function init() {
  if (location.protocol === "file:") {                 // Kartenkacheln brauchen eine echte Adresse (OSM-Nutzungsregeln)
    const n = document.createElement("div"); n.className = "devnote";
    n.dataset.i18n = "local"; n.textContent = t("local");
    document.body.prepend(n);
  }
  const params = new URLSearchParams(location.search);
  const pre = (params.get("order") || "").replace(/\D/g, "").slice(0, 12);
  if (pre) $("orderNo").value = pre;
  $("orderNo").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/[^\d\s]/g, ""); });

  state.cities = window.CITIES || [];                // aus cities.js (geht auch beim Oeffnen als Datei)
  PV_DEFAULT.i = state.cities.findIndex((c) => c[0] === "Berlin" && c[1] === "DE");   // Beispiel der Vorschau
  if (PV_DEFAULT.i < 0) delete PV_DEFAULT.i;
  state.nameCount = new Map();                      // wie oft ein Name vorkommt (Warnung bei Mehrdeutigkeit)
  for (const c of state.cities) { const k = norm(c[0]); state.nameCount.set(k, (state.nameCount.get(k) || 0) + 1); }
  state.baseKeys = state.cities.map((c) => [norm(c[0]), c[5] ? c[5].split("|").map(norm) : []]);
  state.keys = state.baseKeys;
  // sname: Name in der Kartensprache, normalisiert - ohne Suchtext alphabetisch (sonst stuenden Millionenstaedte wie Chongqing oben)
  const opts = state.cities.map((c, i) => ({ value: String(i), text: c[0], pop: c[4], i, ord: 0 }));
  const where = (d) => { const c = state.cities[d.i]; return (c[6] ? c[6] + ", " : "") + regionName(c[1]); };
  // angezeigt wird der Name in der gewaehlten Sprache, klein dahinter der uebliche Name, falls anders
  const label = (d, esc) => { const n = cityName(d.i); return esc(n) + (n !== d.text ? `<span class="cc">${esc(d.text)}</span>` : ""); };
  const render = {
    option: (d, esc) => `<div>${label(d, esc)}<span class="cc">${esc(where(d))}</span></div>`,
    item: (d, esc) => `<div>${esc(cityName(d.i))}<span class="cc">${esc(where(d))}</span></div>`,
    no_results: (d, esc) => `<div class="no-results">${esc(t("no_city"))}</div>`,
  };
  // mit Suchtext: Rangfolge nach Treffer und Einwohnern; ohne Suchtext: erst Grossstaedte (ab 1 Mio.) alphabetisch
  const score = (search) => { const q = norm(search.trim()); return (o) => rank(q, state.keys[o.i][0], state.keys[o.i][1], o.pop); };
  const common = { options: opts, searchField: ["text"], maxOptions: 40, render, score, sortField: [{ field: "$score", direction: "desc" }, { field: "ord", direction: "asc" }] };
  centreTS = new TomSelect("#centreSelect", { ...common, maxItems: 1, allowEmptyOption: true,
    onChange: (v) => pickCity(v) });
  new TomSelect("#cities", { ...common, maxItems: CONFIG.MAX_CITIES, plugins: ["remove_button"],
    onItemAdd() { this.setTextboxValue(""); this.refreshOptions(false); },   // Suchtext nach der Auswahl leeren
    score: (search) => { const f = score(search); return (o) => hasName(o.i) ? f(o) : 0; },   // nur Orte mit Namen in der Kartensprache
    onChange: () => { nearCities(); drawPreview(); },
    render: { ...render,
    item: (d, esc) => `<div>${esc(cityName(d.i))}</div>` } });
  const citiesTS = $("cities").tomselect;

  // Sprache wechseln: Namen nachladen, Suche und Anzeige umstellen, Titel und Vorschau neu
  const onLang = async () => {
    const l = lang();
    await loadNames(l);
    const loc = (window.CITY_NAMES || {})[l] || [];
    const en = (window.CITY_NAMES || {}).en || [];
    state.keys = state.baseKeys.map(([k, alts], i) => {      // Hauptname = Name in der Sprache
      if (!loc[i] && !en[i]) return [k, alts];
      return [loc[i] ? norm(loc[i]) : k, alts.concat([k, en[i] && norm(en[i])].filter(Boolean))];
    });
    // gewaehlte Staedte ohne Namen in dieser Sprache fallen weg (sonst stuende ein fremder Name auf der Karte)
    const drop = citiesTS.getValue().filter((i) => !hasName(+i));
    drop.forEach((i) => citiesTS.removeItem(i, true));
    const box = $("citiesDropped");
    box.hidden = !drop.length;
    box.textContent = drop.length ? t("dropped", { names: drop.map((i) => state.cities[+i][0]).join(", "), lang: $("lang").selectedOptions[0].text }) : "";
    for (const ts of [centreTS, citiesTS]) {
      setOrder(ts);
      ts.clearCache(); ts.refreshItems();
    }
    if (state.centre) setCentre(state.centre); else drawPreview();
    updateTitleRequirement();
  };
  $("lang").addEventListener("change", (e) => { if (e.isTrusted) state.langTouched = true; onLang(); });
  document.querySelectorAll(".uilang button").forEach((b) => b.addEventListener("click", () => setUI(b.dataset.ui, { fromUser: true })));
  loadNames("en").then(onLang);

  document.querySelectorAll("input[name=centreMode]").forEach((r) => r.addEventListener("change", onCentreMode));
  document.querySelectorAll("input[name=unit]").forEach((r) => r.addEventListener("change", renderPlaces));
  $("title").addEventListener("input", () => { state.titleTouched = $("title").value.trim() !== ""; $("title").classList.remove("invalid"); drawPreview(); });
  window.addEventListener("resize", () => drawPreview());
  $("order").addEventListener("input", updateSend); $("order").addEventListener("change", updateSend);
  const panel = $("pvPanel");
  const pvShow = (on) => { panel.classList.toggle("open", on); document.body.classList.toggle("pv-open", on); if (on) { drawPreview(); $("pvClose").focus(); } };
  $("pvOpen").addEventListener("click", () => pvShow(true));
  $("pvClose").addEventListener("click", () => pvShow(false));
  panel.addEventListener("click", (e) => { if (e.target === panel) pvShow(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") pvShow(false); });
  if (document.fonts) document.fonts.load('20px "Federo SZ"').then(() => drawPreview()).catch(() => {});
  drawPreview();
  setUI(initialUI());

  placeMap = makeMap($("placeMap"));
  placeMap.on("click", (e) => setDraft(e.latlng.lat, e.latlng.lng, ""));
  wireSearch($("placeSearch"), $("placeSearchBtn"), $("placeResults"), (it) => {
    placeMap.setView([it.lat, it.lon], it.src === "city" ? 9 : 12);
    setDraft(it.lat, it.lon, [it.name, it.detail].filter(Boolean).join(", ").slice(0, 120));
  });
  $("draftName").addEventListener("input", () => { $("draftAdd").disabled = !$("draftName").value.trim(); drawPreview(); });
  $("draftName").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commitDraft(); } });
  $("draftAdd").addEventListener("click", commitDraft);
  $("draftDrop").addEventListener("click", dropDraft);
  $("draftName").addEventListener("input", () => maxWarn($("draftName"), $("draftMax")));
  $("centreMini").addEventListener("click", () => pvShow(true));
  // Suche fuer die Mitte, sobald die Karte dafuer existiert
  wireSearch($("pinSearch"), $("pinSearchBtn"), $("pinResults"), (it) => {
    pinMap.setView([it.lat, it.lon], 10); setPin(it.lat, it.lon, it.name);
  });

  $("order").addEventListener("submit", submit);
  updateTitleRequirement();

  initBotCheck();

}

document.addEventListener("DOMContentLoaded", () => init().catch((e) => showError(t("e_page") + " (" + e.message + ")")));
