/*
 * fs.js — File System Access API layer. Exposes window.FS.
 *
 * Responsibilities:
 *   - Open a folder via showDirectoryPicker and remember it across reloads
 *     (the directory handle is persisted in IndexedDB).
 *   - Re-request read/write permission on restore.
 *   - Recursively scan the folder into a tree of folders + .md notes.
 *   - Read / write / create / rename / delete notes and folders.
 *   - Import external .md files, and download a copy of a note.
 *
 * All on-disk paths use "/" as a logical separator for the tree; the root
 * directory handle itself has path "".
 */
(function () {
  "use strict";

  const DB_NAME = "mdnotes";
  const STORE = "handles";
  const KEY = "rootDir";

  // ---- Tiny IndexedDB helpers for persisting the directory handle ------------
  function idb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }

  async function idbSet(key, val) {
    const db = await idb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = resolve;
      tx.onerror = function () {
        reject(tx.error);
      };
    });
  }

  async function idbGet(key) {
    const db = await idb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }

  async function idbDel(key) {
    const db = await idb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = function () {
        reject(tx.error);
      };
    });
  }

  // ---- Permission helpers ----------------------------------------------------
  async function ensurePermission(handle, mode) {
    const opts = { mode: mode || "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if ((await handle.requestPermission(opts)) === "granted") return true;
    return false;
  }

  // ---- Public API ------------------------------------------------------------
  let rootHandle = null;

  function isSupported() {
    return typeof window.showDirectoryPicker === "function";
  }

  // Ask the browser to keep our storage (the IndexedDB-persisted folder handle)
  // from being evicted under storage pressure. Best-effort: must run from a user
  // gesture, and may be silently refused — never block the caller on it.
  async function requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        if (!(await navigator.storage.persisted())) {
          await navigator.storage.persist();
        }
      }
    } catch (e) {
      /* persistence is a nice-to-have; ignore failures */
    }
  }

  async function openFolder() {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", startIn: "documents" });
    if (!(await ensurePermission(handle, "readwrite"))) {
      throw new Error("Permission to read/write the folder was denied.");
    }
    rootHandle = handle;
    await idbSet(KEY, handle);
    await requestPersistentStorage();
    return handle;
  }

  // Try to silently restore a previously-opened folder. Returns the handle or null.
  async function restoreFolder(interactive) {
    let handle;
    try {
      handle = await idbGet(KEY);
    } catch (e) {
      return null;
    }
    if (!handle) return null;
    const opts = { mode: "readwrite" };
    const state = await handle.queryPermission(opts);
    if (state === "granted") {
      rootHandle = handle;
      return handle;
    }
    if (interactive) {
      if ((await handle.requestPermission(opts)) === "granted") {
        rootHandle = handle;
        return handle;
      }
    }
    // Permission needs a user gesture; hand the handle back so the UI can ask.
    return { needsPermission: true, handle: handle };
  }

  async function grantRestored(handle) {
    if ((await handle.requestPermission({ mode: "readwrite" })) === "granted") {
      rootHandle = handle;
      await requestPersistentStorage();
      return handle;
    }
    return null;
  }

  function getRoot() {
    return rootHandle;
  }

  function rootName() {
    return rootHandle ? rootHandle.name : "";
  }

  async function forget() {
    rootHandle = null;
    await idbDel(KEY);
  }

  // Walk a directory handle into a tree. Notes = *.md files; folders = subdirs.
  async function scan(dirHandle, basePath) {
    dirHandle = dirHandle || rootHandle;
    basePath = basePath || "";
    const folders = [];
    const notes = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === "directory") {
        if (name.startsWith(".")) continue;
        const path = basePath ? basePath + "/" + name : name;
        // Spread the subtree's folders/notes directly onto the node so every
        // node (root and subfolders alike) has the same { folders, notes } shape
        // that app.js's renderLevel / flattenNotes / flattenFolders expect.
        const sub = await scan(handle, path);
        folders.push({
          type: "folder",
          name: name,
          path: path,
          handle: handle,
          folders: sub.folders,
          notes: sub.notes,
        });
      } else if (handle.kind === "file" && /\.md$/i.test(name)) {
        const path = basePath ? basePath + "/" + name : name;
        notes.push({
          type: "note",
          name: name,
          title: name.replace(/\.md$/i, ""),
          path: path,
          handle: handle,
          parent: dirHandle,
        });
      }
    }
    const cmp = function (a, b) {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    };
    folders.sort(cmp);
    notes.sort(cmp);
    return { folders: folders, notes: notes };
  }

  async function readNote(fileHandle) {
    const file = await fileHandle.getFile();
    return await file.text();
  }

  async function writeNote(fileHandle, text) {
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(text);
      await writable.close();
    } catch (e) {
      await writable.abort();
      throw e;
    }
  }

  // Ensure a unique filename inside dirHandle for the desired base name.
  async function uniqueName(dirHandle, base, ext) {
    ext = ext || ".md";
    const existing = new Set();
    for await (const [name] of dirHandle.entries()) existing.add(name.toLowerCase());
    let candidate = base + ext;
    let n = 2;
    while (existing.has(candidate.toLowerCase())) {
      candidate = base + "-" + n + ext;
      n++;
    }
    return candidate;
  }

  async function createNote(dirHandle, title, content) {
    dirHandle = dirHandle || rootHandle;
    const safe = sanitizeName(title || "Untitled");
    const name = await uniqueName(dirHandle, safe, ".md");
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    await writeNote(fileHandle, content != null ? content : "# " + safe + "\n\n");
    return { name: name, handle: fileHandle };
  }

  async function createFolder(dirHandle, name) {
    dirHandle = dirHandle || rootHandle;
    const safe = sanitizeName(name || "New Folder");
    return await dirHandle.getDirectoryHandle(safe, { create: true });
  }

  async function deleteEntry(dirHandle, name, recursive) {
    dirHandle = dirHandle || rootHandle;
    await dirHandle.removeEntry(name, { recursive: !!recursive });
  }

  // Rename a note within the same directory (copy contents -> new name -> remove old).
  async function renameNote(dirHandle, oldName, newTitle) {
    dirHandle = dirHandle || rootHandle;
    const oldHandle = await dirHandle.getFileHandle(oldName);
    const text = await readNote(oldHandle);
    const safe = sanitizeName(newTitle);
    const target = safe + ".md";
    if (target.toLowerCase() === oldName.toLowerCase()) return { name: oldName, handle: oldHandle };
    const name = await uniqueName(dirHandle, safe, ".md");
    const newHandle = await dirHandle.getFileHandle(name, { create: true });
    try {
      await writeNote(newHandle, text);
    } catch (e) {
      // Clean up the stub so we don't leave a zero-byte file behind.
      await dirHandle.removeEntry(name).catch(function () {});
      throw e;
    }
    await dirHandle.removeEntry(oldName);
    return { name: name, handle: newHandle };
  }

  // Move a note from one directory handle to another (copy -> delete).
  async function moveNote(fromDir, name, toDir) {
    const srcHandle = await fromDir.getFileHandle(name);
    const text = await readNote(srcHandle);
    const target = await uniqueName(toDir, name.replace(/\.md$/i, ""), ".md");
    const destHandle = await toDir.getFileHandle(target, { create: true });
    await writeNote(destHandle, text);
    await fromDir.removeEntry(name);
    return { name: target, handle: destHandle };
  }

  // Import a FileList of .md files into dirHandle.
  async function importFiles(dirHandle, fileList) {
    dirHandle = dirHandle || rootHandle;
    const created = [];
    for (const file of fileList) {
      if (!/\.md$/i.test(file.name) && !/\.markdown$/i.test(file.name) && !/\.txt$/i.test(file.name)) continue;
      const base = file.name.replace(/\.(md|markdown|txt)$/i, "");
      const name = await uniqueName(dirHandle, sanitizeName(base), ".md");
      const handle = await dirHandle.getFileHandle(name, { create: true });
      await writeNote(handle, await file.text());
      created.push(name);
    }
    return created;
  }

  function downloadNote(name, text) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = /\.md$/i.test(name) ? name : name + ".md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function sanitizeName(name) {
    return String(name)
      .replace(/[\x00-\x1f\\/:*?"<>|]/g, "-") // control chars + illegal filename chars on Windows
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.+$/, "") // no trailing dots
      .slice(0, 120) || "Untitled";
  }

  window.FS = {
    isSupported: isSupported,
    openFolder: openFolder,
    restoreFolder: restoreFolder,
    grantRestored: grantRestored,
    forget: forget,
    getRoot: getRoot,
    rootName: rootName,
    scan: scan,
    readNote: readNote,
    writeNote: writeNote,
    createNote: createNote,
    createFolder: createFolder,
    deleteEntry: deleteEntry,
    renameNote: renameNote,
    moveNote: moveNote,
    importFiles: importFiles,
    downloadNote: downloadNote,
    sanitizeName: sanitizeName,
  };
})();
