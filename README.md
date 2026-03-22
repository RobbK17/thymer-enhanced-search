# Enhanced Search — Thymer Plugin

**Version 1.1.5**

Cross-collection record viewer with **Search**, **Duplicates**, and **Compare** modes: filters for text, hashtags, tagged dates, task status, journal day/range, and collections; duplicate and similar title/body analysis (optional property fields in body); side-by-side compare with line diff and keyed property diff for two or three notes; and presets for search and duplicate settings.

## Modes

Use the **Search** / **Duplicates** / **Compare** buttons at the top of the sidebar. **Collections** at the bottom apply to all modes (which collections are included in searches, duplicate scans, and compare card lists).

### Search

In the sidebar (Search mode), sections run **Tagged date** → **Journal date** → **Task status** → **Search** (text box) → **Presets** → **Filter results**, then **Collections** under the mode blocks.

- **Active summary** — In **Search** mode, directly under the mode bar, one line shows what is currently active (e.g. search text, which tagged-date chip, journal day/range, or task statuses). **Section headers** for Tagged date, Journal date, Task status, and Search show a small check when that filter is on.
- **Combining filters** — **Search text** (the text box) can combine with **at most one** of **Tagged date**, **Journal date**, or **Task status**. Those three are **mutually exclusive**: turning on a chip or day in one clears the other two (e.g. you can use text + task status, or text + tagged date, but not tagged date + journal at once). Header **clear** links only clear that section.
- **Search** — Plain text plus `#hashtags` (Thymer’s normal search rules). The search box and **include #types** sit after **Task status** and before **Presets**.
- **Task status** — Chips such as All tasks, Done, Started, … (adds `@…` filters to the search). **clear** on the same line clears status chips only.
- **Tagged date** — Today, Tomorrow, This week, Due, Overdue (adds `@today`, `@week`, etc.). **clear** clears tagged-date chips only.
- **include #types** — Optional; when a selected collection has a **choice** field named `type` or `types`, merges extra matches on that field from your words and `#tags` (see below).
- **Journal date** — Picks an anchor **calendar day** and loads journal pages for a **range** (see below). Separate from normal search when active. **clear** clears journal selection.
- **Journal range** — When journal date is on: **1 day** (single day), **3 days**, or **7 days** (multi-day window around the anchor). The active summary includes the chosen range (e.g. `Journal (Mon, Jan 15, 3 days)`).
- **Collections** — Limit which collections are searched (or which journals are queried in journal mode).
- **Sort** — **Modified (newest first)** (default), **Title (A–Z)**, or **Collection, then modified**; applies to normal search (mixed journal + other collections). Choice is remembered per workspace and stored in presets. **Journal date** mode does not show the sort control.
- **Filter results** — After results load, optionally narrow the **card list** by substring on **note title** or **collection name**. This is a client-side filter only; it does **not** change the Thymer query. Counts can show how many rows match before this filter.
- **Copy list** — In the results toolbar (**Copy list**), copies the **full current result list** (after **Filter results**, if any) to the clipboard as tab-separated **Title**, **Collection**, and **Record ID** — one row per note, header row included (pastes cleanly into spreadsheets). The same control appears on the Compare card list.
- **Presets** — Save and reload combinations of search filters (search text, status, tagged date, journal date, range, collections, include #types, sort, **Filter results** text).
- **Open a result** — Click a card to open the record in a panel.

### Duplicates

- **Duplicate analysis** — Choose what to compare: **Exact titles**, **Similar titles**, **Exact body**, or **Similar body** (default: Similar titles).
- **Similarity** — Slider (70–100%) for similar-title and similar-body modes.
- **Include prefix & suffix variants** — For **Similar titles** only; helps group titles that differ by prefix/suffix wording.
- **Include property fields** — Shown for **Exact body** / **Similar body**; when enabled, custom property text is included in the body string used for duplicate detection.
- **Run analysis** — Scans notes in the **selected collections** (capped at **2500** records per run; narrow collections if you hit the limit). **Run analysis** also **clears the Compare tray** (same as **Clear** on compare) so you start from a clean compare selection.
- **Filter groups** — After results appear, narrow groups by substring match on group label, note title, or collection name.
- **Dismiss / Restore** — Each group header has **Dismiss** to hide that group from the list (until you run analysis again or use **Restore dismissed** in the toolbar). If every group is dismissed, use **Restore dismissed** in the empty state or toolbar to show them all again.
- **Presets** — Save and reload duplicate settings: kind, threshold, prefix option, **include property fields** (when applicable), filter text, and **collections** selection. Loading a preset switches to Duplicates mode and runs analysis.

### Compare

- Run a query in **Search** first so the main area has a result list (or use **Duplicates** results). The **Compare** tray and **Open compare** appear in the sidebar in **Search**, **Duplicates**, and **Compare** modes.
- Use **+** on cards to add up to **three** notes to the tray; **Open compare** opens a **two-note** line diff or a **three-note** side-by-side view. Switch to **Compare** if you only want the compare card list in the main area.
- **Two notes** — Line-oriented diff (insert/delete style) with **Properties** shown as a keyed two-column grid (same property keys aligned); cells are tinted for equal lines, mismatches, or values only on one side. Empty sides use a softer “missing” style than value mismatches.
- **Three notes** — **Body** uses a **three-way line alignment** (not just line index): insertions/deletions are aligned across columns where possible; the body area is one **CSS grid** so each logical row keeps the **same height** across all three columns (including wrapped lines and empty gap cells). **Properties** use a **three-column keyed** grid (one row per property key) with per-cell semantic highlighting; missing fields use the same softer style as two-pane.
- **Filter list** — Shown in **Compare** mode only (hidden in Search/Duplicates). Narrows which notes appear in the compare card list (matches note title or collection name); does not change the underlying search result set from Thymer.
- **Clear** empties the tray. From the diff / side-by-side view, **Back to list** (Compare mode), **Back to duplicates** (Duplicates), or **Back to search** (Search) returns to that list and **clears the compare tray** (selected notes).

## How the options work together (Search)

**Normal search (search box + status or tagged date + collections)**  
**Tagged date**, **Journal date**, and **Task status** are **mutually exclusive** in the sidebar (turning on one clears the others). **Search text** can still combine with whichever of those three is active (for example text + task status, or text + tagged date). When **Journal date** is off, the plugin builds **one** Thymer query from the search box plus **either** task-status chips **or** a single tagged-date chip (not both). Everything is turned into **one query** for Thymer:

1. The **entire search box** string is sent **as you typed it** (spaces, `OR` / `AND` / `NOT`, `===`, `!=`, `#tags`, etc. are **not** rewritten by the plugin).  
2. Any **task status** chips you turned on (`@task`, `@done`, …), **or** at most one **Tagged date** chip (`@today`, `@tomorrow`, `@week`, `@due`, `@overdue`) — not both; the UI keeps status and tagged date mutually exclusive when you are not in journal mode.

Those pieces are combined and run together, so—for example—`report #client` with **Today** and **Done** asks Thymer for results that match **all** of those constraints (as its search language defines).

**Collections (sidebar checkboxes)**  
Normally the plugin **filters** Thymer’s search hits to records in the collections you checked. If your search text includes Thymer’s **`@collection=…`** form (e.g. `@collection="Licenses" ai`), the plugin **does not** apply that sidebar filter — Thymer’s query alone defines scope, and you can run a search even with **no** collections checked. When you run a search, the plugin also **updates the Collections checkboxes** so that only collections whose **names** match the `@collection=` values in the box are checked (case-insensitive; supports quoted names and several `@collection=` tokens). If a name does not match any collection in the workspace, those checkboxes are left unchanged for that name. The plugin still merges **`searchResults.records`** and **`searchResults.lines`** (each line hit’s parent record), deduped by GUID — Thymer’s UI may show a **different** number if it counts “hits” or primary rows only. **include #types** is hidden until at least one collection is checked (it needs a collection with a Type field); with no collections checked it does **not** run. Journal date mode still uses the sidebar collections for which journals are queried.

**Sort (normal search only)**  
After results are loaded, they are ordered by your **Sort** control: **Modified** = last modified time, newest first; rows with no usable modified time sort **last**, then by title. **Title** = record name A–Z. **Collection, then modified** = collection name A–Z, then the same modified rules within each collection. Journal collections follow the same rules as any other collection. **Journal date** mode does not show the sort control (journal list view).

**include #types**  
For the **Type** field merge only, the plugin **splits** the search box on whitespace and drops standalone boolean/operator tokens (`OR`, `AND`, `NOT`, `&&`, `||`, `!`, `=`, `===`, `!=`, `<`, `<=`, `>`, `>=`) so needles aren’t polluted; the **main query** to Thymer is still unchanged. It uses the remaining words and `#tags` to find extra records whose **Type** choice (`type` / `types`) matches those tokens, then merges them with the main results. Those extras are **also** checked against any **task status** and **Tagged date** you have selected (so they can’t ignore `@today`, `@due`, etc.).

**Tagged date only (no words in the search box)**  
The query is just Thymer’s token (e.g. `@today`). If that returns no rows, you’ll see **no records** — that comes from Thymer’s search, not from this plugin skipping the filter.

**Tagged date + search text**  
The plugin sends **one** query (e.g. `your words @today`). How strictly text and `@…` combine is defined by **Thymer’s global search** (same as the rest of the app). If something still looks off with **include #types** turned off, it’s worth comparing the same query in Thymer’s main search.

**Journal date (different mode)**  
When you use the **Journal date** picker (prev/next day, last week / today / next week shortcuts), the plugin loads journal pages for the chosen **day and range** (1 / 3 / 7 days). It does **not** run the same combined “search box + tagged date + status” query for that flow. Turn journal date off to go back to normal search.

Journal date mode does **not** hide pages because of blank **Last modified** or empty body text — if Thymer returns a journal record for that day (or within the range), it is listed. Result cards start with the **preview expanded** (you can collapse with the chevron or **collapse all**).

**Empty search**  
If you leave the search box empty and don’t use status or tagged date, the plugin can show records from the selected collections without a text query (depending on what’s active).

## Files

- `plugin.js` — Main plugin code (includes embedded CSS)
- `plugin.json` — Plugin configuration

## Usage in Thymer

1. Open **Plugins Manager** in Thymer  
2. Create a new global plugin or edit an existing one  
3. Paste the contents of `plugin.js` into the code editor  
4. Set the JSON config from `plugin.json` if needed  
5. The plugin adds a command palette entry: **Toggle Enhanced Search** (opens the panel, or closes it if it’s already open)

## SDK Reference

- [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk/blob/main/types.d.ts)  
- [SDK Examples](https://github.com/thymerapp/thymer-plugin-sdk/tree/main/examples)
