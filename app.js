/*
 * app.js — UI state and wiring for Markdown Notes.
 * Editing is WYSIWYG via Toast UI Editor (window.toastui). Disk I/O via window.FS.
 * Notes are stored as Markdown; the editor converts to/from Markdown transparently.
 */
(function () {
  "use strict";

  // ---- DOM refs -------------------------------------------------------------
  const $ = function (id) {
    return document.getElementById(id);
  };
  const els = {
    unsupported: $("unsupported"),
    app: $("app"),
    btnOpen: $("btn-open"),
    btnOpen2: $("btn-open-2"),
    btnNewNote: $("btn-new-note"),
    btnNewFolder: $("btn-new-folder"),
    btnImport: $("btn-import"),
    btnExport: $("btn-export"),
    btnDelete: $("btn-delete"),
    btnTheme: $("btn-theme"),
    status: $("status"),
    search: $("search"),
    tree: $("tree"),
    editorHeader: $("editor-header"),
    noteTitle: $("note-title"),
    moveFolder: $("move-folder"),
    editorHost: $("editor"),
    welcomeScreen: $("welcome-screen"),
    fileInput: $("file-input"),
  };

  // Short, specific reason for a caught error — surfaced in the status pill,
  // with the full text on hover (title attribute, set by setStatus).
  function describe(e) {
    if (!e) return "failed";
    const name = e.name || "Error";
    return e.message ? name + ": " + e.message : name;
  }

  // ---- State ----------------------------------------------------------------
  const state = {
    tree: { folders: [], notes: [] },
    active: null, // { handle, parentDir, name, path }
    selectedDir: null, // { handle, path } for where new notes/folders go
    collapsed: new Set(), // folder paths that are collapsed
    contentCache: new Map(), // path -> markdown text (for search)
    saveTimer: null,
    query: "",
    loading: false, // true while we programmatically load a note (ignore change events)
    searchGen: 0, // incremented each time a search starts; stale callbacks check this
  };

  let editor = null; // Toast UI Editor instance

  // ---- Status helper --------------------------------------------------------
  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = "status" + (kind ? " " + kind : "");
    els.status.title = kind === "error" ? text : "";
  }

  // ---- Init -----------------------------------------------------------------
  function init() {
    if (!window.FS.isSupported()) {
      els.unsupported.classList.remove("hidden");
      els.app.classList.add("hidden");
      return;
    }
    applyTheme(resolveInitialTheme()); // set <html data-theme> before the editor is built
    createEditor();
    applyTheme(document.documentElement.dataset.theme); // sync the editor's dark class
    wireEvents();
    tryRestore();
  }

  // ---- Theme (light / dark) -------------------------------------------------
  const THEME_KEY = "mdnotes.theme";

  function resolveInitialTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    theme = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    // Toast UI's dark styling hangs off a class on its root element.
    const root = els.editorHost.querySelector(".toastui-editor-defaultUI");
    if (root) root.classList.toggle("toastui-editor-dark", theme === "dark");
    if (els.btnTheme) {
      els.btnTheme.title = theme === "dark" ? "Switch to light" : "Switch to dark";
    }
  }

  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  }

  function createEditor() {
    const dark = document.documentElement.dataset.theme === "dark";
    editor = new toastui.Editor({
      el: els.editorHost,
      height: "100%",
      initialEditType: "wysiwyg",
      previewStyle: "vertical",
      hideModeSwitch: true, // keep it a "normal" editor — no markdown source view
      usageStatistics: false,
      autofocus: false,
      placeholder: "Start writing…",
      theme: dark ? "dark" : "light",
    });
    editor.on("change", onEditorChange);
    // The .toastui-editor-dark class is applied separately by applyTheme().
  }

  async function tryRestore() {
    try {
      const res = await window.FS.restoreFolder(false);
      if (!res) return; // nothing remembered
      if (res.needsPermission) {
        setStatus("Click “Open folder” to reconnect", "");
        els.btnOpen.textContent = "Reconnect folder";
        els.btnOpen.dataset.restore = "1";
        els._restoreHandle = res.handle;
        return;
      }
      await afterOpen();
    } catch (e) {
      console.warn("restore failed", e);
    }
  }

  // ---- Event wiring ---------------------------------------------------------
  function wireEvents() {
    els.btnOpen.addEventListener("click", onOpenClick);
    els.btnOpen2.addEventListener("click", onOpenClick);
    els.btnNewNote.addEventListener("click", onNewNote);
    els.btnNewFolder.addEventListener("click", onNewFolder);
    els.btnImport.addEventListener("click", function () {
      els.fileInput.click();
    });
    els.fileInput.addEventListener("change", onImport);
    els.btnExport.addEventListener("click", onExport);
    els.btnDelete.addEventListener("click", onDeleteActive);
    els.btnTheme.addEventListener("click", toggleTheme);

    els.noteTitle.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        els.noteTitle.blur();
      }
    });
    els.noteTitle.addEventListener("blur", onRenameActive);
    els.moveFolder.addEventListener("change", onMoveActive);

    els.search.addEventListener("input", function () {
      state.query = els.search.value.trim().toLowerCase();
      renderTree();
    });

    document.addEventListener("keydown", function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        onNewNote();
      } else if (k === "s") {
        e.preventDefault();
        saveNow();
      }
    });

    window.addEventListener("beforeunload", function (e) {
      // A debounced save is still pending. saveNow()'s createWritable→write→close
      // chain is async and can't finish during teardown, so fire it best-effort
      // AND ask the browser to confirm the close — that pause gives the write a
      // chance to land instead of silently dropping the last edits.
      if (state.saveTimer) {
        saveNow();
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  async function onOpenClick() {
    // First, try to reconnect a remembered folder. Any failure here must not
    // block the user — fall through to a fresh folder picker.
    if (els.btnOpen.dataset.restore === "1" && els._restoreHandle) {
      els.btnOpen.dataset.restore = "";
      els.btnOpen.textContent = "Open folder";
      try {
        const granted = await window.FS.grantRestored(els._restoreHandle);
        if (granted) {
          await afterOpen();
          return;
        }
      } catch (e) {
        console.warn("reconnect failed, falling back to picker", e);
        await window.FS.forget();
      }
    }
    try {
      await window.FS.openFolder();
      await afterOpen();
    } catch (e) {
      if (e && e.name === "AbortError") return; // user cancelled the picker
      console.error(e);
      setStatus("Couldn’t open folder · " + describe(e), "error");
    }
  }

  // Called once a root folder is available. Scans + renders + opens first note.
  async function afterOpen() {
    enableUI();
    els.welcomeScreen.classList.add("hidden");
    setStatus("Loading…", "");
    await refresh();
    setStatus("Folder: " + window.FS.rootName(), "");
    const all = flattenNotes(state.tree);
    if (all.length) {
      const welcome = all.find(function (n) {
        return /^welcome\.md$/i.test(n.name);
      });
      openNote(welcome || all[0]);
    } else {
      clearEditor();
    }
  }

  function enableUI() {
    [els.btnNewNote, els.btnNewFolder, els.btnImport, els.btnExport, els.search].forEach(function (el) {
      el.disabled = false;
    });
  }

  async function refresh() {
    state.tree = await window.FS.scan(window.FS.getRoot(), "");
    state.contentCache.clear();
    rebuildMoveDropdown();
    renderTree();
  }

  // ---- Tree rendering -------------------------------------------------------
  function flattenFolders(tree, acc) {
    acc = acc || [];
    tree.folders.forEach(function (f) {
      acc.push({ path: f.path, name: f.name, handle: f.handle });
      flattenFolders(f, acc);
    });
    return acc;
  }

  function flattenNotes(tree, acc) {
    acc = acc || [];
    tree.notes.forEach(function (n) {
      acc.push(n);
    });
    tree.folders.forEach(function (f) {
      flattenNotes(f, acc);
    });
    return acc;
  }

  function renderTree() {
    // Invalidate any in-flight search render: bumping the generation makes a
    // pending renderSearchResults() .then() discard itself instead of clobbering
    // what we render now (e.g. the full tree after the query was cleared).
    state.searchGen++;
    els.tree.innerHTML = "";
    if (state.query) {
      renderSearchResults();
      return;
    }
    const frag = document.createDocumentFragment();
    renderLevel(state.tree, frag);
    if (!state.tree.folders.length && !state.tree.notes.length) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.innerHTML = "No notes yet. Click <strong>+ Note</strong> to create one.";
      frag.appendChild(hint);
    }
    els.tree.appendChild(frag);
  }

  function renderLevel(node, container) {
    node.folders.forEach(function (folder) {
      const wrap = document.createElement("div");
      wrap.className = "tree-folder" + (state.collapsed.has(folder.path) ? " collapsed" : "");

      const row = document.createElement("div");
      row.className = "row";
      row.title = folder.path;

      const twisty = document.createElement("span");
      twisty.className = "twisty";
      twisty.textContent = "▾";
      twisty.addEventListener("click", function (e) {
        e.stopPropagation();
        if (state.collapsed.has(folder.path)) state.collapsed.delete(folder.path);
        else state.collapsed.add(folder.path);
        renderTree();
      });

      const label = document.createElement("span");
      label.className = "label";
      label.textContent = folder.name;

      row.addEventListener("click", function () {
        state.selectedDir = { handle: folder.handle, path: folder.path };
      });

      const actions = document.createElement("span");
      actions.className = "row-actions";
      actions.appendChild(iconBtn("✎", "Rename folder", function (e) {
        e.stopPropagation();
        renameFolder(folder);
      }));
      actions.appendChild(iconBtn("🗑", "Delete folder", function (e) {
        e.stopPropagation();
        deleteFolder(folder);
      }));

      row.appendChild(twisty);
      row.appendChild(label);
      row.appendChild(actions);
      wrap.appendChild(row);

      const children = document.createElement("div");
      children.className = "tree-children";
      renderLevel(folder, children);
      wrap.appendChild(children);
      container.appendChild(wrap);
    });

    node.notes.forEach(function (note) {
      container.appendChild(noteRow(note));
    });
  }

  function noteRow(note) {
    const row = document.createElement("div");
    row.className = "tree-note" + (state.active && state.active.path === note.path ? " active" : "");
    row.title = note.path;

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = note.title;

    const ext = document.createElement("span");
    ext.className = "ext";
    ext.textContent = ".md";

    row.addEventListener("click", function () {
      openNote(note);
    });

    const actions = document.createElement("span");
    actions.className = "row-actions";
    actions.appendChild(iconBtn("🗑", "Delete note", function (e) {
      e.stopPropagation();
      deleteNote(note);
    }));

    row.appendChild(label);
    row.appendChild(ext);
    row.appendChild(actions);
    return row;
  }

  function renderSearchResults() {
    const q = state.query;
    const gen = ++state.searchGen;
    const notes = flattenNotes(state.tree);
    Promise.all(
      notes.map(async function (n) {
        if (!state.contentCache.has(n.path)) {
          try {
            state.contentCache.set(n.path, await window.FS.readNote(n.handle));
          } catch (e) {
            state.contentCache.set(n.path, "");
          }
        }
      })
    ).then(function () {
      // Discard if a newer search (or a full-tree render) started while reading.
      if (gen !== state.searchGen) return;
      const matches = notes.filter(function (n) {
        if (n.title.toLowerCase().includes(q)) return true;
        const c = state.contentCache.get(n.path) || "";
        return c.toLowerCase().includes(q);
      });
      els.tree.innerHTML = "";
      if (!matches.length) {
        const hint = document.createElement("div");
        hint.className = "empty-hint";
        hint.textContent = 'No notes match "' + q + '".';
        els.tree.appendChild(hint);
        return;
      }
      const frag = document.createDocumentFragment();
      matches.forEach(function (n) {
        const row = noteRow(n);
        if (n.path.includes("/")) {
          // Show the containing folder as a quiet breadcrumb after the title.
          const crumb = document.createElement("span");
          crumb.className = "ext";
          crumb.textContent = n.path.replace(/\/[^/]*$/, "");
          row.insertBefore(crumb, row.querySelector(".ext"));
        }
        frag.appendChild(row);
      });
      els.tree.appendChild(frag);
    });
  }

  function iconBtn(text, title, handler) {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", handler);
    return b;
  }

  function rebuildMoveDropdown() {
    const folders = flattenFolders(state.tree);
    els.moveFolder.innerHTML = "";
    const rootOpt = document.createElement("option");
    rootOpt.value = "";
    rootOpt.textContent = window.FS.rootName() + " (root)";
    els.moveFolder.appendChild(rootOpt);
    folders.forEach(function (f) {
      const opt = document.createElement("option");
      opt.value = f.path;
      opt.textContent = f.path;
      els.moveFolder.appendChild(opt);
    });
  }

  // ---- Note open / edit / save ---------------------------------------------
  async function openNote(note) {
    // Flush the *previous* note first. saveNow() writes to state.active.handle, so
    // it must run before we point state.active at the new note — otherwise the old
    // editor content would be written into the new note's file, corrupting it.
    await saveNow();
    // Now claim active. Concurrent openNote calls detect they've been superseded
    // via the state.active.path checks further down.
    state.active = {
      handle: note.handle,
      parentDir: note.parent,
      name: note.name,
      path: note.path,
    };
    setStatus("Opening…", "");
    let text = "";
    try {
      text = await window.FS.readNote(note.handle);
    } catch (e) {
      setStatus("Couldn’t read note", "error");
      return;
    }
    // Bail if another click (or a delete that nulled state.active) landed during readNote.
    if (!state.active || state.active.path !== note.path) return;
    state.contentCache.set(note.path, text);

    state.loading = true;
    editor.setMarkdown(text, false);
    setTimeout(function () {
      state.loading = false;
    }, 0);

    els.noteTitle.value = note.title;
    els.editorHeader.classList.remove("hidden");
    els.editorHost.classList.remove("hidden");
    els.welcomeScreen.classList.add("hidden");
    els.moveFolder.value = note.path.includes("/") ? note.path.replace(/\/[^/]*$/, "") : "";
    markActiveInTree();
    setStatus("Saved", "saved");
    editor.focus();
  }

  function markActiveInTree() {
    els.tree.querySelectorAll(".tree-note").forEach(function (el) {
      el.classList.toggle("active", el.title === (state.active && state.active.path));
    });
  }

  function clearEditor() {
    state.active = null;
    state.loading = true;
    editor.setMarkdown("", false);
    setTimeout(function () {
      state.loading = false;
    }, 0);
    els.noteTitle.value = "";
    els.editorHeader.classList.add("hidden");
    els.editorHost.classList.add("hidden");
    els.welcomeScreen.classList.remove("hidden");
  }

  function onEditorChange() {
    if (state.loading || !state.active) return;
    setStatus("Saving…", "saving");
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, 700);
  }

  async function saveNow() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    if (!state.active) return;
    const text = editor.getMarkdown();
    try {
      await window.FS.writeNote(state.active.handle, text);
      state.contentCache.set(state.active.path, text);
      setStatus("Saved", "saved");
    } catch (e) {
      console.error(e);
      setStatus("Save failed", "error");
    }
  }

  // ---- Create / rename / delete / move -------------------------------------
  function targetDir() {
    if (state.selectedDir && state.selectedDir.handle) return state.selectedDir.handle;
    return window.FS.getRoot();
  }

  async function onNewNote() {
    const title = window.prompt("New note name:", "Untitled");
    if (title === null) return;
    const safe = window.FS.sanitizeName(title || "Untitled");
    try {
      const created = await createIn(function (dir) {
        return window.FS.createNote(dir, title || "Untitled", "# " + safe + "\n\n");
      });
      await refresh();
      // Locate by full path: a bare-name match could open a same-named note in
      // another folder instead of the one we just created.
      const expectedPath = created.dirPath
        ? created.dirPath + "/" + created.result.name
        : created.result.name;
      const note = flattenNotes(state.tree).find(function (n) {
        return n.path === expectedPath;
      });
      if (note) openNote(note);
    } catch (e) {
      console.error(e);
      setStatus("Couldn’t create note · " + describe(e), "error");
    }
  }

  async function onNewFolder() {
    const name = window.prompt("New folder name:", "New Folder");
    if (name === null) return;
    try {
      await createIn(function (dir) {
        return window.FS.createFolder(dir, name || "New Folder");
      });
      await refresh();
    } catch (e) {
      console.error(e);
      setStatus("Couldn’t create folder · " + describe(e), "error");
    }
  }

  // Run a create op in the selected folder, returning { result, dirPath } so the
  // caller can locate the new entry by its full path. If the selected folder's
  // handle is stale (deleted out from under us → NotFoundError), fall back to the
  // root once; any other error (e.g. QuotaExceededError) propagates with its real
  // cause rather than being masked by a misleading root retry.
  async function createIn(op) {
    const sel = state.selectedDir;
    try {
      const result = await op(targetDir());
      return { result: result, dirPath: sel && sel.handle ? sel.path : "" };
    } catch (e) {
      if (sel && sel.handle && e && e.name === "NotFoundError") {
        state.selectedDir = null;
        const result = await op(window.FS.getRoot());
        return { result: result, dirPath: "" };
      }
      throw e;
    }
  }

  async function onRenameActive() {
    if (!state.active) return;
    const newTitle = els.noteTitle.value.trim();
    const current = state.active.name.replace(/\.md$/i, "");
    if (!newTitle || newTitle === current) {
      els.noteTitle.value = current;
      return;
    }
    // Snapshot the target before awaiting — a concurrent openNote() could replace
    // state.active during saveNow(), which would otherwise rename the wrong note.
    const parentDir = state.active.parentDir;
    const oldName = state.active.name;
    const oldPath = state.active.path;
    await saveNow();
    try {
      const res = await window.FS.renameNote(parentDir, oldName, newTitle);
      // Compute the expected path of the renamed note before refreshing.
      const parentPath = oldPath.includes("/") ? oldPath.replace(/\/[^/]*$/, "") : "";
      const expectedPath = parentPath ? parentPath + "/" + res.name : res.name;
      await refresh();
      const reopened = flattenNotes(state.tree).find(function (n) {
        return n.path === expectedPath;
      });
      if (reopened) openNote(reopened);
    } catch (e) {
      console.error(e);
      setStatus("Rename failed", "error");
    }
  }

  async function renameFolder(folder) {
    const name = window.prompt("Rename folder:", folder.name);
    if (name === null || !name.trim() || name === folder.name) return;
    try {
      setStatus("Renaming folder…", "saving");
      // If the open note lives inside this folder, flush it to disk first (so its
      // latest content is what gets copied) and remember where to re-open it.
      const oldFolderPath = folder.path;
      const activeSuffix =
        state.active && state.active.path.startsWith(oldFolderPath + "/")
          ? state.active.path.slice(oldFolderPath.length)
          : null;
      if (activeSuffix !== null) await saveNow();

      const parent = parentDirOf(folder.path);
      const newDir = await window.FS.createFolder(parent.handle, name);
      await copyDirInto(folder.handle, newDir);
      await parent.handle.removeEntry(folder.name, { recursive: true });
      await refresh();

      // state.active.handle now points into the deleted folder. Drop it (so the
      // reopen's flush is a no-op against the dead handle) then re-open the note
      // at its new path under the renamed folder.
      if (activeSuffix !== null) {
        const newFolderPath = parent.path ? parent.path + "/" + newDir.name : newDir.name;
        const reopened = flattenNotes(state.tree).find(function (n) {
          return n.path === newFolderPath + activeSuffix;
        });
        state.active = null;
        if (reopened) openNote(reopened);
        else clearEditor();
      }
      setStatus("Folder: " + window.FS.rootName(), "");
    } catch (e) {
      console.error(e);
      setStatus("Folder rename failed", "error");
    }
  }

  async function copyDirInto(src, dest) {
    for await (const [name, handle] of src.entries()) {
      if (handle.kind === "file") {
        const text = await (await handle.getFile()).text();
        const fh = await dest.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
      } else if (handle.kind === "directory") {
        const sub = await dest.getDirectoryHandle(name, { create: true });
        await copyDirInto(handle, sub);
      }
    }
  }

  function parentDirOf(path) {
    if (!path.includes("/")) return { handle: window.FS.getRoot(), path: "" };
    const parentPath = path.replace(/\/[^/]*$/, "");
    const folders = flattenFolders(state.tree);
    const match = folders.find(function (f) {
      return f.path === parentPath;
    });
    return match ? { handle: match.handle, path: parentPath } : { handle: window.FS.getRoot(), path: "" };
  }

  async function deleteNote(note) {
    if (!window.confirm("Delete “" + note.title + "”? This removes the .md file from disk.")) return;
    try {
      await window.FS.deleteEntry(note.parent, note.name, false);
      if (state.active && state.active.path === note.path) clearEditor();
      await refresh();
    } catch (e) {
      console.error(e);
      setStatus("Delete failed", "error");
    }
  }

  async function onDeleteActive() {
    if (!state.active) return;
    deleteNote({
      title: state.active.name.replace(/\.md$/i, ""),
      name: state.active.name,
      parent: state.active.parentDir,
      path: state.active.path,
    });
  }

  async function deleteFolder(folder) {
    if (!window.confirm("Delete folder “" + folder.name + "” and all .md files inside it?")) return;
    try {
      const parent = parentDirOf(folder.path);
      await parent.handle.removeEntry(folder.name, { recursive: true });
      if (state.active && state.active.path.startsWith(folder.path + "/")) clearEditor();
      await refresh();
    } catch (e) {
      console.error(e);
      setStatus("Delete failed", "error");
    }
  }

  async function onMoveActive() {
    if (!state.active) return;
    const targetPath = els.moveFolder.value;
    // Compare by logical path: directory handles from different scan() calls are
    // distinct JS objects, so === would wrongly treat "same folder" as a move.
    const currentParentPath = state.active.path.includes("/")
      ? state.active.path.replace(/\/[^/]*$/, "")
      : "";
    if (targetPath === currentParentPath) return;

    const folders = flattenFolders(state.tree);
    let destHandle = window.FS.getRoot();
    if (targetPath) {
      const f = folders.find(function (x) {
        return x.path === targetPath;
      });
      if (f) destHandle = f.handle;
    }
    // Snapshot before awaiting — a concurrent openNote() could replace state.active.
    const fromDir = state.active.parentDir;
    const oldName = state.active.name;
    await saveNow();
    try {
      const res = await window.FS.moveNote(fromDir, oldName, destHandle);
      await refresh();
      // Find by path (handles are rebuilt by refresh, so identity won't match).
      const expectedPath = targetPath ? targetPath + "/" + res.name : res.name;
      const moved = flattenNotes(state.tree).find(function (n) {
        return n.path === expectedPath;
      });
      if (moved) openNote(moved);
    } catch (e) {
      console.error(e);
      setStatus("Move failed", "error");
    }
  }

  // ---- Import / export ------------------------------------------------------
  async function onImport(e) {
    const files = e.target.files;
    if (!files || !files.length) return;
    try {
      const created = await window.FS.importFiles(targetDir(), files);
      await refresh();
      setStatus("Imported " + created.length + " file(s)", "saved");
    } catch (err) {
      console.error(err);
      setStatus("Import failed", "error");
    }
    els.fileInput.value = "";
  }

  function onExport() {
    if (!state.active) return;
    window.FS.downloadNote(state.active.name, editor.getMarkdown());
  }

  document.addEventListener("DOMContentLoaded", init);
})();
