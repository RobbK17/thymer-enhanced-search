/**
 * Enhanced Search — Thymer plugin v1.1.9
 * Cross-collection record viewer with filters (see README).
 * Modes: Search, Duplicates (analysis), Compare (2–3 notes + diff).
 */
const PLUGIN_NAME = 'Enhanced Search';
const PLUGIN_VERSION = '1.1.9';

/** Skip duplicate/similar scans above this many records (per selected collections). */
const DUPLICATE_SCAN_MAX_RECORDS = 2500;
/** Max records for pairwise similar-body scan (performance). */
const CONTENT_SIMILAR_MAX_RECORDS = 500;
/** Max chars per property value in duplicate body + properties string. */
const DUP_PROP_MAX_PER_FIELD = 800;
/** Max total chars for the properties blob appended to body for duplicate analysis. */
const DUP_PROP_MAX_TOTAL = 8000;

/**
 * Calendar days for journal range, anchored on selected date (local midnight).
 * span3: 1 day before + selected + 2 days after (4 days).
 * span7: 1 day before + selected + 6 days after (8 days).
 */
function _journalDaysForRange(anchor, range) {
  const d0 = new Date(anchor);
  d0.setHours(0, 0, 0, 0);
  if (range === 'span3') {
    return [-1, 0, 1, 2].map(off => {
      const d = new Date(d0);
      d.setDate(d.getDate() + off);
      return d;
    });
  }
  if (range === 'span7') {
    return [-1, 0, 1, 2, 3, 4, 5, 6].map(off => {
      const d = new Date(d0);
      d.setDate(d.getDate() + off);
      return d;a
    });
  }
  return [d0];
}

class Plugin extends AppPlugin {
  /** Enhanced Search viewer panels by `panel.getId()` (refs from getPanels() may differ from register callback). */
  _viewerPanelsById = new Map();
  _collections = [];  // cache of PluginCollectionAPI[]
  /** Flat line-level hits from last search: `{ record, lineItem }` (`lineItem` null = record-only). Merged by record for display. */
  _matchRows = null;
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
  /** Keys from `_dupGroupKey` for groups hidden via Dismiss in the duplicate results pane. */
  _dupDismissedKeys = new Set();
  /** Up to 3 record GUIDs selected for compare */
  _compareGuids = [];
  /** True when main area shows diff / triple view instead of cards */
  _compareDiffOpen = false;
  /** Which sidebar mode was active when **Open compare** was used (`search` | `duplicates` | `compare`) — drives Back label and navigation. */
  _compareBackFrom = 'compare';
  /** Snapshots of sidebar controls when leaving Search vs Duplicates so the shared DOM does not mix the two modes. */
  _sidebarSearchStateCache = null;
  _sidebarDupStateCache = null;

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

    // Date chips — All sends `@task` in the query; then Today, Tomorrow, …
    const dateBar = el.querySelector('.rv-date-bar');
    const allDateBtn = document.createElement('button');
    allDateBtn.type = 'button';
    allDateBtn.className = 'rv-chip';
    allDateBtn.dataset.date = '@task';
    allDateBtn.textContent = 'All';
    allDateBtn.title = 'Tasks (@task)';
    dateBar.appendChild(allDateBtn);
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
    this._bindMocDialog(el, panel);
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

  /**
   * When the search box contains `@collection=…`, turn on only the sidebar checkboxes whose
   * collection names match parsed names (case-insensitive). No-op if nothing parses or nothing matches.
   */
  _syncCollectionCheckboxesFromQuery(el, raw) {
    if (!_searchStringUsesThymerCollectionScope(raw)) return;
    const names = _parseThymerCollectionNamesFromSearch(raw);
    if (!names.length) return;
    const want = new Set(names.map(n => String(n).trim().toLowerCase()));
    const matchedGuids = new Set();
    for (const col of this._collections) {
      const cn = String(col.getName() || '').trim().toLowerCase();
      if (want.has(cn)) matchedGuids.add(col.getGuid());
    }
    if (matchedGuids.size === 0) return;
    el.querySelectorAll('.rv-col-list input').forEach(cb => {
      cb.checked = matchedGuids.has(cb.dataset.colGuid);
    });
    this._updateTypeSearchCheckboxVisibility(el);
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
    if (this._panelMode === 'search') {
      await this._renderSearchPageFromMatchRecords(el);
    }
  }

  /** Client-side filter on current match list (title or collection substring). */
  _getSearchFilteredRecords(el) {
    const raw = el.querySelector('.rv-search-results-filter')?.value ?? '';
    return _filterSearchRows(this._matchRows || [], raw, this._recordColMap);
  }

  /** @returns {{ record: object, lineItems: object[] }[]|null} */
  _getMergedClipboardRows(el) {
    let flatRows;
    if (this._panelMode === 'compare') {
      const filterRaw = el.querySelector('.rv-compare-filter')?.value ?? '';
      flatRows = _filterSearchRows(
        this._matchRows || [],
        filterRaw,
        this._recordColMap
      ).filtered;
    } else if (this._panelMode === 'search') {
      flatRows = this._getSearchFilteredRecords(el).filtered;
    } else {
      return null;
    }
    if (!flatRows.length) return null;
    return _mergeSearchRowsByRecord(flatRows);
  }

  async _writeTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { /* ignore */ }
    }
  }

  async _copyResultListToClipboard(el) {
    const merged = this._getMergedClipboardRows(el);
    if (!merged) return;
    const text = _formatSearchRowsForClipboard(merged, this._recordColMap);
    await this._writeTextToClipboard(text);
  }

  _buildMocMarkdown(el) {
    const merged = this._getMergedClipboardRows(el);
    if (!merged?.length) return null;
    return _formatSearchRowsForMoc(merged, this._recordColMap);
  }

  async _copyMocListToClipboard(el) {
    const text = this._buildMocMarkdown(el);
    if (!text) return;
    await this._writeTextToClipboard(text);
  }

  _closeMocDialog(el) {
    const ov = el.querySelector('.rv-moc-overlay');
    if (ov) ov.hidden = true;
  }

  async _openMocDialog(el) {
    if (!this._buildMocMarkdown(el)) {
      try {
        alert('No results to export. Run a search or compare query first.');
      } catch { /* ignore */ }
      return;
    }
    const nr = el.querySelector('input[name="rv-moc-mode"][value="new"]');
    if (nr) nr.checked = true;
    const tn = el.querySelector('.rv-moc-title-new');
    if (tn) tn.value = 'Map of content';
    const am = el.querySelector('.rv-moc-append-mode');
    if (am) am.value = 'append';
    this._fillMocDialogCollections(el);
    this._syncMocModeUI(el);
    const ov = el.querySelector('.rv-moc-overlay');
    if (ov) ov.hidden = false;
  }

  _fillMocDialogCollections(el) {
    const selNew = el.querySelector('.rv-moc-col-new');
    const selEx = el.querySelector('.rv-moc-col-existing');
    if (!selNew || !selEx) return;
    const opts = () => {
      const parts = ['<option value="">— Select collection —</option>'];
      for (const col of this._collections || []) {
        const g = _esc(col.getGuid());
        const n = _esc(col.getName() || '');
        const j = typeof col.isJournalPlugin === 'function' && col.isJournalPlugin();
        parts.push(`<option value="${g}"${j ? ' data-journal="1"' : ''}>${n}${j ? ' (journal)' : ''}</option>`);
      }
      return parts.join('');
    };
    selNew.innerHTML = opts();
    selEx.innerHTML = opts();
    if (this._collections?.length) {
      const firstNonJournal = this._collections.find(
        c => !(typeof c.isJournalPlugin === 'function' && c.isJournalPlugin())
      );
      if (firstNonJournal) selNew.value = firstNonJournal.getGuid();
      selEx.value = this._collections[0].getGuid();
    }
  }

  _syncMocModeUI(el) {
    const mode = el.querySelector('input[name="rv-moc-mode"]:checked')?.value || 'new';
    const newSec = el.querySelector('.rv-moc-new-section');
    const exSec = el.querySelector('.rv-moc-existing-section');
    const appendRow = el.querySelector('.rv-moc-append-row');
    if (newSec) newSec.hidden = mode !== 'new';
    if (exSec) exSec.hidden = mode !== 'existing';
    if (appendRow) appendRow.hidden = mode !== 'existing';
    if (mode === 'existing') void this._mocRefreshRecordSelect(el);
  }

  async _mocRefreshRecordSelect(el) {
    const colGuid = el.querySelector('.rv-moc-col-existing')?.value;
    const sel = el.querySelector('.rv-moc-record-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select note —</option>';
    if (!colGuid) return;
    const col = this._collections.find(c => c.getGuid() === colGuid);
    if (!col) return;
    let records = [];
    try {
      records = await col.getAllRecords();
    } catch {
      return;
    }
    const sorted = [...records].sort((a, b) => {
      const na = String(a.getName() || '').toLowerCase();
      const nb = String(b.getName() || '').toLowerCase();
      return na.localeCompare(nb, undefined, { sensitivity: 'base' });
    });
    for (const r of sorted) {
      const opt = document.createElement('option');
      opt.value = r.guid;
      opt.textContent = r.getName() || '(untitled)';
      sel.appendChild(opt);
    }
  }

  async _recordHasBodyContent(record) {
    try {
      const items = await record.getLineItems(false);
      const arr = Array.isArray(items) ? items : items ? [items] : [];
      for (const li of arr) {
        const segs = li.segments || [];
        for (const s of segs) {
          const t = String(s.text ?? '').trim();
          if (s.type === 'text' && t) return true;
          if (s.type === 'ref') return true;
          if (s.type === 'hashtag' && t) return true;
          if (s.type === 'link' && t) return true;
          if (s.type === 'linkobj' && t) return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  async _clearRecordBody(record) {
    for (let i = 0; i < 500; i++) {
      const items = await record.getLineItems(false);
      const arr = Array.isArray(items) ? items : items ? [items] : [];
      if (!arr.length) return;
      await arr[0].delete();
    }
  }

  /**
   * Insert MOC as real line items with `ref` segments so links resolve in the editor.
   * Collection headings use plain Markdown `## …` (a leading newline before the 2nd+ heading); record lines are plain `ref` rows (no bullets).
   * `insertFromMarkdown` does not turn `[[…]]` into record refs — only Copy still emits that text.
   * @param {PluginRecord} record
   * @param {{ record: object, lineItems?: object[] }[]} mergedRows
   * @param {Record<string, { colName?: string }>|null} recordColMap
   * @param {PluginLineItem|null} afterTopItem - insert after this top-level sibling, or null for start
   */
  async _mocInsertStructuredContent(record, mergedRows, recordColMap, afterTopItem) {
    const groups = _groupSearchRowsForMoc(mergedRows, recordColMap);
    if (!groups.length) return;
    let afterItem = afterTopItem;
    const h1 = await record.createLineItem(null, afterItem, 'heading', [{ type: 'text', text: 'Map of content' }], null);
    await h1.setHeadingSize(1);
    afterItem = h1;
    for (let gi = 0; gi < groups.length; gi++) {
      const { col, items } = groups[gi];
      const headingText = col.replace(/\r|\n/g, ' ').trim() || '(no collection)';
      const md = gi === 0 ? `## ${headingText}\n` : `\n## ${headingText}\n`;
      await record.insertFromMarkdown(md, null, afterItem);
      const lastAfterHeading = await _mocLastTopLineItem(record);
      if (lastAfterHeading) afterItem = lastAfterHeading;
      if (!items.length) continue;
      for (const { title, guid } of items) {
        const li = await record.createLineItem(
          null,
          afterItem,
          'text',
          [{ type: 'ref', text: _mocRefPayload(title, guid) }],
          null
        );
        afterItem = li;
      }
    }
  }

  async _mocAppendMocStructured(record, mergedRows) {
    const items = await record.getLineItems(false);
    const arr = Array.isArray(items) ? items : items ? [items] : [];
    const last = arr.length ? arr[arr.length - 1] : null;
    await this._mocInsertStructuredContent(record, mergedRows, this._recordColMap, last);
  }

  /**
   * After `collection.createRecord`, `data.getRecord(guid)` may be null briefly until the
   * workspace indexes the new record — poll so MOC write + open works reliably.
   */
  async _waitForDataRecord(guid, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 8000;
    const stepMs = opts.stepMs ?? 32;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = this.data.getRecord(guid);
      if (r) return r;
      await new Promise(res => setTimeout(res, stepMs));
    }
    return this.data.getRecord(guid);
  }

  async _mocOpenWrittenNote(panel, guid) {
    const newPanel = await this.ui.createPanel({ afterPanel: panel });
    if (newPanel) {
      newPanel.navigateTo({
        type: 'edit_panel',
        rootId: guid,
        subId: null,
        workspaceGuid: this.getWorkspaceGuid(),
      });
    }
  }

  async _mocWriteToNote(el, panel) {
    const merged = this._getMergedClipboardRows(el);
    if (!merged?.length) {
      try {
        alert('No results to export.');
      } catch { /* ignore */ }
      return;
    }
    const mode = el.querySelector('input[name="rv-moc-mode"]:checked')?.value || 'new';
    if (mode === 'new') {
      const colGuid = el.querySelector('.rv-moc-col-new')?.value;
      const title = el.querySelector('.rv-moc-title-new')?.value?.trim() || 'Map of content';
      const col = this._collections.find(c => c.getGuid() === colGuid);
      if (!colGuid || !col) {
        try {
          alert('Select a collection.');
        } catch { /* ignore */ }
        return;
      }
      if (typeof col.isJournalPlugin === 'function' && col.isJournalPlugin()) {
        try {
          alert('Choose a non-journal collection for a new note, or use “Existing note” for a journal page.');
        } catch { /* ignore */ }
        return;
      }
      const guid = col.createRecord(title);
      if (!guid) {
        try {
          alert('Could not create note in that collection.');
        } catch { /* ignore */ }
        return;
      }
      const record = await this._waitForDataRecord(guid);
      if (!record) {
        try {
          alert('Created note could not be opened.');
        } catch { /* ignore */ }
        return;
      }
      try {
        await this._mocInsertStructuredContent(record, merged, this._recordColMap, null);
      } catch (e) {
        try {
          alert('Could not write content: ' + (e?.message || String(e)));
        } catch { /* ignore */ }
        return;
      }
      this._closeMocDialog(el);
      await this._mocOpenWrittenNote(panel, guid);
      return;
    }
    const recGuid = el.querySelector('.rv-moc-record-select')?.value;
    if (!recGuid) {
      try {
        alert('Select a note.');
      } catch { /* ignore */ }
      return;
    }
    const record = this.data.getRecord(recGuid);
    if (!record) {
      try {
        alert('Note not found.');
      } catch { /* ignore */ }
      return;
    }
    const wantAppend = el.querySelector('.rv-moc-append-mode')?.value === 'append';
    let hasBody = false;
    try {
      hasBody = await this._recordHasBodyContent(record);
    } catch { /* ignore */ }
    try {
      if (wantAppend && hasBody) {
        await this._mocAppendMocStructured(record, merged);
      } else if (!wantAppend && hasBody) {
        let ok = true;
        try {
          ok = confirm(
            'Replace all content in this note? This cannot be undone from here.'
          );
        } catch {
          ok = false;
        }
        if (!ok) return;
        await this._clearRecordBody(record);
        await this._mocInsertStructuredContent(record, merged, this._recordColMap, null);
      } else {
        await this._mocInsertStructuredContent(record, merged, this._recordColMap, null);
      }
    } catch (e) {
      try {
        alert('Could not write: ' + (e?.message || String(e)));
      } catch { /* ignore */ }
      return;
    }
    this._closeMocDialog(el);
    await this._mocOpenWrittenNote(panel, recGuid);
  }

  _bindMocDialog(el, panel) {
    const ov = el.querySelector('.rv-moc-overlay');
    if (!ov) return;
    ov.addEventListener('click', e => {
      if (e.target === ov) this._closeMocDialog(el);
    });
    el.querySelector('.rv-moc-cancel')?.addEventListener('click', () => this._closeMocDialog(el));
    el.querySelector('.rv-moc-copy-only')?.addEventListener('click', async () => {
      await this._copyMocListToClipboard(el);
      this._closeMocDialog(el);
    });
    el.querySelector('.rv-moc-write')?.addEventListener('click', () => void this._mocWriteToNote(el, panel));
    el.querySelectorAll('input[name="rv-moc-mode"]').forEach(inp => {
      inp.addEventListener('change', () => this._syncMocModeUI(el));
    });
    el.querySelector('.rv-moc-col-existing')?.addEventListener('change', () => void this._mocRefreshRecordSelect(el));
  }

  async _renderSearchPageFromMatchRecords(el) {
    if (this._panelMode !== 'search') return;
    const sortMode = this._captureSortMode(el);
    const results = el.querySelector('.rv-results');
    if (!results) return;
    const list = this._matchRows;
    if (!list?.length) return;
    const selectedGuids = new Set(
      [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid)
    );
    const filterRaw = el.querySelector('.rv-search-results-filter')?.value ?? '';
    const { filtered: visibleFlat, totalBeforeFilter } = _filterSearchRows(
      list,
      filterRaw,
      this._recordColMap
    );
    const visible = _mergeSearchRowsByRecord(visibleFlat);
    const totalBeforeMerged = String(filterRaw || '').trim()
      ? _mergeSearchRowsByRecord(list).length
      : visible.length;
    if (!visible.length) {
      if (totalBeforeFilter > 0) {
        results.innerHTML = `<div class="rv-empty"><span class="ti ti-search-off"></span><div>No notes match filter</div><div class="rv-empty-sub">${totalBeforeFilter} hidden — clear Filter results</div></div>`;
      }
      return;
    }
    const isJournal = this._isJournalResults;
    const expandPreview = isJournal;
    this._pageStart = Math.min(this._pageStart, Math.max(0, visible.length - 1));
    const total = visible.length;
    const firstBatch = visible.slice(this._pageStart, this._pageStart + this._pageSize);
    const hasFilter = String(filterRaw || '').trim().length > 0;
    const toolbarOpts =
      hasFilter && totalBeforeMerged > total ? { listFilterTotalBefore: totalBeforeMerged } : {};
    const activeTaskStatuses = _activeTaskStatusSet(el);
    const searchRaw = el.querySelector('.rv-search-input')?.value ?? '';
    const highlightTerms = _plainSearchHighlightTermsFromQuery(searchRaw);
    const cards = await Promise.all(
      firstBatch.map(row =>
        this._buildCard(row, selectedGuids, expandPreview, {
          compareBtn: true,
          activeTaskStatuses,
          highlightTerms,
        })
      )
    );
    const validCards = cards.filter(Boolean);
    const toolbar = _resultsToolbarHtml(
      this._pageStart,
      firstBatch.length,
      total,
      this._pageSize,
      isJournal,
      sortMode,
      toolbarOpts
    );
    results.innerHTML = toolbar + '<div class="rv-cards-list">' + validCards.join('') + '</div>';
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
      const { filtered } = _filterSearchRows(
        this._matchRows || [],
        filterRaw,
        this._recordColMap
      );
      total = _mergeSearchRowsByRecord(filtered).length;
    } else if (this._panelMode === 'search') {
      const { filtered } = this._getSearchFilteredRecords(el);
      total = _mergeSearchRowsByRecord(filtered).length;
    } else {
      const list = this._matchRows;
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
  /** `single` | `span3` (1 day before + selected + 2 after) | `span7` (1 before + selected + 6 after). */
  _journalRange = 'single';

  // ─── Journal Date ─────────────────────────────────────────────────────────

  _readJournalRange(el) {
    const v = el.querySelector('input.rv-journal-range:checked')?.value;
    if (v === 'span3' || v === 'span7') return v;
    return 'single';
  }

  _syncJournalRangeRadios(el, range) {
    const r = range === 'span3' || range === 'span7' ? range : 'single';
    this._journalRange = r;
    el.querySelectorAll('input.rv-journal-range').forEach(inp => {
      inp.checked = inp.value === r;
    });
  }

  _setJournalDate(date, el) {
    this._journalDate = date;
    const label = el.querySelector('.rv-journal-label');
    if (!date) {
      label.textContent = '—';
      this._syncJournalRangeRadios(el, 'single');
    } else {
      label.textContent = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    }
    // Clear active state on chips except if explicitly set
    el.querySelectorAll('.rv-jchip').forEach(c => c.classList.remove('rv-chip--active'));
    this._runSearch(el);
  }

  /**
   * Only one of tagged date (@…), task status, or journal-day mode may be active.
   * Clears the two areas not listed in `keep`. Does not run search.
   * @param {'tagged'|'journal'|'status'} keep
   */
  _clearSiblingDateFilters(el, keep) {
    if (keep !== 'tagged') {
      el.querySelectorAll('.rv-date-bar .rv-chip').forEach(c => c.classList.remove('rv-chip--active'));
    }
    if (keep !== 'status') {
      el.querySelectorAll('.rv-status-bar .rv-chip').forEach(c => c.classList.remove('rv-chip--active'));
    }
    if (keep !== 'journal') {
      this._journalDate = null;
      const jl = el.querySelector('.rv-journal-label');
      if (jl) jl.textContent = '—';
      el.querySelectorAll('.rv-jchip').forEach(c => c.classList.remove('rv-chip--active'));
    }
  }

  /** Clear tagged date and journal when user types search text (task status stays; combines with query). Does not run search. */
  _clearSidebarFiltersForTextSearch(el) {
    el.querySelectorAll('.rv-date-bar .rv-chip').forEach(c => c.classList.remove('rv-chip--active'));
    this._journalDate = null;
    const jl = el.querySelector('.rv-journal-label');
    if (jl) jl.textContent = '—';
    el.querySelectorAll('.rv-jchip').forEach(c => c.classList.remove('rv-chip--active'));
    this._syncJournalRangeRadios(el, 'single');
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
      includeBodyProps: !!el.querySelector('.rv-dup-body-include-props')?.checked,
      dupFilter: el.querySelector('.rv-dup-filter')?.value ?? '',
      collections: [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid),
    };
  }

  _applyDupStateToDom(el, state) {
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
    const bp = el.querySelector('.rv-dup-body-include-props');
    if (bp) bp.checked = state.includeBodyProps === true;
    const df = el.querySelector('.rv-dup-filter');
    if (df) df.value = state.dupFilter != null ? String(state.dupFilter) : '';
    el.querySelectorAll('.rv-col-list input').forEach(cb => {
      cb.checked = (state.collections || []).includes(cb.dataset.colGuid);
    });
    this._updateTypeSearchCheckboxVisibility(el);
    this._syncDupKindUI(el);
  }

  async _applyDupState(el, state) {
    this._applyDupStateToDom(el, state);
    await this._setPanelMode(el, 'duplicates', { forceDup: true, skipDupCacheRestore: true });
    try {
      this._sidebarDupStateCache = this._getDupState(el);
    } catch { /* ignore */ }
  }

  _getFilterState(el) {
    return {
      search: el.querySelector('.rv-search-input').value,
      statuses: [...el.querySelectorAll('.rv-status-bar .rv-chip--active')].map(c => c.dataset.status),
      date: el.querySelector('.rv-date-bar .rv-chip--active')?.dataset.date || '',
      collections: [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid),
      journalDate: this._journalDate ? this._journalDate.toISOString() : null,
      journalRange: this._readJournalRange(el),
      includeTypeSearch: !!el.querySelector('.rv-search-include-type')?.checked,
      sort: this._captureSortMode(el),
      searchResultsFilter: el.querySelector('.rv-search-results-filter')?.value ?? '',
    };
  }

  _applyFilterState(el, state) {
    el.querySelector('.rv-search-input').value = state.search || '';
    const valid = new Set(TASK_STATUSES.map(s => s.value));
    const statuses = (state.statuses || [])
      .map(s => (s === 'started' ? 'inprogress' : s))
      .filter(s => valid.has(s));
    el.querySelectorAll('.rv-status-bar .rv-chip').forEach(c => {
      c.classList.toggle('rv-chip--active', statuses.includes(c.dataset.status));
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
    if (state.journalRange === 'span3' || state.journalRange === 'span7') {
      this._syncJournalRangeRadios(el, state.journalRange);
    } else {
      this._syncJournalRangeRadios(el, 'single');
    }
    const typeCb = el.querySelector('.rv-search-include-type');
    if (typeCb) typeCb.checked = !!state.includeTypeSearch;
    const srf = el.querySelector('.rv-search-results-filter');
    if (srf) srf.value = state.searchResultsFilter != null ? String(state.searchResultsFilter) : '';
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
      if (searchInput.value.trim().length > 0) {
        this._clearSidebarFiltersForTextSearch(el);
        this._updateActiveSearchIndicators(el);
        searchInput.focus();
      }
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

    // Status chips — toggle (exclusive with tagged date + journal day mode)
    el.querySelector('.rv-status-bar').addEventListener('click', e => {
      const chip = e.target.closest('.rv-chip');
      if (!chip) return;
      this._clearSiblingDateFilters(el, 'status');
      chip.classList.toggle('rv-chip--active');
      this._runSearch(el);
    });

    // Tagged date chips — single-select (All = @task); exclusive with task status + journal day mode
    el.querySelector('.rv-date-bar').addEventListener('click', e => {
      const chip = e.target.closest('.rv-chip');
      if (!chip) return;
      this._clearSiblingDateFilters(el, 'tagged');
      const wasActive = chip.classList.contains('rv-chip--active');
      el.querySelectorAll('.rv-date-bar .rv-chip').forEach(c => c.classList.remove('rv-chip--active'));
      if (!wasActive) chip.classList.add('rv-chip--active');
      this._runSearch(el);
    });

    const clearTaggedDate = () => {
      el.querySelectorAll('.rv-date-bar .rv-chip').forEach(c => c.classList.remove('rv-chip--active'));
      this._runSearch(el);
    };
    el.querySelector('.rv-tagged-date-clear')?.addEventListener('click', clearTaggedDate);

    el.querySelector('.rv-task-status-clear')?.addEventListener('click', () => {
      el.querySelectorAll('.rv-status-bar .rv-chip').forEach(c => c.classList.remove('rv-chip--active'));
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
    el.querySelectorAll('input.rv-journal-range').forEach(inp => {
      inp.addEventListener('change', () => {
        this._journalRange = this._readJournalRange(el);
        if (this._journalDate) this._runSearch(el);
      });
    });

    el.querySelector('.rv-journal-date-bar').addEventListener('click', e => {
      const chip = e.target.closest('.rv-jchip');
      const prev = e.target.closest('.rv-journal-prev');
      const next = e.target.closest('.rv-journal-next');

      if (chip) {
        const val = chip.dataset.jdate;
        const base = this._journalDate || (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
        if (val === 'today') {
          this._clearSiblingDateFilters(el, 'journal');
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          this._setJournalDate(d, el);
          el.querySelector('.rv-jchip[data-jdate="today"]')?.classList.add('rv-chip--active');
        } else if (val === 'lastwk') {
          this._clearSiblingDateFilters(el, 'journal');
          const d = new Date(base);
          d.setDate(d.getDate() - 7);
          this._setJournalDate(d, el);
        } else if (val === 'nextwk') {
          this._clearSiblingDateFilters(el, 'journal');
          const d = new Date(base);
          d.setDate(d.getDate() + 7);
          this._setJournalDate(d, el);
        }
      } else if (prev) {
        this._clearSiblingDateFilters(el, 'journal');
        const base = this._journalDate || (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
        const d = new Date(base);
        d.setDate(d.getDate() - 1);
        this._setJournalDate(d, el);
      } else if (next) {
        this._clearSiblingDateFilters(el, 'journal');
        const base = this._journalDate || (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
        const d = new Date(base);
        d.setDate(d.getDate() + 1);
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
        if (!isNaN(idx)) {
          this._applyFilterState(el, this._getPresets()[idx].state);
          try {
            this._sidebarSearchStateCache = this._getFilterState(el);
          } catch { /* ignore */ }
        }
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
      if (this._isJournalResults || !this._matchRows?.length) return;
      this._matchRows = _sortSearchRows(this._matchRows, v, this._recordColMap);
      this._pageStart = 0;
      this._renderCurrentPage(el);
    });

    el.querySelector('.rv-mode-bar')?.addEventListener('click', e => {
      const btn = e.target.closest('.rv-mode-btn');
      if (!btn?.dataset.mode) return;
      this._setPanelMode(el, btn.dataset.mode);
    });

    el.querySelector('.rv-dup-run')?.addEventListener('click', () => {
      this._compareGuids = [];
      this._compareDiffOpen = false;
      this._syncCompareTray(el);
      void this._runDuplicateAnalysis(el);
    });

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

    let searchResultsFilterDebounce = null;
    el.querySelector('.rv-search-results-filter')?.addEventListener('input', () => {
      clearTimeout(searchResultsFilterDebounce);
      searchResultsFilterDebounce = setTimeout(() => {
        if (this._panelMode === 'search' && this._matchRows?.length) {
          this._pageStart = 0;
          void this._renderSearchPageFromMatchRecords(el);
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
    const bpw = el.querySelector('.rv-dup-body-props-wrap');
    if (bpw) bpw.style.display = k === 'content_exact' || k === 'content_similar' ? 'flex' : 'none';
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.forceDup] — When switching to Duplicates, always run analysis (e.g. dup preset load).
   * @param {boolean} [opts.skipDupCacheRestore] — Duplicates DOM already set (e.g. dup preset); do not overlay cached dup state.
   */
  async _setPanelMode(el, mode, opts = {}) {
    if (!['search', 'duplicates', 'compare'].includes(mode)) return;
    this._compareDiffOpen = false;

    if (mode === 'compare') {
      if (this._panelMode === 'search') {
        try {
          this._sidebarSearchStateCache = this._getFilterState(el);
        } catch { /* ignore */ }
      } else if (this._panelMode === 'duplicates') {
        try {
          this._sidebarDupStateCache = this._getDupState(el);
        } catch { /* ignore */ }
      }
      await this._runSearch(el, { ignoreMode: true });
      this._panelMode = 'compare';
      this._applyPanelMode(el);
      this._renderCompareMain(el);
      return;
    }

    if (mode === 'search' && this._panelMode === 'duplicates') {
      try {
        this._sidebarDupStateCache = this._getDupState(el);
      } catch { /* ignore */ }
    } else if (mode === 'duplicates' && this._panelMode === 'search') {
      try {
        this._sidebarSearchStateCache = this._getFilterState(el);
      } catch { /* ignore */ }
    }

    this._panelMode = mode;
    this._applyPanelMode(el);
    if (mode === 'search') {
      if (this._sidebarSearchStateCache) {
        this._applyFilterState(el, this._sidebarSearchStateCache);
      } else {
        await this._runSearch(el);
      }
    } else if (mode === 'duplicates') {
      if (!opts.skipDupCacheRestore && this._sidebarDupStateCache) {
        this._applyDupStateToDom(el, this._sidebarDupStateCache);
      }
      const shouldDupRefresh = this._dupGroups != null;
      this._dupDismissedKeys.clear();
      this._dupGroups = null;
      if (opts.forceDup || shouldDupRefresh) {
        await this._runDuplicateAnalysis(el);
      } else {
        this._renderDuplicatePlaceholder(el);
      }
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
    if (!this._matchRows?.length) {
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-columns"></span><div>No results to compare</div><div class="rv-empty-sub">Switch to Search, run a query, then return here and use + on cards</div></div>`;
      return;
    }
    const filterRaw = el.querySelector('.rv-compare-filter')?.value ?? '';
    const { filtered: visibleFlat, totalBeforeFilter } = _filterSearchRows(
      this._matchRows,
      filterRaw,
      this._recordColMap
    );
    const visible = _mergeSearchRowsByRecord(visibleFlat);
    const totalBeforeMerged = String(filterRaw || '').trim()
      ? _mergeSearchRowsByRecord(this._matchRows).length
      : visible.length;
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
      hasFilter && totalBeforeMerged > total ? { listFilterTotalBefore: totalBeforeMerged } : {};
    const activeTaskStatuses = _activeTaskStatusSet(el);
    const searchRaw = el.querySelector('.rv-search-input')?.value ?? '';
    const highlightTerms = _plainSearchHighlightTermsFromQuery(searchRaw);
    Promise.all(
      firstBatch.map(row =>
        this._buildCard(row, selectedGuids, false, { compareBtn: true, activeTaskStatuses, highlightTerms })
      )
    ).then(cards => {
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
    this._dupDismissedKeys.clear();
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
      const includeBodyProps = !!el.querySelector('.rv-dup-body-include-props')?.checked;
      if (kind === 'title_exact') {
        groups = _duplicateGroupsTitleExact(records);
      } else if (kind === 'title_similar') {
        const includeVariants = !!el.querySelector('.rv-dup-title-variant')?.checked;
        groups = _duplicateGroupsTitleSimilar(records, threshold, includeVariants);
      } else if (kind === 'content_exact') {
        const withText = await _recordsWithBodyText(records, includeBodyProps);
        groups = _duplicateGroupsContentExact(withText, { includeProps: includeBodyProps });
      } else {
        if (records.length > CONTENT_SIMILAR_MAX_RECORDS) {
          results.innerHTML = `<div class="rv-empty"><span class="ti ti-alert-triangle"></span><div>Too many records for similar-body scan (${records.length})</div><div class="rv-empty-sub">Narrow collections (max ${CONTENT_SIMILAR_MAX_RECORDS} for this mode)</div></div>`;
          this._dupGroups = null;
          return;
        }
        const withText = await _recordsWithBodyText(records, includeBodyProps);
        groups = _duplicateGroupsContentSimilar(withText, threshold, { includeProps: includeBodyProps });
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
    const groupsAfterDismiss = groups.filter(g => !this._dupDismissedKeys.has(_dupGroupKey(g)));
    if (!groupsAfterDismiss.length) {
      const n = this._dupDismissedKeys.size;
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-eye-off"></span><div>All groups hidden</div><div class="rv-empty-sub">${n} group(s) dismissed — <button type="button" class="rv-link rv-dup-reset-dismissed">Restore dismissed</button></div></div>`;
      return;
    }
    const filterRaw = el.querySelector('.rv-dup-filter')?.value ?? '';
    const { filtered, totalBeforeFilter } = _filterDupGroupsForDisplay(
      groupsAfterDismiss,
      filterRaw,
      this._recordColMap
    );
    if (!filtered.length) {
      results.innerHTML = `<div class="rv-empty"><span class="ti ti-search-off"></span><div>No groups match filter</div><div class="rv-empty-sub">${totalBeforeFilter} group(s) hidden — clear Filter groups</div></div>`;
      return;
    }
    const totalNotes = filtered.reduce((s, g) => s + g.records.length, 0);
    const selectedGuids = new Set(
      [...el.querySelectorAll('.rv-col-list input:checked')].map(cb => cb.dataset.colGuid)
    );
    const hasFilter = String(filterRaw || '').trim().length > 0;
    const nd = this._dupDismissedKeys.size;
    const countText = hasFilter
      ? `${filtered.length} of ${totalBeforeFilter} groups · ${totalNotes} notes`
      : `${filtered.length} groups · ${totalNotes} notes`;
    const restoreDismissed =
      nd > 0
        ? `<span class="rv-col-actions"><span>·</span><button type="button" class="rv-link rv-dup-reset-dismissed" title="Show every dismissed group again">Restore dismissed (${nd})</button></span>`
        : '';
    const head = `<div class="rv-results-toolbar rv-results-toolbar--dup"><div class="rv-count-row"><span class="rv-count">${countText}</span>${restoreDismissed}</div></div>`;

    const buildGroup = async g => {
      const key = _dupGroupKey(g);
      const keyAttr = encodeURIComponent(key);
      const cards = await Promise.all(
        g.records.map(r => this._buildCard({ record: r, lineItems: [] }, selectedGuids, false, { compareBtn: true }))
      );
      const valid = cards.filter(Boolean);
      return `<div class="rv-dup-group">
  <div class="rv-dup-group-head">
    <span class="rv-dup-group-head-main">${_esc(g.label)} <span class="rv-dup-group-n">(${g.records.length})</span></span>
    <button type="button" class="rv-link rv-dup-dismiss" data-dup-key="${keyAttr}" title="Hide this group from the list">Dismiss</button>
  </div>
  <div class="rv-cards-list">${valid.join('')}</div>
</div>`;
    };

    Promise.all(filtered.map(buildGroup)).then(parts => {
      results.innerHTML = head + `<div class="rv-dup-groups">${parts.join('')}</div>`;
    });
  }

  _openCompareDiff(el) {
    if (this._compareGuids.length < 2) return;
    this._compareBackFrom = ['search', 'duplicates', 'compare'].includes(this._panelMode)
      ? this._panelMode
      : 'compare';
    this._compareDiffOpen = true;
    this._renderCompareDiff(el);
  }

  _compareBackLabel() {
    if (this._compareBackFrom === 'duplicates') return 'Back to duplicates';
    if (this._compareBackFrom === 'search') return 'Back to search';
    return 'Back to list';
  }

  async _goBackFromCompareDiff(el) {
    this._compareDiffOpen = false;
    this._compareGuids = [];
    this._syncCompareTray(el);
    const from = this._compareBackFrom;
    if (from === 'duplicates') {
      if (this._dupGroups?.length) this._renderDuplicateResults(el, this._dupGroups);
      else this._renderDuplicatePlaceholder(el);
      return;
    }
    if (from === 'search') {
      await this._renderSearchPageFromMatchRecords(el);
      return;
    }
    await this._renderCompareMain(el);
  }

  async _renderCompareDiff(el) {
    const results = el.querySelector('.rv-results');
    if (!results) return;
    const backLabel = this._compareBackLabel();
    const guids = [...this._compareGuids].slice(0, 3);
    const records = guids.map(g => this.data.getRecord(g)).filter(Boolean);
    if (records.length < 2) {
      this._compareDiffOpen = false;
      await this._goBackFromCompareDiff(el);
      return;
    }

    const texts = await Promise.all(records.map(r => _extractRecordFullText(r)));
    const titles = records.map(r => r.getName() || '(untitled)');

    if (records.length === 2) {
      const diff = _diffLines(texts[0], texts[1]);
      const propsDiffHtml = _renderComparePropertiesTwoPaneKeyed(records[0], records[1], titles[0], titles[1]);
      results.innerHTML = _renderTwoPaneDiffHtml(
        titles[0],
        titles[1],
        diff,
        records[0].guid,
        records[1].guid,
        backLabel,
        propsDiffHtml
      );
      return;
    }

    const propsHtml = _renderComparePropertiesThreePaneKeyed(
      records[0],
      records[1],
      records[2],
      titles[0],
      titles[1],
      titles[2]
    );
    results.innerHTML = _renderTriplePaneHtml(titles, texts, records.map(r => r.guid), backLabel, propsHtml);
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

  /**
   * One-line summary under the mode bar + check icons on filter section labels.
   * Search text can combine with task status; tagged date, journal, and task status remain mutually exclusive in the sidebar.
   */
  _updateActiveSearchIndicators(el) {
    const sumEl = el.querySelector('.rv-active-filters-summary');
    const setSectionIcon = (selector, active) => {
      const icon = el.querySelector(`${selector} .rv-section-active-icon`);
      if (!icon) return;
      icon.classList.toggle('ti-check', active);
      icon.classList.toggle('rv-section-active-icon--on', active);
    };

    const raw = el.querySelector('.rv-search-input')?.value?.trim() ?? '';
    const hasText = raw.length > 0;
    const taggedChip = el.querySelector('.rv-date-bar .rv-chip--active');
    const hasTagged = !!taggedChip;
    const hasJournal = !!this._journalDate;
    const statusChips = el.querySelectorAll('.rv-status-bar .rv-chip--active');
    const hasStatus = statusChips.length > 0;

    setSectionIcon('.rv-section--filter-tagged', hasTagged);
    setSectionIcon('.rv-section--filter-journal', hasJournal);
    setSectionIcon('.rv-section--filter-status', hasStatus);
    setSectionIcon('.rv-section--filter-search', hasText);

    if (!sumEl) return;
    const parts = [];
    if (hasText) parts.push('Search text');
    if (hasTagged) {
      const label = taggedChip?.textContent?.trim() || 'Tagged date';
      parts.push(`Tagged date (${label})`);
    }
    if (hasJournal) {
      const d = this._journalDate;
      const ds = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      const jr = this._readJournalRange(el);
      const span =
        jr === 'span3'
          ? ', 3 days'
          : jr === 'span7'
            ? ', 7 days'
            : ', 1 day';
      parts.push(`Journal (${ds}${span})`);
    }
    if (hasStatus) {
      const names = [...statusChips].map(c => c.textContent.trim()).filter(Boolean);
      parts.push(`Task status (${names.join(', ')})`);
    }
    sumEl.textContent = parts.length === 0
      ? 'Active: collections only (no text or date/status filters)'
      : 'Active: ' + parts.join(' · ');
  }

  /**
   * Human-readable filter summary for empty-result copy (e.g. `tagged date — All · search: foo`).
   */
  _describeSearchFiltersForEmpty(el) {
    const parts = [];
    const raw = el.querySelector('.rv-search-input')?.value?.trim() ?? '';
    if (raw) {
      const short = raw.length > 100 ? raw.slice(0, 97) + '…' : raw;
      parts.push(`search: ${short}`);
    }
    const taggedChip = el.querySelector('.rv-date-bar .rv-chip--active');
    if (taggedChip) {
      const label = taggedChip.textContent?.trim() || taggedChip.dataset.date || 'Tagged date';
      parts.push(`tagged date — ${label}`);
    }
    const statusChips = [...el.querySelectorAll('.rv-status-bar .rv-chip--active')];
    if (statusChips.length) {
      const names = statusChips.map(c => String(c.textContent || '').trim()).filter(Boolean).join(', ');
      if (names) parts.push(`task status — ${names}`);
    }
    if (el.querySelector('.rv-search-include-type')?.checked) {
      parts.push('include #types');
    }
    const nCol = el.querySelectorAll('.rv-col-list input:checked').length;
    if (nCol > 0) parts.push(`${nCol} collection${nCol === 1 ? '' : 's'}`);
    return parts.length ? parts.join(' · ') : '';
  }

  /**
   * @param {{ ignoreMode?: boolean }} [opts] - If true, refresh `_matchRows` only (no search result DOM); used when switching to Compare from any mode so the compare list uses up-to-date query results.
   */
  async _runSearch(el, opts = {}) {
    if (!opts.ignoreMode && this._panelMode !== 'search') return;
    this._updateActiveSearchIndicators(el);
    const sortMode = this._captureSortMode(el);
    const results = el.querySelector('.rv-results');
    if (!opts.ignoreMode) {
      results.innerHTML = `<div class="rv-loading"><span class="rv-spin ti ti-refresh"></span> Searching…</div>`;
    }

    // Build query string
    const parts = [];

    const raw = el.querySelector('.rv-search-input').value.trim();
    const thymerCollectionScope = _searchStringUsesThymerCollectionScope(raw);
    if (thymerCollectionScope) this._syncCollectionCheckboxesFromQuery(el, raw);
    // When @collection=… is in the box, Thymer scopes the search — don’t filter again by sidebar checkboxes.
    this._filterRecordsByCollectionCheckboxes = !thymerCollectionScope;

    // Pass search text verbatim to Thymer (preserves OR/AND/NOT, ===, !=, #tags, etc.)
    if (raw) parts.push(raw);
    const { texts: textsForType, tags: tagsForType } = _tokensForTypeMerge(raw);

    const activeStatuses = [...el.querySelectorAll('.rv-status-bar .rv-chip--active')]
      .map(c => c.dataset.status)
      .filter(Boolean);
    const statusQuery = _taskStatusTokensOrJoined(activeStatuses);
    if (statusQuery) parts.push(statusQuery);

    const activeDateChip = el.querySelector('.rv-date-bar .rv-chip--active');
    if (activeDateChip) parts.push(activeDateChip.dataset.date);

    // Status + tagged date only (for intersecting “include #types” merges with the same filters)
    const filterPartsOnly = [];
    if (statusQuery) filterPartsOnly.push(statusQuery);
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
        this._matchRows = [];
        if (!opts.ignoreMode) {
          results.innerHTML = `<div class="rv-empty"><span class="ti ti-filter-off"></span><div>No collections selected</div></div>`;
        }
        return;
      }
    }

    const query = parts.join(' ').trim();

    // If journal date is active, find journal records for that date (or range) across selected collections
    if (this._journalDate) {
      this._filterRecordsByCollectionCheckboxes = true;
      this._journalRange = this._readJournalRange(el);
      const range = this._journalRange;
      const days = _journalDaysForRange(this._journalDate, range);
      const users = this.data.getActiveUsers();
      const journalCols = this._collections.filter(c =>
        c.isJournalPlugin() && selectedGuids.has(c.getGuid())
      );
      const batches = await Promise.all(
        days.map(dayDate => {
          const dt = DateTime.dateOnly(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate());
          return Promise.all(
            journalCols.flatMap(col =>
              users.map(user => col.getJournalRecord(user, dt))
            )
          );
        })
      );
      const seen = new Set();
      const merged = [];
      for (const batch of batches) {
        for (const r of batch) {
          if (!r || seen.has(r.guid)) continue;
          seen.add(r.guid);
          merged.push(r);
        }
      }
      const filtered = this._filterJournalDateRecords(merged);
      if (filtered.length === 0) {
        this._matchRows = [];
        if (!opts.ignoreMode) {
          if (range === 'single') {
            results.innerHTML = `<div class="rv-empty"><span class="ti ti-calendar-off"></span><div>No journal entry for this date</div></div>`;
          } else {
            results.innerHTML = `<div class="rv-empty"><span class="ti ti-calendar-off"></span><div>No journal entries for this date range</div><div class="rv-empty-sub">No entries in the selected ${range === 'span3' ? '3 days' : '7 days'} window</div></div>`;
          }
        }
        return;
      }
      this._matchRows = filtered.map(r => ({ record: r, lineItem: null }));
      this._isJournalResults = true;
      this._pageStart = 0;
      if (!opts.ignoreMode) await this._renderSearchPageFromMatchRecords(el);
      return;
    }

    let rows = [];

    if (!query) {
      // No filters active — pull directly from pre-built map, filtered by selected collections
      const allGuids = Object.keys(this._recordColMap)
        .filter(guid => selectedGuids.has(this._recordColMap[guid].colGuid));
      rows = allGuids.map(guid => this.data.getRecord(guid)).filter(Boolean).map(r => ({ record: r, lineItem: null }));
    } else {
      // Run search query then filter to selected collections
      const includeTypeSearch =
        !!el.querySelector('.rv-search-include-type')?.checked
        && this._selectedCollectionsHaveTypeField(selectedGuidsForTypeMerge);
      const wantTypeMerge =
        includeTypeSearch
        && query.trim().length > 0
        && (textsForType.length > 0 || tagsForType.length > 0);

      /** Line hits first (one row per line); record-only hits for pages with no line match. */
      const mergeSearchResultRows = searchResults => {
        const guidsWithLineHits = new Set();
        for (const li of searchResults.lines || []) {
          const record = li.getRecord();
          if (record) guidsWithLineHits.add(record.guid);
        }
        const out = [];
        for (const li of searchResults.lines || []) {
          const record = li.getRecord();
          if (!record) continue;
          out.push({ record, lineItem: li });
        }
        for (const record of searchResults.records || []) {
          if (!record) continue;
          if (guidsWithLineHits.has(record.guid)) continue;
          out.push({ record, lineItem: null });
        }
        return out;
      };

      try {
        const searchResults = await this.data.searchByQuery(query, 500);
        rows = mergeSearchResultRows(searchResults);
        const seen = new Set();
        for (const row of rows) seen.add(row.record.guid);

        // Type-field merges only match words/#tags; they must also satisfy task + tagged date
        // (same tokens run alone through Thymer), or they would bypass @today / @due / status.
        let filterSetForTypeMerge = null;
        if (wantTypeMerge && filterQueryStructured) {
          const fr = await this.data.searchByQuery(filterQueryStructured, 5000);
          filterSetForTypeMerge = _guidsFromSearchResults(fr);
        }

        if (wantTypeMerge) {
          const typeHits = await this._recordsMatchingTypeField(textsForType, tagsForType, selectedGuidsForTypeMerge);
          for (const r of typeHits) {
            if (seen.has(r.guid)) continue;
            if (filterSetForTypeMerge && !filterSetForTypeMerge.has(r.guid)) continue;
            seen.add(r.guid);
            rows.push({ record: r, lineItem: null });
          }
        }
      } catch (err) {
        this._matchRows = [];
        if (!opts.ignoreMode) {
          results.innerHTML = `<div class="rv-empty"><span class="ti ti-alert-triangle"></span><div>${_esc(err.message)}</div></div>`;
        }
        return;
      }

      // Filter to selected collections (skip when query uses @collection=… for Thymer-side scope)
      if (this._filterRecordsByCollectionCheckboxes) {
        rows = rows.filter(row => {
          const meta = this._recordColMap[row.record.guid];
          return meta && selectedGuids.has(meta.colGuid);
        });
      } else {
        rows = rows.filter(row => this._recordColMap[row.record.guid]);
      }
    }

    // Drop journal records with no real "Last modified" (same as UI "—"); those are empty journal shells.
    const filtered = rows.filter(
      row => !(this._isJournalCollectionRecord(row.record) && _isBlankLastModified(row.record))
    );

    if (filtered.length === 0) {
      this._matchRows = [];
      if (!opts.ignoreMode) {
        const detail = this._describeSearchFiltersForEmpty(el);
        const sub = detail
          ? `for: ${_esc(detail)}`
          : 'Try adjusting your filters';
        results.innerHTML = `<div class="rv-empty"><span class="ti ti-search-off"></span><div>No records found</div><div class="rv-empty-sub">${sub}</div></div>`;
      }
      return;
    }

    const sorted = _sortSearchRows(filtered, sortMode, this._recordColMap);
    this._matchRows = sorted;
    this._isJournalResults = false;
    this._pageStart = 0;
    if (!opts.ignoreMode) await this._renderSearchPageFromMatchRecords(el);
  }

  /**
   * @param {{ record: object, lineItems?: object[] }} row - Merged hit: `lineItems` = matching lines (empty = record-only).
   * @param {boolean} [expandPreview] - When true (journal date mode), card starts with preview expanded.
   * @param {{ compareBtn?: boolean, activeTaskStatuses?: Set<string>, highlightTerms?: string[]|null }} [opts] - `activeTaskStatuses` drives Done-filter checkbox styling on hit lines; `highlightTerms` highlights plain search words in hit lines.
   */
  async _buildCard(row, selectedGuids, expandPreview = false, opts = {}) {
    const record = row.record;
    const lineItems = Array.isArray(row.lineItems) ? row.lineItems : [];
    // Fast O(1) lookup using pre-built map
    const meta = this._recordColMap[record.guid];
    const colName = meta ? meta.colName : '';
    const colIcon = meta ? meta.colIcon : 'file-text';
    const colGuid = meta ? meta.colGuid : null;

    // Filter by sidebar collections (skipped when search used @collection=…)
    if (this._filterRecordsByCollectionCheckboxes && colGuid && !selectedGuids.has(colGuid)) return null;

    const hitTexts = lineItems.map(li => _lineItemPlainText(li)).filter(Boolean);

    // Full text excerpt for expanded preview (many lines); prioritize matching lines when present
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
    if (hitTexts.length) {
      const hitSet = new Set(hitTexts);
      const rest = previewChunks.filter(c => !hitSet.has(c));
      previewChunks.length = 0;
      const cap = Math.max(0, PREVIEW_MAX_LINE_ITEMS - hitTexts.length);
      previewChunks.push(...hitTexts, ...rest.slice(0, cap));
    }
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

    const taskStatusSet = opts.activeTaskStatuses instanceof Set ? opts.activeTaskStatuses : new Set();
    const highlightTerms = Array.isArray(opts.highlightTerms) && opts.highlightTerms.length ? opts.highlightTerms : null;
    const hitLineRows = lineItems
      .map(li => {
        const t = _lineItemPlainText(li);
        if (!t) return '';
        const icon = _lineItemHitCheckboxIcon(li, taskStatusSet);
        const checkWrap = icon
          ? `<span class="rv-card-hit-check-wrap" aria-hidden="true"><span class="ti ${icon}"></span></span>`
          : '';
        const display = highlightTerms
          ? _truncateDisplayWithSearchHighlight(t, 220, highlightTerms)
          : _truncateDisplay(t, 220);
        const hitHtml = highlightTerms
          ? _highlightPlainSearchTermsInText(display, highlightTerms)
          : _esc(display);
        return `<div class="rv-card-hit-line">${checkWrap}<span class="rv-card-hit-line-text">${hitHtml}</span></div>`;
      })
      .filter(Boolean);
    const hitLineBlock = hitLineRows.length ? `<div class="rv-card-hit-lines">${hitLineRows.join('')}</div>` : '';

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
      ${hitLineBlock}
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
        await this._goBackFromCompareDiff(el);
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
      if (e.target.closest('.rv-copy-csv')) {
        e.stopPropagation();
        await this._copyResultListToClipboard(el);
        return;
      }
      if (e.target.closest('.rv-copy-moc')) {
        e.stopPropagation();
        await this._openMocDialog(el);
        return;
      }
      if (e.target.closest('.rv-dup-dismiss')) {
        e.stopPropagation();
        const btn = e.target.closest('.rv-dup-dismiss');
        const enc = btn?.dataset.dupKey;
        if (enc == null || enc === '') return;
        try {
          const key = decodeURIComponent(enc);
          this._dupDismissedKeys.add(key);
          if (this._dupGroups?.length) this._renderDuplicateResults(el, this._dupGroups);
        } catch { /* ignore */ }
        return;
      }
      if (e.target.closest('.rv-dup-reset-dismissed')) {
        e.stopPropagation();
        this._dupDismissedKeys.clear();
        if (this._dupGroups?.length) this._renderDuplicateResults(el, this._dupGroups);
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
  { value: 'done',       label: 'Done',        color: '#22c55e' },
  { value: 'inprogress', label: 'In progress', color: '#3b82f6' },
  { value: 'important',  label: 'Important',   color: '#f97316' },
  { value: 'waiting',   label: 'Waiting',    color: '#a855f7' },
  { value: 'discuss',   label: 'Discuss',    color: '#06b6d4' },
  { value: 'alert',     label: 'Alert',      color: '#ef4444' },
  { value: 'starred',   label: 'Starred',    color: '#eab308' },
];

/**
 * Sidebar task-status values → one Thymer query fragment: one `@token`, or `@a OR @b OR …` when several chips are on.
 * @param {string[]} statusValues - e.g. `['done', 'inprogress']`
 * @returns {string}
 */
function _taskStatusTokensOrJoined(statusValues) {
  const vals = (statusValues || []).filter(Boolean);
  if (!vals.length) return '';
  if (vals.length === 1) return '@' + vals[0];
  return vals.map(s => '@' + s).join(' OR ');
}

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
  return typeof raw === 'string' && /@collection\s*=/i.test(raw);
}

/**
 * Extracts each @collection=… value from search text (quoted or unquoted).
 * Matches Thymer-style `@collection="Name"` and `@collection=Name`. Case-insensitive on the token.
 */
function _parseThymerCollectionNamesFromSearch(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const out = [];
  const lower = raw.toLowerCase();
  const needle = '@collection';
  let i = 0;
  while (i < raw.length) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) break;
    let j = idx + needle.length;
    while (j < raw.length && /\s/.test(raw[j])) j++;
    if (raw[j] !== '=') {
      i = idx + 1;
      continue;
    }
    j++;
    while (j < raw.length && /\s/.test(raw[j])) j++;
    if (j >= raw.length) break;
    const c = raw[j];
    if (c === '"' || c === "'") {
      const end = raw.indexOf(c, j + 1);
      if (end > j) {
        out.push(raw.slice(j + 1, end));
        i = end + 1;
        continue;
      }
    }
    const tail = raw.slice(j);
    const um = /^[^\s@]+/.exec(tail);
    if (um) {
      out.push(um[0]);
      i = j + um[0].length;
    } else {
      i = j + 1;
    }
  }
  return out.map(t => t.trim()).filter(Boolean);
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
 * Stable sort for search result rows (by parent record fields; multiple line hits per record stay in relative order).
 * @param {'modified'|'title'|'collection_modified'} mode
 */
function _sortSearchRows(rows, mode, recordColMap) {
  const m = _SORT_MODES.includes(mode) ? mode : 'modified';
  const out = [...rows];
  if (m === 'title') {
    out.sort((a, b) => _cmpTitleAsc(a.record, b.record));
  } else if (m === 'collection_modified') {
    out.sort((a, b) => _cmpCollectionThenModified(a.record, b.record, recordColMap));
  } else {
    out.sort((a, b) => _cmpModifiedDesc(a.record, b.record));
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
      <button type="button" class="rv-link rv-expand-all">expand</button>
      <span>·</span>
      <button type="button" class="rv-link rv-collapse-all">collapse</button>
      <span>·</span>
      <button type="button" class="rv-link rv-copy-csv" title="Copy results as CSV (Title, Collection, Record ID, Match line)">CSV</button>
      <span>·</span>
      <button type="button" class="rv-link rv-copy-moc" title="Map of content: write to a note or copy Markdown">MOC</button>
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

/** Stable string for one property; dates as ISO for cross-locale duplicate matching. */
function _dupPropertyValueString(record, prop) {
  const name = prop.field?.label || prop.name || '';
  if (!name) return null;
  try {
    const d = record.date(name);
    if (d) {
      try {
        const dt = d instanceof Date ? d : new Date(d);
        if (!Number.isNaN(dt.getTime())) return dt.toISOString();
      } catch { /* fall through */ }
      return String(d);
    }
    const num = record.number(name);
    if (num != null && !Number.isNaN(num)) return String(num);
    const txt = record.text(name);
    if (txt) {
      const t = String(txt).trim();
      if (!t) return null;
      return t.length > DUP_PROP_MAX_PER_FIELD ? t.slice(0, DUP_PROP_MAX_PER_FIELD) + '…' : t;
    }
  } catch { return null; }
  return null;
}

/** Canonical property lines for duplicate body comparison (sorted, capped). */
function _extractPropertiesTextForDup(record) {
  let props;
  try {
    props = record.getAllProperties().filter(p => !_isBuiltinTimestampProperty(p));
  } catch {
    return '';
  }
  const withVal = [];
  for (const p of props) {
    const key = `${String(p.field?.id || '')}\0${String(p.name || '')}`;
    const val = _dupPropertyValueString(record, p);
    if (val == null || val === '') continue;
    const label = String(p.field?.label || p.name || '').trim() || key;
    withVal.push({ key, label, val });
  }
  withVal.sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }));
  const lines = [];
  let total = 0;
  for (const { label, val } of withVal) {
    const line = `${label}: ${val}`;
    const add = line.length + (lines.length ? 1 : 0);
    if (total + add > DUP_PROP_MAX_TOTAL) break;
    lines.push(line);
    total += add;
  }
  return lines.join('\n');
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

async function _extractRecordFullText(record, opts = {}) {
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
  let out = chunks.join('\n');
  if (opts.includeProps) {
    const propsBlob = _extractPropertiesTextForDup(record);
    if (propsBlob) {
      out = out ? `${out}\n\n---\n${propsBlob}` : `---\n${propsBlob}`;
    }
  }
  return out;
}

async function _recordsWithBodyText(records, includeProps = false) {
  const out = [];
  for (const r of records) {
    const body = await _extractRecordFullText(r, { includeProps });
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

function _duplicateGroupsContentExact(withText, opts = {}) {
  const label = opts.includeProps ? 'Same body text (+ properties)' : 'Same body text';
  const map = new Map();
  for (const { record, body } of withText) {
    const k = _hashStr(_normalizeBodyForHash(body));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(record);
  }
  const groups = [];
  for (const recs of map.values()) {
    if (recs.length < 2) continue;
    groups.push({ label, records: recs });
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

function _duplicateGroupsContentSimilar(withText, threshold, opts = {}) {
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
  const pct = Math.round(threshold * 100);
  const label = opts.includeProps
    ? `Similar body (+ properties) (${pct}%+ word overlap)`
    : `Similar body (${pct}%+ word overlap)`;
  for (const g of buck.values()) {
    if (g.length < 2) continue;
    groups.push({
      label,
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

/** Max line count per dimension for full 3-way alignment DP (memory ~ (n+1)(m+1)(p+1) cells). */
const _THREE_WAY_DP_MAX_LINES = 200;
const _THREE_WAY_DP_MAX_CELLS = 5_500_000;

/**
 * Per-row highlight flags for three aligned lines (two agree → odd column out; all differ → all).
 */
function _tripleConsensusFlags(L0, L1, L2) {
  if (L0 === L1 && L1 === L2) {
    return { allEq: true, d0: false, d1: false, d2: false };
  }
  if (L1 === L2) {
    const odd = L0 !== L1;
    return { allEq: false, d0: odd, d1: false, d2: false };
  }
  if (L0 === L2) {
    const odd = L1 !== L0;
    return { allEq: false, d0: false, d1: odd, d2: false };
  }
  if (L0 === L1) {
    const odd = L2 !== L0;
    return { allEq: false, d0: false, d1: false, d2: odd };
  }
  return { allEq: false, d0: true, d1: true, d2: true };
}

/** Fallback: naive same-index rows (only when line count exceeds DP budget). */
function _diffLinesTripleIndexedFallback(a, b, c) {
  const max = Math.max(a.length, b.length, c.length);
  const rows = [];
  for (let i = 0; i < max; i++) {
    const L0 = a[i] ?? '';
    const L1 = b[i] ?? '';
    const L2 = c[i] ?? '';
    const { allEq, d0, d1, d2 } = _tripleConsensusFlags(L0, L1, L2);
    rows.push({ allEq, L0, L1, L2, d0, d1, d2 });
  }
  return rows;
}

/**
 * 3-way line alignment (dynamic programming over line arrays): matches insert/delete/move
 * across columns like a merge, not raw line index. Rows are (L0,L1,L2) with '' for gaps;
 * highlights use _tripleConsensusFlags. Falls back to index alignment if DP budget exceeded.
 */
function _diffLinesTripleAligned(a, b, c) {
  const n = a.length;
  const m = b.length;
  const p = c.length;
  const cells = (n + 1) * (m + 1) * (p + 1);
  if (
    n > _THREE_WAY_DP_MAX_LINES ||
    m > _THREE_WAY_DP_MAX_LINES ||
    p > _THREE_WAY_DP_MAX_LINES ||
    cells > _THREE_WAY_DP_MAX_CELLS
  ) {
    return _diffLinesTripleIndexedFallback(a, b, c);
  }

  const NINF = -1e9;
  const dp = new Float64Array(cells);
  dp.fill(NINF);
  dp[0] = 0;

  const idx = (i, j, k) => i * (m + 1) * (p + 1) + j * (p + 1) + k;

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      for (let k = 0; k <= p; k++) {
        if (i === 0 && j === 0 && k === 0) continue;
        let best = NINF;
        const relax = (v, pred) => {
          if (pred > NINF / 2) best = Math.max(best, pred + v);
        };

        if (i > 0 && j > 0 && k > 0) {
          const ta = a[i - 1];
          const tb = b[j - 1];
          const tc = c[k - 1];
          relax(ta === tb && tb === tc ? 3 : 0, dp[idx(i - 1, j - 1, k - 1)]);
        }
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) relax(2, dp[idx(i - 1, j - 1, k)]);
        if (i > 0 && k > 0 && a[i - 1] === c[k - 1]) relax(2, dp[idx(i - 1, j, k - 1)]);
        if (j > 0 && k > 0 && b[j - 1] === c[k - 1]) relax(2, dp[idx(i, j - 1, k - 1)]);
        if (i > 0) relax(0, dp[idx(i - 1, j, k)]);
        if (j > 0) relax(0, dp[idx(i, j - 1, k)]);
        if (k > 0) relax(0, dp[idx(i, j, k - 1)]);

        dp[idx(i, j, k)] = best;
      }
    }
  }

  if (dp[idx(n, m, p)] <= NINF / 2) {
    return _diffLinesTripleIndexedFallback(a, b, c);
  }

  const rows = [];
  let i = n;
  let j = m;
  let k = p;
  while (i > 0 || j > 0 || k > 0) {
    const cur = dp[idx(i, j, k)];

    const tryTripleEq = () => {
      if (i > 0 && j > 0 && k > 0) {
        const ta = a[i - 1];
        const tb = b[j - 1];
        const tc = c[k - 1];
        if (ta === tb && tb === tc && dp[idx(i - 1, j - 1, k - 1)] + 3 === cur) {
          rows.push({ L0: ta, L1: tb, L2: tc });
          i--;
          j--;
          k--;
          return true;
        }
      }
      return false;
    };
    const tryPairAB = () => {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && dp[idx(i - 1, j - 1, k)] + 2 === cur) {
        rows.push({ L0: a[i - 1], L1: b[j - 1], L2: '' });
        i--;
        j--;
        return true;
      }
      return false;
    };
    const tryPairAC = () => {
      if (i > 0 && k > 0 && a[i - 1] === c[k - 1] && dp[idx(i - 1, j, k - 1)] + 2 === cur) {
        rows.push({ L0: a[i - 1], L1: '', L2: c[k - 1] });
        i--;
        k--;
        return true;
      }
      return false;
    };
    const tryPairBC = () => {
      if (j > 0 && k > 0 && b[j - 1] === c[k - 1] && dp[idx(i, j - 1, k - 1)] + 2 === cur) {
        rows.push({ L0: '', L1: b[j - 1], L2: c[k - 1] });
        j--;
        k--;
        return true;
      }
      return false;
    };
    const tryTripleMis = () => {
      if (i > 0 && j > 0 && k > 0) {
        const ta = a[i - 1];
        const tb = b[j - 1];
        const tc = c[k - 1];
        if (!(ta === tb && tb === tc) && dp[idx(i - 1, j - 1, k - 1)] === cur) {
          rows.push({ L0: ta, L1: tb, L2: tc });
          i--;
          j--;
          k--;
          return true;
        }
      }
      return false;
    };
    const tryA = () => {
      if (i > 0 && dp[idx(i - 1, j, k)] === cur) {
        rows.push({ L0: a[i - 1], L1: '', L2: '' });
        i--;
        return true;
      }
      return false;
    };
    const tryB = () => {
      if (j > 0 && dp[idx(i, j - 1, k)] === cur) {
        rows.push({ L0: '', L1: b[j - 1], L2: '' });
        j--;
        return true;
      }
      return false;
    };
    const tryC = () => {
      if (k > 0 && dp[idx(i, j, k - 1)] === cur) {
        rows.push({ L0: '', L1: '', L2: c[k - 1] });
        k--;
        return true;
      }
      return false;
    };

    const step =
      tryTripleEq() ||
      tryPairAB() ||
      tryPairAC() ||
      tryPairBC() ||
      tryTripleMis() ||
      tryA() ||
      tryB() ||
      tryC();

    if (!step) {
      if (i > 0) {
        rows.push({ L0: a[i - 1], L1: '', L2: '' });
        i--;
      } else if (j > 0) {
        rows.push({ L0: '', L1: b[j - 1], L2: '' });
        j--;
      } else if (k > 0) {
        rows.push({ L0: '', L1: '', L2: c[k - 1] });
        k--;
      } else break;
    }
  }

  rows.reverse();
  return rows.map(({ L0, L1, L2 }) => {
    const { allEq, d0, d1, d2 } = _tripleConsensusFlags(L0, L1, L2);
    return { allEq, L0, L1, L2, d0, d1, d2 };
  });
}

function _diffLinesTriple(text0, text1, text2) {
  const a = String(text0 || '').split('\n');
  const b = String(text1 || '').split('\n');
  const c = String(text2 || '').split('\n');
  return _diffLinesTripleAligned(a, b, c);
}

function _tripleColLineClass(allEq, colIdx, differs) {
  if (allEq || !differs) return 'rv-diff-col-line rv-diff-equal';
  return `rv-diff-col-line rv-diff-triple-changed rv-diff-triple-changed--${colIdx}`;
}

/** Display value for one property in compare (locale dates; same filters as card expanded props). */
function _comparePropertyDisplayValue(record, prop) {
  const name = prop.field?.label || prop.name || '';
  if (!name) return null;
  try {
    const date = record.date(name);
    if (date) return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const num = record.number(name);
    if (num != null && !Number.isNaN(num)) return String(num);
    const txt = record.text(name);
    if (txt) {
      const t = String(txt).trim();
      if (!t) return null;
      return t.length > 800 ? t.slice(0, 800) + '…' : t;
    }
  } catch { return null; }
  return null;
}

/** Sorted "Label: value" lines for compare property panel. */
function _comparePropertyLinesForDisplay(record) {
  let props;
  try {
    props = record.getAllProperties().filter(p => !_isBuiltinTimestampProperty(p));
  } catch {
    return [];
  }
  const rows = [];
  for (const p of props) {
    const key = `${String(p.field?.id || '')}\0${String(p.name || '')}`;
    const val = _comparePropertyDisplayValue(record, p);
    if (val == null || val === '') continue;
    const label = String(p.field?.label || p.name || '').trim() || key;
    rows.push({ key, line: `${label}: ${val}` });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }));
  return rows.map(r => r.line);
}

/** Map stable key → { label, display, fieldName } for keyed compare (non-empty values only). */
function _comparePropertyMapForDisplay(record) {
  const map = new Map();
  let props;
  try {
    props = record.getAllProperties().filter(p => !_isBuiltinTimestampProperty(p));
  } catch {
    return map;
  }
  for (const p of props) {
    const key = `${String(p.field?.id || '')}\0${String(p.name || '')}`;
    const val = _comparePropertyDisplayValue(record, p);
    if (val == null || val === '') continue;
    const label = String(p.field?.label || p.name || '').trim() || key;
    const fieldName = p.field?.label || p.name || '';
    map.set(key, { label, display: val, fieldName });
  }
  return map;
}

/** True if two property entries represent the same value (dates by instant, numbers by value, else normalized display). */
function _comparePropertyEntriesEqual(recordA, recordB, entryA, entryB) {
  if (!entryA || !entryB) return false;
  const nameA = entryA.fieldName;
  const nameB = entryB.fieldName;
  try {
    const dA = recordA.date(nameA);
    const dB = recordB.date(nameB);
    if (dA && dB) {
      const ta = dA instanceof Date ? dA.getTime() : new Date(dA).getTime();
      const tb = dB instanceof Date ? dB.getTime() : new Date(dB).getTime();
      if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;
    }
    const nA = recordA.number(nameA);
    const nB = recordB.number(nameB);
    if (nA != null && nB != null && !Number.isNaN(nA) && !Number.isNaN(nB)) return nA === nB;
  } catch { /* fall through */ }
  return _normalizeBodyForHash(entryA.display) === _normalizeBodyForHash(entryB.display);
}

/** All three property entries present and pairwise semantically equal. */
function _comparePropertyEntriesEqualThree(recordA, recordB, recordC, ea, eb, ec) {
  if (!ea || !eb || !ec) return false;
  return (
    _comparePropertyEntriesEqual(recordA, recordB, ea, eb) &&
    _comparePropertyEntriesEqual(recordB, recordC, eb, ec) &&
    _comparePropertyEntriesEqual(recordA, recordC, ea, ec)
  );
}

/**
 * Per-column state for 3-way keyed properties: `missing` = no value here (softer tint),
 * `exclusive` / `mismatch` = strong column tint (only note with key, or unequal values).
 */
function _triplePropCellKind(recordA, recordB, recordC, ea, eb, ec, col) {
  const present = [!!ea, !!eb, !!ec];
  const count = present[0] + present[1] + present[2];
  const entries = [ea, eb, ec];
  const records = [recordA, recordB, recordC];
  const e = entries[col];
  if (!e) return 'missing';
  if (count === 1) return 'exclusive';
  let differs = false;
  for (let j = 0; j < 3; j++) {
    if (j === col || !entries[j]) continue;
    if (!_comparePropertyEntriesEqual(records[col], records[j], e, entries[j])) differs = true;
  }
  return differs ? 'mismatch' : 'equal';
}

/** `<pre>` class for 3-way keyed property cells. */
function _tripleKeyedPropCellClass(allEq, colIdx, kind) {
  if (allEq || kind === 'equal') return 'rv-diff-cell rv-diff-equal';
  if (kind === 'missing') return `rv-diff-cell rv-diff-cell--missing rv-diff-cell--missing-${colIdx}`;
  return `rv-diff-cell rv-diff-triple-changed rv-diff-triple-changed--${colIdx}`;
}

/** Collapsible properties block; `open` = expanded by default (used where keyed diff is not shown). */
function _renderComparePropertiesCollapsible(record) {
  const lines = _comparePropertyLinesForDisplay(record);
  const n = lines.length;
  const inner = lines.length
    ? lines.map(l => `<div class="rv-compare-prop-line">${_esc(l)}</div>`).join('')
    : '<div class="rv-compare-prop-empty">No custom properties</div>';
  return `<details class="rv-compare-props" open>
  <summary class="rv-compare-props-summary"><span class="ti ti-chevron-right rv-compare-props-chevron" aria-hidden="true"></span> Properties (${n})</summary>
  <div class="rv-compare-props-body">${inner}</div>
</details>`;
}

/**
 * Two-pane: aligned columns per property key; diff colors for equal / mismatch / left-only / right-only.
 */
function _renderComparePropertiesTwoPaneKeyed(recordA, recordB, titleA = '', titleB = '') {
  const mapA = _comparePropertyMapForDisplay(recordA);
  const mapB = _comparePropertyMapForDisplay(recordB);
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
  const keys = [...allKeys].sort((ka, kb) => {
    const la = (mapA.get(ka) || mapB.get(ka)).label;
    const lb = (mapA.get(kb) || mapB.get(kb)).label;
    return la.localeCompare(lb, undefined, { sensitivity: 'base' });
  });

  let inner;
  if (keys.length === 0) {
    inner = '<div class="rv-compare-prop-empty">No custom properties</div>';
  } else {
    const head = `<div class="rv-compare-props-keyed-head">
  <div class="rv-compare-props-keyed-hcell">${_esc(_truncateDisplay(String(titleA || 'Left'), 36))}</div>
  <div class="rv-compare-props-keyed-hcell">${_esc(_truncateDisplay(String(titleB || 'Right'), 36))}</div>
</div>`;
    const rows = keys
      .map(key => {
        const entryA = mapA.get(key);
        const entryB = mapB.get(key);
        let rowClass = 'rv-diff-equal';
        if (entryA && entryB) {
          rowClass = _comparePropertyEntriesEqual(recordA, recordB, entryA, entryB)
            ? 'rv-diff-equal'
            : 'rv-prop-diff-mismatch';
        } else if (entryA && !entryB) {
          rowClass = 'rv-diff-del';
        } else if (!entryA && entryB) {
          rowClass = 'rv-diff-add';
        } else {
          return '';
        }
        const leftLine = entryA ? `${entryA.label}: ${entryA.display}` : '';
        const rightLine = entryB ? `${entryB.label}: ${entryB.display}` : '';
        const leftInner = entryA ? _esc(leftLine) : '<span class="rv-prop-missing">—</span>';
        const rightInner = entryB ? _esc(rightLine) : '<span class="rv-prop-missing">—</span>';
        const leftPreCls = entryA ? 'rv-diff-cell' : 'rv-diff-cell rv-diff-cell--missing rv-diff-cell--missing-0';
        const rightPreCls = entryB ? 'rv-diff-cell' : 'rv-diff-cell rv-diff-cell--missing rv-diff-cell--missing-1';
        return `<div class="rv-diff-row ${rowClass}"><pre class="${leftPreCls}">${leftInner}</pre><pre class="${rightPreCls}">${rightInner}</pre></div>`;
      })
      .filter(Boolean)
      .join('');
    inner = `<div class="rv-compare-props-keyed-wrap">${head}<div class="rv-diff-grid rv-diff-grid--props">${rows}</div></div>`;
  }
  return `<details class="rv-compare-props" open>
  <summary class="rv-compare-props-summary"><span class="ti ti-chevron-right rv-compare-props-chevron" aria-hidden="true"></span> Properties (${keys.length})</summary>
  <div class="rv-compare-props-body rv-compare-props-body--diff">${inner}</div>
</details>`;
}

/**
 * Three-pane: one keyed grid (same keys across columns) with per-cell semantic diff tints.
 */
function _renderComparePropertiesThreePaneKeyed(recordA, recordB, recordC, titleA = '', titleB = '', titleC = '') {
  const mapA = _comparePropertyMapForDisplay(recordA);
  const mapB = _comparePropertyMapForDisplay(recordB);
  const mapC = _comparePropertyMapForDisplay(recordC);
  const allKeys = new Set([...mapA.keys(), ...mapB.keys(), ...mapC.keys()]);
  const keys = [...allKeys].sort((ka, kb) => {
    const la = (mapA.get(ka) || mapB.get(ka) || mapC.get(ka)).label;
    const lb = (mapA.get(kb) || mapB.get(kb) || mapC.get(kb)).label;
    return la.localeCompare(lb, undefined, { sensitivity: 'base' });
  });

  let inner;
  if (keys.length === 0) {
    inner = '<div class="rv-compare-prop-empty">No custom properties</div>';
  } else {
    const head = `<div class="rv-compare-props-keyed-head rv-compare-props-keyed-head--triple">
  <div class="rv-compare-props-keyed-hcell">${_esc(_truncateDisplay(String(titleA || 'Left'), 28))}</div>
  <div class="rv-compare-props-keyed-hcell">${_esc(_truncateDisplay(String(titleB || 'Middle'), 28))}</div>
  <div class="rv-compare-props-keyed-hcell">${_esc(_truncateDisplay(String(titleC || 'Right'), 28))}</div>
</div>`;
    const rows = keys
      .map(key => {
        const ea = mapA.get(key);
        const eb = mapB.get(key);
        const ec = mapC.get(key);
        if (!ea && !eb && !ec) return '';
        const allEq = _comparePropertyEntriesEqualThree(recordA, recordB, recordC, ea, eb, ec);
        const k0 = _triplePropCellKind(recordA, recordB, recordC, ea, eb, ec, 0);
        const k1 = _triplePropCellKind(recordA, recordB, recordC, ea, eb, ec, 1);
        const k2 = _triplePropCellKind(recordA, recordB, recordC, ea, eb, ec, 2);
        const line0 = ea ? `${ea.label}: ${ea.display}` : '';
        const line1 = eb ? `${eb.label}: ${eb.display}` : '';
        const line2 = ec ? `${ec.label}: ${ec.display}` : '';
        const inner0 = ea ? _esc(line0) : '<span class="rv-prop-missing">—</span>';
        const inner1 = eb ? _esc(line1) : '<span class="rv-prop-missing">—</span>';
        const inner2 = ec ? _esc(line2) : '<span class="rv-prop-missing">—</span>';
        const c0 = _tripleKeyedPropCellClass(allEq, 0, k0);
        const c1 = _tripleKeyedPropCellClass(allEq, 1, k1);
        const c2 = _tripleKeyedPropCellClass(allEq, 2, k2);
        return `<div class="rv-diff-prop-row-triple"><pre class="${c0}">${inner0}</pre><pre class="${c1}">${inner1}</pre><pre class="${c2}">${inner2}</pre></div>`;
      })
      .filter(Boolean)
      .join('');
    inner = `<div class="rv-compare-props-keyed-wrap">${head}<div class="rv-diff-grid rv-diff-grid--props rv-diff-grid--props-triple">${rows}</div></div>`;
  }
  return `<details class="rv-compare-props" open>
  <summary class="rv-compare-props-summary"><span class="ti ti-chevron-right rv-compare-props-chevron" aria-hidden="true"></span> Properties (${keys.length})</summary>
  <div class="rv-compare-props-body rv-compare-props-body--diff">${inner}</div>
</details>`;
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

function _renderTwoPaneDiffHtml(titleA, titleB, seq, guidA, guidB, backLabel = 'Back to list', propsDiffHtml = '') {
  const rows = seq
    .map(({ t, left, right }) => {
      const cls = t === 'both' ? 'rv-diff-equal' : t === 'left' ? 'rv-diff-del' : 'rv-diff-add';
      return `<div class="rv-diff-row ${cls}"><pre class="rv-diff-cell">${_esc(left)}</pre><pre class="rv-diff-cell">${_esc(right)}</pre></div>`;
    })
    .join('');
  return `<div class="rv-compare-diff-wrap">
  <div class="rv-compare-diff-header">
    <button type="button" class="rv-link rv-compare-back">${_esc(backLabel)}</button>
    <span class="rv-compare-diff-titles"><span>${_esc(_truncateDisplay(titleA, 40))}</span><span class="rv-diff-vs">vs</span><span>${_esc(_truncateDisplay(titleB, 40))}</span></span>
  </div>
  <div class="rv-compare-col-actions-row">
    <div class="rv-compare-col-actions-cell">${_compareRecordActionsHtml(guidA, titleA)}</div>
    <div class="rv-compare-col-actions-cell">${_compareRecordActionsHtml(guidB, titleB)}</div>
  </div>
  <div class="rv-compare-props-row rv-compare-props-row--full">
    <div class="rv-compare-props-cell">${propsDiffHtml}</div>
  </div>
  <div class="rv-diff-grid">${rows}</div>
</div>`;
}

function _renderTriplePaneHtml(titles, texts, guids, backLabel = 'Back to list', propsHtml = '') {
  const bodyRows = _diffLinesTriple(texts[0], texts[1], texts[2]);
  const heads = [0, 1, 2]
    .map(colIdx => {
      const t = titles[colIdx] || '';
      const gid = guids[colIdx] || '';
      return `<div class="rv-diff-triple-head-cell"><div class="rv-diff-col-head">
  ${gid ? _compareRecordActionsHtml(gid, t) : `<span class="rv-compare-file-name">${_esc(_truncateDisplay(t, 48))}</span>`}
</div></div>`;
    })
    .join('');
  const bodyCells = bodyRows.flatMap(r =>
    [0, 1, 2].map(colIdx => {
      const Lk = colIdx === 0 ? 'L0' : colIdx === 1 ? 'L1' : 'L2';
      const Dk = colIdx === 0 ? 'd0' : colIdx === 1 ? 'd1' : 'd2';
      const line = r[Lk];
      const cls = _tripleColLineClass(r.allEq, colIdx, r[Dk]);
      return `<pre class="${cls}">${_esc(line)}</pre>`;
    })
  );
  const bodySync = `<div class="rv-diff-triple-body-span"><div class="rv-diff-triple-body-sync">${bodyCells.join('')}</div></div>`;
  return `<div class="rv-compare-diff-wrap rv-compare-diff-wrap--triple">
  <div class="rv-compare-diff-header">
    <button type="button" class="rv-link rv-compare-back">${_esc(backLabel)}</button>
    <span class="rv-compare-diff-hint">Three notes side by side</span>
  </div>
  <div class="rv-diff-triple rv-diff-triple--keyed-props">
    ${heads}
    <div class="rv-diff-triple-props-span">${propsHtml}</div>
    ${bodySync}
  </div>
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

/** Stable id for a duplicate group (label + sorted record GUIDs). */
function _dupGroupKey(g) {
  const guids = (g.records || []).map(r => r?.guid).filter(Boolean).sort();
  return `${String(g.label || '')}\0${guids.join(',')}`;
}

/**
 * Collapse flat search hits into one card per record; `lineItems` collects all line hits in visit order.
 * @param {{ record: object, lineItem: object|null }[]} flatRows
 * @returns {{ record: object, lineItems: object[] }[]}
 */
function _mergeSearchRowsByRecord(flatRows) {
  const map = new Map();
  const order = [];
  for (const row of flatRows) {
    const g = row.record.guid;
    if (!map.has(g)) {
      map.set(g, { record: row.record, lineItems: [] });
      order.push(g);
    }
    if (row.lineItem) map.get(g).lineItems.push(row.lineItem);
  }
  return order.map(g => map.get(g));
}

/**
 * Plain text for a line hit (segments with string text, including dates on tasks).
 */
function _lineItemPlainText(li) {
  if (!li?.segments?.length) return '';
  const parts = [];
  for (const s of li.segments) {
    if (typeof s.text === 'string') parts.push(s.text);
  }
  return parts.join('').trim();
}

function _escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive substring matches for hit-line highlights (includes partial words).
 * Longest terms first so longer tokens win when one contains another (e.g. "foo" vs "foobar").
 */
function _searchHighlightSubstringRegex(terms) {
  const sorted = [...terms].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!sorted.length) return /$^/;
  const pattern = sorted.map(t => _escapeRegExp(t)).join('|');
  try {
    return new RegExp(`(${pattern})`, 'giu');
  } catch {
    return new RegExp(`(${pattern})`, 'gi');
  }
}

/** Earliest character index where any term matches as a substring (case-insensitive). */
function _firstSubstringMatchIndex(str, terms) {
  const s = String(str ?? '');
  const lower = s.toLowerCase();
  let best = -1;
  for (const t of terms) {
    if (!t) continue;
    const idx = lower.indexOf(t.toLowerCase());
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

/**
 * Prefer a slice that contains the first substring match so long lines still show highlights.
 */
function _truncateDisplayWithSearchHighlight(str, maxLen, terms) {
  const s = String(str ?? '');
  if (s.length <= maxLen) return s;
  if (!terms?.length) return _truncateDisplay(s, maxLen);
  const idx = _firstSubstringMatchIndex(s, terms);
  if (idx < 0) return _truncateDisplay(s, maxLen);
  const lead = Math.min(56, Math.floor(maxLen * 0.38));
  const start = Math.max(0, Math.min(idx - lead, s.length - maxLen));
  const slice = s.slice(start, start + maxLen);
  const prefix = start > 0 ? '…' : '';
  const suffix = start + maxLen < s.length ? '…' : '';
  return prefix + slice + suffix;
}

/** Tokens skipped when deriving plain-text highlight words from the search box. */
const _PLAIN_SEARCH_HIGHLIGHT_STOP = new Set([
  'or', 'and', 'not', '||', '&&', '!', '=', '===', '!=', '<', '<=', '>', '>=',
]);

/**
 * Words from the search box to highlight in hit lines when the query has no `@` or `#`.
 * @returns {string[]|null}
 */
function _plainSearchHighlightTermsFromQuery(queryRaw) {
  const q = String(queryRaw || '').trim();
  if (!q || /[@#]/.test(q)) return null;
  const tokens = q.split(/\s+/).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (_PLAIN_SEARCH_HIGHLIGHT_STOP.has(lower)) continue;
    if (tok.length < 2) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(tok);
  }
  return out.length ? out : null;
}

/**
 * Case-insensitive substring highlights as safe HTML (`<mark class="rv-search-hit-mark">`).
 * Partial word matches are included; same rules as `_searchHighlightSubstringRegex`.
 * @param {string} text
 * @param {string[]} terms
 */
function _highlightPlainSearchTermsInText(text, terms) {
  if (!text || !terms?.length) return _esc(text);
  const re = _searchHighlightSubstringRegex(terms);
  const parts = [];
  let last = 0;
  let m;
  const r = new RegExp(re.source, re.flags);
  while ((m = r.exec(text)) !== null) {
    if (m.index > last) parts.push(_esc(text.slice(last, m.index)));
    parts.push(`<mark class="rv-search-hit-mark">${_esc(m[0])}</mark>`);
    last = m.index + m[0].length;
    if (m[0].length === 0) r.lastIndex++;
  }
  if (last < text.length) parts.push(_esc(text.slice(last)));
  return parts.join('');
}

/** Active task-status chip values (`done`, `inprogress`, …) from the sidebar. */
function _activeTaskStatusSet(el) {
  try {
    return new Set(
      [...el.querySelectorAll('.rv-status-bar .rv-chip--active')]
        .map(c => c.dataset.status)
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

/**
 * Tabler icon class for leading checkbox on a **task** search hit line (done vs open).
 * Non-task line hits return null — no checkbox affordance for plain text/heading/etc.
 */
function _lineItemHitCheckboxIcon(li, activeTaskStatuses) {
  const st = activeTaskStatuses instanceof Set ? activeTaskStatuses : new Set();
  if (!li || li.type !== 'task') return null;
  try {
    const p = li.props;
    if (
      p &&
      (p.done === true ||
        p.done === 1 ||
        p.completed === true ||
        String(p.taskStatus || '').toLowerCase() === 'done' ||
        String(p.status || '').toLowerCase() === 'done')
    ) {
      return 'ti-square-check';
    }
  } catch { /* ignore */ }
  // Done filter: hits are done tasks; line props often omit completion flags.
  if (st.has('done')) {
    return 'ti-square-check';
  }
  return 'ti-square';
}

/**
 * Client-side filter for search/compare result rows (case-insensitive substring).
 * Matches note title, collection name, or matching line text.
 * @returns {{ filtered: { record: object, lineItem: object|null }[], totalBeforeFilter: number }}
 */
function _filterSearchRows(rows, filterText, recordColMap) {
  const totalBeforeFilter = rows.length;
  const n = String(filterText || '').trim().toLowerCase();
  if (!n) return { filtered: rows, totalBeforeFilter };
  const filtered = rows.filter(row => {
    const r = row.record;
    try {
      if (String(r.getName() || '').toLowerCase().includes(n)) return true;
    } catch { /* ignore */ }
    const m = recordColMap?.[r.guid];
    if (m && String(m.colName || '').toLowerCase().includes(n)) return true;
    if (row.lineItem) {
      const t = _lineItemPlainText(row.lineItem).toLowerCase();
      if (t.includes(n)) return true;
    }
    return false;
  });
  return { filtered, totalBeforeFilter };
}

/** Normalize cell text: newlines/tabs → space (before CSV escaping). */
function _csvFlattenCell(s) {
  return String(s ?? '').replace(/\r|\n|\t/g, ' ');
}

/** RFC-style CSV: comma-separated; fields with `,` or `"` quoted, `"` doubled inside quotes. */
function _csvEscapeCell(s) {
  const t = _csvFlattenCell(s);
  if (/[",]/.test(t)) {
    return `"${t.replace(/"/g, '""')}"`;
  }
  return t;
}

/** CSV lines: Title, Collection, Record ID, Match line(s) — merged rows join hits with ` | `. */
function _formatSearchRowsForClipboard(rows, recordColMap) {
  const lines = ['Title,Collection,Record ID,Match line'];
  for (const row of rows) {
    const r = row.record;
    if (!r) continue;
    let title = '(untitled)';
    try {
      title = String(r.getName() || '').trim() || '(untitled)';
    } catch { /* ignore */ }
    const m = recordColMap?.[r.guid];
    const col = m ? String(m.colName ?? '') : '';
    const matchLine = (row.lineItems || [])
      .map(li => _csvFlattenCell(_lineItemPlainText(li)))
      .filter(Boolean)
      .join(' | ');
    lines.push(
      [_csvEscapeCell(title), _csvEscapeCell(col), _csvEscapeCell(String(r.guid)), _csvEscapeCell(matchLine)].join(',')
    );
  }
  return lines.join('\n');
}

/** Last top-level line item (for chaining after `insertFromMarkdown` headings). */
async function _mocLastTopLineItem(record) {
  const items = await record.getLineItems(false);
  const arr = Array.isArray(items) ? items : items ? [items] : [];
  return arr.length ? arr[arr.length - 1] : null;
}

/**
 * Wiki-style text for **Copy** / clipboard. `@Foo` is not a note link (reserved for filters).
 * Pasting `[[Note title]]` into Thymer may resolve like the Obsidian importer; **`insertFromMarkdown`
 * does not** create record links — use structured insert (`ref` segments) when writing from MOC.
 * Titles containing `[` or `]` break the delimiter; we fall back to `[[guid]]`.
 */
function _mocWikiLink(recordTitle, guid) {
  const t = String(recordTitle ?? '').replace(/\r|\n|\t/g, ' ').trim() || '(untitled)';
  const g = String(guid || '').trim();
  if (/[\[\]]/.test(t)) {
    return g ? `[[${g}]]` : `[[${t}]]`;
  }
  return `[[${t}]]`;
}

/** Payload for a `ref` line-item segment (links to a record by guid). */
function _mocRefPayload(recordTitle, guid) {
  const t = String(recordTitle ?? '').replace(/\r|\n|\t/g, ' ').trim() || '(untitled)';
  const g = String(guid || '').trim();
  if (/[\[\]]/.test(t)) {
    return g ? { guid: g, title: g } : { guid: g, title: '(untitled)' };
  }
  return { guid: g, title: t };
}

/**
 * @returns {{ col: string, items: { title: string, guid: string }[] }[]}
 */
function _groupSearchRowsForMoc(rows, recordColMap) {
  const byCol = new Map();
  for (const row of rows) {
    const r = row.record;
    if (!r) continue;
    let title = '(untitled)';
    try {
      title = String(r.getName() || '').trim() || '(untitled)';
    } catch { /* ignore */ }
    const m = recordColMap?.[r.guid];
    const col = m ? String(m.colName ?? '').trim() || '(no collection)' : '(no collection)';
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col).push({ title, guid: r.guid });
  }
  return [...byCol.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
    .map(([col, items]) => ({ col, items }));
}

/**
 * Markdown “map of content”: `# Map of content`, then `## collection` and one `[[title]]` per line (no list bullets).
 * A blank line is inserted before each `##` from the 2nd collection onward.
 */
function _formatSearchRowsForMoc(rows, recordColMap) {
  const groups = _groupSearchRowsForMoc(rows, recordColMap);
  const lines = ['# Map of content', ''];
  for (let gi = 0; gi < groups.length; gi++) {
    const { col, items } = groups[gi];
    const heading = col.replace(/\r|\n/g, ' ').trim() || '(no collection)';
    if (gi > 0) lines.push('');
    lines.push(`## ${heading}`);
    lines.push('');
    for (const { title, guid } of items) {
      lines.push(_mocWikiLink(title, guid));
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
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
    </div>

    <div class="rv-block rv-block-search">

    <div class="rv-active-filters-summary" aria-live="polite"></div>

    <div class="rv-section rv-section--filter-tagged">
      <div class="rv-section-label">
        <span class="rv-section-active-icon ti" aria-hidden="true"></span>
        Tagged Date
        <span class="rv-col-actions">
          <button type="button" class="rv-link rv-tagged-date-clear">clear</button>
        </span>
      </div>
      <div class="rv-date-bar"></div>
    </div>

    <div class="rv-section rv-section--filter-journal">
      <div class="rv-section-label">
        <span class="rv-section-active-icon ti" aria-hidden="true"></span>
        Journal Date
        <span class="rv-col-actions">
          <button type="button" class="rv-link rv-journal-clear">clear</button>
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
        <div class="rv-journal-range-row">
          <span class="rv-journal-range-label">Range</span>
          <label class="rv-journal-range-opt"><input type="radio" name="rv-journal-range" class="rv-journal-range" value="single" checked> 1 day</label>
          <label class="rv-journal-range-opt"><input type="radio" name="rv-journal-range" class="rv-journal-range" value="span3"> 3 days</label>
          <label class="rv-journal-range-opt"><input type="radio" name="rv-journal-range" class="rv-journal-range" value="span7"> 7 days</label>
        </div>
      </div>
    </div>

    <div class="rv-section rv-section--filter-status">
      <div class="rv-section-label">
        <span class="rv-section-active-icon ti" aria-hidden="true"></span>
        Task status
        <span class="rv-col-actions">
          <button type="button" class="rv-link rv-task-status-clear">clear</button>
        </span>
      </div>
      <div class="rv-status-bar"></div>
    </div>

    <div class="rv-section rv-section--filter-search">
      <div class="rv-section-label">
        <span class="rv-section-active-icon ti" aria-hidden="true"></span>
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
      <div class="rv-section-label">Presets</div>
      <div class="rv-preset-list"></div>
      <div class="rv-preset-save-row">
        <input class="rv-preset-name" type="text" placeholder="Name this filter set…">
        <button class="rv-preset-save" title="Save preset"><span class="ti ti-device-floppy"></span></button>
        <button class="rv-preset-edit-toggle" title="Manage presets"><span class="ti ti-trash"></span></button>
      </div>
    </div>

    <div class="rv-section">
      <div class="rv-section-label">Filter results</div>
      <input type="text" class="rv-search-results-filter" placeholder="Title or collection…" autocomplete="off" title="Narrows the current result list by note title or collection name (does not change the Thymer query)">
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
          <span>Include prefix &amp; suffix variants</span>
        </label>
        <label class="rv-dup-body-props-wrap">
          <input type="checkbox" class="rv-dup-body-include-props">
          <span>Include property fields</span>
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

  <div class="rv-moc-overlay" hidden>
    <div class="rv-moc-dialog" role="dialog" aria-modal="true" aria-labelledby="rv-moc-dlg-title">
      <div class="rv-moc-dlg-heading" id="rv-moc-dlg-title">Map of content</div>
      <div class="rv-moc-mode">
        <label class="rv-moc-radio"><input type="radio" name="rv-moc-mode" value="new" checked> New note</label>
        <label class="rv-moc-radio"><input type="radio" name="rv-moc-mode" value="existing"> Existing note</label>
      </div>
      <div class="rv-moc-new-section">
        <label class="rv-moc-label">Collection</label>
        <select class="rv-moc-col-new"></select>
        <label class="rv-moc-label">Note title</label>
        <input type="text" class="rv-moc-title-new" value="Map of content" placeholder="Title for the new note" autocomplete="off">
      </div>
      <div class="rv-moc-existing-section" hidden>
        <label class="rv-moc-label">Collection</label>
        <select class="rv-moc-col-existing"></select>
        <label class="rv-moc-label">Note</label>
        <select class="rv-moc-record-select"><option value="">— Select note —</option></select>
      </div>
      <div class="rv-moc-append-row" hidden>
        <label class="rv-moc-label">If the note already has content</label>
        <select class="rv-moc-append-mode">
          <option value="append">Append to end</option>
          <option value="replace">Replace entire note</option>
        </select>
      </div>
      <p class="rv-moc-hint">Writing to a note inserts <strong>clickable links</strong> (one line per note; <code>##</code> headings per collection). Copy only uses Markdown <code>[[…]]</code> text (no list bullets).</p>
      <div class="rv-moc-actions">
        <button type="button" class="rv-link rv-moc-cancel">Cancel</button>
        <button type="button" class="rv-link rv-moc-copy-only">Copy only</button>
        <button type="button" class="rv-moc-write">Write</button>
      </div>
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

.rv-moc-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
}
.rv-moc-overlay[hidden] {
  display: none !important;
}
.rv-moc-dialog {
  width: min(420px, 100%);
  max-height: min(90vh, 560px);
  overflow-y: auto;
  padding: 20px 18px;
  border-radius: 10px;
  border: 1px solid rgba(128, 128, 128, 0.28);
  background: rgba(26, 26, 30, 0.98);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}
.rv-moc-dlg-heading {
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 14px 0;
}
.rv-moc-mode {
  display: flex;
  gap: 16px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.rv-moc-radio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.rv-moc-new-section,
.rv-moc-existing-section,
.rv-moc-append-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
/* Author display:flex rule wins over the HTML hidden attribute unless we force this. */
.rv-moc-new-section[hidden],
.rv-moc-existing-section[hidden],
.rv-moc-append-row[hidden] {
  display: none !important;
}
.rv-moc-label {
  font-size: 10px;
  font-weight: 600;
  opacity: 0.55;
  text-transform: uppercase;
  letter-spacing: 0.35px;
}
.rv-moc-col-new,
.rv-moc-col-existing,
.rv-moc-record-select,
.rv-moc-append-mode,
.rv-moc-title-new {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.22);
  background: transparent;
  color: inherit;
  font-size: 12px;
  outline: none;
}
.rv-moc-col-new:focus,
.rv-moc-col-existing:focus,
.rv-moc-record-select:focus,
.rv-moc-append-mode:focus,
.rv-moc-title-new:focus {
  border-color: var(--color-accent, #2563eb);
}
.rv-moc-hint {
  font-size: 10px;
  opacity: 0.55;
  line-height: 1.45;
  margin: 0 0 14px 0;
}
.rv-moc-hint code {
  font-size: 10px;
  opacity: 0.9;
}
.rv-moc-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
}
.rv-moc-write {
  padding: 8px 14px;
  border-radius: 6px;
  border: none;
  background: var(--color-accent, #2563eb);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.rv-moc-write:hover {
  filter: brightness(1.08);
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
.rv-card-hit-lines {
  margin-top: 5px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rv-card-hit-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.45;
  font-weight: 400;
  color: inherit;
  opacity: 0.78;
}
.rv-card-hit-check-wrap {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}
.rv-card-hit-check-wrap .ti {
  font-size: 13px;
  opacity: 0.72;
  line-height: 1;
}
.rv-card-hit-line-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.rv-card-hit-line-text .rv-search-hit-mark {
  background: #fff200;
  color: #0d0d0d;
  border-radius: 2px;
  padding: 0 2px;
  box-shadow: inset 0 0 0 1px rgba(234, 179, 0, 0.55);
}
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
.rv-journal-range-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.35;
}
.rv-journal-range-label {
  opacity: 0.55;
  font-weight: 600;
  margin-right: 2px;
}
.rv-journal-range-opt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  opacity: 0.9;
}
.rv-journal-range-opt input {
  margin: 0;
  width: 12px;
  height: 12px;
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
.rv-active-filters-summary {
  font-size: 11px;
  line-height: 1.35;
  color: rgba(128,128,128,0.95);
  margin: -6px 0 12px 0;
  min-height: 1.35em;
}
.rv-section-active-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  margin-right: 4px;
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.12s;
  vertical-align: middle;
}
.rv-section-active-icon--on {
  opacity: 1;
  color: var(--color-accent, #2563eb);
}
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
.rv-sidebar--mode-search .rv-compare-filter-wrap,
.rv-sidebar--mode-duplicates .rv-compare-filter-wrap { display: none; }
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
.rv-dup-body-props-wrap {
  display: none;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 11px;
  line-height: 1.35;
  cursor: pointer;
}
.rv-dup-body-props-wrap input {
  margin: 0;
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  cursor: pointer;
}
.rv-dup-body-props-wrap span { opacity: 0.88; }
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
.rv-compare-filter,
.rv-search-results-filter {
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
.rv-compare-filter:focus,
.rv-search-results-filter:focus {
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
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
  opacity: 0.85;
}
.rv-dup-group-head-main { flex: 1; min-width: 0; }
.rv-dup-dismiss { flex-shrink: 0; font-size: 11px; }
.rv-dup-group-n { opacity: 0.5; font-weight: 500; }
.rv-results-toolbar--dup { margin-bottom: 12px; }
.rv-results-toolbar--dup .rv-count-row {
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

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
.rv-compare-props-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  border: 1px solid rgba(128,128,128,0.2);
  border-top: 1px solid rgba(128,128,128,0.15);
  border-bottom: none;
  overflow: hidden;
  background: rgba(128,128,128,0.06);
}
.rv-compare-props-row--full {
  grid-template-columns: 1fr;
}
.rv-compare-props-cell {
  padding: 6px 10px;
  border-right: 1px solid rgba(128,128,128,0.15);
  min-width: 0;
}
.rv-compare-props-cell:last-child { border-right: none; }
.rv-compare-props-row--full .rv-compare-props-cell { border-right: none; }
.rv-compare-props {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
}
.rv-compare-props-summary {
  cursor: pointer;
  font-weight: 600;
  list-style: none;
  padding: 2px 0 4px 0;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.rv-compare-props-chevron {
  flex-shrink: 0;
  font-size: 15px;
  line-height: 1;
  opacity: 0.65;
  transition: transform 0.15s ease, opacity 0.12s;
}
.rv-compare-props summary:hover .rv-compare-props-chevron { opacity: 0.95; }
details[open] > .rv-compare-props-summary .rv-compare-props-chevron {
  transform: rotate(90deg);
}
.rv-compare-props-summary::-webkit-details-marker { display: none; }
.rv-compare-props-body {
  padding-top: 4px;
  max-height: min(28vh, 240px);
  overflow-y: auto;
}
.rv-compare-props-body--diff {
  max-height: none;
  overflow: visible;
  padding-top: 2px;
}
.rv-diff-grid--props {
  max-height: min(28vh, 260px);
  overflow-y: auto;
  border-radius: 6px;
  font-size: 11px;
}
.rv-compare-props-keyed-wrap {
  border: 1px solid rgba(128,128,128,0.2);
  border-radius: 6px;
  overflow: hidden;
}
.rv-compare-props-keyed-head {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  border-bottom: 1px solid rgba(128,128,128,0.15);
  background: rgba(128,128,128,0.08);
}
.rv-compare-props-keyed-hcell {
  padding: 5px 8px;
  font-size: 10px;
  font-weight: 600;
  opacity: 0.8;
  border-right: 1px solid rgba(128,128,128,0.12);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rv-compare-props-keyed-hcell:last-child { border-right: none; }
.rv-compare-props-keyed-head--triple {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
  width: 100%;
}
.rv-diff-grid--props-triple .rv-diff-cell.rv-diff-equal { background: rgba(128,128,128,0.04); }
.rv-diff-grid--props-triple .rv-diff-cell.rv-diff-triple-changed--0 { background: rgba(37, 99, 235, 0.06); }
.rv-diff-grid--props-triple .rv-diff-cell.rv-diff-triple-changed--1 { background: rgba(234, 179, 8, 0.07); }
.rv-diff-grid--props-triple .rv-diff-cell.rv-diff-triple-changed--2 { background: rgba(34, 197, 94, 0.06); }
.rv-diff-grid--props-triple .rv-diff-cell.rv-diff-cell--missing {
  background: rgba(128, 128, 128, 0.05);
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.13);
}
.rv-diff-grid--props-triple .rv-diff-cell.rv-diff-cell--missing .rv-prop-missing {
  opacity: 0.4;
}
.rv-diff-grid--props-triple .rv-diff-cell.rv-diff-cell--missing-0 {
  box-shadow: inset 3px 0 0 rgba(37, 99, 235, 0.2), inset 0 0 0 1px rgba(128, 128, 128, 0.1);
}
.rv-diff-grid--props-triple .rv-diff-cell.rv-diff-cell--missing-1 {
  box-shadow: inset 3px 0 0 rgba(234, 179, 8, 0.32), inset 0 0 0 1px rgba(128, 128, 128, 0.1);
}
.rv-diff-grid--props-triple .rv-diff-cell.rv-diff-cell--missing-2 {
  box-shadow: inset 3px 0 0 rgba(34, 197, 94, 0.26), inset 0 0 0 1px rgba(128, 128, 128, 0.1);
}
.rv-compare-props-keyed-wrap .rv-diff-grid--props {
  border: none;
  border-radius: 0;
  max-height: min(26vh, 240px);
}
.rv-diff-row.rv-prop-diff-mismatch .rv-diff-cell:first-child { background: rgba(37, 99, 235, 0.06); }
.rv-diff-row.rv-prop-diff-mismatch .rv-diff-cell:last-child { background: rgba(234, 179, 8, 0.07); }
/* Keyed props: empty side (—) — softer than mismatch / exclusive */
.rv-diff-grid--props .rv-diff-cell.rv-diff-cell--missing {
  background: rgba(128, 128, 128, 0.05);
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.13);
}
.rv-diff-grid--props .rv-diff-cell.rv-diff-cell--missing .rv-prop-missing {
  opacity: 0.4;
}
.rv-diff-grid--props .rv-diff-cell.rv-diff-cell--missing-0 {
  box-shadow: inset 3px 0 0 rgba(37, 99, 235, 0.2), inset 0 0 0 1px rgba(128, 128, 128, 0.1);
}
.rv-diff-grid--props .rv-diff-cell.rv-diff-cell--missing-1 {
  box-shadow: inset 3px 0 0 rgba(234, 179, 8, 0.32), inset 0 0 0 1px rgba(128, 128, 128, 0.1);
}
.rv-diff-grid--props .rv-diff-del .rv-diff-cell.rv-diff-cell--missing:last-child,
.rv-diff-grid--props .rv-diff-add .rv-diff-cell.rv-diff-cell--missing:first-child {
  background: rgba(128, 128, 128, 0.05);
}
.rv-prop-missing { opacity: 0.5; font-style: italic; }
.rv-compare-prop-line {
  padding: 3px 0;
  border-bottom: 1px solid rgba(128,128,128,0.1);
  word-break: break-word;
  white-space: pre-wrap;
}
.rv-compare-prop-line:last-child { border-bottom: none; }
.rv-compare-prop-empty { opacity: 0.55; font-style: italic; padding: 2px 0; }
.rv-compare-props-row + .rv-diff-grid {
  border-top: none;
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
/* Three-pane keyed props: avoid display:contents (fragile); each row is its own 3-col grid */
.rv-diff-grid.rv-diff-grid--props-triple {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.rv-diff-prop-row-triple {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 0;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
.rv-diff-prop-row-triple .rv-diff-cell {
  min-width: 0;
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
.rv-diff-del .rv-diff-cell:first-child { background: rgba(37, 99, 235, 0.06); }
.rv-diff-del .rv-diff-cell:last-child { background: rgba(128,128,128,0.04); }
.rv-diff-add .rv-diff-cell:first-child { background: rgba(128,128,128,0.04); }
.rv-diff-add .rv-diff-cell:last-child { background: rgba(234, 179, 8, 0.07); }
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
  .rv-diff-triple--keyed-props { grid-template-columns: 1fr; }
}
.rv-diff-triple--keyed-props {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  align-items: start;
  max-height: min(70vh, 720px);
  overflow: auto;
}
.rv-diff-triple-props-span {
  grid-column: 1 / -1;
  min-width: 0;
}
/* One shared grid for body: each diff row is a single grid row so column heights stay aligned */
.rv-diff-triple-body-span {
  grid-column: 1 / -1;
  min-width: 0;
}
.rv-diff-triple-body-sync {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
  align-items: stretch;
  justify-items: stretch;
  gap: 0;
  border: 1px solid rgba(128,128,128,0.2);
  border-radius: 8px;
  overflow: hidden;
  max-height: min(60vh, 520px);
  overflow-y: auto;
}
.rv-diff-triple-body-sync .rv-diff-col-line {
  border-right: 1px solid rgba(128,128,128,0.12);
}
.rv-diff-triple-body-sync .rv-diff-col-line:nth-child(3n) {
  border-right: none;
}
.rv-diff-triple-head-cell { min-width: 0; }
.rv-diff-triple-head-cell .rv-diff-col-head {
  border: 1px solid rgba(128,128,128,0.2);
  border-radius: 8px;
}
.rv-diff-col {
  display: flex;
  flex-direction: column;
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
.rv-diff-col-props {
  padding: 6px 10px;
  border-bottom: 1px solid rgba(128,128,128,0.12);
  background: rgba(128,128,128,0.04);
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
/* Two-pane compare: body + keyed properties use blue / amber / gray (see .rv-diff-* / .rv-prop-diff-mismatch). */
/* Three-pane: neutral chrome; body uses per-line tints (same hues as two-pane + green for column 3). */
.rv-diff-col-body-wrap {
  flex: 1;
  min-height: 0;
  max-height: 60vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.rv-diff-col-line {
  margin: 0;
  padding: 4px 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.45;
  border-bottom: 1px solid rgba(128,128,128,0.1);
}
.rv-diff-col-line.rv-diff-equal { background: rgba(128,128,128,0.04); }
.rv-diff-col-line.rv-diff-triple-changed--0 { background: rgba(37, 99, 235, 0.06); }
.rv-diff-col-line.rv-diff-triple-changed--1 { background: rgba(234, 179, 8, 0.07); }
.rv-diff-col-line.rv-diff-triple-changed--2 { background: rgba(34, 197, 94, 0.06); }
`;
