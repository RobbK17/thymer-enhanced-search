/**
 * Enhanced Search — Thymer plugin v1.1.0
 * Cross-collection record viewer with filters (see README).
 * Modes: Search, Duplicates (analysis), Compare (2–3 notes + diff).
 */
const PLUGIN_NAME = 'Enhanced Search';
const PLUGIN_VERSION = '1.1.0';

/** Skip duplicate/similar scans above this many records (per selected collections). */
const DUPLICATE_SCAN_MAX_RECORDS = 2500;
/** Max records for pairwise similar-body scan (performance). */
const CONTENT_SIMILAR_MAX_RECORDS = 500;

class Plugin extends AppPlugin {
  /** Enhanced Search viewer panels by `panel.getId()` (refs from getPanels() may differ from register callback). */
  _viewerPanelsById = new Map();
  _collections = [];  // cache of PluginCollectionAPI[]
  /** Full result list from last search (for pagination). */
  _matchRecords = null;
  /** Index of first record on the current page (0, then +pageSize each Load next). */
  _pageStart = 0;
  _pageSize = 50;
  _isJournalResults = false;
  /** When false, search used `@collection=…` — don’t filter results/cards by sidebar checkboxes. */
  _filterRecordsByCollectionCheckboxes = true;

  /** `search` | `duplicates` | `compare` */
  _panelMode = 'search';
  /** @type {{ label: string, records: object[] }[]|null} */
  _dupGroups = null;
  /** Up to 3 record GUIDs selected for compare */
  _compareGuids = [];
  /** True when main area shows diff / triple view instead of cards */
  _compareDiffOpen = false;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  onLoad() {
    this.ui.injectCSS(CSS);

    this.ui.registerCustomPanelType('viewer-main', (panel) => {
      this._viewerPanelsById.set(panel.getId(), panel);
      this._initPanel(panel);
      panel.getElement().addEventListener('_destroy', () => {
        this._viewerPanelsById.delete(panel.getId());
      });
    });

    this.ui.addSidebarItem({
      label: PLUGIN_NAME,
      icon: 'filter',
      tooltip: `Open or close ${PLUGIN_NAME}`,
      onClick: () => this._openViewer(),
    });

    this.ui.addCommandPaletteCommand({
      label: `Toggle ${PLUGIN_NAME}`,
      icon: 'filter',
      onSelected: () => this._openViewer(),
    });
  }

  onUnload() {
    this._viewerPanelsById.clear();
  }

  /** Drop viewer entries that are no longer in getPanels() (compare by panel id, not object identity). */
  _syncViewerPanels() {
    try {
      const open = this.ui.getPanels();
      if (!open?.length) {
        this._viewerPanelsById.clear();
        return;
      }
      const openIds = new Set(open.map(p => p.getId()));
      for (const id of [...this._viewerPanelsById.keys()]) {
        if (!openIds.has(id)) this._viewerPanelsById.delete(id);
      }
    } catch {
      /* ignore */
    }
  }

  // ─── Panel ───────────────────────────────────────────────────────────────

  async _openViewer() {
    this._syncViewerPanels();

    // Toggle: if an Enhanced Search panel is already open, close it instead of stacking another.
    const active = this.ui.getActivePanel();
    if (active && this._viewerPanelsById.has(active.getId())) {
      this.ui.closePanel(active);
      this._viewerPanelsById.delete(active.getId());
      return;
    }
    if (this._viewerPanelsById.size > 0) {
      const p = [...this._viewerPanelsById.values()][0];
      this.ui.closePanel(p);
      this._viewerPanelsById.delete(p.getId());
      return;
    }
    const panel = await this.ui.createPanel();
    if (panel) panel.navigateToCustomType('viewer-main');
  }

  async _initPanel(panel) {
    panel.setTitle(PLUGIN_NAME);
    const el = panel.getElement();
    Object.assign(el.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      bottom: '4px',
      overflow: 'hidden',
    });
    el.innerHTML = SHELL_HTML;

    // Show loading while building collection map
    el.querySelector('.rv-results').innerHTML =
      '<div class="rv-loading"><span class="rv-spin ti ti-refresh"></span> Loading collections…</div>';

    // Load all collections and pre-build recordGuid -> col meta map
    const cols = await this.data.getAllCollections();
    this._collections = [...cols].sort((a, b) => {
      const na = String(a.getName() || '').toLowerCase();
      const nb = String(b.getName() || '').toLowerCase();
      const c = na.localeCompare(nb, undefined, { sensitivity: 'base' });
      return c !== 0 ? c : String(a.getGuid()).localeCompare(String(b.getGuid()));
    });
    this._recordColMap = {};

    await Promise.all(this._collections.map(async col => {
      try {
        const records = await col.getAllRecords();
        const meta = {
          colName: col.getName(),
          colIcon: col.getConfiguration().icon || 'file-text',
          colGuid: col.getGuid(),
        };
        for (const r of records) this._recordColMap[r.guid] = meta;
      } catch { /* skip */ }
    }));

    // Build collection checkboxes (alphabetical by name)
    const colList = el.querySelector('.rv-col-list');
    this._collections.forEach(col => {
      const cfg  = col.getConfiguration();
      const item = document.createElement('label');
      item.className = 'rv-col-item';
      item.innerHTML = `
        <input type="checkbox" data-col-guid="${col.getGuid()}" checked>
        <span class="ti ti-${cfg.icon || 'stack'}"></span>
        <span class="rv-col-item-name">${_esc(col.getName())}</span>`;
      colList.appendChild(item);
    });

    // Status chips
    const statusBar = el.querySelector('.rv-status-bar');
    TASK_STATUSES.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'rv-chip';
      btn.dataset.status = s.value;
      btn.innerHTML = `<span class="rv-chip-dot" style="background:${s.color}"></span>${s.label}`;
      statusBar.appendChild(btn);
    });

    // Date chips
    const dateBar = el.querySelector('.rv-date-bar');
    DATE_FILTERS.forEach(d => {
      const btn = document.createElement('button');
      btn.className = 'rv-chip';
      btn.dataset.date = d.value;
      btn.textContent = d.label;
      dateBar.appendChild(btn);
    });

    this._pageSize = this._readPageSize();
    this._bindEvents(el);
    this._syncSearchClear(el);
    this._syncDupKindUI(el);
    this._bindCardActions(el, panel);
    this._renderPresets(el);
    this._renderDupPresets(el);
    this._updateTypeSearchCheckboxVisibility(el);
    this._applyPanelMode(el);
    this._runSearch(el);
  }

  _readPageSize() {
    try {
      const v = parseInt(localStorage.getItem('rv_page_size_' + this.getWorkspaceGuid()) || '50', 10);
      return [40, 50, 60].includes(v) ? v : 50;
    } catch {
      return 50;
    }
  }

  _sortStorageKey() {
    return 'rv_sort_' + this.getWorkspaceGuid();
  }

  /** Read sort mode from toolbar select (if present) or localStorage; default `modified`. */
  _captureSortMode(el) {
    const sel = el.querySelector('.rv-sort-select');
    if (sel && ['modified', 'title', 'collection_modified'].includes(sel.value)) return sel.value;
    try {
      const v = localStorage.getItem(this._sortStorageKey());
      if (v && ['modified', 'title', 'collection_modified'].includes(v)) return v;
    } catch { /* ignore */ }
    return 'modified';
  }

  /** Show/hide circle-x clear control when the search field has text. */
  _syncSearchClear(el) {
    const input = el.querySelector('.rv-search-input');
    const btn = el.querySelector('.rv-search-clear');
    if (!input || !btn) return;
    btn.hidden = !input.value.trim();
  }

  /** True if this record's collection is a journal plugin (used to apply blank-journal filter in mixed search). */
  _isJournalCollectionRecord(record) {
    const meta = this._recordColMap[record.guid];
    if (!meta) return false;
    const col = this._collections.find(c => c.getGuid() === meta.colGuid);
    return !!(col && typeof col.isJournalPlugin === 'function' && col.isJournalPlugin());
  }

  /** True if any checked collection defines an active **choice** field named type or types. */
  _selectedCollectionsHaveTypeField(selectedGuids) {
    for (const guid of selectedGuids) {
      const col = this._collections.find(c => c.getGuid() === guid);
      if (col && _collectionHasTypeField(col)) return true;
    }
    return false;
  }

  /**
   * Records in selected collections whose **Type** choice field matches the same tokens as tag
   * search: plain words plus each #hashtag (with and without #). Ensures _recordColMap for hits.
   */
  async _recordsMatchingTypeField(texts, tags, selectedGuids) {
    const out = [];
    const seen = new Set();
    const needles = _typeSearchNeedles(texts, tags);
    if (!needles.length) return out;

    for (const col of this._collections) {
      if (!selectedGuids.has(col.getGuid())) continue;
      const typeKeys = _typeChoiceFieldKeysForCollection(col);
      if (!typeKeys.length) continue;
      const colMeta = {
        colName: col.getName(),
        colIcon: col.getConfiguration().icon || 'file-text',
        colGuid: col.getGuid(),
      };
      let all;
      try {
        all = await col.getAllRecords();
      } catch {
        continue;
      }
      for (const record of all) {
        if (seen.has(record.guid)) continue;
        const hay = _recordTypeChoiceFieldBlob(record, typeKeys);
        if (!hay) continue;
        if (!needles.some(n => hay.includes(n))) continue;
        seen.add(record.guid);
        if (!this._recordColMap[record.guid]) this._recordColMap[record.guid] = colMeta;
        out.push(record);
      }
    }
    return out;
  }

  /** Show #type search checkbox only when a selected collection has a Type field. */
  _updateTypeSearchCheckboxVisibility(el) {
    const wrap = el.querySelector('.rv-search-include-type-wrap');
    const cb = el.querySelector('.rv-search-include-type');
    if (!wrap || !cb) return;
    const selectedGuids = new Set(
      [...el.querySelectorAll('.rv-col-list input:checked')].map(inp => inp.dataset.colGuid)
    );
    const show = this._selectedCollectionsHaveTypeField(selectedGuids);
    wrap.style.display = show ? 'flex' : 'none';
    if (!show) cb.checked = false;
  }

  /**
   * Journal-date results: keep whatever `getJournalRecord` returned (truthy records only).
   * No filtering by last modified or body text — empty shells for the selected day are still shown.
   */
  _filterJournalDateRecords(records) {
    return records.filter(Boolean);
  }

  async _renderCurrentPage(el) {
    if (this._panelMode === 'compare') {
      await this._renderCompareMain(el);
      return;
    }
    const list = this._matchRecords;
    if (!list || !list.length) return;
    const total = list.length;
    const selectedGuids = new Set(
      [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid)
    );
    const batch = list.slice(this._pageStart, this._pageStart + this._pageSize);
    const cards = await Promise.all(batch.map(r => this._buildCard(r, selectedGuids, this._isJournalResults, { compareBtn: true })));
    const html = cards.filter(Boolean).join('');
    const container = el.querySelector('.rv-cards-list');
    if (container) container.innerHTML = html;
    const countEl = el.querySelector('.rv-results-toolbar .rv-count');
    if (countEl) {
      countEl.textContent = _countRangeLabel(this._pageStart, batch.length, total, this._isJournalResults);
    }
    const hasPrev = this._pageStart > 0;
    const end = this._pageStart + batch.length;
    const hasNext = end < total;
    const loadBar = el.querySelector('.rv-load-more-bar');
    if (loadBar) loadBar.outerHTML = _renderLoadMoreBar(hasPrev, hasNext);
    const main = el.querySelector('.rv-main');
    if (main) main.scrollTop = 0;
  }

  async _loadPrevPage(el) {
    if (this._pageStart <= 0) return;
    this._pageStart = Math.max(0, this._pageStart - this._pageSize);
    await this._renderCurrentPage(el);
  }

  async _loadNextPage(el) {
    let total;
    if (this._panelMode === 'compare') {
      const filterRaw = el.querySelector('.rv-compare-filter')?.value ?? '';
      const { filtered } = _filterRecordsForCompareDisplay(
        this._matchRecords || [],
        filterRaw,
        this._recordColMap
      );
      total = filtered.length;
    } else {
      const list = this._matchRecords;
      if (!list || !list.length) return;
      total = list.length;
    }
    if (!total) return;
    const nextStart = this._pageStart + this._pageSize;
    if (nextStart >= total) return;
    this._pageStart = nextStart;
    await this._renderCurrentPage(el);
  }

  // ─── Events ───────────────────────────────────────────────────────────────


  _journalDate = null; // Date object or null

  // ─── Journal Date ─────────────────────────────────────────────────────────

  _setJournalDate(date, el) {
    this._journalDate = date;
    const label = el.querySelector('.rv-journal-label');
    if (!date) {
      label.textContent = '—';
    } else {
      label.textContent = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    }
    // Clear active state on chips except if explicitly set
    el.querySelectorAll('.rv-jchip').forEach(c => c.classList.remove('rv-chip--active'));
    this._runSearch(el);
  }


  _presetsKey() { return 'rv_presets_' + this.getWorkspaceGuid(); }

  _dupPresetsKey() { return 'rv_dup_presets_' + this.getWorkspaceGuid(); }

  _getPresets() {
    try { return JSON.parse(localStorage.getItem(this._presetsKey()) || '[]'); }
    catch { return []; }
  }

  _savePresets(presets) {
    try { localStorage.setItem(this._presetsKey(), JSON.stringify(presets)); }
    catch { /* ignore */ }
  }

  _getDupPresets() {
    try { return JSON.parse(localStorage.getItem(this._dupPresetsKey()) || '[]'); }
    catch { return []; }
  }

  _saveDupPresets(presets) {
    try { localStorage.setItem(this._dupPresetsKey(), JSON.stringify(presets)); }
    catch { /* ignore */ }
  }

  _getDupState(el) {
    const thrEl = el.querySelector('.rv-dup-threshold');
    return {
      kind: el.querySelector('.rv-dup-kind')?.value || 'title_similar',
      threshold: thrEl ? parseInt(thrEl.value, 10) : 85,
      titleVariant: !!el.querySelector('.rv-dup-title-variant')?.checked,
      dupFilter: el.querySelector('.rv-dup-filter')?.value ?? '',
      collections: [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid),
    };
  }

  async _applyDupState(el, state) {
    const kinds = ['title_exact', 'title_similar', 'content_exact', 'content_similar'];
    const kind = kinds.includes(state.kind) ? state.kind : 'title_similar';
    const sel = el.querySelector('.rv-dup-kind');
    if (sel) sel.value = kind;
    const thr = el.querySelector('.rv-dup-threshold');
    if (thr) {
      const raw = Number(state.threshold);
      const v = Number.isFinite(raw) ? Math.min(100, Math.max(70, Math.round(raw))) : 85;
      thr.value = String(v);
      const lab = el.querySelector('.rv-dup-threshold-val');
      if (lab) lab.textContent = v + '%';
    }
    const tv = el.querySelector('.rv-dup-title-variant');
    if (tv) tv.checked = state.titleVariant !== false;
    const df = el.querySelector('.rv-dup-filter');
    if (df) df.value = state.dupFilter != null ? String(state.dupFilter) : '';
    el.querySelectorAll('.rv-col-list input').forEach(cb => {
      cb.checked = (state.collections || []).includes(cb.dataset.colGuid);
    });
    this._updateTypeSearchCheckboxVisibility(el);
    this._syncDupKindUI(el);
    this._setPanelMode(el, 'duplicates');
    await this._runDuplicateAnalysis(el);
  }

  _getFilterState(el) {
    return {
      search: el.querySelector('.rv-search-input').value,
      statuses: [...el.querySelectorAll('.rv-status-bar .rv-chip--active')].map(c => c.dataset.status),
      date: el.querySelector('.rv-date-bar .rv-chip--active')?.dataset.date || '',
      collections: [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid),
      journalDate: this._journalDate ? this._journalDate.toISOString() : null,
      includeTypeSearch: !!el.querySelector('.rv-search-include-type')?.checked,
      sort: this._captureSortMode(el),
    };
  }

  _applyFilterState(el, state) {
    el.querySelector('.rv-search-input').value = state.search || '';
    el.querySelectorAll('.rv-status-bar .rv-chip').forEach(c => {
      c.classList.toggle('rv-chip--active', (state.statuses || []).includes(c.dataset.status));
    });
    el.querySelectorAll('.rv-date-bar .rv-chip').forEach(c => {
      c.classList.toggle('rv-chip--active', c.dataset.date === state.date);
    });
    el.querySelectorAll('.rv-col-list input').forEach(cb => {
      cb.checked = (state.collections || []).includes(cb.dataset.colGuid);
    });
    if (state.journalDate) {
      this._journalDate = new Date(state.journalDate);
      const label = el.querySelector('.rv-journal-label');
      label.textContent = this._journalDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    } else {
      this._journalDate = null;
      el.querySelector('.rv-journal-label').textContent = '—';
    }
    const typeCb = el.querySelector('.rv-search-include-type');
    if (typeCb) typeCb.checked = !!state.includeTypeSearch;
    if (state.sort && ['modified', 'title', 'collection_modified'].includes(state.sort)) {
      try { localStorage.setItem(this._sortStorageKey(), state.sort); } catch { /* ignore */ }
    }
    this._syncSearchClear(el);
    this._updateTypeSearchCheckboxVisibility(el);
    this._runSearch(el);
  }

  _presetEditMode = false;

  _dupPresetEditMode = false;

  _renderPresets(el) {
    const presets = this._getPresets();
    const list = el.querySelector('.rv-preset-list');
    list.innerHTML = '';
    if (presets.length === 0) {
      list.innerHTML = '<div class="rv-preset-empty">No saved presets yet</div>';
      return;
    }
    presets.forEach((preset, i) => {
      const row = document.createElement('div');
      row.className = 'rv-preset-row';
      if (this._presetEditMode) {
        row.innerHTML = `
          <span class="rv-preset-name-label">${_esc(preset.name)}</span>
          <button class="rv-preset-del" data-index="${i}" title="Delete">
            <span class="ti ti-trash"></span>
          </button>`;
      } else {
        row.innerHTML = `
          <button class="rv-preset-load" data-index="${i}">${_esc(preset.name)}</button>`;
      }
      list.appendChild(row);
    });
    // Update toggle button appearance
    const toggle = el.querySelector('.rv-preset-edit-toggle');
    if (toggle) toggle.style.opacity = this._presetEditMode ? '1' : '0.45';
  }

  _renderDupPresets(el) {
    const presets = this._getDupPresets();
    const list = el.querySelector('.rv-dup-preset-list');
    if (!list) return;
    list.innerHTML = '';
    if (presets.length === 0) {
      list.innerHTML = '<div class="rv-preset-empty">No saved presets yet</div>';
      return;
    }
    presets.forEach((preset, i) => {
      const row = document.createElement('div');
      row.className = 'rv-dup-preset-row';
      if (this._dupPresetEditMode) {
        row.innerHTML = `
          <span class="rv-dup-preset-name-label">${_esc(preset.name)}</span>
          <button type="button" class="rv-dup-preset-del" data-index="${i}" title="Delete">
            <span class="ti ti-trash"></span>
          </button>`;
      } else {
        row.innerHTML = `
          <button type="button" class="rv-dup-preset-load" data-index="${i}">${_esc(preset.name)}</button>`;
      }
      list.appendChild(row);
    });
    const toggle = el.querySelector('.rv-dup-preset-edit-toggle');
    if (toggle) toggle.style.opacity = this._dupPresetEditMode ? '1' : '0.45';
  }

  _bindEvents(el) {
    // Combined search — debounced
    let debounce = null;
    const searchInput = el.querySelector('.rv-search-input');
    searchInput.addEventListener('input', () => {
      this._syncSearchClear(el);
      clearTimeout(debounce);
      debounce = setTimeout(() => this._runSearch(el), 400);
    });
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { clearTimeout(debounce); this._runSearch(el); }
    });
    el.querySelector('.rv-search-clear')?.addEventListener('click', () => {
      searchInput.value = '';
      this._syncSearchClear(el);
      clearTimeout(debounce);
      this._runSearch(el);
      searchInput.focus();
    });

    // Status chips — toggle
    el.querySelector('.rv-status-bar').addEventListener('click', e => {
      const chip = e.target.closest('.rv-chip');
      if (!chip) return;
      chip.classList.toggle('rv-chip--active');
      this._runSearch(el);
    });

    // Date chips — single select
    el.querySelector('.rv-date-bar').addEventListener('click', e => {
      const chip = e.target.closest('.rv-chip');
      if (!chip) return;
      const wasActive = chip.classList.contains('rv-chip--active');
      el.querySelectorAll('.rv-date-bar .rv-chip').forEach(c => c.classList.remove('rv-chip--active'));
      if (!wasActive) chip.classList.add('rv-chip--active');
      this._runSearch(el);
    });

    // Collection checkboxes
    el.querySelector('.rv-col-list').addEventListener('change', () => {
      this._updateTypeSearchCheckboxVisibility(el);
      if (this._panelMode === 'search') this._runSearch(el);
    });

    // Select all / none
    el.querySelector('.rv-col-all').addEventListener('click', () => {
      el.querySelectorAll('.rv-col-list input').forEach(cb => cb.checked = true);
      this._updateTypeSearchCheckboxVisibility(el);
      if (this._panelMode === 'search') this._runSearch(el);
    });
    el.querySelector('.rv-col-none').addEventListener('click', () => {
      el.querySelectorAll('.rv-col-list input').forEach(cb => cb.checked = false);
      this._updateTypeSearchCheckboxVisibility(el);
      if (this._panelMode === 'search') this._runSearch(el);
    });

    el.querySelector('.rv-search-include-type')?.addEventListener('change', () => this._runSearch(el));

    // Journal date clear link
    el.querySelector('.rv-journal-clear')?.addEventListener('click', () => {
      this._setJournalDate(null, el);
    });

    // Journal date nav
    el.querySelector('.rv-journal-date-bar').addEventListener('click', e => {
      const chip = e.target.closest('.rv-jchip');
      const prev = e.target.closest('.rv-journal-prev');
      const next = e.target.closest('.rv-journal-next');

      if (chip) {
        const val = chip.dataset.jdate;
        const base = this._journalDate || (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
        if (val === 'today') {
          const d = new Date(); d.setHours(0,0,0,0);
          chip.classList.add('rv-chip--active');
          this._journalDate = d;
          el.querySelector('.rv-journal-label').textContent =
            d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
          this._runSearch(el);
        } else if (val === 'lastwk') {
          const d = new Date(base); d.setDate(d.getDate() - 7);
          this._setJournalDate(d, el);
        } else if (val === 'nextwk') {
          const d = new Date(base); d.setDate(d.getDate() + 7);
          this._setJournalDate(d, el);
        }
      } else if (prev) {
        const base = this._journalDate || (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
        const d = new Date(base); d.setDate(d.getDate() - 1);
        this._setJournalDate(d, el);
      } else if (next) {
        const base = this._journalDate || (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
        const d = new Date(base); d.setDate(d.getDate() + 1);
        this._setJournalDate(d, el);
      }
    });

    // Save preset
    el.querySelector('.rv-preset-save').addEventListener('click', () => {
      const nameInput = el.querySelector('.rv-preset-name');
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const presets = this._getPresets();
      presets.push({ name, state: this._getFilterState(el) });
      this._savePresets(presets);
      nameInput.value = '';
      this._renderPresets(el);
    });

    // Load presets
    el.querySelector('.rv-preset-list').addEventListener('click', e => {
      const loadBtn = e.target.closest('.rv-preset-load');
      const delBtn  = e.target.closest('.rv-preset-del');
      if (loadBtn) {
        const idx = parseInt(loadBtn.dataset.index);
        if (!isNaN(idx)) this._applyFilterState(el, this._getPresets()[idx].state);
      } else if (delBtn) {
        const idx = parseInt(delBtn.dataset.index);
        if (isNaN(idx)) return;
        const presets = this._getPresets();
        presets.splice(idx, 1);
        this._savePresets(presets);
        this._renderPresets(el);
      }
    });

    // Toggle edit/delete mode
    el.querySelector('.rv-preset-edit-toggle').addEventListener('click', () => {
      this._presetEditMode = !this._presetEditMode;
      this._renderPresets(el);
    });

    el.querySelector('.rv-dup-preset-save')?.addEventListener('click', () => {
      const nameInput = el.querySelector('.rv-dup-preset-name');
      const name = nameInput?.value.trim();
      if (!name) {
        nameInput?.focus();
        return;
      }
      const presets = this._getDupPresets();
      presets.push({ name, state: this._getDupState(el) });
      this._saveDupPresets(presets);
      nameInput.value = '';
      this._renderDupPresets(el);
    });

    el.querySelector('.rv-dup-preset-list')?.addEventListener('click', e => {
      const loadBtn = e.target.closest('.rv-dup-preset-load');
      const delBtn = e.target.closest('.rv-dup-preset-del');
      if (loadBtn) {
        const idx = parseInt(loadBtn.dataset.index, 10);
        if (!isNaN(idx)) void this._applyDupState(el, this._getDupPresets()[idx].state);
      } else if (delBtn) {
        const idx = parseInt(delBtn.dataset.index, 10);
        if (isNaN(idx)) return;
        const presets = this._getDupPresets();
        presets.splice(idx, 1);
        this._saveDupPresets(presets);
        this._renderDupPresets(el);
      }
    });

    el.querySelector('.rv-dup-preset-edit-toggle')?.addEventListener('click', () => {
      this._dupPresetEditMode = !this._dupPresetEditMode;
      this._renderDupPresets(el);
    });

    // Sort (delegated — toolbar is re-rendered after each search)
    el.addEventListener('change', e => {
      if (!e.target.classList?.contains('rv-sort-select')) return;
      const v = e.target.value;
      if (!['modified', 'title', 'collection_modified'].includes(v)) return;
      try { localStorage.setItem(this._sortStorageKey(), v); } catch { /* ignore */ }
      if (this._isJournalResults || !this._matchRecords?.length) return;
      this._matchRecords = _sortRecordsForDisplay(this._matchRecords, v, this._recordColMap);
      this._pageStart = 0;
      this._renderCurrentPage(el);
    });

    el.querySelector('.rv-mode-bar')?.addEventListener('click', e => {
      const btn = e.target.closest('.rv-mode-btn');
      if (!btn?.dataset.mode) return;
      this._setPanelMode(el, btn.dataset.mode);
    });

    el.querySelector('.rv-dup-run')?.addEventListener('click', () => this._runDuplicateAnalysis(el));

    el.querySelector('.rv-compare-open')?.addEventListener('click', () => this._openCompareDiff(el));

    el.querySelector('.rv-compare-clear')?.addEventListener('click', () => {
      this._compareGuids = [];
      this._compareDiffOpen = false;
      this._syncCompareTray(el);
      this._renderCompareMain(el);
    });

    el.querySelector('.rv-compare-tray')?.addEventListener('click', e => {
      const rm = e.target.closest('.rv-compare-rm');
      if (!rm?.dataset.guid) return;
      this._compareGuids = this._compareGuids.filter(g => g !== rm.dataset.guid);
      this._syncCompareTray(el);
    });

    el.querySelector('.rv-dup-kind')?.addEventListener('change', () => this._syncDupKindUI(el));

    el.querySelector('.rv-dup-threshold')?.addEventListener('input', e => {
      const lab = el.querySelector('.rv-dup-threshold-val');
      if (lab) lab.textContent = e.target.value + '%';
    });

    let dupFilterDebounce = null;
    el.querySelector('.rv-dup-filter')?.addEventListener('input', () => {
      clearTimeout(dupFilterDebounce);
      dupFilterDebounce = setTimeout(() => {
        if (this._dupGroups?.length) this._renderDuplicateResults(el, this._dupGroups);
      }, 200);
    });

    let compareFilterDebounce = null;
    el.querySelector('.rv-compare-filter')?.addEventListener('input', () => {
      clearTimeout(compareFilterDebounce);
      compareFilterDebounce = setTimeout(() => {
        if (this._panelMode === 'compare') {
          this._pageStart = 0;
          this._renderCompareMain(el);
        }
      }, 200);
    });
  }

  _syncDupKindUI(el) {
    const k = el.querySelector('.rv-dup-kind')?.value;
    const tw = el.querySelector('.rv-dup-threshold-wrap');
    if (tw) tw.style.display = k === 'title_similar' || k === 'content_similar' ? '' : 'none';
    const vw = el.querySelector('.rv-dup-title-variant-wrap');
    if (vw) vw.style.display = k === 'title_similar' ? 'flex' : 'none';
  }

  _setPanelMode(el, mode) {
    if (!['search', 'duplicates', 'compare'].includes(mode)) return;
    this._panelMode = mode;
    this._compareDiffOpen = false;
    this._applyPanelMode(el);
    if (mode === 'search') {
      this._runSearch(el);
    } else if (mode === 'duplicates') {
      this._dupGroups = null;
      this._renderDuplicatePlaceholder(el);
    } else {
      this._renderCompareMain(el);
    }
  }

  _applyPanelMode(el) {
    const sb = el.querySelector('.rv-sidebar');
    if (!sb) return;
    sb.classList.remove('rv-sidebar--mode-search', 'rv-sidebar--mode-duplicates', 'rv-sidebar--mode-compare');
    sb.classList.add('rv-sidebar--mode-' + this._panelMode);
    el.querySelectorAll('.rv-mode-btn').forEach(b => {
      b.classList.toggle('rv-mode-btn--active', b.dataset.mode === this._panelMode);
    });
    this._syncCompareTray(el);
  }

  _syncCompareTray(el) {
    const tray = el.querySelector('.rv-compare-tray');
    const openBtn = el.querySelector('.rv-compare-open');
    if (!tray) return;
    const guids = this._compareGuids;
    tray.innerHTML = guids
      .map(g => {
        const r = this.data.getRecord(g);
        const name = r ? _truncateDisplay(r.getName() || '(untitled)', 28) : g.slice(0, 8);
        return `<span class="rv-compare-chip"><span class="rv-compare-chip-t">${_esc(name)}</span><button type="button" class="rv-compare-rm" data-guid="${_esc(g)}" title="Remove">×</button></span>`;
      })
      .join('');
    if (openBtn) {
      openBtn.disabled = guids.length < 2;
      openBtn.title = guids.length < 2 ? 'Select at least 2 notes' : 'Open compare view';
    }
  }

  _renderDuplicatePlaceholder(el) {
    const results = el.querySelector('.rv-results');
    if (!results) return;
    results.innerHTML = `<div class="rv-empty"><span class="ti ti-copy"></span><div>Duplicate analysis</div><div class="rv-empty-sub">Choose a kind and threshold, then Run analysis</div></div>`;
  }

  _renderCompareMain(el) {
    if (this._compareDiffOpen) {
      this._renderCompareDiff(el);
      return;
    }
    if (this._panelMode !== 'compare') return;
    const results = el.querySelector('.rv-results');
    if (!results) return;
    if (!this._matchRecords?.length) {
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-columns"></span><div>No results to compare</div><div class="rv-empty-sub">Switch to Search, run a query, then return here and use + on cards</div></div>`;
      return;
    }
    const filterRaw = el.querySelector('.rv-compare-filter')?.value ?? '';
    const { filtered: visible, totalBeforeFilter } = _filterRecordsForCompareDisplay(
      this._matchRecords,
      filterRaw,
      this._recordColMap
    );
    if (!visible.length) {
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-search-off"></span><div>No notes match filter</div><div class="rv-empty-sub">${totalBeforeFilter} hidden — clear Filter list</div></div>`;
      return;
    }
    const sortMode = this._captureSortMode(el);
    const total = visible.length;
    const selectedGuids = new Set(
      [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid)
    );
    this._pageStart = Math.min(this._pageStart, Math.max(0, total - 1));
    const firstBatch = visible.slice(this._pageStart, this._pageStart + this._pageSize);
    const hasFilter = String(filterRaw || '').trim().length > 0;
    const toolbarOpts =
      hasFilter && totalBeforeFilter > total ? { listFilterTotalBefore: totalBeforeFilter } : {};
    Promise.all(firstBatch.map(r => this._buildCard(r, selectedGuids, false, { compareBtn: true }))).then(cards => {
      const validCards = cards.filter(Boolean);
      const toolbar = _resultsToolbarHtml(
        this._pageStart,
        firstBatch.length,
        total,
        this._pageSize,
        this._isJournalResults,
        sortMode,
        toolbarOpts
      );
      results.innerHTML = toolbar + '<div class="rv-cards-list">' + validCards.join('') + '</div>';
    });
  }

  async _runDuplicateAnalysis(el) {
    const results = el.querySelector('.rv-results');
    if (!results) return;
    const kind = el.querySelector('.rv-dup-kind')?.value || 'title_similar';
    const thrEl = el.querySelector('.rv-dup-threshold');
    const threshold = thrEl ? parseInt(thrEl.value, 10) / 100 : 0.85;

    results.innerHTML = `<div class="rv-loading"><span class="rv-spin ti ti-refresh"></span> Scanning…</div>`;

    const records = await this._gatherRecordsForDuplicateScan(el);
    if (records.length === 0) {
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-filter-off"></span><div>No records in selected collections</div></div>`;
      this._dupGroups = null;
      return;
    }
    if (records.length > DUPLICATE_SCAN_MAX_RECORDS) {
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-alert-triangle"></span><div>Too many records (${records.length})</div><div class="rv-empty-sub">Narrow collections (max ${DUPLICATE_SCAN_MAX_RECORDS})</div></div>`;
      this._dupGroups = null;
      return;
    }

    try {
      let groups;
      if (kind === 'title_exact') {
        groups = _duplicateGroupsTitleExact(records);
      } else if (kind === 'title_similar') {
        const includeVariants = !!el.querySelector('.rv-dup-title-variant')?.checked;
        groups = _duplicateGroupsTitleSimilar(records, threshold, includeVariants);
      } else if (kind === 'content_exact') {
        const withText = await _recordsWithBodyText(records);
        groups = _duplicateGroupsContentExact(withText);
      } else {
        if (records.length > CONTENT_SIMILAR_MAX_RECORDS) {
          results.innerHTML = `<div class="rv-empty"><span class="ti ti-alert-triangle"></span><div>Too many records for similar-body scan (${records.length})</div><div class="rv-empty-sub">Narrow collections (max ${CONTENT_SIMILAR_MAX_RECORDS} for this mode)</div></div>`;
          this._dupGroups = null;
          return;
        }
        const withText = await _recordsWithBodyText(records);
        groups = _duplicateGroupsContentSimilar(withText, threshold);
      }
      this._dupGroups = groups;
      this._renderDuplicateResults(el, groups);
    } catch (err) {
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-alert-triangle"></span><div>${_esc(err.message || String(err))}</div></div>`;
      this._dupGroups = null;
    }
  }

  async _gatherRecordsForDuplicateScan(el) {
    const selectedGuids = new Set(
      [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid)
    );
    const out = [];
    for (const col of this._collections) {
      if (!selectedGuids.has(col.getGuid())) continue;
      let recs;
      try {
        recs = await col.getAllRecords();
      } catch {
        continue;
      }
      for (const r of recs) {
        if (!r) continue;
        if (this._isJournalCollectionRecord(r) && _isBlankLastModified(r)) continue;
        out.push(r);
      }
    }
    return out;
  }

  _renderDuplicateResults(el, groups) {
    const results = el.querySelector('.rv-results');
    if (!results) return;
    if (!groups.length) {
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-check"></span><div>No duplicate groups found</div></div>`;
      return;
    }
    const filterRaw = el.querySelector('.rv-dup-filter')?.value ?? '';
    const { filtered, totalBeforeFilter } = _filterDupGroupsForDisplay(groups, filterRaw, this._recordColMap);
    if (!filtered.length) {
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-search-off"></span><div>No groups match filter</div><div class="rv-empty-sub">${totalBeforeFilter} group(s) hidden — clear Filter groups</div></div>`;
      return;
    }
    const totalNotes = filtered.reduce((s, g) => s + g.records.length, 0);
    const selectedGuids = new Set(
      [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid)
    );
    const hasFilter = String(filterRaw || '').trim().length > 0;
    const countText = hasFilter
      ? `${filtered.length} of ${totalBeforeFilter} groups · ${totalNotes} notes`
      : `${filtered.length} groups · ${totalNotes} notes`;
    const head = `<div class="rv-results-toolbar rv-results-toolbar--dup"><div class="rv-count-row"><span class="rv-count">${countText}</span></div></div>`;

    const buildGroup = async g => {
      const cards = await Promise.all(g.records.map(r => this._buildCard(r, selectedGuids, false, { compareBtn: true })));
      const valid = cards.filter(Boolean);
      return `<div class="rv-dup-group">
  <div class="rv-dup-group-head">${_esc(g.label)} <span class="rv-dup-group-n">(${g.records.length})</span></div>
  <div class="rv-cards-list">${valid.join('')}</div>
</div>`;
    };

    Promise.all(filtered.map(buildGroup)).then(parts => {
      results.innerHTML = head + `<div class="rv-dup-groups">${parts.join('')}</div>`;
    });
  }

  _openCompareDiff(el) {
    if (this._compareGuids.length < 2) return;
    this._compareDiffOpen = true;
    this._renderCompareDiff(el);
  }

  async _renderCompareDiff(el) {
    const results = el.querySelector('.rv-results');
    if (!results) return;
    const guids = [...this._compareGuids].slice(0, 3);
    const records = guids.map(g => this.data.getRecord(g)).filter(Boolean);
    if (records.length < 2) {
      this._compareDiffOpen = false;
      this._renderCompareMain(el);
      return;
    }

    const texts = await Promise.all(records.map(r => _extractRecordFullText(r)));
    const titles = records.map(r => r.getName() || '(untitled)');

    if (records.length === 2) {
      const diff = _diffLines(texts[0], texts[1]);
      results.innerHTML = _renderTwoPaneDiffHtml(titles[0], titles[1], diff, records[0].guid, records[1].guid);
      return;
    }

    results.innerHTML = _renderTriplePaneHtml(titles, texts, records.map(r => r.guid));
  }

  async _compareActionOpen(el, searchPanel, guid) {
    const record = this.data.getRecord(guid);
    if (!record) return;
    const newPanel = await this.ui.createPanel({ afterPanel: searchPanel });
    if (newPanel) {
      newPanel.navigateTo({
        type: 'edit_panel',
        rootId: record.guid,
        subId: null,
        workspaceGuid: this.getWorkspaceGuid(),
      });
    }
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async _runSearch(el) {
    if (this._panelMode !== 'search') return;
    const sortMode = this._captureSortMode(el);
    const results = el.querySelector('.rv-results');
    results.innerHTML = `<div class="rv-loading"><span class="rv-spin ti ti-refresh"></span> Searching…</div>`;

    // Build query string
    const parts = [];

    const raw = el.querySelector('.rv-search-input').value.trim();
    const thymerCollectionScope = _searchStringUsesThymerCollectionScope(raw);
    // When @collection=… is in the box, Thymer scopes the search — don’t filter again by sidebar checkboxes.
    this._filterRecordsByCollectionCheckboxes = !thymerCollectionScope;

    // Pass search text verbatim to Thymer (preserves OR/AND/NOT, ===, !=, #tags, etc.)
    if (raw) parts.push(raw);
    const { texts: textsForType, tags: tagsForType } = _tokensForTypeMerge(raw);

    const activeStatuses = [...el.querySelectorAll('.rv-status-bar .rv-chip--active')]
      .map(c => c.dataset.status);
    activeStatuses.forEach(s => parts.push('@' + s));

    const activeDateChip = el.querySelector('.rv-date-bar .rv-chip--active');
    if (activeDateChip) parts.push(activeDateChip.dataset.date);

    // Status + tagged date only (for intersecting “include #types” merges with the same filters)
    const filterPartsOnly = [];
    activeStatuses.forEach(s => filterPartsOnly.push('@' + s));
    if (activeDateChip) filterPartsOnly.push(activeDateChip.dataset.date);
    const filterQueryStructured = filterPartsOnly.join(' ').trim();

    // Selected collection GUIDs
    const selectedGuids = new Set(
      [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid)
    );
    const selectedGuidsForTypeMerge = thymerCollectionScope
      ? new Set(this._collections.map(c => c.getGuid()))
      : selectedGuids;

    // If no collections selected, show empty (unless Thymer query already scopes @collection=…)
    if (selectedGuids.size === 0) {
      if (!thymerCollectionScope || !raw.trim()) {
        this._matchRecords = [];
        results.innerHTML = `<div class="rv-empty"><span class="ti ti-filter-off"></span><div>No collections selected</div></div>`;
        return;
      }
    }

    const query = parts.join(' ').trim();

    // If journal date is active, find journal records for that date across selected collections
    if (this._journalDate) {
      this._filterRecordsByCollectionCheckboxes = true;
      const users = this.data.getActiveUsers();
      const journalCols = this._collections.filter(c =>
        c.isJournalPlugin() && selectedGuids.has(c.getGuid())
      );
      const journalRecords = await Promise.all(
        journalCols.flatMap(col =>
          users.map(user => {
            const d = this._journalDate;
            const dt = DateTime.dateOnly(d.getFullYear(), d.getMonth(), d.getDate());
            return col.getJournalRecord(user, dt);
          })
        )
      );
      const filtered = this._filterJournalDateRecords(journalRecords);
      if (filtered.length === 0) {
        this._matchRecords = [];
        results.innerHTML = `<div class="rv-empty"><span class="ti ti-calendar-off"></span><div>No journal entry for this date</div></div>`;
        return;
      }
      this._matchRecords = filtered;
      this._isJournalResults = true;
      this._pageStart = 0;
      const total = filtered.length;
      const firstBatch = filtered.slice(0, this._pageSize);
      const cards = await Promise.all(firstBatch.map(r => this._buildCard(r, selectedGuids, true, { compareBtn: true })));
      const validCards = cards.filter(Boolean);
      const toolbar = _resultsToolbarHtml(this._pageStart, firstBatch.length, total, this._pageSize, true, sortMode);
      results.innerHTML = toolbar + '<div class="rv-cards-list">' + validCards.join('') + '</div>';
      return;
    }

    let records = [];

    if (!query) {
      // No filters active — pull directly from pre-built map, filtered by selected collections
      const allGuids = Object.keys(this._recordColMap)
        .filter(guid => selectedGuids.has(this._recordColMap[guid].colGuid));
      records = allGuids.map(guid => this.data.getRecord(guid)).filter(Boolean);
    } else {
      // Run search query then filter to selected collections
      const includeTypeSearch =
        !!el.querySelector('.rv-search-include-type')?.checked
        && this._selectedCollectionsHaveTypeField(selectedGuidsForTypeMerge);
      const wantTypeMerge =
        includeTypeSearch
        && query.trim().length > 0
        && (textsForType.length > 0 || tagsForType.length > 0);

      const addSearchResults = (searchResults, seen) => {
        for (const record of searchResults.records || []) {
          if (!record || seen.has(record.guid)) continue;
          seen.add(record.guid);
          records.push(record);
        }
        for (const li of searchResults.lines || []) {
          const record = li.getRecord();
          if (!record || seen.has(record.guid)) continue;
          seen.add(record.guid);
          records.push(record);
        }
      };

      try {
        const searchResults = await this.data.searchByQuery(query, 500);
        const seen = new Set();
        addSearchResults(searchResults, seen);

        if (_debugSearchEnabled()) {
          _logSearchDebug('after searchByQuery merge', {
            pluginVersion: PLUGIN_VERSION,
            query,
            wantTypeMerge,
            includeTypeSearch,
            recsArrayLen: (searchResults.records || []).length,
            linesArrayLen: (searchResults.lines || []).length,
            mergedRecordCount: records.length,
          });
        }

        // Type-field merges only match words/#tags; they must also satisfy task + tagged date
        // (same tokens run alone through Thymer), or they would bypass @today / @due / status.
        let filterSetForTypeMerge = null;
        if (wantTypeMerge && filterQueryStructured) {
          const fr = await this.data.searchByQuery(filterQueryStructured, 5000);
          filterSetForTypeMerge = _guidsFromSearchResults(fr);
        }

        if (wantTypeMerge) {
          const beforeType = records.length;
          const typeHits = await this._recordsMatchingTypeField(textsForType, tagsForType, selectedGuidsForTypeMerge);
          for (const r of typeHits) {
            if (seen.has(r.guid)) continue;
            if (filterSetForTypeMerge && !filterSetForTypeMerge.has(r.guid)) continue;
            seen.add(r.guid);
            records.push(r);
          }
          if (_debugSearchEnabled()) {
            _logSearchDebug('include #types merge', {
              beforeTypeMerge: beforeType,
              afterTypeMerge: records.length,
              added: records.length - beforeType,
            });
          }
        }
      } catch (err) {
        this._matchRecords = [];
        results.innerHTML = `<div class="rv-empty"><span class="ti ti-alert-triangle"></span><div>${_esc(err.message)}</div></div>`;
        return;
      }

      // Filter to selected collections (skip when query uses @collection=… for Thymer-side scope)
      if (this._filterRecordsByCollectionCheckboxes) {
        records = records.filter(r => {
          const meta = this._recordColMap[r.guid];
          return meta && selectedGuids.has(meta.colGuid);
        });
      } else {
        records = records.filter(r => this._recordColMap[r.guid]);
      }

      if (_debugSearchEnabled()) {
        _logSearchDebug('after sidebar / map filter', {
          filterBySidebarCheckboxes: this._filterRecordsByCollectionCheckboxes,
          count: records.length,
        });
      }
    }

    // Drop journal records with no real "Last modified" (same as UI "—"); those are empty journal shells.
    const filtered = records.filter(
      r => !(this._isJournalCollectionRecord(r) && _isBlankLastModified(r))
    );

    if (filtered.length === 0) {
      this._matchRecords = [];
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-search-off"></span><div>No records found</div><div class="rv-empty-sub">Try adjusting your filters</div></div>`;
      return;
    }

    if (_debugSearchEnabled()) {
      _logSearchDebug('final (after blank-journal shell filter)', { count: filtered.length });
    }

    const sorted = _sortRecordsForDisplay(filtered, sortMode, this._recordColMap);
    this._matchRecords = sorted;
    this._isJournalResults = false;
    this._pageStart = 0;
    const total = sorted.length;
    const firstBatch = sorted.slice(0, this._pageSize);
    const cards = await Promise.all(firstBatch.map(r => this._buildCard(r, selectedGuids, false, { compareBtn: true })));
    const validCards = cards.filter(Boolean);
    const toolbar = _resultsToolbarHtml(this._pageStart, firstBatch.length, total, this._pageSize, false, sortMode);
    results.innerHTML = toolbar + '<div class="rv-cards-list">' + validCards.join('') + '</div>';
  }

  /**
   * @param {boolean} [expandPreview] - When true (journal date mode), card starts with preview expanded.
   * @param {{ compareBtn?: boolean }} [opts]
   */
  async _buildCard(record, selectedGuids, expandPreview = false, opts = {}) {
    // Fast O(1) lookup using pre-built map
    const meta = this._recordColMap[record.guid];
    const colName = meta ? meta.colName : '';
    const colIcon = meta ? meta.colIcon : 'file-text';
    const colGuid = meta ? meta.colGuid : null;

    // Filter by sidebar collections (skipped when search used @collection=…)
    if (this._filterRecordsByCollectionCheckboxes && colGuid && !selectedGuids.has(colGuid)) return null;

    // Full text excerpt for expanded preview (many lines)
    const previewChunks = [];
    try {
      const lines = await record.getLineItems(false);
      const textLines = lines.filter(li =>
        ['text', 'task', 'heading', 'quote'].includes(li.type) && li.segments?.length
      );
      for (const li of textLines) {
        const t = li.segments
          .filter(s => s.type === 'text' || s.type === 'bold' || s.type === 'italic')
          .map(s => typeof s.text === 'string' ? s.text : '')
          .join('')
          .trim();
        if (t) previewChunks.push(t);
        if (previewChunks.length >= PREVIEW_MAX_LINE_ITEMS) break;
      }
    } catch { /* no preview */ }
    const previewText = previewChunks.join('\n\n');

    const updatedAt = record.getUpdatedAt();

    // Drop collection fields that mirror record created/modified (prevents duplicate dates in expanded view).
    const props = record.getAllProperties().filter(p => !_isBuiltinTimestampProperty(p));
    const propChips = props
      .map(p => {
        const val = _propDisplayExpanded(p, record);
        if (!val) return '';
        return `<span class="rv-prop-chip"><span class="rv-prop-label">${_esc(p.field?.label || p.name || '')}</span><span class="rv-prop-val">${_esc(val)}</span></span>`;
      })
      .filter(Boolean)
      .join('');

    // One line only: last modified (canonical record time; avoids repeating created + modified).
    const datesBlock = `
  <div class="rv-card-date-block">
    <div class="rv-card-date-line"><span class="rv-card-date-label">Last modified</span> ${_fmtDateTime(updatedAt)}</div>
  </div>`;

    const previewBlock = previewText
      ? `<div class="rv-card-preview-text" style="--rv-preview-lines:${PREVIEW_MAX_DISPLAY_LINES}">${_esc(previewText)}</div>`
      : '';

    const propsBlock = propChips
      ? `<div class="rv-card-props">${propChips}</div>`
      : '';

    const icon = record.getIcon(true) || ('ti-' + colIcon);
    const name = record.getName() || '(untitled)';
    const timePart = updatedAt
      ? `<span class="rv-card-time-sep"> · </span><span class="rv-card-time">${_esc(_fmtRel(updatedAt))}</span>`
      : '';

    const compareBtn = opts.compareBtn
      ? `<button type="button" class="rv-card-compare-add" data-record-guid="${record.guid}" title="Add to compare">+</button>`
      : '';

    const openClass = expandPreview ? ' rv-card--preview-open' : '';
    return `
<div class="rv-card has-expandable${openClass}" data-record-guid="${record.guid}">
  <div class="rv-card-header">
    <button type="button" class="rv-card-preview-toggle" aria-label="Toggle details" title="Details" aria-expanded="${expandPreview ? 'true' : 'false'}">
      <span class="rv-card-preview-chevron ti ti-chevron-right"></span>
    </button>
    <div class="rv-card-icon"><span class="ti ${icon}"></span></div>
    <div class="rv-card-main">
      <div class="rv-card-one-line">
        <span class="rv-card-title">${_esc(name)}</span><span class="rv-card-col-bracket"> [${_esc(_truncateDisplay(colName, COLLECTION_NAME_IN_CARD_MAX))}]</span>${timePart}
      </div>
    </div>
    ${compareBtn}
  </div>
  <div class="rv-card-preview-inner">
    ${datesBlock}
    ${previewBlock}
    ${propsBlock}
  </div>
</div>`;
  }

  _bindCardActions(el, searchPanel) {
    el.querySelector('.rv-results').addEventListener('click', async e => {
      if (e.target.closest('.rv-compare-back')) {
        e.preventDefault();
        this._compareDiffOpen = false;
        if (this._panelMode === 'compare') await this._renderCompareMain(el);
        return;
      }
      if (e.target.closest('.rv-compare-action-open')) {
        e.stopPropagation();
        const btn = e.target.closest('.rv-compare-action-open');
        const guid = btn?.dataset.recordGuid;
        if (guid) await this._compareActionOpen(el, searchPanel, guid);
        return;
      }
      if (e.target.closest('.rv-card-compare-add')) {
        e.stopPropagation();
        const btn = e.target.closest('.rv-card-compare-add');
        const guid = btn?.dataset.recordGuid;
        if (guid && !this._compareGuids.includes(guid) && this._compareGuids.length < 3) {
          this._compareGuids.push(guid);
          this._syncCompareTray(el);
        }
        return;
      }
      if (e.target.closest('.rv-load-prev')) {
        e.stopPropagation();
        await this._loadPrevPage(el);
        return;
      }
      if (e.target.closest('.rv-load-next')) {
        e.stopPropagation();
        await this._loadNextPage(el);
        return;
      }
      if (e.target.closest('.rv-page-size')) {
        e.stopPropagation();
        const btn = e.target.closest('.rv-page-size');
        const size = parseInt(btn.dataset.size, 10);
        if ([40, 50, 60].includes(size)) {
          this._pageSize = size;
          try {
            localStorage.setItem('rv_page_size_' + this.getWorkspaceGuid(), String(size));
          } catch { /* ignore */ }
          if (this._panelMode === 'compare') await this._renderCompareMain(el);
          else await this._runSearch(el);
        }
        return;
      }
      if (e.target.closest('.rv-expand-all')) {
        e.stopPropagation();
        el.querySelectorAll('.rv-cards-list .rv-card.has-expandable').forEach(c => {
          c.classList.add('rv-card--preview-open');
          const btn = c.querySelector('.rv-card-preview-toggle');
          if (btn) btn.setAttribute('aria-expanded', 'true');
        });
        return;
      }
      if (e.target.closest('.rv-collapse-all')) {
        e.stopPropagation();
        el.querySelectorAll('.rv-cards-list .rv-card.has-expandable').forEach(c => {
          c.classList.remove('rv-card--preview-open');
          const btn = c.querySelector('.rv-card-preview-toggle');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        });
        return;
      }
      if (e.target.closest('.rv-card-preview-toggle')) {
        e.stopPropagation();
        const card = e.target.closest('.rv-card');
        if (card) {
          card.classList.toggle('rv-card--preview-open');
          const btn = card.querySelector('.rv-card-preview-toggle');
          if (btn) {
            btn.setAttribute('aria-expanded', card.classList.contains('rv-card--preview-open') ? 'true' : 'false');
          }
        }
        return;
      }
      const card = e.target.closest('.rv-card');
      if (!card) return;
      const guid = card.dataset.recordGuid;
      const record = this.data.getRecord(guid);
      if (!record) return;
      const newPanel = await this.ui.createPanel({ afterPanel: searchPanel });
      if (newPanel) newPanel.navigateTo({
        type: 'edit_panel',
        rootId: record.guid,
        subId: null,
        workspaceGuid: this.getWorkspaceGuid(),
      });
    });
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TASK_STATUSES = [
  { value: 'task',      label: 'All tasks',  color: '#94a3b8' },
  { value: 'done',      label: 'Done',       color: '#22c55e' },
  { value: 'started',   label: 'Started',    color: '#3b82f6' },
  { value: 'important', label: 'Important',  color: '#f97316' },
  { value: 'waiting',   label: 'Waiting',    color: '#a855f7' },
  { value: 'discuss',   label: 'Discuss',    color: '#06b6d4' },
  { value: 'alert',     label: 'Alert',      color: '#ef4444' },
  { value: 'starred',   label: 'Starred',    color: '#eab308' },
];

const DATE_FILTERS = [
  { value: '@today',        label: 'Today'     },
  { value: '@tomorrow',     label: 'Tomorrow'  },
  { value: '@week',         label: 'This week' },
  { value: '@due',          label: 'Due'       },
  { value: '@overdue',      label: 'Overdue'   },
];

/** Max Thymer line items pulled into the body preview (text/task/heading/quote). */
const PREVIEW_MAX_LINE_ITEMS = 24;
/** Visible lines shown for body preview (clips with overflow; matches line-height 1.5). */
const PREVIEW_MAX_DISPLAY_LINES = 6;
/** Max characters for collection name inside `[ ]` on the card title line. */
const COLLECTION_NAME_IN_CARD_MAX = 10;

/** Truncate for display; adds `…` when shortened. */
function _truncateDisplay(str, maxLen) {
  const s = String(str ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

/**
 * Tokens excluded from "include #types" needle extraction only (Thymer query is unchanged).
 * Matches whole whitespace-separated tokens: booleans, && || !, comparison operators.
 */
const _TYPE_MERGE_RESERVED = new Set([
  'or', 'and', 'not', '||', '&&', '!',
  '=', '===', '!=', '<', '<=', '>', '>=',
]);

/**
 * Split raw search text for Type-field merge: #tags + non-reserved words.
 * Does not alter what is sent to searchByQuery.
 */
function _tokensForTypeMerge(raw) {
  const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const tags = words.filter(w => w.startsWith('#'));
  const texts = words.filter(w => {
    if (w.startsWith('#')) return false;
    if (_TYPE_MERGE_RESERVED.has(w)) return false;
    if (_TYPE_MERGE_RESERVED.has(w.toLowerCase())) return false;
    return true;
  });
  return { texts, tags };
}

/** True if the user is using Thymer’s @collection=… scope in the search box (don’t filter by local checkboxes). */
function _searchStringUsesThymerCollectionScope(raw) {
  return typeof raw === 'string' && /@collection\s*=/.test(raw);
}

/** Opt-in: `localStorage.setItem('rv_debug_search', '1')` then reload; logs search pipeline counts to the console. */
function _debugSearchEnabled() {
  try {
    return localStorage.getItem('rv_debug_search') === '1';
  } catch {
    return false;
  }
}

function _logSearchDebug(stage, payload) {
  try {
    console.log(`[${PLUGIN_NAME}]`, stage, payload);
  } catch {
    /* ignore */
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Collect record GUIDs from a searchByQuery result (records + line hits). */
function _guidsFromSearchResults(searchResults) {
  const s = new Set();
  if (searchResults?.records) {
    for (const record of searchResults.records) {
      if (record?.guid) s.add(record.guid);
    }
  }
  if (searchResults?.lines) {
    for (const li of searchResults.lines) {
      try {
        const record = li.getRecord?.();
        if (record?.guid) s.add(record.guid);
      } catch { /* ignore */ }
    }
  }
  return s;
}

const _SORT_MODES = ['modified', 'title', 'collection_modified'];

/** Milliseconds since epoch for sorting, or `null` if no usable last modified. */
function _recordSortTimeMs(record) {
  let d;
  try {
    d = record.getUpdatedAt();
  } catch {
    return null;
  }
  if (d == null) return null;
  if (typeof d === 'number') d = new Date(d);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

function _recordTitleSort(record) {
  try {
    return String(record.getName() || '').toLowerCase().trim();
  } catch {
    return '';
  }
}

function _recordCollectionNameSort(record, recordColMap) {
  const m = recordColMap[record.guid];
  return String(m?.colName || '').toLowerCase().trim();
}

function _cmpGuid(a, b) {
  return String(a.guid).localeCompare(String(b.guid));
}

/** Last modified descending; missing date last; tiebreak title then guid. */
function _cmpModifiedDesc(a, b) {
  const ta = _recordSortTimeMs(a);
  const tb = _recordSortTimeMs(b);
  const aOk = ta !== null;
  const bOk = tb !== null;
  if (aOk && bOk && ta !== tb) return tb - ta;
  if (aOk && !bOk) return -1;
  if (!aOk && bOk) return 1;
  const t = _recordTitleSort(a).localeCompare(_recordTitleSort(b), undefined, { sensitivity: 'base' });
  if (t !== 0) return t;
  return _cmpGuid(a, b);
}

/** Title A–Z; tiebreak guid. */
function _cmpTitleAsc(a, b) {
  const t = _recordTitleSort(a).localeCompare(_recordTitleSort(b), undefined, { sensitivity: 'base' });
  if (t !== 0) return t;
  return _cmpGuid(a, b);
}

/** Collection name A–Z, then last modified desc (same null rules), then title. */
function _cmpCollectionThenModified(a, b, recordColMap) {
  const ca = _recordCollectionNameSort(a, recordColMap);
  const cb = _recordCollectionNameSort(b, recordColMap);
  const c = ca.localeCompare(cb, undefined, { sensitivity: 'base' });
  if (c !== 0) return c;
  return _cmpModifiedDesc(a, b);
}

/**
 * Stable sort for result list (mixed collections including journals).
 * @param {'modified'|'title'|'collection_modified'} mode
 */
function _sortRecordsForDisplay(records, mode, recordColMap) {
  const m = _SORT_MODES.includes(mode) ? mode : 'modified';
  const out = [...records];
  if (m === 'title') {
    out.sort(_cmpTitleAsc);
  } else if (m === 'collection_modified') {
    out.sort((a, b) => _cmpCollectionThenModified(a, b, recordColMap));
  } else {
    out.sort(_cmpModifiedDesc);
  }
  return out;
}

/** Plural label for "Showing X of Y …" */
function _countNoun(total, isJournal) {
  if (isJournal) return total === 1 ? 'journal entry' : 'journal entries';
  return total === 1 ? 'record' : 'records';
}

/** e.g. "Showing 1–50 of 237 records" or "Showing 51 of 51 records". */
function _countRangeLabel(pageStart, batchLen, total, isJournal) {
  const noun = _countNoun(total, isJournal);
  if (total === 0 || batchLen === 0) return '';
  const a = pageStart + 1;
  const b = pageStart + batchLen;
  if (a === b) return `Showing ${a} of ${total} ${noun}`;
  return `Showing ${a}–${b} of ${total} ${noun}`;
}

/** Prev/next row (empty string if neither applies). */
function _renderLoadMoreBar(hasPrev, hasNext) {
  if (!hasPrev && !hasNext) return '';
  const prev = hasPrev
    ? '<button type="button" class="rv-link rv-load-prev">Load previous</button>'
    : '';
  const next = hasNext
    ? '<button type="button" class="rv-link rv-load-next">Load next</button>'
    : '';
  return `<div class="rv-load-more-bar">${prev}${next}</div>`;
}

/** Toolbar: count, per-page (40/50/60), expand/collapse, sort (non-journal), load previous/next. */
function _resultsToolbarHtml(pageStart, batchLen, total, pageSize, isJournal, sortMode = 'modified', opts = {}) {
  const { listFilterTotalBefore } = opts;
  let rangeText = _countRangeLabel(pageStart, batchLen, total, isJournal);
  if (listFilterTotalBefore != null && listFilterTotalBefore > total) {
    rangeText += ` <span class="rv-filter-meta">(${listFilterTotalBefore} total before filter)</span>`;
  }
  const sizes = [40, 50, 60].map(n =>
    `<button type="button" class="rv-link rv-page-size${n === pageSize ? ' rv-link--active' : ''}" data-size="${n}">${n}</button>`
  ).join('<span>·</span>');
  const hasPrev = pageStart > 0;
  const hasNext = pageStart + batchLen < total;
  const sortRow = isJournal
    ? ''
    : `<div class="rv-toolbar-sort">
    <span class="rv-sort-label">Sort</span>
    <select class="rv-sort-select" title="Order of results" aria-label="Sort results">
      <option value="modified"${sortMode === 'modified' ? ' selected' : ''}>Modified (newest first)</option>
      <option value="title"${sortMode === 'title' ? ' selected' : ''}>Title (A–Z)</option>
      <option value="collection_modified"${sortMode === 'collection_modified' ? ' selected' : ''}>Collection, then modified</option>
    </select>
  </div>`;
  return `<div class="rv-results-toolbar">
  <div class="rv-count-row">
    <span class="rv-count">${rangeText}</span>
    <span class="rv-col-actions">
      <span class="rv-page-per">Per page</span>
      ${sizes}
      <span>·</span>
      <button type="button" class="rv-link rv-expand-all">expand all</button>
      <span>·</span>
      <button type="button" class="rv-link rv-collapse-all">collapse all</button>
    </span>
  </div>
  ${sortRow}
  ${_renderLoadMoreBar(hasPrev, hasNext)}
</div>`;
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _fmtRel(date) {
  if (!date) return '';
  const diff = Date.now() - date;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7)  return `${d}d ago`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function _fmtDateTime(date) {
  if (!date) return '—';
  try {
    return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '—';
  }
}

/** Strip optional leading # and lowercase for field id/label comparison. */
function _normalizePropertyFieldName(s) {
  let t = String(s || '').trim().toLowerCase();
  if (t.startsWith('#')) t = t.slice(1);
  return t;
}

/** True if field id/label is "type" or "types" (optional leading #, e.g. #type). */
function _fieldNameIsTypeOrTypes(idOrLabel) {
  const n = _normalizePropertyFieldName(idOrLabel);
  return n === 'type' || n === 'types';
}

/**
 * Field id + label keys for a **choice** property named type or types.
 */
function _typeChoiceFieldKeysForCollection(col) {
  const fields = col.getConfiguration?.()?.fields;
  if (!Array.isArray(fields)) return [];
  const keys = [];
  for (const f of fields) {
    if (!f || f.active === false) continue;
    const t = String(f.type || '').toLowerCase();
    if (t !== 'choice') continue;
    if (!_fieldNameIsTypeOrTypes(f.id) && !_fieldNameIsTypeOrTypes(f.label)) continue;
    if (f.id) keys.push(String(f.id));
    if (f.label) keys.push(String(f.label));
  }
  return [...new Set(keys)];
}

/**
 * Needles to match against Type choice labels/ids: plain words plus each #tag as `tag` and `#tag`.
 */
function _typeSearchNeedles(texts, tags) {
  const set = new Set();
  for (const w of texts) {
    const x = String(w).toLowerCase().trim();
    if (x) set.add(x);
  }
  for (const raw of tags) {
    const t = String(raw).trim();
    if (!t.startsWith('#')) continue;
    const inner = t.slice(1).toLowerCase().trim();
    if (!inner) continue;
    set.add(inner);
    set.add('#' + inner);
  }
  return [...set];
}

/** Lowercased searchable blob from Type **choice** field(s): labels, ids, text fallbacks. */
function _recordTypeChoiceFieldBlob(record, keys) {
  const chunks = [];
  const push = v => {
    if (v != null && String(v).trim()) chunks.push(String(v).trim());
  };
  for (const key of keys) {
    try {
      const pr = record.prop(key);
      if (!pr) continue;
      try {
        push(pr.choiceLabel?.());
      } catch { /* ignore */ }
      try {
        const labs = pr.selectedChoiceLabels?.();
        if (labs?.length) labs.forEach(l => push(l));
      } catch { /* ignore */ }
      try {
        const ids = pr.selectedChoices?.();
        if (ids?.length) ids.forEach(id => push(id));
      } catch { /* ignore */ }
      try {
        const c = pr.choice?.();
        if (c) push(c);
      } catch { /* ignore */ }
      try {
        push(pr.text?.());
      } catch { /* ignore */ }
      try {
        const txts = pr.texts?.();
        if (txts?.length) txts.forEach(t => push(t));
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }
  return [...new Set(chunks)].join(' ').toLowerCase();
}

/** Collection has an active choice field named type or types. */
function _collectionHasTypeField(col) {
  return _typeChoiceFieldKeysForCollection(col).length > 0;
}

/**
 * True when Last modified would render as "—" in the card (_fmtDateTime), i.e. no usable updated time.
 * Used to exclude empty journal placeholder records from results.
 */
function _isBlankLastModified(record) {
  let d;
  try {
    d = record.getUpdatedAt();
  } catch {
    return true;
  }
  if (d == null) return true;
  if (typeof d === 'number') d = new Date(d);
  if (!(d instanceof Date)) return true;
  if (Number.isNaN(d.getTime())) return true;
  try {
    d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    return false;
  } catch {
    return true;
  }
}

/** Hide props that duplicate the record's built-in created/updated timestamps. */
function _isBuiltinTimestampProperty(prop) {
  const label = String(prop.field?.label || prop.name || '').toLowerCase().trim();
  const id = String(prop.field?.id || prop.name || '').toLowerCase().trim();
  if (!label && !id) return false;
  const created = /^(created|created\s+at|date\s+created|created\s+date)$/.test(label)
    || /^(created|createdat|date_created|created_date)$/.test(id);
  const modified = /^(modified|updated|updated\s+at|last\s+modified|date\s+modified)$/.test(label)
    || /^(modified|updated|updatedat|lastmodified|date_modified)$/.test(id);
  return created || modified;
}

/** Longer values for expanded card details. */
function _propDisplayExpanded(prop, record) {
  try {
    const name = prop.field?.label || prop.name || '';
    if (!name) return null;
    const date = record.date(name);
    if (date) return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const num = record.number(name);
    if (num != null) return String(num);
    const txt = record.text(name);
    if (txt) return txt.length > 800 ? txt.slice(0, 800) + '…' : txt;
    return null;
  } catch { return null; }
}

// ─── Duplicates & compare helpers ───────────────────────────────────────────

class _UnionFind {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i) {
    return this.p[i] === i ? i : (this.p[i] = this.find(this.p[i]));
  }
  union(a, b) {
    const pa = this.find(a);
    const pb = this.find(b);
    if (pa !== pb) this.p[pa] = pb;
  }
}

function _normalizeTitleForDup(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function _lev(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}

function _titleSimilarity(a, b) {
  const na = _normalizeTitleForDup(a);
  const nb = _normalizeTitleForDup(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const d = _lev(na, nb);
  const mx = Math.max(na.length, nb.length);
  return mx ? 1 - d / mx : 1;
}

/** Jaccard similarity on whitespace-separated words (lowercased). */
function _jaccardTitleWords(na, nb) {
  const wa = na.split(/\s+/).filter(Boolean).map(w => w.toLowerCase());
  const wb = nb.split(/\s+/).filter(Boolean).map(w => w.toLowerCase());
  const setA = new Set(wa);
  const setB = new Set(wb);
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const uni = setA.size + setB.size - inter;
  return uni ? inter / uni : 0;
}

/** Longest common prefix length / max(length). */
function _lcpTitleRatio(na, nb) {
  const m = Math.min(na.length, nb.length);
  let lcp = 0;
  for (let i = 0; i < m; i++) {
    if (na[i] === nb[i]) lcp++;
    else break;
  }
  const mx = Math.max(na.length, nb.length);
  return mx ? lcp / mx : 1;
}

/**
 * 1 if one title’s words are a full prefix of the other’s (e.g. "A B" vs "A B Registration").
 * Avoids substring traps like "9" vs "91" (word-by-word match only).
 */
function _titleWordPrefixVariantScore(na, nb) {
  const a = na.split(/\s+/).filter(Boolean);
  const b = nb.split(/\s+/).filter(Boolean);
  if (!a.length || !b.length) return 0;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length > longer.length) return 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) return 0;
  }
  return shorter.length < longer.length ? 1 : 0;
}

/**
 * Similar title score. When `includeVariants` is true, also considers word-prefix variants,
 * token overlap, and common-prefix ratio (helps "Short title" vs "Short title Registration").
 */
function _titleSimilarityDup(a, b, includeVariants) {
  const base = _titleSimilarity(a, b);
  if (!includeVariants) return base;
  const na = _normalizeTitleForDup(a);
  const nb = _normalizeTitleForDup(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return base;
  if (na === nb) return 1;
  const wp = _titleWordPrefixVariantScore(na, nb);
  const jac = _jaccardTitleWords(na, nb);
  const lcp = _lcpTitleRatio(na, nb);
  return Math.max(base, wp, jac, lcp);
}

function _duplicateGroupsTitleExact(records) {
  const map = new Map();
  for (const r of records) {
    let name = '';
    try {
      name = _normalizeTitleForDup(r.getName());
    } catch { /* ignore */ }
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(r);
  }
  const groups = [];
  for (const recs of map.values()) {
    if (recs.length < 2) continue;
    let raw = '';
    try {
      raw = recs[0].getName() || '';
    } catch { /* ignore */ }
    const label = raw ? `Same titles: "${_truncateDisplay(raw, 56)}"` : 'Same titles (empty)';
    groups.push({ label, records: recs });
  }
  groups.sort((a, b) => b.records.length - a.records.length);
  return groups;
}

function _duplicateGroupsTitleSimilar(records, threshold, includeVariants = false) {
  const n = records.length;
  if (n < 2) return [];
  const uf = new _UnionFind(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let na;
      let nb;
      try {
        na = records[i].getName();
        nb = records[j].getName();
      } catch {
        continue;
      }
      if (_titleSimilarityDup(na, nb, includeVariants) >= threshold) uf.union(i, j);
    }
  }
  const buck = new Map();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    if (!buck.has(r)) buck.set(r, []);
    buck.get(r).push(records[i]);
  }
  const groups = [];
  for (const g of buck.values()) {
    if (g.length < 2) continue;
    let rep = '';
    try {
      rep = g[0].getName() || '';
    } catch { /* ignore */ }
    const vTag = includeVariants ? ' · prefix/extra words' : '';
    const label = `Similar titles (${Math.round(threshold * 100)}%+${vTag}): "${_truncateDisplay(rep, 48)}"`;
    groups.push({ label, records: g });
  }
  groups.sort((a, b) => b.records.length - a.records.length);
  return groups;
}

function _normalizeBodyForHash(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

async function _extractRecordFullText(record) {
  const chunks = [];
  try {
    const lines = await record.getLineItems(false);
    const textLines = lines.filter(li =>
      ['text', 'task', 'heading', 'quote'].includes(li.type) && li.segments?.length
    );
    for (const li of textLines) {
      const t = li.segments
        .filter(s => s.type === 'text' || s.type === 'bold' || s.type === 'italic')
        .map(s => typeof s.text === 'string' ? s.text : '')
        .join('')
        .trim();
      if (t) chunks.push(t);
    }
  } catch { /* skip */ }
  return chunks.join('\n');
}

async function _recordsWithBodyText(records) {
  const out = [];
  for (const r of records) {
    const body = await _extractRecordFullText(r);
    out.push({ record: r, body });
  }
  return out;
}

function _hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return String(h >>> 0);
}

function _duplicateGroupsContentExact(withText) {
  const map = new Map();
  for (const { record, body } of withText) {
    const k = _hashStr(_normalizeBodyForHash(body));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(record);
  }
  const groups = [];
  for (const recs of map.values()) {
    if (recs.length < 2) continue;
    groups.push({ label: 'Same body text', records: recs });
  }
  groups.sort((a, b) => b.records.length - a.records.length);
  return groups;
}

function _jaccardWords(a, b) {
  const wa = new Set(String(a).toLowerCase().split(/\s+/).filter(w => w.length >= 2));
  const wb = new Set(String(b).toLowerCase().split(/\s+/).filter(w => w.length >= 2));
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const uni = wa.size + wb.size - inter;
  return uni ? inter / uni : 0;
}

function _duplicateGroupsContentSimilar(withText, threshold) {
  const n = withText.length;
  if (n < 2) return [];
  const uf = new _UnionFind(n);
  for (let i = 0; i < n; i++) {
    const bi = withText[i].body;
    for (let j = i + 1; j < n; j++) {
      if (_jaccardWords(bi, withText[j].body) >= threshold) uf.union(i, j);
    }
  }
  const buck = new Map();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    if (!buck.has(r)) buck.set(r, []);
    buck.get(r).push(withText[i].record);
  }
  const groups = [];
  for (const g of buck.values()) {
    if (g.length < 2) continue;
    groups.push({
      label: `Similar body (${Math.round(threshold * 100)}%+ word overlap)`,
      records: g,
    });
  }
  groups.sort((a, b) => b.records.length - a.records.length);
  return groups;
}

function _diffLines(textA, textB) {
  const a = String(textA || '').split('\n');
  const b = String(textB || '').split('\n');
  const m = a.length;
  const n = b.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const seq = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      seq.push({ t: 'both', left: a[i - 1], right: b[j - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      seq.push({ t: 'right', left: '', right: b[j - 1] });
      j--;
    } else if (i > 0) {
      seq.push({ t: 'left', left: a[i - 1], right: '' });
      i--;
    } else break;
  }
  seq.reverse();
  return seq;
}

function _compareRecordActionsHtml(guid, fileName) {
  const g = _esc(guid);
  const raw = String(fileName ?? '').trim() || '(untitled)';
  const name = _esc(_truncateDisplay(raw, 72));
  const titleAttr = _esc(raw);
  return `<div class="rv-compare-actions-block">
  <span class="rv-compare-file-name" title="${titleAttr}">${name}</span>
  <span class="rv-compare-col-actions">
  <button type="button" class="rv-link rv-compare-action-open" data-record-guid="${g}" title="Open in a new panel">Open</button>
</span>
</div>`;
}

function _renderTwoPaneDiffHtml(titleA, titleB, seq, guidA, guidB) {
  const rows = seq
    .map(({ t, left, right }) => {
      const cls = t === 'both' ? 'rv-diff-equal' : t === 'left' ? 'rv-diff-del' : 'rv-diff-add';
      return `<div class="rv-diff-row ${cls}"><pre class="rv-diff-cell">${_esc(left)}</pre><pre class="rv-diff-cell">${_esc(right)}</pre></div>`;
    })
    .join('');
  return `<div class="rv-compare-diff-wrap">
  <div class="rv-compare-diff-header">
    <button type="button" class="rv-link rv-compare-back">Back to list</button>
    <span class="rv-compare-diff-titles"><span>${_esc(_truncateDisplay(titleA, 40))}</span><span class="rv-diff-vs">vs</span><span>${_esc(_truncateDisplay(titleB, 40))}</span></span>
  </div>
  <div class="rv-compare-col-actions-row">
    <div class="rv-compare-col-actions-cell">${_compareRecordActionsHtml(guidA, titleA)}</div>
    <div class="rv-compare-col-actions-cell">${_compareRecordActionsHtml(guidB, titleB)}</div>
  </div>
  <div class="rv-diff-grid">${rows}</div>
</div>`;
}

function _renderTriplePaneHtml(titles, texts, guids) {
  const cols = titles
    .map((t, i) => {
      const gid = guids[i] || '';
      return `<div class="rv-diff-col"><div class="rv-diff-col-head">
  ${gid ? _compareRecordActionsHtml(gid, t) : `<span class="rv-compare-file-name">${_esc(_truncateDisplay(t, 48))}</span>`}
</div><pre class="rv-diff-col-body">${_esc(texts[i] || '')}</pre></div>`;
    })
    .join('');
  return `<div class="rv-compare-diff-wrap rv-compare-diff-wrap--triple">
  <div class="rv-compare-diff-header">
    <button type="button" class="rv-link rv-compare-back">Back to list</button>
    <span class="rv-compare-diff-hint">Three notes side by side</span>
  </div>
  <div class="rv-diff-triple">${cols}</div>
</div>`;
}

/**
 * Client-side filter for duplicate-result groups (case-insensitive substring).
 * Matches group label, any record title, or collection name from `recordColMap`.
 * @returns {{ filtered: { label: string, records: object[] }[], totalBeforeFilter: number }}
 */
function _filterDupGroupsForDisplay(groups, filterText, recordColMap) {
  const totalBeforeFilter = groups.length;
  const n = String(filterText || '').trim().toLowerCase();
  if (!n) return { filtered: groups, totalBeforeFilter };
  const filtered = groups.filter(g => {
    if (String(g.label || '').toLowerCase().includes(n)) return true;
    for (const r of g.records) {
      try {
        if (String(r.getName() || '').toLowerCase().includes(n)) return true;
      } catch { /* ignore */ }
      const m = recordColMap?.[r.guid];
      if (m && String(m.colName || '').toLowerCase().includes(n)) return true;
    }
    return false;
  });
  return { filtered, totalBeforeFilter };
}

/**
 * Client-side filter for compare-mode result list (case-insensitive substring).
 * Matches note title or collection name from `recordColMap`.
 * @returns {{ filtered: object[], totalBeforeFilter: number }}
 */
function _filterRecordsForCompareDisplay(records, filterText, recordColMap) {
  const totalBeforeFilter = records.length;
  const n = String(filterText || '').trim().toLowerCase();
  if (!n) return { filtered: records, totalBeforeFilter };
  const filtered = records.filter(r => {
    try {
      if (String(r.getName() || '').toLowerCase().includes(n)) return true;
    } catch { /* ignore */ }
    const m = recordColMap?.[r.guid];
    if (m && String(m.colName || '').toLowerCase().includes(n)) return true;
    return false;
  });
  return { filtered, totalBeforeFilter };
}

// ─── Static HTML ─────────────────────────────────────────────────────────────

const SHELL_HTML = `
<div class="rv-root">

  <div class="rv-sidebar rv-sidebar--mode-search">
    <div class="rv-sidebar-title">
      <span class="ti ti-filter"></span> Enhanced Search
    </div>

    <div class="rv-mode-bar">
      <button type="button" class="rv-mode-btn rv-mode-btn--active" data-mode="search">Search</button>
      <button type="button" class="rv-mode-btn" data-mode="duplicates">Duplicates</button>
      <button type="button" class="rv-mode-btn" data-mode="compare">Compare</button>
    </div>

    <div class="rv-block rv-block-search">

    <div class="rv-section">
      <div class="rv-section-label">
        <span>Search</span>
        <label class="rv-search-include-type-wrap">
          <input type="checkbox" class="rv-search-include-type">
          <span>include #types</span>
        </label>
      </div>
      <div class="rv-search-wrap">
        <span class="ti ti-search rv-search-icon"></span>
        <input class="rv-search-input" type="text" placeholder="text or #hashtag…" autocomplete="off">
        <button type="button" class="rv-search-clear" aria-label="Clear search" title="Clear search" hidden>
          <span class="ti ti-circle-x" aria-hidden="true"></span>
        </button>
      </div>
      <div class="rv-search-hint">Use # for hashtags e.g. #project</div>
    </div>

    <div class="rv-section">
      <div class="rv-section-label">Tagged Date</div>
      <div class="rv-date-bar"></div>
    </div>

    <div class="rv-section">
      <div class="rv-section-label">
        Journal Date
        <span class="rv-col-actions">
          <button class="rv-link rv-journal-clear">clear</button>
        </span>
      </div>
      <div class="rv-journal-date-bar">
        <div class="rv-journal-nav">
          <button class="rv-journal-prev" title="Previous day">‹</button>
          <span class="rv-journal-label">—</span>
          <button class="rv-journal-next" title="Next day">›</button>
        </div>
        <div class="rv-journal-chips">
          <button class="rv-chip rv-jchip" data-jdate="lastwk">last wk</button>
          <button class="rv-chip rv-jchip" data-jdate="today">Today</button>
          <button class="rv-chip rv-jchip" data-jdate="nextwk">next wk</button>
        </div>
      </div>
    </div>

    <div class="rv-section">
      <div class="rv-section-label">Task status</div>
      <div class="rv-status-bar"></div>
    </div>

    <div class="rv-section">
      <div class="rv-section-label">Presets</div>
      <div class="rv-preset-list"></div>
      <div class="rv-preset-save-row">
        <input class="rv-preset-name" type="text" placeholder="Name this filter set…">
        <button class="rv-preset-save" title="Save preset"><span class="ti ti-device-floppy"></span></button>
        <button class="rv-preset-edit-toggle" title="Manage presets"><span class="ti ti-trash"></span></button>
      </div>
    </div>

    </div>

    <div class="rv-block rv-block-dup">
      <div class="rv-section">
        <div class="rv-section-label">Duplicate analysis</div>
        <select class="rv-dup-kind" title="What to compare">
          <option value="title_exact">Exact titles</option>
          <option value="title_similar" selected>Similar titles</option>
          <option value="content_exact">Exact body</option>
          <option value="content_similar">Similar body</option>
        </select>
        <div class="rv-dup-threshold-wrap">
          <div class="rv-dup-threshold-label">Similarity <span class="rv-dup-threshold-val">85%</span></div>
          <input type="range" min="70" max="100" value="85" class="rv-dup-threshold" title="Similarity threshold">
        </div>
        <label class="rv-dup-title-variant-wrap">
          <input type="checkbox" class="rv-dup-title-variant" checked>
          <span>Include prefix &amp; extra words (suffix variants)</span>
        </label>
        <button type="button" class="rv-dup-run">Run analysis</button>
        <div class="rv-dup-filter-wrap">
          <div class="rv-dup-filter-label">Filter groups</div>
          <input type="text" class="rv-dup-filter" placeholder="Title, label, or collection…" autocomplete="off" title="Shows groups that match this text anywhere in the group label, a note title, or collection name">
        </div>
      </div>
      <div class="rv-section">
        <div class="rv-section-label">Presets</div>
        <div class="rv-dup-preset-list"></div>
        <div class="rv-dup-preset-save-row">
          <input class="rv-dup-preset-name" type="text" placeholder="Name this duplicate preset…" autocomplete="off">
          <button type="button" class="rv-dup-preset-save" title="Save preset"><span class="ti ti-device-floppy"></span></button>
          <button type="button" class="rv-dup-preset-edit-toggle" title="Manage presets"><span class="ti ti-trash"></span></button>
        </div>
      </div>
    </div>

    <div class="rv-block rv-block-compare">
      <div class="rv-section">
        <div class="rv-section-label">Compare notes</div>
        <div class="rv-compare-tray"></div>
        <div class="rv-compare-actions">
          <button type="button" class="rv-link rv-compare-clear">Clear</button>
          <button type="button" class="rv-compare-open" disabled>Open compare</button>
        </div>
        <div class="rv-compare-filter-wrap">
          <div class="rv-compare-filter-label">Filter list</div>
          <input type="text" class="rv-compare-filter" placeholder="Title or collection…" autocomplete="off" title="Shows notes whose title or collection name contains this text">
        </div>
        <div class="rv-compare-hint">+ on cards adds here (max 3). Search in Search mode first.</div>
      </div>
    </div>

    <div class="rv-section rv-section--collections">
      <div class="rv-section-label">
        Collections
        <span class="rv-col-actions">
          <button class="rv-link rv-col-all">all</button>
          <span>·</span>
          <button class="rv-link rv-col-none">none</button>
        </span>
      </div>
      <div class="rv-col-list"></div>
    </div>
  </div>

  <div class="rv-main">
    <div class="rv-results">
      <div class="rv-loading"><span class="rv-spin ti ti-refresh"></span> Loading…</div>
    </div>
  </div>

</div>`;

// ─── Styles ───────────────────────────────────────────────────────────────────

const CSS = `
/* ── Layout ── */
.rv-root {
  position: absolute;
  inset: 0;
  display: flex;
  overflow: hidden;
  font-size: 13px;
  color: var(--text-color-primary, var(--color-text, #e8e8e8));
  font-family: inherit;
}

/* ── Sidebar ── */
.rv-sidebar {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid rgba(128,128,128,0.2);
  padding: 20px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0;
  background: rgba(128,128,128,0.06);
}
.rv-sidebar-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  opacity: 0.4;
  margin-bottom: 18px;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ── Sections ── */
.rv-section {
  margin-bottom: 18px;
}
.rv-section-label {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.5;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 7px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.rv-col-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  font-size: 10px;
  opacity: 0.7;
}
.rv-link {
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
  font-size: 10px;
  padding: 0;
  text-decoration: underline;
  opacity: 0.6;
}
.rv-link:hover { opacity: 1; }

/* ── Search inputs ── */
.rv-search-wrap {
  position: relative;
}
.rv-search-icon {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  opacity: 0.4;
  pointer-events: none;
}
.rv-search-hint {
  font-size: 10px;
  opacity: 0.35;
  margin-top: 4px;
  padding-left: 2px;
}
.rv-search-include-type-wrap {
  display: none;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin: 0;
  padding: 0;
  font-size: 10px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  opacity: 0.85;
  text-transform: none;
  letter-spacing: 0;
}
.rv-search-include-type-wrap input {
  margin: 0;
  flex-shrink: 0;
  cursor: pointer;
}
.rv-search-input {
  width: 100%;
  padding: 6px 34px 6px 28px;
  border-radius: 6px;
  border: 1px solid rgba(128,128,128,0.2);
  background: transparent;
  font-size: 12px;
  color: inherit;
  outline: none;
  box-sizing: border-box;
}
.rv-search-input:focus {
  border-color: var(--color-accent, #2563eb);
}
.rv-search-clear {
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(128,128,128,0.14);
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s;
}
.rv-search-clear:hover {
  background: rgba(128,128,128,0.26);
}
.rv-search-clear[hidden] {
  display: none !important;
}
.rv-search-clear .ti {
  font-size: 15px;
  opacity: 0.7;
  line-height: 1;
}
.rv-search-clear:hover .ti {
  opacity: 0.95;
}

/* ── Chips ── */
.rv-status-bar,
.rv-date-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.rv-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 20px;
  border: 1px solid rgba(128,128,128,0.2);
  background: transparent;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
  color: inherit;
  transition: background 0.12s, border-color 0.12s;
  white-space: nowrap;
}
.rv-chip:hover {
  background: rgba(128,128,128,0.08);
}
.rv-chip--active {
  background: var(--color-accent, #2563eb);
  border-color: var(--color-accent, #2563eb);
  color: #fff;
}
.rv-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rv-chip--active .rv-chip-dot {
  background: rgba(255,255,255,0.8) !important;
}

/* ── Collection list ── */
.rv-col-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rv-col-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 4px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.1s;
}
.rv-col-item:hover { background: rgba(128,128,128,0.08); }
.rv-col-item input[type=checkbox] { flex-shrink: 0; cursor: pointer; }
.rv-col-item .ti { opacity: 0.6; font-size: 12px; }
.rv-col-item-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Main results area ── */
.rv-main {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  min-width: 0;
}
.rv-results-toolbar {
  margin-bottom: 4px;
}
.rv-results-toolbar .rv-count-row {
  flex-wrap: wrap;
  align-items: flex-start;
}
.rv-results-toolbar .rv-col-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
  row-gap: 4px;
}
.rv-toolbar-sort {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.rv-sort-label {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.5;
  text-transform: uppercase;
  letter-spacing: 0.35px;
}
.rv-sort-select {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid rgba(128,128,128,0.22);
  background: transparent;
  color: inherit;
  cursor: pointer;
  max-width: min(280px, 100%);
}
.rv-sort-select:focus {
  outline: none;
  border-color: var(--color-accent, #2563eb);
}
.rv-load-more-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}
.rv-page-per {
  font-size: 11px;
  opacity: 0.55;
  text-transform: uppercase;
  letter-spacing: 0.35px;
  margin-right: 2px;
}
.rv-link.rv-link--active {
  opacity: 1;
  font-weight: 600;
  text-decoration: underline;
}
.rv-cards-list {
  display: flex;
  flex-direction: column;
}
.rv-count-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
.rv-count-row .rv-count {
  margin-bottom: 0;
}
.rv-count {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.6;
  color: var(--text-color-primary, var(--color-text, #e8e8e8));
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 12px;
}

/* ── Cards ── */
.rv-card {
  border: 1px solid rgba(128,128,128,0.25);
  border-radius: 8px;
  padding: 5px 9px;
  margin-bottom: 3px;
  background: rgba(128,128,128,0.08);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, padding 0.12s, margin 0.12s;
}
.rv-card--preview-open {
  padding: 12px 14px;
  margin-bottom: 10px;
  border-radius: 10px;
}
.rv-card:hover {
  border-color: var(--color-accent, #2563eb);
  background: rgba(37,99,235,0.08);
}
.rv-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 0;
}
.rv-card--preview-open .rv-card-header {
  align-items: flex-start;
}
.rv-card-preview-toggle {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: rgba(128,128,128,0.1);
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s;
}
.rv-card--preview-open .rv-card-preview-toggle {
  width: 22px;
  height: 22px;
  margin-top: 2px;
}
.rv-card-preview-toggle:hover {
  background: rgba(128,128,128,0.2);
}
.rv-card-preview-chevron {
  font-size: 13px;
  opacity: 0.65;
  transition: transform 0.15s ease;
  display: block;
}
.rv-card--preview-open .rv-card-preview-chevron {
  transform: rotate(90deg);
}
.rv-card-icon {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: rgba(128,128,128,0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  flex-shrink: 0;
}
.rv-card--preview-open .rv-card-icon {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  font-size: 14px;
  margin-top: 1px;
}
.rv-card-main { flex: 1; min-width: 0; }
/* One line: title (ellipsis) + [collection] + · relative time */
.rv-card-one-line {
  display: flex;
  align-items: baseline;
  flex-wrap: nowrap;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--text-color-primary, var(--color-text, #e8e8e8));
}
.rv-card-one-line .rv-card-title {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rv-card-col-bracket {
  flex-shrink: 0;
  font-weight: 400;
  opacity: 0.55;
}
.rv-card-time-sep {
  flex-shrink: 0;
  opacity: 0.45;
  font-weight: 400;
}
.rv-card-time {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 400;
  opacity: 0.55;
}
.rv-card--preview-open .rv-card-one-line {
  font-size: 13.5px;
  line-height: 1.35;
}
.rv-dot { opacity: 0.5; }
.rv-card-preview-inner {
  display: none;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(128,128,128,0.18);
}
.rv-card--preview-open .rv-card-preview-inner {
  display: block;
}
.rv-card-date-block {
  margin-bottom: 10px;
  font-size: 11px;
  opacity: 0.75;
}
.rv-card-date-line {
  margin-bottom: 4px;
}
.rv-card-date-label {
  font-weight: 600;
  opacity: 0.55;
  margin-right: 6px;
}
.rv-card-preview-text {
  font-size: 12px;
  opacity: 0.72;
  color: var(--text-color-primary, var(--color-text, #e8e8e8));
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  border-left: 2px solid rgba(128,128,128,0.2);
  padding-left: 10px;
  margin-bottom: 10px;
  /* ~N lines at line-height 1.5; --rv-preview-lines set on element (default 6) */
  max-height: calc(1.5em * var(--rv-preview-lines, 6));
  overflow: hidden;
}
.rv-card-props {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.rv-prop-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(128,128,128,0.08);
  font-size: 11px;
  max-width: 200px;
  overflow: hidden;
}
.rv-prop-label {
  opacity: 0.5;
  white-space: nowrap;
  flex-shrink: 0;
}
.rv-prop-val {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── States ── */
.rv-loading,
.rv-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 60px 20px;
  opacity: 0.4;
  font-size: 13px;
  text-align: center;
}
.rv-loading { flex-direction: row; gap: 8px; }
.rv-empty .ti { font-size: 28px; }
.rv-empty-sub { font-size: 11px; opacity: 0.7; }

@keyframes rv-rotate { to { transform: rotate(360deg); } }
.rv-spin { display: inline-block; animation: rv-rotate 1s linear infinite; }

/* ── Journal date ── */
.rv-journal-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.rv-journal-prev,
.rv-journal-next {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid rgba(128,128,128,0.2);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.rv-journal-prev:hover,
.rv-journal-next:hover { background: rgba(128,128,128,0.12); }
.rv-journal-label {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  opacity: 0.7;
  text-align: center;
}
.rv-journal-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: center;
}

/* ── Presets (search + duplicates) ── */
.rv-preset-list,
.rv-dup-preset-list { display: flex; flex-direction: column; gap: 3px; margin-bottom: 7px; }
.rv-preset-empty { font-size: 11px; opacity: 0.35; padding: 2px 0; }
.rv-preset-row,
.rv-dup-preset-row { display: flex; align-items: center; gap: 5px; }
.rv-preset-load,
.rv-dup-preset-load {
  flex: 1;
  text-align: left;
  background: rgba(128,128,128,0.08);
  border: 1px solid rgba(128,128,128,0.18);
  border-radius: 5px;
  padding: 5px 9px;
  font-size: 12px;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.12s;
}
.rv-preset-load:hover,
.rv-dup-preset-load:hover { background: rgba(128,128,128,0.18); border-color: rgba(128,128,128,0.35); }
.rv-preset-name-label,
.rv-dup-preset-name-label {
  flex: 1;
  font-size: 12px;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rv-preset-del,
.rv-dup-preset-del {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  opacity: 0.5;
  transition: opacity 0.1s, background 0.1s;
}
.rv-preset-del:hover,
.rv-dup-preset-del:hover { opacity: 1; background: rgba(220,50,50,0.2); }
.rv-preset-save-row,
.rv-dup-preset-save-row { display: flex; gap: 5px; align-items: center; }
.rv-preset-edit-toggle,
.rv-dup-preset-edit-toggle {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid rgba(128,128,128,0.2);
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  opacity: 0.45;
  transition: opacity 0.1s, background 0.1s;
}
.rv-preset-edit-toggle:hover,
.rv-dup-preset-edit-toggle:hover { opacity: 1; background: rgba(220,50,50,0.12); }
.rv-preset-name,
.rv-dup-preset-name {
  flex: 1;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid rgba(128,128,128,0.2);
  background: transparent;
  font-size: 12px;
  color: inherit;
  outline: none;
  min-width: 0;
}
.rv-preset-name:focus,
.rv-dup-preset-name:focus { border-color: var(--color-accent, #2563eb); }
.rv-preset-save,
.rv-dup-preset-save {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid rgba(128,128,128,0.2);
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: background 0.1s;
}
.rv-preset-save:hover,
.rv-dup-preset-save:hover { background: rgba(37,99,235,0.15); border-color: #2563eb; }

/* ── Mode bar & duplicate / compare sidebar ── */
.rv-mode-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.rv-mode-btn {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(128,128,128,0.22);
  background: transparent;
  color: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.rv-mode-btn:hover { background: rgba(128,128,128,0.08); }
.rv-mode-btn--active {
  background: var(--color-accent, #2563eb);
  border-color: var(--color-accent, #2563eb);
  color: #fff;
}
.rv-sidebar--mode-search .rv-block-dup { display: none; }
.rv-sidebar--mode-duplicates .rv-block-search { display: none; }
.rv-sidebar--mode-compare .rv-block-search { display: none; }
.rv-sidebar--mode-compare .rv-block-dup { display: none; }
.rv-dup-kind {
  width: 100%;
  margin-bottom: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid rgba(128,128,128,0.22);
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}
.rv-dup-threshold-wrap { margin-bottom: 10px; }
.rv-dup-title-variant-wrap {
  display: none;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 11px;
  line-height: 1.35;
  cursor: pointer;
  opacity: 0.92;
}
.rv-dup-title-variant-wrap input {
  margin: 2px 0 0 0;
  flex-shrink: 0;
  cursor: pointer;
}
.rv-dup-title-variant-wrap span { opacity: 0.88; }
.rv-dup-threshold-label {
  font-size: 10px;
  opacity: 0.55;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.35px;
}
.rv-dup-threshold {
  width: 100%;
  accent-color: var(--color-accent, #2563eb);
}
.rv-dup-run {
  width: 100%;
  padding: 8px 10px;
  border-radius: 6px;
  border: none;
  background: var(--color-accent, #2563eb);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.rv-dup-run:hover { filter: brightness(1.08); }
.rv-dup-filter-wrap,
.rv-compare-filter-wrap { margin-top: 12px; }
.rv-dup-filter-label,
.rv-compare-filter-label {
  font-size: 10px;
  font-weight: 600;
  opacity: 0.5;
  text-transform: uppercase;
  letter-spacing: 0.35px;
  margin-bottom: 5px;
}
.rv-dup-filter,
.rv-compare-filter {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(128,128,128,0.22);
  background: transparent;
  color: inherit;
  font-size: 12px;
  outline: none;
}
.rv-dup-filter:focus,
.rv-compare-filter:focus {
  border-color: var(--color-accent, #2563eb);
}
.rv-results-toolbar .rv-filter-meta {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.55;
}
.rv-compare-tray {
  min-height: 28px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 8px;
}
.rv-compare-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px 3px 8px;
  border-radius: 5px;
  background: rgba(128,128,128,0.12);
  font-size: 11px;
  max-width: 100%;
}
.rv-compare-chip-t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
.rv-compare-rm {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.55;
  padding: 0 2px;
  font-size: 14px;
  line-height: 1;
}
.rv-compare-rm:hover { opacity: 1; }
.rv-compare-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.rv-compare-open {
  flex: 1;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid rgba(128,128,128,0.25);
  background: rgba(128,128,128,0.08);
  color: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.rv-compare-open:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.rv-compare-open:not(:disabled):hover {
  border-color: var(--color-accent, #2563eb);
  background: rgba(37,99,235,0.12);
}
.rv-compare-hint {
  font-size: 10px;
  opacity: 0.45;
  line-height: 1.35;
}
.rv-card-compare-add {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid rgba(128,128,128,0.25);
  background: rgba(128,128,128,0.06);
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
  color: inherit;
  padding: 0;
  align-self: flex-start;
  margin-top: 1px;
}
.rv-card-compare-add:hover {
  border-color: var(--color-accent, #2563eb);
  background: rgba(37,99,235,0.12);
}
.rv-dup-groups { display: flex; flex-direction: column; gap: 16px; }
.rv-dup-group-head {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
  opacity: 0.85;
}
.rv-dup-group-n { opacity: 0.5; font-weight: 500; }
.rv-results-toolbar--dup { margin-bottom: 12px; }

/* ── Compare diff ── */
.rv-compare-diff-wrap { display: flex; flex-direction: column; gap: 12px; min-height: 200px; }
.rv-compare-diff-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}
.rv-compare-diff-titles {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.85;
  flex-wrap: wrap;
  justify-content: flex-end;
  flex: 1;
  min-width: 0;
}
.rv-diff-vs { opacity: 0.45; font-weight: 500; }
.rv-compare-diff-hint { font-size: 11px; opacity: 0.55; }
.rv-compare-col-actions-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  border: 1px solid rgba(128,128,128,0.2);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  overflow: hidden;
  margin-top: 4px;
}
.rv-compare-col-actions-cell {
  padding: 6px 10px;
  border-right: 1px solid rgba(128,128,128,0.15);
  background: rgba(128,128,128,0.04);
}
.rv-compare-col-actions-cell:last-child { border-right: none; }
.rv-compare-actions-block {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  width: 100%;
}
.rv-compare-file-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 4px;
}
.rv-compare-col-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
}
.rv-compare-col-actions .rv-link { font-size: 11px; }
.rv-compare-col-actions-row + .rv-diff-grid {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.rv-diff-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  border: 1px solid rgba(128,128,128,0.2);
  border-radius: 8px;
  overflow: hidden;
  max-height: min(70vh, 720px);
  overflow-y: auto;
  font-size: 12px;
}
.rv-diff-row {
  display: contents;
}
.rv-diff-cell {
  margin: 0;
  padding: 4px 8px;
  white-space: pre-wrap;
  word-break: break-word;
  border-bottom: 1px solid rgba(128,128,128,0.1);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.45;
}
.rv-diff-equal .rv-diff-cell { background: rgba(128,128,128,0.04); }
.rv-diff-del .rv-diff-cell:first-child { background: rgba(220,50,50,0.12); }
.rv-diff-del .rv-diff-cell:last-child { background: rgba(128,128,128,0.04); }
.rv-diff-add .rv-diff-cell:first-child { background: rgba(128,128,128,0.04); }
.rv-diff-add .rv-diff-cell:last-child { background: rgba(34,197,94,0.12); }
.rv-diff-triple {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  align-items: start;
  max-height: min(70vh, 720px);
  overflow: auto;
}
@media (max-width: 900px) {
  .rv-diff-triple { grid-template-columns: 1fr; }
}
.rv-diff-col {
  border: 1px solid rgba(128,128,128,0.2);
  border-radius: 8px;
  overflow: hidden;
  min-width: 0;
}
.rv-diff-col-head {
  padding: 6px 10px;
  font-size: 11px;
  border-bottom: 1px solid rgba(128,128,128,0.15);
  background: rgba(128,128,128,0.06);
}
.rv-diff-col-head .rv-compare-actions-block {
  width: 100%;
}
.rv-diff-col-body {
  margin: 0;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  line-height: 1.45;
  max-height: 60vh;
  overflow-y: auto;
}
`;
