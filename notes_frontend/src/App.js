import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Notes API strategy:
 * - If REACT_APP_API_BASE or REACT_APP_BACKEND_URL is set, attempt REST calls:
 *     GET    {base}/notes
 *     POST   {base}/notes
 *     PUT    {base}/notes/:id
 *     DELETE {base}/notes/:id
 * - If requests fail (or base is not set), fall back to in-memory storage so UI still works.
 */

/**
 * @typedef {Object} Note
 * @property {string} id
 * @property {string} title
 * @property {string} content
 * @property {number} updatedAt
 * @property {number} createdAt
 */

/** Generate a stable-ish id without adding deps. */
function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Minimal fetch helper with JSON handling and good errors. */
async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status} ${res.statusText}) ${text}`.trim());
  }

  // Some delete endpoints might return empty body
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  return res.json();
}

function resolveApiBase() {
  const base =
    (process.env.REACT_APP_API_BASE || "").trim() ||
    (process.env.REACT_APP_BACKEND_URL || "").trim();

  // If someone set it without protocol in dev, leave it as-is; fetch will throw and we fall back.
  return base.replace(/\/+$/, "");
}

/**
 * In-memory store lives for the page lifetime only.
 * This is intentionally simple per requirements.
 */
function createInMemoryStore() {
  /** @type {Map<string, Note>} */
  const map = new Map();

  const now = Date.now();
  const seed = [
    {
      id: makeId(),
      title: "Welcome",
      content:
        "This is a simple notes app.\n\n- Create notes from the sidebar\n- Edit title and content here\n- Delete notes from the list",
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
    },
  ];
  seed.forEach((n) => map.set(n.id, n));

  return {
    list() {
      return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    create() {
      const ts = Date.now();
      /** @type {Note} */
      const note = {
        id: makeId(),
        title: "Untitled",
        content: "",
        createdAt: ts,
        updatedAt: ts,
      };
      map.set(note.id, note);
      return note;
    },
    update(id, patch) {
      const existing = map.get(id);
      if (!existing) throw new Error("Note not found");
      const updated = { ...existing, ...patch, updatedAt: Date.now() };
      map.set(id, updated);
      return updated;
    },
    remove(id) {
      map.delete(id);
    },
  };
}

/**
 * Data access wrapper that tries API first (if configured) and falls back to in-memory.
 */
function createNotesDataSource() {
  const apiBase = resolveApiBase();
  const memory = createInMemoryStore();

  let mode = apiBase ? "api" : "memory";

  async function listNotes() {
    if (mode === "api") {
      try {
        const data = await fetchJson(`${apiBase}/notes`, { method: "GET" });
        // Accept both raw arrays or wrapped responses.
        const notes = Array.isArray(data) ? data : data?.notes;
        if (!Array.isArray(notes)) throw new Error("Unexpected API response for notes list");
        return notes;
      } catch (e) {
        // Hard fallback: keep UI working even if API is down/mismatched.
        mode = "memory";
        return memory.list();
      }
    }
    return memory.list();
  }

  async function createNote() {
    if (mode === "api") {
      try {
        const payload = { title: "Untitled", content: "" };
        const created = await fetchJson(`${apiBase}/notes`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        return created ?? payload;
      } catch (e) {
        mode = "memory";
        return memory.create();
      }
    }
    return memory.create();
  }

  async function updateNote(id, patch) {
    if (mode === "api") {
      try {
        const updated = await fetchJson(`${apiBase}/notes/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(patch),
        });
        return updated ?? { id, ...patch };
      } catch (e) {
        mode = "memory";
        return memory.update(id, patch);
      }
    }
    return memory.update(id, patch);
  }

  async function deleteNote(id) {
    if (mode === "api") {
      try {
        await fetchJson(`${apiBase}/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
        return;
      } catch (e) {
        mode = "memory";
        memory.remove(id);
        return;
      }
    }
    memory.remove(id);
  }

  function getMode() {
    return mode;
  }

  return { listNotes, createNote, updateNote, deleteNote, getMode, apiBase };
}

function formatUpdatedAt(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: "short", day: "2-digit" });
  } catch {
    return "";
  }
}

// PUBLIC_INTERFACE
function App() {
  /**
   * UI state:
   * - notes: list displayed in sidebar (sorted by updatedAt desc)
   * - selectedId: which note is active in editor
   * - draftTitle/draftContent: controlled inputs for the editor
   * - dirty: whether draft differs from last saved note snapshot
   */
  const dataSource = useMemo(() => createNotesDataSource(), []);
  const [notes, setNotes] = useState(/** @type {Note[]} */ ([]));
  const [selectedId, setSelectedId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [dirty, setDirty] = useState(false);

  const [status, setStatus] = useState({
    loading: true,
    saving: false,
    deleting: false,
    error: "",
  });

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedId) || null,
    [notes, selectedId]
  );

  const lastLoadedSnapshotRef = useRef({ title: "", content: "" });

  async function refreshListAndMaybeSelect(preferId) {
    try {
      setStatus((s) => ({ ...s, loading: true, error: "" }));
      const list = await dataSource.listNotes();

      // Normalize shape a bit (for API variance).
      const normalized = list
        .map((n) => ({
          id: String(n.id),
          title: typeof n.title === "string" ? n.title : "Untitled",
          content: typeof n.content === "string" ? n.content : "",
          createdAt: typeof n.createdAt === "number" ? n.createdAt : Date.now(),
          updatedAt: typeof n.updatedAt === "number" ? n.updatedAt : Date.now(),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);

      setNotes(normalized);

      const nextId =
        (preferId && normalized.some((n) => n.id === preferId) && preferId) ||
        (selectedId && normalized.some((n) => n.id === selectedId) && selectedId) ||
        (normalized[0]?.id || "");

      setSelectedId(nextId);
      setStatus((s) => ({ ...s, loading: false }));
    } catch (e) {
      setStatus((s) => ({
        ...s,
        loading: false,
        error: e instanceof Error ? e.message : "Failed to load notes",
      }));
    }
  }

  useEffect(() => {
    refreshListAndMaybeSelect("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever selectedNote changes (or list loads), update the editor draft (unless dirty).
  useEffect(() => {
    if (!selectedNote) {
      setDraftTitle("");
      setDraftContent("");
      lastLoadedSnapshotRef.current = { title: "", content: "" };
      setDirty(false);
      return;
    }

    // If switching notes while dirty, we still switch (simple app). You could add confirm here later.
    setDraftTitle(selectedNote.title);
    setDraftContent(selectedNote.content);
    lastLoadedSnapshotRef.current = { title: selectedNote.title, content: selectedNote.content };
    setDirty(false);
  }, [selectedNote?.id]); // only when note identity changes

  // Track dirty state based on draft vs snapshot.
  useEffect(() => {
    const snap = lastLoadedSnapshotRef.current;
    setDirty(draftTitle !== snap.title || draftContent !== snap.content);
  }, [draftTitle, draftContent]);

  // PUBLIC_INTERFACE
  async function handleCreateNote() {
    try {
      setStatus((s) => ({ ...s, saving: true, error: "" }));
      const created = await dataSource.createNote();

      // Ensure a complete note object for UI (API may return partial)
      const ts = Date.now();
      const normalized = {
        id: String(created?.id ?? makeId()),
        title: typeof created?.title === "string" ? created.title : "Untitled",
        content: typeof created?.content === "string" ? created.content : "",
        createdAt: typeof created?.createdAt === "number" ? created.createdAt : ts,
        updatedAt: typeof created?.updatedAt === "number" ? created.updatedAt : ts,
      };

      // Optimistic insert then refresh (refresh also selects correctly for API mode).
      setNotes((prev) => [normalized, ...prev].sort((a, b) => b.updatedAt - a.updatedAt));
      setSelectedId(normalized.id);
      setDraftTitle(normalized.title);
      setDraftContent(normalized.content);
      lastLoadedSnapshotRef.current = { title: normalized.title, content: normalized.content };
      setDirty(false);

      // Keep sidebar in sync with server if in API mode.
      await refreshListAndMaybeSelect(normalized.id);
      setStatus((s) => ({ ...s, saving: false }));
    } catch (e) {
      setStatus((s) => ({
        ...s,
        saving: false,
        error: e instanceof Error ? e.message : "Failed to create note",
      }));
    }
  }

  // PUBLIC_INTERFACE
  async function handleSave() {
    if (!selectedNote) return;
    try {
      setStatus((s) => ({ ...s, saving: true, error: "" }));

      const updated = await dataSource.updateNote(selectedNote.id, {
        title: draftTitle.trim() ? draftTitle : "Untitled",
        content: draftContent,
      });

      const ts = Date.now();
      const merged = {
        ...selectedNote,
        title: typeof updated?.title === "string" ? updated.title : draftTitle.trim() ? draftTitle : "Untitled",
        content: typeof updated?.content === "string" ? updated.content : draftContent,
        updatedAt: typeof updated?.updatedAt === "number" ? updated.updatedAt : ts,
      };

      setNotes((prev) =>
        prev
          .map((n) => (n.id === selectedNote.id ? merged : n))
          .sort((a, b) => b.updatedAt - a.updatedAt)
      );

      lastLoadedSnapshotRef.current = { title: merged.title, content: merged.content };
      setDirty(false);

      // In API mode, refresh to reflect any server-side formatting.
      await refreshListAndMaybeSelect(selectedNote.id);

      setStatus((s) => ({ ...s, saving: false }));
    } catch (e) {
      setStatus((s) => ({
        ...s,
        saving: false,
        error: e instanceof Error ? e.message : "Failed to save note",
      }));
    }
  }

  // PUBLIC_INTERFACE
  async function handleDelete(id) {
    const note = notes.find((n) => n.id === id);
    const ok = window.confirm(`Delete "${note?.title || "this note"}"? This cannot be undone.`);
    if (!ok) return;

    try {
      setStatus((s) => ({ ...s, deleting: true, error: "" }));
      await dataSource.deleteNote(id);

      setNotes((prev) => prev.filter((n) => n.id !== id));
      const remaining = notes.filter((n) => n.id !== id);
      const nextId = remaining[0]?.id || "";
      setSelectedId(nextId);

      await refreshListAndMaybeSelect(nextId);
      setStatus((s) => ({ ...s, deleting: false }));
    } catch (e) {
      setStatus((s) => ({
        ...s,
        deleting: false,
        error: e instanceof Error ? e.message : "Failed to delete note",
      }));
    }
  }

  // PUBLIC_INTERFACE
  function handleSelect(id) {
    setSelectedId(id);
  }

  function onEditorKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      handleSave();
    }
  }

  const connectivityPill = useMemo(() => {
    const mode = dataSource.getMode();
    if (mode === "api") return { label: "Connected", className: "pill pill--connected" };
    if (dataSource.apiBase) return { label: "Offline fallback", className: "pill pill--offline" };
    return { label: "Local", className: "pill pill--local" };
  }, [dataSource]);

  return (
    <div className="NotesApp" onKeyDown={onEditorKeyDown}>
      <header className="Topbar">
        <div className="Topbar__left">
          <div className="Brand">
            <div className="Brand__mark" aria-hidden="true" />
            <div className="Brand__text">
              <div className="Brand__title">Notes</div>
              <div className="Brand__subtitle">Simple, fast, focused</div>
            </div>
          </div>
        </div>

        <div className="Topbar__right">
          <span className={connectivityPill.className} title={dataSource.apiBase ? dataSource.apiBase : "No API base configured"}>
            {connectivityPill.label}
          </span>

          <button className="Btn Btn--primary" onClick={handleCreateNote} disabled={status.loading || status.saving}>
            New note
          </button>

          <button className="Btn Btn--secondary" onClick={handleSave} disabled={!selectedNote || !dirty || status.saving}>
            {status.saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <main className="Layout">
        <aside className="Sidebar" aria-label="Notes list">
          <div className="Sidebar__header">
            <div className="Sidebar__title">All notes</div>
            <div className="Sidebar__meta">
              {status.loading ? "Loading…" : `${notes.length} note${notes.length === 1 ? "" : "s"}`}
            </div>
          </div>

          {status.error ? (
            <div className="InlineError" role="alert">
              {status.error}
            </div>
          ) : null}

          <div className="NotesList" role="list">
            {notes.map((n) => {
              const active = n.id === selectedId;
              return (
                <div
                  key={n.id}
                  className={`NoteListItem ${active ? "NoteListItem--active" : ""}`}
                  role="listitem"
                >
                  <button className="NoteListItem__select" onClick={() => handleSelect(n.id)} aria-current={active ? "true" : "false"}>
                    <div className="NoteListItem__title">{n.title || "Untitled"}</div>
                    <div className="NoteListItem__sub">
                      <span className="NoteListItem__date">{formatUpdatedAt(n.updatedAt)}</span>
                      <span className="NoteListItem__dot" aria-hidden="true">
                        ·
                      </span>
                      <span className="NoteListItem__snippet">{(n.content || "").replace(/\s+/g, " ").slice(0, 48) || "No content"}</span>
                    </div>
                  </button>

                  <button
                    className="IconBtn IconBtn--danger"
                    onClick={() => handleDelete(n.id)}
                    aria-label={`Delete note "${n.title || "Untitled"}"`}
                    disabled={status.deleting}
                    title="Delete"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="Editor" aria-label="Selected note editor">
          {!selectedNote ? (
            <div className="EmptyState">
              <div className="EmptyState__card">
                <div className="EmptyState__title">No note selected</div>
                <div className="EmptyState__desc">Create a new note or select one from the sidebar to start editing.</div>
                <button className="Btn Btn--primary" onClick={handleCreateNote} disabled={status.loading || status.saving}>
                  Create your first note
                </button>
              </div>
            </div>
          ) : (
            <div className="Editor__inner">
              <div className="Editor__fields">
                <label className="Field">
                  <span className="Field__label">Title</span>
                  <input
                    className="Input"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    placeholder="Untitled"
                    maxLength={120}
                  />
                </label>

                <label className="Field Field--grow">
                  <span className="Field__label">Content</span>
                  <textarea
                    className="Textarea"
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    placeholder="Write your note…"
                  />
                </label>
              </div>

              <footer className="Editor__footer">
                <div className="Editor__status">
                  {dirty ? (
                    <span className="Status Status--dirty">Unsaved changes</span>
                  ) : (
                    <span className="Status Status--saved">Saved</span>
                  )}
                  <span className="Status__hint">Tip: Ctrl/⌘ + S to save</span>
                </div>

                <div className="Editor__actions">
                  <button className="Btn Btn--secondary" onClick={handleSave} disabled={!dirty || status.saving}>
                    {status.saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </footer>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
