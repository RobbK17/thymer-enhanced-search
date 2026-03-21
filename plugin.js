/**
 * Enhanced Search — Thymer plugin v1.0.0
 * Cross-collection record viewer with filters (see README).
 */
const PLUGIN_NAME = 'Enhanced Search';
const PLUGIN_VERSION = '1.0.0';

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
    this._bindCardActions(el, panel);
    this._renderPresets(el);
    this._updateTypeSearchCheckboxVisibility(el);
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
    const list = this._matchRecords;
    if (!list || !list.length) return;
    const total = list.length;
    const selectedGuids = new Set(
      [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid)
    );
    const batch = list.slice(this._pageStart, this._pageStart + this._pageSize);
    const cards = await Promise.all(batch.map(r => this._buildCard(r, selectedGuids, this._isJournalResults)));
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
    const list = this._matchRecords;
    if (!list || !list.length) return;
    const total = list.length;
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

  _getPresets() {
    try { return JSON.parse(localStorage.getItem(this._presetsKey()) || '[]'); }
    catch { return []; }
  }

  _savePresets(presets) {
    try { localStorage.setItem(this._presetsKey(), JSON.stringify(presets)); }
    catch { /* ignore */ }
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
      this._runSearch(el);
    });

    // Select all / none
    el.querySelector('.rv-col-all').addEventListener('click', () => {
      el.querySelectorAll('.rv-col-list input').forEach(cb => cb.checked = true);
      this._updateTypeSearchCheckboxVisibility(el);
      this._runSearch(el);
    });
    el.querySelector('.rv-col-none').addEventListener('click', () => {
      el.querySelectorAll('.rv-col-list input').forEach(cb => cb.checked = false);
      this._updateTypeSearchCheckboxVisibility(el);
      this._runSearch(el);
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
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async _runSearch(el) {
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
      const cards = await Promise.all(firstBatch.map(r => this._buildCard(r, selectedGuids, true)));
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
    const cards = await Promise.all(firstBatch.map(r => this._buildCard(r, selectedGuids, false)));
    const validCards = cards.filter(Boolean);
    const toolbar = _resultsToolbarHtml(this._pageStart, firstBatch.length, total, this._pageSize, false, sortMode);
    results.innerHTML = toolbar + '<div class="rv-cards-list">' + validCards.join('') + '</div>';
  }

  /**
   * @param {boolean} [expandPreview] - When true (journal date mode), card starts with preview expanded.
   */
  async _buildCard(record, selectedGuids, expandPreview = false) {
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
          await this._runSearch(el);
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
function _resultsToolbarHtml(pageStart, batchLen, total, pageSize, isJournal, sortMode = 'modified') {
  const rangeText = _countRangeLabel(pageStart, batchLen, total, isJournal);
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

// ─── Static HTML ─────────────────────────────────────────────────────────────

const SHELL_HTML = `
<div class="rv-root">

  <div class="rv-sidebar">
    <div class="rv-sidebar-title">
      <span class="ti ti-filter"></span> Filters
    </div>

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

/* ── Presets ── */
.rv-preset-list { display: flex; flex-direction: column; gap: 3px; margin-bottom: 7px; }
.rv-preset-empty { font-size: 11px; opacity: 0.35; padding: 2px 0; }
.rv-preset-row { display: flex; align-items: center; gap: 5px; }
.rv-preset-load {
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
.rv-preset-load:hover { background: rgba(128,128,128,0.18); border-color: rgba(128,128,128,0.35); }
.rv-preset-name-label {
  flex: 1;
  font-size: 12px;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rv-preset-del {
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
.rv-preset-del:hover { opacity: 1; background: rgba(220,50,50,0.2); }
.rv-preset-save-row { display: flex; gap: 5px; align-items: center; }
.rv-preset-edit-toggle {
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
.rv-preset-edit-toggle:hover { opacity: 1; background: rgba(220,50,50,0.12); }
.rv-preset-name {
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
.rv-preset-name:focus { border-color: var(--color-accent, #2563eb); }
.rv-preset-save {
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
.rv-preset-save:hover { background: rgba(37,99,235,0.15); border-color: #2563eb; }
`;
