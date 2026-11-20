// ═══════════════════════════════════════════════════════════════════════════════
// SCORE EDITOR — write a piece without touching JSON by hand, hear it, and
// download its folder (score.json + audio/) to put in a GitHub repo.
//
// The piece being edited lives in `doc`; every change recompiles it with the
// same score engine the conductor and phones use, so the timeline, the errors
// and the preview always match what the ensemble will play.
// ═══════════════════════════════════════════════════════════════════════════════

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_GROUPS = 8;
const TYPO_TIME = 600; // an event later than 10 minutes is probably a typo

// sounds:  [{ name, path, file, url }]  file = a File chosen here, url = where it
//          already is (a repo or this site); path = where it goes in the folder
// credit:  a credit line, shown on the conductor and the phones. Not on the
//          form: kept from an opened piece (the PTC scores need theirs)
// effects: { A: [effect, …] }           as in score.json, one list per group
// events:  [event, …]                   as in score.json
// effectEvents: [effect event, …]       as in score.json: { at, groups, set, to, glide }
let doc = blankDoc();
function blankDoc() { return { title: '', credit: '', groups: 2, end: '', sounds: [], effects: {}, events: [], effectEvents: [] }; }

const groupLetters = () => LETTERS.slice(0, doc.groups).split('');
const $ = id => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v !== undefined && v !== null && v !== false) e[k] = v;
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c);
  return e;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOC ⇄ score.json
// ═══════════════════════════════════════════════════════════════════════════════
// Drops empty fields so the JSON stays tidy
function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === '' || v === undefined || v === null || (typeof v === 'number' && !isFinite(v))) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? clean(v) : v;
  }
  return out;
}

// A sound's path inside the saved folder. Paths that point outside it (or
// whole URLs) are saved under audio/ instead.
function savedPath(path) {
  const p = normPath(path);
  return /^(\.\.\/|\/|[a-z]+:)/i.test(p) ? 'audio/' + p.split('/').pop() : p;
}

// The score as it is now. `forSaving` writes the paths the saved folder will use.
function toScore(forSaving = false) {
  const score = { title: doc.title.trim() || 'Untitled', groups: doc.groups, sounds: {} };
  if (doc.credit.trim()) score.credit = doc.credit.trim();
  for (const s of doc.sounds) if (s.name) score.sounds[s.name] = forSaving ? savedPath(s.path) : s.path;
  const effects = {};
  for (const g of groupLetters()) if ((doc.effects[g] || []).length) effects[g] = doc.effects[g].map(clean);
  if (Object.keys(effects).length) score.effects = effects;
  score.events = doc.events.map(e => {
    const out = clean(e);
    if (out.groups === 'all' || out.spread !== undefined) delete out.groups;
    return out;
  });
  if (doc.effectEvents.length) score.effectEvents = doc.effectEvents.map(e => {
    const out = clean(e);
    if (out.groups === 'all') delete out.groups;
    return out;
  });
  if (doc.end.trim()) score.end = doc.end.trim();
  return score;
}

// score.json (+ where its sounds are) → doc. `locate(path)` gives { file } or
// { url } for each sound path, or null if it can't be found. Sounds the events
// play by their path (no "sounds" list, like the scores in scores.js) are
// listed too, named by that path.
function fromScore(score, locate) {
  const d = blankDoc();
  d.title = score.title || '';
  d.credit = score.credit || '';
  d.groups = Math.max(1, Math.min(MAX_GROUPS,
    typeof score.groups === 'number' ? Math.floor(score.groups)
      : Array.isArray(score.groups) ? score.groups.length : 4));
  d.end = score.end !== undefined ? String(score.end) : '';
  const listed = score.sounds && typeof score.sounds === 'object' ? score.sounds : {};
  const played = (score.events || []).filter(e => e.play !== undefined).map(e => soundId(e.play));
  for (const name of new Set([...Object.keys(listed), ...played])) {
    if (!name) continue;
    const path = soundPath(name, score);
    d.sounds.push({ name, path, file: null, url: null, ...(locate(path) || {}) });
  }
  const letters = LETTERS.slice(0, d.groups);
  for (const [key, list] of Object.entries(score.effects || {})) {
    const gs = key === 'all' || key === '*' ? letters.split('') : key.split('');
    for (const g of gs) {
      if (!letters.includes(g) || !Array.isArray(list)) continue;
      d.effects[g] = [...(d.effects[g] || []), ...JSON.parse(JSON.stringify(list)).map(lfoUnderFrequency)];
    }
  }
  const withGroups = e => ({ ...e, at: String(e.at ?? '0:00'), groups: groupsString(e.groups) });
  // Effect changes have their own list; any left among the events (older
  // pieces) move there
  const events = Array.isArray(score.events) ? score.events : [];
  d.events = events.filter(e => e.set === undefined).map(withGroups);
  d.effectEvents = [...(Array.isArray(score.effectEvents) ? score.effectEvents : []), ...events.filter(e => e.set !== undefined)]
    .map(withGroups)
    // An LFO's rate was "id.rate"; it's now "id.frequency.rate"
    .map(e => ({ ...e, set: typeof e.set === 'string' ? e.set.replace(/^([^.]+)\.rate$/, '$1.frequency.rate') : e.set }));
  return d;
}

// Older pieces put a filter's "lfo" on the effect; it now goes under its
// frequency: { frequency: { lfo: { … } } }
function lfoUnderFrequency(fx) {
  if (!fx || !fx.lfo) return fx;
  const { lfo, ...rest } = fx;
  return hasLfo(rest) ? rest : { ...rest, frequency: { lfo } };
}

const groupsString = g => g === undefined || g === 'all' || g === '*' ? 'all' : Array.isArray(g) ? g.join('') : String(g);

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE: compile, timeline, errors, JSON
// ═══════════════════════════════════════════════════════════════════════════════
let comp = compileScore(toScore());

function changed() {
  const score = toScore();
  comp = compileScore(score);
  $('json').textContent = JSON.stringify(toScore(true), null, 2);

  const problems = [...comp.errors];
  const names = doc.sounds.map(s => s.name);
  for (const s of doc.sounds) {
    if (!s.name) problems.push(`a sound (${s.path}) has no name`);
    else if (names.indexOf(s.name) !== names.lastIndexOf(s.name)) problems.push(`two sounds are called "${s.name}"`);
    if (!s.file && !s.url) problems.push(`sound "${s.name}": no audio file chosen`);
  }
  doc.events.forEach((e, i) => {
    const t = parseTime(e.at);
    if (t > TYPO_TIME) problems.push(`event ${i + 1}: at ${fmtTime(t)}, is that a typo?`);
    for (const k of ['play', 'stop', 'sound']) {
      if (e[k] && e[k] !== 'all' && !names.includes(e[k])) problems.push(`event ${i + 1}: no sound called "${e[k]}"`);
    }
    if (e.play !== undefined && !e.play) problems.push(`event ${i + 1}: choose a sound to play`);
  });
  doc.effectEvents.forEach((e, i) => {
    const t = parseTime(e.at);
    if (t > TYPO_TIME) problems.push(`effect event ${i + 1}: at ${fmtTime(t)}, is that a typo?`);
  });
  $('errors').replaceChildren(...[...new Set(problems)].map(p => el('li', { textContent: p })));
}

function renderLoop() {
  const head = preview ? preview.st + (audioCtx.currentTime - preview.at) : (parseTime($('previewFrom').value) || 0);
  drawScoreTimeline($('timeline'), comp, { head, duration: n => soundDur.get(n) || null });
  if (preview) {
    const end = Math.max(comp.end, 0);
    $('previewStatus').textContent = head < preview.st ? 'STARTING…' : `${fmtTime(head)} / ${fmtTime(end)}`;
    if (end > 0 && head > end + 2) stopPreview();
  }
  requestAnimationFrame(renderLoop);
}
// ═══════════════════════════════════════════════════════════════════════════════
// FORM: piece, sounds, effects, events, effect events
// ═══════════════════════════════════════════════════════════════════════════════
function render() {
  $('title').value = doc.title;
  $('end').value = doc.end;
  $('groupCount').value = doc.groups;
  renderSounds();
  renderEffects();
  renderEvents();
  renderPreviewGroups();
  changed();
}

function numberInput(value, placeholder, onValue, attrs = {}) {
  return el('input', {
    type: 'number', step: 'any', value: value ?? '', placeholder: placeholder ?? '', ...attrs,
    oninput: e => { onValue(e.target.value === '' ? undefined : +e.target.value); changed(); },
  });
}

// A caption over an input. Only real inputs get a <label>: clicking a label
// presses the first button inside it, which would toggle a group by accident.
// An on/off button in the style of the group toggles (in place of a checkbox)
function toggle(text, on, onChange) {
  return el('button', { class: 'ed-toggle ed-switch' + (on ? ' on' : ''), textContent: text, type: 'button',
    onclick: () => onChange(!on) });
}

function field(label, input) {
  const tag = ['INPUT', 'SELECT', 'TEXTAREA'].includes(input.tagName) ? 'label' : 'div';
  return el(tag, { class: 'ed-field' }, el('span', { class: 'cn', textContent: label }), input);
}

// ── Sounds ────────────────────────────────────────────────────────────────────
const soundNames = () => doc.sounds.map(s => s.name).filter(Boolean);

function soundNameFor(fileName) {
  let base = fileName.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'sound';
  let name = base, n = 2;
  while (doc.sounds.some(s => s.name === name)) name = `${base}-${n++}`;
  return name;
}

function addSoundFiles(files) {
  for (const file of files) {
    const path = 'audio/' + file.name;
    const same = doc.sounds.find(s => s.path === path);
    if (same) { same.file = file; same.url = null; continue; } // a new version of that file
    doc.sounds.push({ name: soundNameFor(file.name), path, file, url: null });
  }
  render();
}

// Renaming a sound renames it in the events too
function renameSound(s, name) {
  const old = s.name;
  s.name = name;
  for (const e of doc.events) for (const k of ['play', 'stop', 'sound']) if (e[k] === old) e[k] = name;
}

function renderSounds() {
  $('sounds').replaceChildren(...doc.sounds.map(s => {
    const where = s.file ? `${s.path} · chosen here` : s.url ? `${s.path} · in the piece's folder` : `${s.path} · missing: choose a file`;
    // The name box fits its name (within limits), so long names stay readable
    const fit = input => { input.style.width = `calc(${Math.min(Math.max(input.value.length, 6), 28)}ch + 0.9rem)`; };
    // One compact line per sound: its name (editable), its file, replace, remove
    const name = el('input', { type: 'text', value: s.name, class: 'ed-sound-name', title: 'Name, used by the events', placeholder: 'name',
      oninput: e => { fit(e.target); renameSound(s, e.target.value.trim()); renderEvents(); changed(); } });
    fit(name);
    return el('div', { class: 'ed-sound' },
      name,
      el('span', { class: 'ed-sound-path' + (s.file || s.url ? '' : ' ed-bad'), title: where,
        textContent: s.file || s.url ? s.path : `${s.path} · missing` }),
      el('label', { class: 'ed-mini', textContent: 'Replace…', title: 'Choose another file for this sound' },
        el('input', { type: 'file', accept: 'audio/*,.aif,.aiff', hidden: true,
          onchange: e => { const f = e.target.files[0]; if (f) { s.file = f; s.url = null; s.path = 'audio/' + f.name; render(); } } })),
      el('button', { class: 'ed-mini', textContent: '×', title: 'Remove this sound', type: 'button',
        onclick: () => { doc.sounds.splice(doc.sounds.indexOf(s), 1); render(); } }));
  }));
}

// ── Effects ───────────────────────────────────────────────────────────────────
function renderEffects() {
  $('effects').replaceChildren(...groupLetters().map(g => {
    const list = doc.effects[g] = doc.effects[g] || [];
    return el('div', { class: 'ed-group' },
      el('div', { class: 'ed-group-hd' },
        el('span', { class: 'ed-letter', textContent: g, style: `color:${groupColor(g, groupLetters())}` }),
        el('span', { class: 'hint', textContent: list.length ? '' : 'no effects' })),
      ...list.map((fx, i) => effectRow(g, list, fx, i)),
      el('div', { class: 'ed-row' },
        el('button', { class: 'btn btn-reset ed-btn', textContent: '+ Add effect',
          onclick: () => { list.push({ type: 'lowpass' }); render(); } }),
        list.length && doc.groups > 1 ? el('button', { class: 'btn btn-reset ed-btn', textContent: `Copy to every group`,
          onclick: () => { for (const h of groupLetters()) if (h !== g) doc.effects[h] = JSON.parse(JSON.stringify(list)); render(); } }) : null));
  }));
}

function effectRow(g, list, fx, i) {
  const def = EFFECT_TYPES[fx.type] || EFFECT_TYPES.lowpass;
  const settingFields = (defs, obj, prefix = '', labels = {}) => Object.entries(defs).map(([k, [d, min, max]]) =>
    field(labels[k] ?? prefix + k, numberInput(obj[k], d, v => { obj[k] = v; }, { min, max })));
  const fields = [];
  if (def === FILTER) {
    // The frequency is a number, or swept by an LFO: { frequency: { lfo: { … } } }
    const lfo = hasLfo(fx);
    fields.push(field('Frequency', toggle(lfo ? 'LFO' : 'fixed', lfo,
      on => { if (on) fx.frequency = { lfo: {} }; else delete fx.frequency; render(); })));
    if (lfo) fields.push(...settingFields(FILTER.lfo, fx.frequency.lfo, 'LFO '));
    else fields.push(...settingFields({ frequency: FILTER.settings.frequency }, fx, '', { frequency: 'Hz' }));
    fields.push(...settingFields({ q: FILTER.settings.q }, fx));
  } else {
    fields.push(...settingFields(def.settings, fx), ...settingFields(def.fixed || {}, fx));
  }
  return el('div', { class: 'ed-effect' },
    el('span', { class: 'ed-num', textContent: i + 1 }),
    field('Type', el('select', { class: 'score-sel',
      onchange: e => { list[i] = { type: e.target.value, ...(fx.id ? { id: fx.id } : {}) }; render(); } },
      ...Object.keys(EFFECT_TYPES).map(t => el('option', { value: t, textContent: t, selected: t === fx.type })))),
    field('ID (optional)', el('input', { type: 'text', value: fx.id || '', placeholder: fx.type, class: 'ed-id',
      oninput: e => { fx.id = e.target.value.trim() || undefined; renderEvents(); changed(); } })),
    ...fields,
    el('button', { class: 'btn btn-reset ed-btn', textContent: 'Remove',
      onclick: () => { list.splice(i, 1); render(); } }));
}

// A filter whose frequency is swept by an LFO
const hasLfo = fx => !!(fx && fx.frequency && typeof fx.frequency === 'object');

// The settings an effect change can move on `fx`: an LFO's rate stands in
// for the frequency it sweeps ("frequency.rate")
function effectSettings(fx) {
  return Object.keys(EFFECT_TYPES[fx.type].settings).map(k => (k === 'frequency' && hasLfo(fx) ? 'frequency.rate' : k));
}

// A setting's [default, min, max] on `fx`
function settingRange(fx, s) {
  const def = EFFECT_TYPES[fx.type];
  return s === 'frequency.rate' ? def.lfo.rate : def.settings[s];
}
const SETTING_LABEL = { frequency: 'frequency (Hz)', 'frequency.rate': 'LFO rate (Hz)', time: 'time (s)' };

// The effects in groups `gs`, one per id: [{ id, type, groups, settings, all }]
// (`all`: that effect in each of those groups)
function effectsIn(gs) {
  const byId = new Map();
  for (const g of gs) for (const fx of doc.effects[g] || []) {
    if (!EFFECT_TYPES[fx.type]) continue;
    const id = fx.id || fx.type;
    if (!byId.has(id)) byId.set(id, { id, type: fx.type, groups: [], settings: [], all: [] });
    const x = byId.get(id);
    x.groups.push(g);
    x.all.push(fx);
    for (const s of effectSettings(fx)) if (!x.settings.includes(s)) x.settings.push(s);
  }
  return [...byId.values()];
}

// ── Events ────────────────────────────────────────────────────────────────────
// Each action: its own fields, as [key, kind, label]
const ACTIONS = {
  play:   { fields: [['play', 'sound', 'Sound'], ['ratio', 'num', 'Ratio'], ['fade', 'num', 'Fade in'], ['level', 'num', 'Level'],
                     ['loop', 'once', 'Play once'], ['fadeOut', 'oneShotNum', 'Fade out end']], start: { fade: 2 } },
  stop:   { fields: [['stop', 'soundAll', 'Sound'], ['fade', 'num', 'Fade out']], start: { stop: 'all', fade: 5 } },
  ratio:  { fields: [['ratio', 'num', 'Ratio'], ['glide', 'num', 'Glide'], ['sound', 'soundOpt', 'Only sound']], start: { ratio: 1.01 } },
  spread: { fields: [['spread', 'num', 'Spread'], ['glide', 'num', 'Glide']], start: { spread: 1.005 }, allGroups: true },
  level:  { fields: [['level', 'num', 'Level'], ['fade', 'num', 'Fade'], ['sound', 'soundOpt', 'Only sound']], start: { level: 0.5, fade: 2 } },
};
const FIELD_HINT = { ratio: '1 = none', fade: 's', glide: 's', level: '0–1', spread: '1 = none', to: '', fadeOut: 's' };

// Which action an event is (same precedence as compileScore)
function actionOf(e) {
  if (e.spread !== undefined) return 'spread';
  if (e.play !== undefined) return 'play';
  if (e.stop !== undefined) return 'stop';
  if (e.ratio !== undefined) return 'ratio';
  if (e.level !== undefined) return 'level';
  return 'play';
}

function addEvent() {
  const last = doc.events[doc.events.length - 1];
  doc.events.push({ at: last ? last.at : '0:00', groups: 'all', play: soundNames()[0] ?? '', ...ACTIONS.play.start });
  renderEvents();
  changed();
}

function addEffectEvent() {
  const last = doc.effectEvents[doc.effectEvents.length - 1];
  // "set" is filled in with the first effect, once the groups have one
  doc.effectEvents.push({ at: last ? last.at : '0:00', groups: 'all', set: '' });
  renderEvents();
  changed();
}

// Stable, like the engine
const byTime = list => list.map((e, i) => ({ e, i, t: parseTime(e.at) }))
  .sort((a, b) => (a.t - b.t) || (a.i - b.i)).map(x => x.e);

function sortEvents() {
  doc.events = byTime(doc.events);
  renderEvents();
  changed();
}

function sortEffectEvents() {
  doc.effectEvents = byTime(doc.effectEvents);
  renderEvents();
  changed();
}

function groupToggles(e, onChange) {
  const letters = groupLetters();
  const current = () => (e.groups === 'all' ? letters : e.groups.split(''));
  const on = current();
  const set = list => { e.groups = !list.length || list.length === letters.length ? 'all' : letters.filter(g => list.includes(g)).join(''); onChange(); };
  return el('span', { class: 'ed-letters' },
    ...letters.map(g => el('button', {
      class: 'ed-toggle' + (on.includes(g) ? ' on' : ''), textContent: g, type: 'button',
      style: on.includes(g) ? `background:${groupColor(g, letters)};border-color:${groupColor(g, letters)}` : '',
      onclick: () => { const now = current(); set(now.includes(g) ? now.filter(x => x !== g) : [...now, g]); },
    })),
    el('button', { class: 'ed-toggle' + (e.groups === 'all' ? ' on' : ''), textContent: 'all', type: 'button', onclick: () => set([]) }));
}

// `own`: the event's own action key, which stays present (as "") so the
// event keeps its action
function eventField(e, [key, kind, label], own = key === actionOf(e)) {
  const select = (options, blank) => el('select', { class: 'score-sel',
    onchange: ev => { e[key] = ev.target.value === '' ? (own ? '' : undefined) : ev.target.value; changed(); } },
    ...(blank !== undefined ? [el('option', { value: '', textContent: blank })] : []),
    ...options.map(o => el('option', { value: o, textContent: o, selected: String(e[key]) === o })));
  if (kind === 'num') return field(label, numberInput(e[key], FIELD_HINT[key], v => { e[key] = v; }));
  // "loop": false plays the file once; looping is the default, so it's left out then
  if (kind === 'once') return field(label, toggle(e.loop === false ? 'yes' : 'no', e.loop === false,
    on => { if (on) e.loop = false; else { delete e.loop; delete e.fadeOut; } renderEvents(); changed(); }));
  if (kind === 'oneShotNum') return e.loop === false ? field(label, numberInput(e[key], FIELD_HINT[key], v => { e[key] = v; })) : null;
  if (kind === 'sound') return field(label, select(soundNames(), soundNames().length ? undefined : '(add a sound first)'));
  if (kind === 'soundAll') return field(label, select(['all', ...soundNames()]));
  if (kind === 'soundOpt') return field(label, select(soundNames(), 'every sound'));
}

// One effect change: pick an effect in its groups, then one of its settings
function effectEventRow(e, i) {
  const gs = e.groups === 'all' ? groupLetters() : e.groups.split('');
  const fxs = effectsIn(gs);
  if (!e.set && fxs.length) e.set = `${fxs[0].id}.${fxs[0].settings[0]}`;
  const [id, ...rest] = String(e.set || '').split('.');
  const setting = rest.join('.');
  const cur = fxs.find(x => x.id === id);
  const head = [
    el('span', { class: 'ed-num', textContent: i + 1 }),
    field('At', el('input', { type: 'text', value: e.at, class: 'from-ctrl', placeholder: 'm:ss',
      oninput: ev => { e.at = ev.target.value.trim(); changed(); } })),
    field('Groups', groupToggles(e, () => { renderEvents(); changed(); })),
  ];
  const redo = () => { renderEvents(); changed(); };

  // No effects to change yet: say where they're added
  if (!fxs.length) return el('div', { class: 'ed-event' }, ...head,
    el('span', { class: 'hint ed-empty' },
      (gs.length === groupLetters().length ? 'No group has effects yet. ' : `${gs.join(', ')} ${gs.length > 1 ? 'have' : 'has'} no effects yet. `),
      el('button', { class: 'ed-mini', type: 'button', textContent: 'Add one under Effect chains ↑',
        onclick: () => $('effectsSec').scrollIntoView({ behavior: 'smooth', block: 'start' }) })),
    rowActions(doc.effectEvents, i));

  // A choice no longer there (renamed, removed, other groups) stays visible; it shows as an error
  const opt = (value, text, selected) => el('option', { value, textContent: text, selected });
  const fxLabel = x => `${x.id}${x.id !== x.type ? ` · ${x.type}` : ''} (${x.groups.join(', ')})`;
  const effectSel = el('select', { class: 'score-sel', onchange: ev => {
      const x = fxs.find(f => f.id === ev.target.value);
      e.set = `${x.id}.${x.settings.includes(setting) ? setting : x.settings[0]}`;
      redo();
    } },
    ...(cur ? [] : [opt(id, `${id || '?'} (not in these groups)`, true)]),
    ...fxs.map(x => opt(x.id, fxLabel(x), x === cur)));
  const settings = cur ? [...cur.settings] : [];
  if (setting && !settings.includes(setting)) settings.unshift(setting);
  const settingSel = el('select', { class: 'score-sel', onchange: ev => { e.set = `${id}.${ev.target.value}`; redo(); } },
    ...settings.map(s => opt(s, (SETTING_LABEL[s] ?? s) + (cur && cur.settings.includes(s) ? '' : ' (not here)'), s === setting)));

  // The setting's range, and its value just before this change (from the
  // first group that has it)
  const g = cur && cur.groups.find((_, n) => effectSettings(cur.all[n]).includes(setting));
  const range = g ? settingRange(cur.all[cur.groups.indexOf(g)], setting) : null;
  const before = g ? valueBefore(g, id, setting, parseTime(e.at)) : null;
  const toLabel = before === null ? 'To' : `To · from ${+before.toFixed(2)}`;
  return el('div', { class: 'ed-event' }, ...head,
    field('Effect', effectSel),
    field('Setting', settingSel),
    field(toLabel, numberInput(e.to, range ? `${range[1]}–${range[2]}` : '', v => { e.to = v; },
      range ? { min: range[1], max: range[2], title: `${range[1]}–${range[2]}` } : {})),
    field('Glide', numberInput(e.glide, 's', v => { e.glide = v; })),
    rowActions(doc.effectEvents, i));
}

// What a setting is just before `t`, with the changes before it applied
function valueBefore(g, id, setting, t) {
  const fx = ((comp.effects || {})[g] || []).find(x => x.id === id);
  const curve = fx && fx.curves[setting === 'frequency.rate' ? 'rate' : setting];
  return curve && isFinite(t) ? valueAt(curve, t - 1e-6) : null; // before the first point: the chain's own value
}

// Copy and Remove for a row of `list`, at the right end of the row
function rowActions(list, i) {
  return el('span', { class: 'ed-actions' },
    el('button', { class: 'btn btn-reset ed-btn', textContent: 'Copy', title: 'Duplicate this row',
      onclick: () => { list.splice(i + 1, 0, JSON.parse(JSON.stringify(list[i]))); renderEvents(); changed(); } }),
    el('button', { class: 'btn btn-reset ed-btn', textContent: 'Remove',
      onclick: () => { list.splice(i, 1); renderEvents(); changed(); } }));
}

// Renders both lists: the events and the effect events
function renderEvents() {
  comp = compileScore(toScore()); // the effect changes show values from it
  $('effectEvents').replaceChildren(...doc.effectEvents.map(effectEventRow));

  $('events').replaceChildren(...doc.events.map((e, i) => {
    const action = actionOf(e);
    const spec = ACTIONS[action];
    return el('div', { class: 'ed-event' },
      el('span', { class: 'ed-num', textContent: i + 1 }),
      field('At', el('input', { type: 'text', value: e.at, class: 'from-ctrl', placeholder: 'm:ss',
        oninput: ev => { e.at = ev.target.value.trim(); changed(); } })),
      spec.allGroups ? field('Groups', el('span', { class: 'hint', textContent: 'whole piece' }))
        : field('Groups', groupToggles(e, () => { renderEvents(); changed(); })),
      field('Action', el('select', { class: 'score-sel',
        onchange: ev => {
          const next = ev.target.value;
          doc.events[i] = { at: e.at, groups: e.groups, ...ACTIONS[next].start };
          if (next === 'play') doc.events[i].play = soundNames()[0] ?? '';
          renderEvents(); changed();
        } }, ...Object.keys(ACTIONS).map(a => el('option', { value: a, textContent: a, selected: a === action })))),
      ...spec.fields.map(f => eventField(e, f)),
      rowActions(doc.events, i));
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREVIEW — plays the ticked groups here, `phones per group` phones each,
// built by the same code as a phone (playback.js + effects.js)
// ═══════════════════════════════════════════════════════════════════════════════
let audioCtx = null, preview = null;
let previewOn = new Set(); // groups ticked to hear (empty = not chosen yet: all)
const decodedSounds = new Map(); // File or URL → Promise<AudioBuffer>
const soundDur = new Map();      // sound name → seconds, once decoded

function renderPreviewGroups() {
  const letters = groupLetters();
  if (!previewOn.size) previewOn = new Set(letters);
  $('previewGroups').replaceChildren(...letters.map(g => el('button', {
    class: 'ed-toggle' + (previewOn.has(g) ? ' on' : ''), textContent: g, type: 'button',
    style: previewOn.has(g) ? `background:${groupColor(g, letters)};border-color:${groupColor(g, letters)}` : '',
    onclick: () => { previewOn.has(g) ? previewOn.delete(g) : previewOn.add(g); if (!previewOn.size) previewOn.add(g); renderPreviewGroups(); },
  })));
}

function decodeSound(s) {
  const key = s.file || s.url;
  if (!key) return Promise.reject(new Error('no audio file chosen'));
  if (!decodedSounds.has(key)) {
    const bytes = s.file ? s.file.arrayBuffer()
      : fetch(s.url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
    const p = bytes.then(d => audioCtx.decodeAudioData(d));
    p.catch(() => decodedSounds.delete(key)); // let the next Preview retry
    decodedSounds.set(key, p);
  }
  return decodedSounds.get(key);
}

function previewToggle() { preview ? stopPreview() : startPreview(); }

async function startPreview() {
  const score = toScore();
  const pcomp = compileScore(score);
  const groups = pcomp.groups.filter(g => previewOn.has(g));
  const phones = Math.max(1, Math.min(8, Math.floor(+$('previewPhones').value) || 1));
  const st = parseTime($('previewFrom').value || '0');
  if (!isFinite(st) || st < 0) { $('previewStatus').textContent = 'START TIME SHOULD LOOK LIKE 1:30'; return; }

  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();

  // Decode the sounds those groups use
  $('previewStatus').textContent = 'LOADING SOUNDS…';
  $('previewPlay').disabled = true;
  const buffers = {}, failed = [];
  const used = [...new Set(pcomp.layers.filter(L => groups.includes(L.group)).map(L => L.sound))];
  await Promise.all(used.map(async name => {
    const s = doc.sounds.find(x => x.name === name);
    try { buffers[name] = await decodeSound(s || {}); soundDur.set(name, buffers[name].duration); }
    catch (e) { failed.push(`${name} (${e.message})`); }
  }));
  $('previewPlay').disabled = false;

  // Many phones on one speaker add up: scale down, and catch the peaks
  const master = audioCtx.createGain();
  master.gain.value = 1 / Math.sqrt(Math.max(1, groups.length * phones));
  const limiter = audioCtx.createDynamicsCompressor();
  master.connect(limiter).connect(audioCtx.destination);

  const at = audioCtx.currentTime + 0.1;
  const chains = [], nodes = [];
  for (const g of groups) {
    for (let rank = 1; rank <= phones; rank++) {
      const chain = buildChain(audioCtx, pcomp.effects[g], master);
      scheduleChain(chain, st, at, t => at + (t - st));
      chains.push(chain);
      nodes.push(...scheduleLayers(audioCtx, pcomp, {
        group: g, rank, st, at, smooth: false, fade: 0.005, overrides: [],
        bufferFor: L => buffers[L.sound] || null, destination: chain.input,
      }));
    }
  }
  preview = { at, st, master, limiter, chains, nodes };
  $('previewPlay').textContent = '■   Stop';
  $('previewPlay').classList.add('on');
  if (failed.length) $('errors').prepend(el('li', { textContent: `preview: couldn't load ${failed.join(', ')}` }));
}

function stopPreview() {
  if (!preview) return;
  const { master, limiter, chains, nodes } = preview;
  const t = audioCtx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(master.gain.value, t);
  master.gain.linearRampToValueAtTime(0, t + 0.05);
  for (const n of nodes) { try { n.src.stop(t + 0.06); } catch (e) {} }
  setTimeout(() => { chains.forEach(c => c.dispose()); master.disconnect(); limiter.disconnect(); }, 200);
  preview = null;
  $('previewPlay').textContent = '▶   Preview';
  $('previewPlay').classList.remove('on');
  $('previewStatus').textContent = 'STOPPED';
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPEN: a GitHub link, a folder on this computer, a ZIP, or a new piece
// ═══════════════════════════════════════════════════════════════════════════════
function opened(d, from) {
  stopPreview();
  doc = d;
  previewOn = new Set();
  render();
  const missing = doc.sounds.filter(s => !s.file && !s.url).length;
  $('openStatus').textContent = `Opened “${doc.title || 'Untitled'}” from ${from}.` +
    (missing ? ` ${missing} sound file${missing > 1 ? 's are' : ' is'} missing: choose ${missing > 1 ? 'them' : 'it'} under Sounds.` : '');
}

// One of the scores in scores.js: its sounds come from this site's assets/
function openBuiltIn(i) {
  const score = SCORES[+i];
  if (!score) return;
  const dir = new URL(SOUND_DIR, document.baseURI);
  opened(fromScore(score, path => ({ url: new URL(path, dir).href })), 'the built-in scores');
}

async function openLink(link = $('openLink').value) {
  $('openStatus').textContent = 'Opening…';
  try {
    const { base, score } = await loadPiece(link);
    opened(fromScore(score, path => ({ url: new URL(path, base).href })), 'the link');
    $('openLink').value = link;
  } catch (e) { $('openStatus').textContent = e.message; }
}

// Paths in a folder or ZIP, without "./" and with forward slashes
const normPath = p => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/\.\//g, '/');

// Finds score.json (the shallowest one) among `paths`; returns its folder ("" or "x/")
function scoreFolder(paths) {
  const found = paths.filter(p => /(^|\/)score\.json$/i.test(p)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  return found === undefined ? null : found.slice(0, found.length - 'score.json'.length);
}

async function openFolder(files) {
  const byPath = new Map([...files].map(f => [normPath(f.webkitRelativePath || f.name), f]));
  const folder = scoreFolder([...byPath.keys()]);
  if (folder === null) { $('openStatus').textContent = 'No score.json in that folder.'; return; }
  try {
    const score = JSON.parse(await byPath.get(folder + 'score.json').text());
    opened(fromScore(score, path => {
      const f = byPath.get(normPath(folder + path));
      return f ? { file: f } : null;
    }), 'the folder');
  } catch (e) { $('openStatus').textContent = `Could not read score.json: ${e.message}`; }
}

async function openZip(file) {
  try {
    const zip = await JSZip.loadAsync(file);
    const paths = Object.keys(zip.files).filter(p => !zip.files[p].dir);
    const folder = scoreFolder(paths);
    if (folder === null) { $('openStatus').textContent = 'No score.json in that ZIP.'; return; }
    const score = JSON.parse(await zip.file(folder + 'score.json').async('string'));
    const files = {};
    for (const path of new Set(fromScore(score, () => null).sounds.map(s => s.path))) {
      const entry = zip.file(normPath(folder + path));
      if (entry) files[path] = new File([await entry.async('blob')], path.split('/').pop());
    }
    opened(fromScore(score, path => (files[path] ? { file: files[path] } : null)), 'the ZIP');
  } catch (e) { $('openStatus').textContent = `Could not open that ZIP: ${e.message}`; }
}

function newPiece() {
  opened(blankDoc(), 'scratch');
  $('openStatus').textContent = 'New piece. Add your sounds, then your events.';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAVE
// ═══════════════════════════════════════════════════════════════════════════════
const slug = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-piece';

async function downloadZip() {
  const status = $('saveStatus');
  const folderName = slug(doc.title);
  const zip = new JSZip(), folder = zip.folder(folderName);
  folder.file('score.json', JSON.stringify(toScore(true), null, 2) + '\n');
  const missing = [];
  status.textContent = 'Packing…';
  for (const s of doc.sounds) {
    try {
      const r = s.file ? null : s.url ? await fetch(s.url) : null;
      if (r && !r.ok) throw new Error('HTTP ' + r.status);
      const blob = s.file || (r ? await r.blob() : null);
      if (blob) folder.file(savedPath(s.path), blob); else missing.push(s.name);
    } catch (e) { missing.push(s.name); }
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = el('a', { href: URL.createObjectURL(blob), download: folderName + '.zip' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  status.textContent = `Saved ${folderName}.zip.` + (missing.length ? ` Not included (no file): ${missing.join(', ')}.` : '') +
    ' Upload what is inside the folder to your repo (score.json at the top, plus audio/).';
}

async function copyJSON() {
  const json = JSON.stringify(toScore(true), null, 2);
  try { await navigator.clipboard.writeText(json); $('saveStatus').textContent = 'score.json copied.'; }
  catch (e) { $('saveStatus').textContent = 'Could not copy: open "score.json" below and copy it from there.'; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════
function themeChanged() {
  toggleTheme();
  $('themeBtn').textContent = document.documentElement.dataset.theme === 'dark' ? '◐   Light' : '◐   Dark';
}

$('groupCount').replaceChildren(...Array.from({ length: MAX_GROUPS }, (_, i) =>
  el('option', { value: i + 1, textContent: `${i + 1} (${LETTERS.slice(0, i + 1).split('').join(', ')})` })));
$('groupCount').addEventListener('change', e => { doc.groups = +e.target.value; previewOn = new Set(); render(); });
$('title').addEventListener('input', e => { doc.title = e.target.value; changed(); });
$('openBuiltIn').replaceChildren(el('option', { value: '', textContent: 'Open a built-in score…' }),
  ...SCORES.map((sc, i) => el('option', { value: i, textContent: sc.title || 'Score ' + (i + 1) })));
$('openBuiltIn').addEventListener('change', e => { if (e.target.value !== '') openBuiltIn(e.target.value); e.target.value = ''; });
$('end').addEventListener('input', e => { doc.end = e.target.value; changed(); });
$('addSounds').addEventListener('change', e => { addSoundFiles([...e.target.files]); e.target.value = ''; });
$('openFolder').addEventListener('change', e => { if (e.target.files.length) openFolder(e.target.files); e.target.value = ''; });
$('openZip').addEventListener('change', e => { if (e.target.files[0]) openZip(e.target.files[0]); e.target.value = ''; });
$('openLink').addEventListener('keydown', e => { if (e.key === 'Enter') openLink(); });
$('timeline').addEventListener('click', ev => {
  if (preview) return;
  const r = $('timeline').getBoundingClientRect();
  const t = Math.max(0, Math.min(Math.max(comp.end, 1), Math.round($('timeline')._x2t(ev.clientX - r.left))));
  $('previewFrom').value = fmtTime(t);
});
$('themeBtn').textContent = document.documentElement.dataset.theme === 'dark' ? '◐   Light' : '◐   Dark';

// editor.html?link=… or ?score=<n> (scores.js) opens that piece straight
// away (the conductor links here with the piece it has loaded)
const startParams = new URLSearchParams(location.search);
render();
if (startParams.get('link')) openLink(startParams.get('link'));
else if (startParams.get('score') !== null && SCORES[+startParams.get('score')]) openBuiltIn(startParams.get('score'));
requestAnimationFrame(renderLoop);

document.body.addEventListener('keydown', ev => {
  if (ev.key === ' ' && ev.target === document.body) { ev.preventDefault(); previewToggle(); }
});
