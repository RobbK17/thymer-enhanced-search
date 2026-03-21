# Enhanced Search — Thymer Plugin

**Version 1.0.0**

Cross-collection record viewer with filters for text, hashtags, tagged dates, task status, and collections.

## Features

- **Search** — Plain text plus `#hashtags` (Thymer’s normal search rules)
- **Task status** — Chips such as All tasks, Done, Started, … (adds `@…` filters to the search)
- **Tagged date** — Today, Tomorrow, This week, Due, Overdue (adds `@today`, `@week`, etc.)
- **include #types** — Optional; when a selected collection has a **choice** field named `type` or `types`, merges extra matches on that field from your words and `#tags` (see below)
- **Journal date** — Picks a **calendar day** and shows journal pages for that day (separate from search; see below)
- **Collections** — Limit which collections are searched
- **Sort** — **Modified (newest first)** (default), **Title (A–Z)**, or **Collection, then modified**; applies to normal search (mixed journal + other collections). Choice is remembered per workspace and stored in presets.
- **Presets** — Save and reload combinations of the above
- **Open a result** — Click a card to open the record in a panel

## How the options work together

**Normal search (search box + status + tagged date + collections)**  
Everything you set is turned into **one query** for Thymer:

1. The **entire search box** string is sent **as you typed it** (spaces, `OR` / `AND` / `NOT`, `===`, `!=`, `#tags`, etc. are **not** rewritten by the plugin).  
2. Any **task status** chips you turned on (`@task`, `@done`, …)  
3. At most one **Tagged date** chip (`@today`, `@tomorrow`, `@week`, `@due`, `@overdue`)

Those pieces are combined and run together, so—for example—`report #client` with **Today** and **Done** asks Thymer for results that match **all** of those constraints (as its search language defines).

**Collections (sidebar checkboxes)**  
Normally the plugin **filters** Thymer’s search hits to records in the collections you checked. If your search text includes Thymer’s **`@collection=…`** form (e.g. `@collection="Licenses" ai`), the plugin **does not** apply that sidebar filter — Thymer’s query alone defines scope, and you can run a search even with **no** collections checked. The plugin still merges **`searchResults.records`** and **`searchResults.lines`** (each line hit’s parent record), deduped by GUID — Thymer’s UI may show a **different** number if it counts “hits” or primary rows only. **include #types** is hidden until at least one collection is checked (it needs a collection with a Type field); with no collections checked it does **not** run. Journal date mode still uses the sidebar collections for which journals are queried.

**Debugging a different count vs Thymer**  
In the browser devtools console: `localStorage.setItem('rv_debug_search', '1')`, reload Thymer, run your search, and check console lines prefixed `[Enhanced Search]` — they show merged record count after `searchByQuery`, after collection filter, and after dropping blank journal shells. Set `'0'` or remove the key to turn off.

**Sort (normal search only)**  
After results are loaded, they are ordered by your **Sort** control: **Modified** = last modified time, newest first; rows with no usable modified time sort **last**, then by title. **Title** = record name A–Z. **Collection, then modified** = collection name A–Z, then the same modified rules within each collection. Journal collections follow the same rules as any other collection. **Journal date** mode does not show the sort control (single-day journal view).

**include #types**  
For the **Type** field merge only, the plugin **splits** the search box on whitespace and drops standalone boolean/operator tokens (`OR`, `AND`, `NOT`, `&&`, `||`, `!`, `=`, `===`, `!=`, `<`, `<=`, `>`, `>=`) so needles aren’t polluted; the **main query** to Thymer is still unchanged. It uses the remaining words and `#tags` to find extra records whose **Type** choice (`type` / `types`) matches those tokens, then merges them with the main results. Those extras are **also** checked against any **task status** and **Tagged date** you have selected (so they can’t ignore `@today`, `@due`, etc.).

**Tagged date only (no words in the search box)**  
The query is just Thymer’s token (e.g. `@today`). If that returns no rows, you’ll see **no records** — that comes from Thymer’s search, not from this plugin skipping the filter.

**Tagged date + search text**  
The plugin sends **one** query (e.g. `your words @today`). How strictly text and `@…` combine is defined by **Thymer’s global search** (same as the rest of the app). If something still looks off with **include #types** turned off, it’s worth comparing the same query in Thymer’s main search.

**Journal date (different mode)**  
When you use the **Journal date** picker (prev/next day, last week / today / next week shortcuts), the plugin switches to **that day’s journal pages** only. It does **not** run the same combined “search box + tagged date + status” query for that flow. Turn journal date off to go back to normal search.

Journal date mode does **not** hide pages because of blank **Last modified** or empty body text — if Thymer returns a journal record for that day, it is listed. Result cards start with the **preview expanded** (you can collapse with the chevron or **collapse all**).

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
