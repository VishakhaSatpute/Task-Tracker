// Reads .txt notes from a user-picked folder and turns each new or edited file
// into a project. Dedup key: file name + lastModified, stored in "noteFiles".

import { extractProjectsFromNote, copyForClaudeError, normName } from "./claude.js";

const HANDLE_KEY = "notesFolder";

// Bump when extraction changes so previously processed files are re-extracted once.
// 1 (or missing) = single project per file; 2 = multi-project extraction.
export const EXTRACTOR_VERSION = 2;

export const folderApiSupported = typeof window !== "undefined" && "showDirectoryPicker" in window;

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function genId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

// Firestore-style ids can't hold "/", so encode file names.
function fileDocId(name) {
  return encodeURIComponent(name);
}

export async function pickFolder(store) {
  if (!folderApiSupported) throw { code: "unsupported", message: "Folder access needs Chrome or Edge." };
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: "task-tracker-notes", mode: "read" });
  } catch (e) {
    if (e && e.name === "AbortError") return null;
    throw e;
  }
  await store.setHandle(HANDLE_KEY, handle);
  return handle;
}

export async function getSavedFolder(store) {
  try { return (await store.getHandle(HANDLE_KEY)) || null; } catch (e) { return null; }
}

// "granted" | "prompt" | "denied"
export async function folderPermission(handle) {
  if (!handle || !handle.queryPermission) return "denied";
  return handle.queryPermission({ mode: "read" });
}

export async function requestFolderPermission(handle) {
  if (!handle || !handle.requestPermission) return "denied";
  return handle.requestPermission({ mode: "read" });
}

/**
 * Runs one sync pass.
 * Returns { created, updated, skipped, failed: [{file, message}], total }.
 * Must be called from a user gesture if permission is not already granted.
 */
export async function syncNotes({ store, handle, onProgress, force = false }) {
  const summary = { created: 0, updated: 0, skipped: 0, empty: 0, failed: [], files: [], total: 0 };
  if (!handle) throw { code: "no_folder", message: "No notes folder selected." };

  let perm = await folderPermission(handle);
  if (perm !== "granted") perm = await requestFolderPermission(handle);
  if (perm !== "granted") throw { code: "permission_denied", message: "Permission to read the folder was not granted." };

  const files = [];
  try {
    for await (const entry of handle.values()) {
      if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".txt")) files.push(entry);
    }
  } catch (e) {
    throw { code: "folder_unreadable", message: "Could not read the folder. It may have been moved or deleted." };
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  summary.total = files.length;

  const types = store.peekCollection("types");
  const typeChoices = types.length ? types : [{ id: "task", label: "Task" }, { id: "issue", label: "Issue" }];

  const memberNames = store.peekCollection("members").map((m) => m.name).filter(Boolean);

  let done = 0;
  for (const entry of files) {
    done += 1;
    if (onProgress) onProgress({ done, total: files.length, file: entry.name });
    try {
      const file = await entry.getFile();
      const known = store.peekDoc("noteFiles/" + fileDocId(entry.name));
      const knownComplete = Boolean(known) && known.complete !== false; // records from before this flag are complete
      if (!force && knownComplete && known.version === EXTRACTOR_VERSION && known.lastModified === file.lastModified && known.size === file.size) {
        summary.skipped += 1;
        summary.files.push({ name: entry.name, status: "unchanged", projects: 0 });
        continue;
      }
      const text = (await file.text()).trim();
      if (!text) {
        summary.skipped += 1;
        summary.files.push({ name: entry.name, status: "empty file", projects: 0 });
        continue;
      }
      const contentHash = await sha256Hex(text);
      const recordBase = { name: entry.name, lastModified: file.lastModified, size: file.size, version: EXTRACTOR_VERSION };

      if (!force) {
        // Same content as last time (re-saved, touched, cloud-synced): nothing to do.
        if (knownComplete && known.version === EXTRACTOR_VERSION && known.contentHash === contentHash) {
          await store.doc("noteFiles/" + fileDocId(entry.name)).update({ lastModified: file.lastModified, size: file.size });
          summary.skipped += 1;
          summary.files.push({ name: entry.name, status: "unchanged content", projects: 0 });
          continue;
        }
        // Same content already processed under another file name (copy / rename).
        const twin = store.peekCollection("noteFiles").find(
          (r) => r.name !== entry.name && r.complete !== false && r.contentHash === contentHash && r.version === EXTRACTOR_VERSION
        );
        if (twin) {
          await store.doc("noteFiles/" + fileDocId(entry.name)).set({
            ...recordBase, contentHash, projectIds: [], projectCount: 0, duplicateOf: twin.name, complete: true, syncedAt: Date.now(),
          });
          summary.skipped += 1;
          summary.files.push({ name: entry.name, status: "duplicate of " + twin.name, projects: 0 });
          continue;
        }
      }

      const createdBefore = summary.created;
      const updatedBefore = summary.updated;

      // Projects this file produced on earlier syncs (older records stored a single projectId).
      const knownIds = ((known && (known.projectIds || (known.projectId ? [known.projectId] : []))) || [])
        .filter((id) => store.peekDoc("projects/" + id));
      const existing = knownIds.map((id) => {
        const p = store.peekDoc("projects/" + id);
        return { id, name: p.name, description: p.description || "" };
      });

      const found = await extractProjectsFromNote({ noteText: text, fileName: entry.name, types: typeChoices, existing, members: memberNames });
      const now = Date.now();
      const resultIds = [...knownIds];
      const matched = new Set();

      // Persist progress after every project so a failure mid-file can't orphan projects:
      // the retry sees them as this file's existing projects instead of recreating them.
      const saveProgress = () => store.doc("noteFiles/" + fileDocId(entry.name)).set({
        ...recordBase, projectIds: [...resultIds], complete: false, syncedAt: Date.now(),
      });

      for (const p of found) {
        const noteBody = p.excerpt || text;
        // The model sometimes returns existingId: null for a project it already saw; match by name too.
        if (!p.existingId) {
          const sameName = existing.find((e) => !matched.has(e.id) && normName(e.name) === normName(p.name));
          if (sameName) p.existingId = sameName.id;
        }
        if (p.existingId && !matched.has(p.existingId)) {
          // Same project as before: refresh the drafted text only. Status, etc. stay as the team set them;
          // an assignee is filled in only if the project has none.
          matched.add(p.existingId);
          const current = store.peekDoc("projects/" + p.existingId);
          await store.doc("projects/" + p.existingId).update({
            name: p.name,
            description: p.description,
            ...(p.assignedTo && !(current && current.assignedTo) ? { assignedTo: p.assignedTo } : {}),
            updatedAt: now,
          });
          await store.doc("projects/" + p.existingId + "/notes/" + genId()).set({
            text: "Source note updated (" + entry.name + "):\n\n" + noteBody,
            author: "Notes sync",
            createdAt: now,
          });
          summary.updated += 1;
          await saveProgress();
        } else {
          const projects = store.peekCollection("projects");
          // New projects go to the top of the manual order.
          const minOrder = projects.reduce((m, q) => Math.min(m, q.order ?? 0), 0);
          const projectId = genId();
          await store.doc("projects/" + projectId).set({
            name: p.name,
            description: p.description,
            typeId: p.typeId,
            priority: p.priority,
            assignedTo: p.assignedTo || "",
            status: "ideation",
            order: minOrder - 1,
            sourceFile: entry.name,
            createdAt: now,
            updatedAt: now,
          });
          await store.doc("projects/" + projectId + "/notes/" + genId()).set({
            text: noteBody,
            author: "Notes sync (" + entry.name + ")",
            createdAt: now,
          });
          resultIds.push(projectId);
          summary.created += 1;
          await saveProgress();
        }
      }
      if (found.length === 0) summary.empty += 1;

      // Marked complete only after every project was written.
      await store.doc("noteFiles/" + fileDocId(entry.name)).set({
        ...recordBase,
        contentHash,
        projectIds: resultIds,
        projectCount: found.length,
        complete: true,
        syncedAt: now,
      });
      summary.files.push({
        name: entry.name,
        status: found.length === 0 ? "no projects found" : "processed",
        projects: found.length,
        created: summary.created - createdBefore,
        updated: summary.updated - updatedBefore,
      });
    } catch (err) {
      // Not marked complete, so the next sync retries it (projects already saved are reused, not recreated).
      const message = copyForClaudeError(err) || "Failed";
      summary.failed.push({ file: entry.name, message });
      summary.files.push({ name: entry.name, status: "failed", projects: 0 });
      if (err && (err.code === "no_api_key" || err.code === "auth_error")) break;
    }
  }
  return summary;
}
