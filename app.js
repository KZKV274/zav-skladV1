'use strict';
/* =========================================================
   ЗАВ. СКЛАД — приложение учёта прихода товаров цеха
   ========================================================= */

/* ---------- КОНФИГУРАЦИЯ КАТЕГОРИЙ ---------- */
const CATEGORIES = {
  raskroy: { label: 'Закройный',        code: 'ЗК',  hasFabric: true  },
  shveiny: { label: 'Швейный',          code: 'ШВ',  hasFabric: false },
  utug:    { label: 'Утюг',             code: 'УТ',  hasFabric: false },
  petlya:  { label: 'Петля и пуговица', code: 'ПП',  hasFabric: false },
  otk:     { label: 'ОТК и упаковка',   code: 'ОТК', hasFabric: false },
};
const ROUTES = ['raskroy', 'shveiny', 'utug', 'petlya', 'otk', 'reports'];
const UNITS = ['шт', 'кг', 'м', 'упаковка', 'пара', 'рулон', 'литр', 'другое'];

/* ---------- СОСТОЯНИЕ ---------- */
const state = {
  route: 'raskroy',
  subtab: 'fabric',        // для raskroy: fabric | regular
  entries: {},              // { category: [entries...] } — живой кэш из onSnapshot
  items: {},                 // { "category:subtype": [ {id,name,unit} ] }
  unsub: {},                 // активные подписки Firestore по категориям
  editingEntryId: null,
  editingCategory: null,
  editingSubtype: null,
  rollsDraft: [],             // черновик рулонов в открытой форме
  photoDraftFile: null,
  confirmCallback: null,
  reportRows: [],             // последний результат отчёта (для экспорта в Excel)
  charts: {},                  // активные экземпляры Chart.js в разделе «Отчёты»
};

/* ---------- УТИЛИТЫ ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function fmtMoney(n, currency) {
  const num = Number(n) || 0;
  const s = num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `$${s}` : `${s} сом`;
}
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}
function uidLocal() { return 'tmp_' + Math.random().toString(36).slice(2, 10); }

/* ---------- ШАПКА / ДАТА / СВЯЗЬ ---------- */
function renderTopbarDate() {
  const d = new Date();
  $('#todayDate').textContent = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
function setConnStatus(online) {
  $('#connDot').classList.toggle('online', online);
  $('#connDot').classList.toggle('offline', !online);
  $('#connLabel').textContent = online ? 'на связи' : 'нет соединения';
}
window.addEventListener('online', () => setConnStatus(true));
window.addEventListener('offline', () => setConnStatus(false));

/* Реальная проверка связи с Firestore (а не просто интернет в браузере) */
function initConnectionWatcher() {
  db.collection('entries').limit(1).onSnapshot(
    { includeMetadataChanges: true },
    (snap) => setConnStatus(!snap.metadata.fromCache),
    () => setConnStatus(false)
  );
}

/* ---------- РОУТИНГ ---------- */
function setRoute(route, subtab) {
  state.route = route;
  if (subtab) state.subtab = subtab;
  $$('.navbar__item').forEach(b => b.classList.toggle('active', b.dataset.route === route));
  renderMain();
}
$('#navbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.navbar__item');
  if (!btn) return;
  setRoute(btn.dataset.route);
});

/* =========================================================
   FIRESTORE — подписки
   ========================================================= */
function ensureEntriesSubscription(category) {
  if (state.unsub[category]) return;
  state.unsub[category] = db.collection('entries')
    .where('category', '==', category)
    .orderBy('date', 'desc')
    .onSnapshot((snap) => {
      setConnStatus(true);
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // досортировка: внутри одного дня — сначала последние добавленные
      rows.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bt - at;
      });
      state.entries[category] = rows;
      if (state.route === category) renderMain();
    }, (err) => {
      console.error(err);
      setConnStatus(false);
      toast('Ошибка соединения с базой');
    });
}
function ensureItemsSubscription(category, subtype) {
  const key = `${category}:${subtype}`;
  if (state.unsub[key]) return;
  state.unsub[key] = db.collection('items')
    .where('category', '==', category)
    .where('subtype', '==', subtype)
    .onSnapshot((snap) => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      state.items[key] = rows;
      // обновим datalist, если форма открыта
      populateItemDatalist();
    }, (err) => console.error(err));
}
async function addItemIfNew(category, subtype, name, unit) {
  const key = `${category}:${subtype}`;
  const list = state.items[key] || [];
  const exists = list.some(i => i.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (exists || !name.trim()) return;
  try {
    await db.collection('items').add({
      category, subtype, name: name.trim(),
      unit: unit || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.error(e); }
}

/* Номер партии — атомарный счётчик по категории */
async function nextPartyNumber(category) {
  const code = CATEGORIES[category].code;
  const ref = db.collection('counters').doc(category);
  const seq = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const cur = doc.exists ? (doc.data().seq || 0) : 0;
    const next = cur + 1;
    tx.set(ref, { seq: next }, { merge: true });
    return next;
  });
  return `${code}-${String(seq).padStart(4, '0')}`;
}

/* =========================================================
   ОТРИСОВКА — главный роутер вида
   ========================================================= */
function renderMain() {
  const view = $('#mainView');
  if (state.route === 'reports') { renderReportsPage(view); return; }
  renderCategoryPage(view, state.route);
}

function renderCategoryPage(view, category) {
  ensureEntriesSubscription(category);
  const meta = CATEGORIES[category];
  const hasFabric = meta.hasFabric;
  const subtype = hasFabric ? state.subtab : 'regular';

  ensureItemsSubscription(category, subtype);

  const allEntries = state.entries[category] || [];
  const entries = allEntries.filter(e => e.subtype === subtype);

  let html = `
    <div class="page-head">
      <div>
        <h2>${meta.label}</h2>
        <p class="page-head__sub">${entries.length ? entries.length + ' записей прихода' : 'записей пока нет'}</p>
      </div>
    </div>`;

  if (hasFabric) {
    html += `
      <div class="subtabs">
        <button data-sub="fabric" class="${subtype === 'fabric' ? 'active' : ''}">Ткань</button>
        <button data-sub="regular" class="${subtype === 'regular' ? 'active' : ''}">Прочее</button>
      </div>`;
  }

  html += `
    <div class="fab-row">
      <button class="btn btn--primary btn--block" id="addEntryBtn">+ Добавить приход</button>
    </div>
    <div id="entriesList"></div>`;

  view.innerHTML = html;

  $$('.subtabs button').forEach(b => b.addEventListener('click', () => {
    state.subtab = b.dataset.sub;
    renderMain();
  }));
  $('#addEntryBtn').addEventListener('click', () => openEntryForm(category, subtype, null));

  const list = $('#entriesList');
  if (!entries.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">🗂️</div>
        <p>Пока нет ни одной записи.<br>Нажми «Добавить приход», чтобы внести первую партию.</p>
      </div>`;
    return;
  }
  list.innerHTML = entries.map(renderTicketHTML).join('');
  $$('.ticket [data-edit]', list).forEach(btn => btn.addEventListener('click', () => {
    const entry = entries.find(e => e.id === btn.dataset.edit);
    openEntryForm(category, subtype, entry);
  }));
  $$('.ticket [data-del]', list).forEach(btn => btn.addEventListener('click', () => {
    confirmDelete(btn.dataset.del, `Партия ${btn.dataset.party} будет удалена без возможности восстановления.`);
  }));
}

function renderTicketHTML(e) {
  const isFabric = e.subtype === 'fabric';
  const title = isFabric ? escapeHtml(e.fabricName) : escapeHtml(e.itemName);
  const colorLine = isFabric && e.color ? `<div class="ticket__color">Цвет: ${escapeHtml(e.color)}</div>` : '';
  const sumClass = isFabric ? 'usd' : 'som';
  const sum = fmtMoney(e.totalSum, isFabric ? 'USD' : 'SOM');

  let metaHtml = `<div class="ticket__meta"><span>📅 <b>${fmtDate(e.date)}</b></span>`;
  if (isFabric) {
    metaHtml += `<span>Рулонов: <b>${e.rolls?.length || 0}</b></span>`;
    metaHtml += `<span>Всего ярдов: <b>${e.totalYards}</b></span>`;
    metaHtml += `<span>Цена/ярд: <b>${fmtMoney(e.pricePerYard, 'USD')}</b></span>`;
  } else {
    metaHtml += `<span>Кол-во: <b>${e.quantity} ${escapeHtml(e.unit)}</b></span>`;
    metaHtml += `<span>Цена/ед: <b>${fmtMoney(e.pricePerUnit, 'SOM')}</b></span>`;
  }
  metaHtml += `</div>`;

  const rollsHtml = isFabric && e.rolls?.length
    ? `<div class="ticket__rolls">${e.rolls.map((r, i) => `<span class="roll-chip">Р${i + 1}: ${r.length} ярд</span>`).join('')}</div>`
    : '';

  const photoHtml = e.photoURL ? `<div class="ticket__photo"><img src="${escapeHtml(e.photoURL)}" alt="Фото"></div>` : '';

  return `
    <div class="ticket">
      <div class="ticket__row">
        <div>
          <div class="ticket__title">${title}</div>
          ${colorLine}
        </div>
        <div class="ticket__stamp">${escapeHtml(e.partyNumber)}</div>
      </div>
      <div class="ticket__dash"></div>
      ${metaHtml}
      ${rollsHtml}
      ${photoHtml}
      <div class="ticket__sum">
        <span class="sum-value ${sumClass}">${sum}</span>
        <span class="ticket__actions">
          <button data-edit="${e.id}" title="Редактировать">✏️</button>
          <button data-del="${e.id}" data-party="${escapeHtml(e.partyNumber)}" title="Удалить">🗑️</button>
        </span>
      </div>
    </div>`;
}

/* =========================================================
   ФОРМА ПРИХОДА
   ========================================================= */
function openEntryForm(category, subtype, existing) {
  state.editingEntryId = existing ? existing.id : null;
  state.editingCategory = category;
  state.editingSubtype = subtype;
  state.photoDraftFile = null;
  state.rollsDraft = existing?.rolls ? existing.rolls.map(r => r.length) : [null];

  $('#entryDialogTitle').textContent = existing ? `Редактировать · ${existing.partyNumber}` : 'Новый приход';
  const body = $('#entryFormBody');
  body.innerHTML = subtype === 'fabric' ? fabricFormHTML(existing) : regularFormHTML(existing);

  populateItemDatalist();
  wireFormEvents(subtype);
  recalcTotals(subtype);

  const dlg = $('#entryDialog');
  dlg.showModal();
}

function fabricFormHTML(e) {
  const rolls = state.rollsDraft;
  return `
    <div class="field">
      <label for="f_fabricName">Название ткани</label>
      <input list="itemsDatalist" id="f_fabricName" type="text" placeholder="Например: Кулирка" value="${escapeHtml(e?.fabricName || '')}" required>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="f_color">Цвет</label>
        <input id="f_color" type="text" placeholder="Например: Синий" value="${escapeHtml(e?.color || '')}">
      </div>
      <div class="field">
        <label for="f_date">Дата</label>
        <input id="f_date" type="date" value="${e?.date || todayISO()}" required>
      </div>
    </div>
    <div class="field">
      <label>Рулоны (ярды)</label>
      <div class="rolls-box" id="rollsBox">
        ${rolls.map((v, i) => rollRowHTML(i, v)).join('')}
      </div>
      <button type="button" class="add-roll-btn" id="addRollBtn">+ Добавить рулон</button>
    </div>
    <div class="field">
      <label for="f_price">Цена за ярд ($)</label>
      <input id="f_price" type="number" min="0" step="0.01" placeholder="1.70" value="${e?.pricePerYard ?? ''}" required>
    </div>
    <div class="calc-box usd">
      <span>Всего: <b id="calcYards">0</b> ярд.</span>
      <span>Сумма: <b id="calcSum">$0.00</b></span>
    </div>
    ${photoFieldHTML(e)}
  `;
}
function rollRowHTML(i, value) {
  return `
    <div class="roll-row" data-roll-row="${i}">
      <span>${i + 1}.</span>
      <input type="number" min="0" step="0.1" class="roll-input" placeholder="Длина в ярдах" value="${value ?? ''}">
      <button type="button" class="roll-remove" data-roll-remove="${i}" aria-label="Удалить рулон">✕</button>
    </div>`;
}
function regularFormHTML(e) {
  const cat = state.editingCategory;
  return `
    <div class="field">
      <label for="f_itemName">Товар</label>
      <input list="itemsDatalist" id="f_itemName" type="text" placeholder="Например: Нитка №40" value="${escapeHtml(e?.itemName || '')}" required>
      <p class="hint">Если товара нет в списке — просто впиши название, он добавится в справочник автоматически.</p>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="f_date">Дата</label>
        <input id="f_date" type="date" value="${e?.date || todayISO()}" required>
      </div>
      <div class="field">
        <label for="f_unit">Единица</label>
        <select id="f_unit">
          ${UNITS.map(u => `<option value="${u}" ${e?.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="f_qty">Количество</label>
        <input id="f_qty" type="number" min="0" step="0.01" value="${e?.quantity ?? ''}" required>
      </div>
      <div class="field">
        <label for="f_priceUnit">Цена за единицу (сом)</label>
        <input id="f_priceUnit" type="number" min="0" step="0.01" value="${e?.pricePerUnit ?? ''}" required>
      </div>
    </div>
    <div class="calc-box">
      <span>Сумма:</span>
      <b id="calcSum">0 сом</b>
    </div>
    ${photoFieldHTML(e)}
  `;
}
function photoFieldHTML(e) {
  return `
    <div class="field">
      <label for="f_photo">Фото (необязательно)</label>
      <div class="photo-input">
        <input id="f_photo" type="file" accept="image/*" capture="environment">
        <img id="photoPreview" class="photo-preview" src="${e?.photoURL || ''}" style="${e?.photoURL ? 'display:block' : ''}">
      </div>
      ${!storage ? '<p class="hint">Firebase Storage не настроен — фото сохраняться не будут.</p>' : ''}
    </div>`;
}

function populateItemDatalist() {
  let dl = $('#itemsDatalist');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'itemsDatalist';
    document.body.appendChild(dl);
  }
  const key = `${state.editingCategory}:${state.editingSubtype}`;
  const items = state.items[key] || [];
  dl.innerHTML = items.map(i => `<option value="${escapeHtml(i.name)}">`).join('');
}

function wireFormEvents(subtype) {
  $('#closeEntryDialog').onclick = () => $('#entryDialog').close();
  $('#cancelEntryBtn').onclick = () => $('#entryDialog').close();

  const photoInput = $('#f_photo');
  if (photoInput) {
    photoInput.onchange = () => {
      const file = photoInput.files[0];
      state.photoDraftFile = file || null;
      if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          const prev = $('#photoPreview');
          prev.src = reader.result;
          prev.style.display = 'block';
        };
        reader.readAsDataURL(file);
      }
    };
  }

  if (subtype === 'fabric') {
    $('#addRollBtn').onclick = () => {
      state.rollsDraft.push(null);
      $('#rollsBox').insertAdjacentHTML('beforeend', rollRowHTML(state.rollsDraft.length - 1, null));
      wireRollRemovers();
      wireRollInputs();
    };
    wireRollRemovers();
    wireRollInputs();
    $('#f_price').oninput = () => recalcTotals('fabric');
  } else {
    $('#f_qty').oninput = () => recalcTotals('regular');
    $('#f_priceUnit').oninput = () => recalcTotals('regular');
  }

  $('#entryForm').onsubmit = (ev) => { ev.preventDefault(); saveEntry(); };
}
function wireRollInputs() {
  $$('.roll-input').forEach((inp, idx) => {
    inp.oninput = () => { state.rollsDraft[idx] = inp.value; recalcTotals('fabric'); };
  });
}
function wireRollRemovers() {
  $$('.roll-remove').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.rollRemove);
      state.rollsDraft.splice(i, 1);
      if (!state.rollsDraft.length) state.rollsDraft.push(null);
      $('#rollsBox').innerHTML = state.rollsDraft.map((v, idx) => rollRowHTML(idx, v)).join('');
      wireRollRemovers();
      wireRollInputs();
      recalcTotals('fabric');
    };
  });
}
function recalcTotals(subtype) {
  if (subtype === 'fabric') {
    const yards = state.rollsDraft.reduce((sum, v) => sum + (Number(v) || 0), 0);
    const price = Number($('#f_price')?.value) || 0;
    $('#calcYards').textContent = yards.toFixed(1).replace(/\.0$/, '');
    $('#calcSum').textContent = `$${(yards * price).toFixed(2)}`;
  } else {
    const qty = Number($('#f_qty')?.value) || 0;
    const price = Number($('#f_priceUnit')?.value) || 0;
    $('#calcSum').textContent = `${(qty * price).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} сом`;
  }
}

async function uploadPhotoIfAny(category, partyNumber) {
  if (!state.photoDraftFile || !storage) return null;
  try {
    const path = `entries/${category}/${partyNumber}_${Date.now()}_${state.photoDraftFile.name}`;
    const ref = storage.ref().child(path);
    await ref.put(state.photoDraftFile);
    return await ref.getDownloadURL();
  } catch (e) {
    console.error(e);
    toast('Не удалось загрузить фото');
    return null;
  }
}

async function saveEntry() {
  const saveBtn = $('#saveEntryBtn');
  saveBtn.disabled = true; saveBtn.textContent = 'Сохранение…';
  try {
    const category = state.editingCategory;
    const subtype = state.editingSubtype;
    const isEdit = !!state.editingEntryId;
    const date = $('#f_date').value;
    if (!date) throw new Error('Укажи дату');

    let payload = { category, subtype, date, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };

    if (subtype === 'fabric') {
      const fabricName = $('#f_fabricName').value.trim();
      const color = $('#f_color').value.trim();
      const pricePerYard = Number($('#f_price').value) || 0;
      const rolls = state.rollsDraft.filter(v => Number(v) > 0).map(v => ({ length: Number(v) }));
      if (!fabricName) throw new Error('Укажи название ткани');
      if (!rolls.length) throw new Error('Добавь хотя бы один рулон');
      const totalYards = rolls.reduce((s, r) => s + r.length, 0);
      const totalSum = Math.round(totalYards * pricePerYard * 100) / 100;
      Object.assign(payload, { fabricName, color, rolls, pricePerYard, totalYards, totalSum });
      await addItemIfNew(category, 'fabric', fabricName, null);
    } else {
      const itemName = $('#f_itemName').value.trim();
      const unit = $('#f_unit').value;
      const quantity = Number($('#f_qty').value) || 0;
      const pricePerUnit = Number($('#f_priceUnit').value) || 0;
      if (!itemName) throw new Error('Укажи название товара');
      if (quantity <= 0) throw new Error('Количество должно быть больше нуля');
      const totalSum = Math.round(quantity * pricePerUnit * 100) / 100;
      Object.assign(payload, { itemName, unit, quantity, pricePerUnit, totalSum });
      await addItemIfNew(category, 'regular', itemName, unit);
    }

    if (isEdit) {
      const photoURL = await uploadPhotoIfAny(category, 'edit');
      if (photoURL) payload.photoURL = photoURL;
      await db.collection('entries').doc(state.editingEntryId).update(payload);
      toast('Запись обновлена');
    } else {
      payload.partyNumber = await nextPartyNumber(category);
      payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      const photoURL = await uploadPhotoIfAny(category, payload.partyNumber);
      if (photoURL) payload.photoURL = photoURL;
      await db.collection('entries').add(payload);
      toast(`Добавлено · ${payload.partyNumber}`);
    }
    $('#entryDialog').close();
  } catch (e) {
    console.error(e);
    toast(e.message || 'Не удалось сохранить запись');
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = 'Сохранить';
  }
}

/* ---------- УДАЛЕНИЕ ---------- */
function confirmDelete(entryId, text) {
  $('#confirmText').textContent = text;
  state.confirmCallback = async () => {
    try {
      await db.collection('entries').doc(entryId).delete();
      toast('Запись удалена');
    } catch (e) {
      console.error(e);
      toast('Не удалось удалить запись');
    }
  };
  $('#confirmDialog').showModal();
}
$('#confirmOkBtn').addEventListener('click', async () => {
  $('#confirmDialog').close();
  if (state.confirmCallback) await state.confirmCallback();
  state.confirmCallback = null;
});
$('#confirmCancelBtn').addEventListener('click', () => { $('#confirmDialog').close(); state.confirmCallback = null; });

/* =========================================================
   ОТЧЁТЫ
   ========================================================= */
function defaultReportRange() {
  const now = new Date();
  const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const to = todayISO();
  return { from, to };
}

function renderReportsPage(view) {
  const { from, to } = state.reportRange || defaultReportRange();
  state.reportRange = { from, to };

  view.innerHTML = `
    <div class="page-head"><h2>Отчёты</h2></div>
    <div class="filters">
      <div class="filters__row">
        <div class="field">
          <label for="r_from">С даты</label>
          <input id="r_from" type="date" value="${from}">
        </div>
        <div class="field">
          <label for="r_to">По дату</label>
          <input id="r_to" type="date" value="${to}">
        </div>
      </div>
      <div class="filters__row">
        <div class="field">
          <label for="r_cat">Категория</label>
          <select id="r_cat">
            <option value="all">Все категории</option>
            ${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <button class="btn btn--primary btn--block" id="runReportBtn">Показать отчёт</button>
    </div>
    <div id="reportResults"></div>
  `;

  $('#runReportBtn').addEventListener('click', runReport);
  runReport();
}

async function runReport() {
  const from = $('#r_from').value;
  const to = $('#r_to').value;
  const cat = $('#r_cat').value;
  state.reportRange = { from, to };
  const results = $('#reportResults');
  results.innerHTML = `<p class="hint">Загрузка…</p>`;

  try {
    let q = db.collection('entries').where('date', '>=', from).where('date', '<=', to).orderBy('date', 'desc');
    const snap = await q.get();
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (cat !== 'all') rows = rows.filter(r => r.category === cat);
    state.reportRows = rows;
    renderReportResults(rows);
  } catch (e) {
    console.error(e);
    results.innerHTML = `<p class="hint">Не удалось загрузить отчёт. ${e.message.includes('index') ? 'Возможно, нужно создать индекс в Firestore — открой консоль браузера, там будет ссылка.' : ''}</p>`;
  }
}

function renderReportResults(rows) {
  const results = $('#reportResults');
  if (!rows.length) {
    results.innerHTML = `<div class="empty-state"><div class="empty-state__icon">📭</div><p>За выбранный период записей нет.</p></div>`;
    return;
  }

  let usdTotal = 0, somTotal = 0;
  const byCat = {};
  Object.keys(CATEGORIES).forEach(k => byCat[k] = { usd: 0, som: 0, count: 0 });
  rows.forEach(r => {
    byCat[r.category].count++;
    if (r.subtype === 'fabric') { usdTotal += r.totalSum || 0; byCat[r.category].usd += r.totalSum || 0; }
    else { somTotal += r.totalSum || 0; byCat[r.category].som += r.totalSum || 0; }
  });

  let html = `
    <div class="summary-grid">
      <div class="summary-card usd"><div class="label">Ткань, $</div><div class="value">$${usdTotal.toFixed(2)}</div></div>
      <div class="summary-card som"><div class="label">Прочее, сом</div><div class="value">${somTotal.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}</div></div>
      <div class="summary-card total"><div class="label">Всего записей</div><div class="value">${rows.length}</div></div>
    </div>
    <div class="chart-box">
      <h3>Расходы по категориям, сом</h3>
      <div class="chart-canvas-wrap"><canvas id="catChart"></canvas></div>
    </div>
    <div class="chart-box">
      <h3>Динамика прихода по дням</h3>
      <div class="chart-canvas-wrap"><canvas id="trendChart"></canvas></div>
    </div>
    <div class="cat-breakdown">
      <table>
        <thead><tr><th>Категория</th><th>Записей</th><th>$</th><th>Сом</th></tr></thead>
        <tbody>
          ${Object.entries(CATEGORIES).map(([k, v]) => `
            <tr>
              <td>${v.label}</td>
              <td class="num">${byCat[k].count}</td>
              <td class="num">${byCat[k].usd ? '$' + byCat[k].usd.toFixed(2) : '—'}</td>
              <td class="num">${byCat[k].som ? byCat[k].som.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <button class="btn btn--primary btn--block" id="exportExcelBtn">⬇ Скачать в Excel</button>
    <div style="height:14px"></div>
    <div id="reportList"></div>
  `;
  results.innerHTML = html;
  $('#exportExcelBtn').addEventListener('click', exportToExcel);
  $('#reportList').innerHTML = rows.map(renderTicketHTML).join('');
  buildCategoryChart(byCat);
  buildTrendChart(rows);
}

/* ---------- Графики (Chart.js) ---------- */
const CHART_COLORS = {
  som: '#55744F',
  usd: '#3D5A80',
  grid: '#CFCBBB',
  text: '#5B5C52',
};
function destroyChart(key) {
  if (state.charts?.[key]) { state.charts[key].destroy(); state.charts[key] = null; }
}
function baseChartOptions(yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: CHART_COLORS.text, font: { family: 'Manrope', size: 11 } } },
      y: {
        beginAtZero: true,
        grid: { color: CHART_COLORS.grid },
        ticks: { color: CHART_COLORS.text, font: { family: 'Manrope', size: 11 } },
        title: yLabel ? { display: true, text: yLabel, color: CHART_COLORS.text, font: { family: 'Manrope', size: 11 } } : undefined,
      },
    },
  };
}
function buildCategoryChart(byCat) {
  const canvas = $('#catChart');
  if (!canvas || typeof Chart === 'undefined') return;
  destroyChart('cat');
  state.charts = state.charts || {};
  const labels = Object.values(CATEGORIES).map(v => v.label);
  const somData = Object.keys(CATEGORIES).map(k => byCat[k].som);
  const hasData = somData.some(v => v > 0);
  if (!hasData) { canvas.replaceWith(Object.assign(document.createElement('p'), { className: 'chart-empty', textContent: 'Нет данных в сомах за период' })); return; }
  state.charts.cat = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data: somData, backgroundColor: CHART_COLORS.som, borderRadius: 5, maxBarThickness: 42 }] },
    options: baseChartOptions('сом'),
  });
}
function buildTrendChart(rows) {
  const canvas = $('#trendChart');
  if (!canvas || typeof Chart === 'undefined') return;
  destroyChart('trend');
  state.charts = state.charts || {};
  if (!rows.length) { canvas.replaceWith(Object.assign(document.createElement('p'), { className: 'chart-empty', textContent: 'Нет данных за период' })); return; }

  const byDate = {};
  rows.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = { usd: 0, som: 0 };
    if (r.subtype === 'fabric') byDate[r.date].usd += r.totalSum || 0;
    else byDate[r.date].som += r.totalSum || 0;
  });
  const dates = Object.keys(byDate).sort();
  const labels = dates.map(fmtDate);
  const somData = dates.map(d => Math.round(byDate[d].som * 100) / 100);
  const usdData = dates.map(d => Math.round(byDate[d].usd * 100) / 100);

  state.charts.trend = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Сом', data: somData, borderColor: CHART_COLORS.som, backgroundColor: CHART_COLORS.som, tension: .3, yAxisID: 'y', pointRadius: 3 },
        { label: 'Доллары ($)', data: usdData, borderColor: CHART_COLORS.usd, backgroundColor: CHART_COLORS.usd, tension: .3, yAxisID: 'y1', pointRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'bottom', labels: { color: CHART_COLORS.text, font: { family: 'Manrope', size: 11 }, boxWidth: 12 } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: CHART_COLORS.text, font: { family: 'Manrope', size: 10 }, maxRotation: 45, minRotation: 0 } },
        y: { position: 'left', beginAtZero: true, grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.som, font: { size: 10 } }, title: { display: true, text: 'сом', color: CHART_COLORS.som, font: { size: 10 } } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { color: CHART_COLORS.usd, font: { size: 10 } }, title: { display: true, text: '$', color: CHART_COLORS.usd, font: { size: 10 } } },
      },
    },
  });
}

function exportToExcel() {
  const rows = state.reportRows || [];
  if (!rows.length) { toast('Нет данных для выгрузки'); return; }

  const data = rows.map(r => ({
    'Партия': r.partyNumber,
    'Категория': CATEGORIES[r.category]?.label || r.category,
    'Тип': r.subtype === 'fabric' ? 'Ткань' : 'Товар',
    'Дата': fmtDate(r.date),
    'Название': r.subtype === 'fabric' ? r.fabricName : r.itemName,
    'Цвет': r.subtype === 'fabric' ? (r.color || '') : '',
    'Кол-во рулонов': r.subtype === 'fabric' ? (r.rolls?.length || 0) : '',
    'Ярдов всего': r.subtype === 'fabric' ? r.totalYards : '',
    'Кол-во': r.subtype === 'regular' ? r.quantity : '',
    'Ед.изм.': r.subtype === 'regular' ? r.unit : '',
    'Цена за ед.': r.subtype === 'fabric' ? r.pricePerYard : r.pricePerUnit,
    'Валюта': r.subtype === 'fabric' ? 'USD' : 'сом',
    'Сумма': r.totalSum,
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = Object.keys(data[0]).map(k => ({ wch: Math.max(12, k.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Приход');
  const { from, to } = state.reportRange;
  XLSX.writeFile(wb, `Зав-Склад_${from}_${to}.xlsx`);
  toast('Файл Excel скачан');
}

/* =========================================================
   PWA — установка на телефон
   ========================================================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.error('SW error', err));
  });
}

/* =========================================================
   СТАРТ
   ========================================================= */
renderTopbarDate();
setConnStatus(navigator.onLine);
initConnectionWatcher();
setRoute('raskroy');
