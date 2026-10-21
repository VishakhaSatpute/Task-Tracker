import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createStore } from "./store.js";
import { draftProjectsFromIdea, copyForClaudeError } from "./claude.js";
import {
  folderApiSupported, pickFolder, getSavedFolder, syncNotes,
} from "./notesSync.js";
import { getAssignees } from "./assignees.js";
import { SettingsModal } from "./SettingsModal.jsx";
import { SignOutButton } from "./auth.jsx";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings.js";

const STATUSES = ["ideation", "inprogress", "completed", "dead"];
const STATUS_LABELS = { ideation: "Ideation", inprogress: "In Progress", completed: "Completed", dead: "Dead" };
const PRIORITIES = ["high", "medium", "low"];
const SEED_TYPES = [
  { id: "task", label: "Task", isBuiltIn: true },
  { id: "issue", label: "Issue", isBuiltIn: true },
];

// Identifies this tab to the server's sync lease.
const TAB_ID = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

function genId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2, 10));
}

function statusVar(status) { return "var(--s-" + status + ")"; }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ---------- store-backed hooks ----------

function useDb() {
  const [db, setDb] = useState(undefined); // undefined = loading, null = unavailable
  useEffect(() => {
    let cancelled = false;
    createStore().then(
      (d) => { if (!cancelled) setDb(d); },
      (e) => { console.error("store open failed", e); if (!cancelled) setDb(null); }
    );
    return () => { cancelled = true; };
  }, []);
  return db;
}

function useCollection(db, path) {
  const [docs, setDocs] = useState(null); // null = loading
  useEffect(() => {
    if (!db || !path) { setDocs(null); return; }
    setDocs(null);
    const unsub = db.collection(path).onSnapshot(
      (snap) => { setDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() }))); },
      (err) => { console.error("store subscribe error", path, err); setDocs([]); }
    );
    return unsub;
  }, [db, path]);
  return docs;
}

async function ensureSeedTypes(db, existingTypes) {
  if (!db || existingTypes === null) return;
  if (existingTypes.length > 0) return;
  for (const t of SEED_TYPES) {
    try {
      await db.doc("types/" + t.id).set({ label: t.label, isBuiltIn: true });
    } catch (e) {
      console.error("seed type failed", e);
    }
  }
}

// ---------- small marks ----------

function PriorityMark({ level }) {
  const n = { high: 3, medium: 2, low: 1 }[level] || 1;
  return (
    <span className="prio" data-level={level} role="img" aria-label={cap(level) + " priority"}>
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= n ? "on" : ""} style={{ height: 5 + i * 3 }} />
      ))}
    </span>
  );
}

function Assignee({ names }) {
  if (names.length === 0) {
    return (
      <span className="who">
        <span className="avatar none" aria-hidden="true" />
        <span className="nm none">Unassigned</span>
      </span>
    );
  }
  if (names.length > 1) {
    return (
      <span className="who multi" title={names.join(", ")}>
        <span className="avatars" aria-hidden="true">
          {names.slice(0, 3).map((n) => <span key={n} className="avatar">{initials(n)}</span>)}
        </span>
        <span className="nm">{names[0]} +{names.length - 1}</span>
      </span>
    );
  }
  const name = names[0];
  return (
    <span className="who" title={name}>
      <span className="avatar" aria-hidden="true">{initials(name)}</span>
      <span className="nm">{name}</span>
    </span>
  );
}

function StatusMark({ status }) {
  return (
    <span className="m-status" style={{ "--status": statusVar(status) }}>
      <span className="dot" aria-hidden="true" />
      {STATUS_LABELS[status] || status}
    </span>
  );
}

// dueDate is a "YYYY-MM-DD" string; parse it as a local date so it never shifts a day.
function parseDueDate(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function Meta({ project, typeLabel, showStatus }) {
  const due = project.dueDate ? parseDueDate(project.dueDate) : null;
  const open = project.status === "ideation" || project.status === "inprogress";
  const overdue = Boolean(due) && open && due < new Date(new Date().setHours(0, 0, 0, 0));
  return (
    <div className="meta">
      {showStatus && <StatusMark status={project.status} />}
      {/* <span className="m-type">{typeLabel}</span> */}
      <span className="m-prio">
        <PriorityMark level={project.priority} />
        {cap(project.priority)}
      </span>
      <Assignee names={getAssignees(project)} />
      <span className="m-due" data-overdue={overdue} title={overdue ? "Overdue" : "Due date"}>
        {due ? due.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""}
      </span>
      <span className="m-date" title="Created">{project.createdAt ? formatNoteTime(project.createdAt) : "—"}</span>
    </div>
  );
}

// ---------- Pipeline: status bar that doubles as the filter ----------

function PipelineStrip({ projects, value, onChange, interactive }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setReady(true), 60);
    return () => clearTimeout(id);
  }, []);

  const counts = useMemo(() => {
    const c = { ideation: 0, inprogress: 0, completed: 0, dead: 0 };
    for (const p of projects) if (c[p.status] !== undefined) c[p.status] += 1;
    return c;
  }, [projects]);

  const items = [
    ...(interactive ? [{ value: "all", label: "All", count: projects.length }] : []),
    ...STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s], count: counts[s] })),
  ];

  if (interactive) {
    return (
      <nav className="tabs" aria-label="Filter by status">
        {items.map((it) => (
          <button
            key={it.value}
            type="button"
            className="tab"
            aria-pressed={value === it.value}
            onClick={() => onChange(it.value)}
            style={it.value === "all" ? undefined : { "--status": statusVar(it.value) }}
          >
            {it.value !== "all" && <span className="dot" aria-hidden="true" />}
            <span>{it.label}</span>
            <span className="tab-count">{it.count}</span>
          </button>
        ))}
      </nav>
    );
  }

  return (
    <div className="pipeline">
      <div className="bar" aria-hidden="true">
        {STATUSES.map((s) => {
          const dim = interactive && value !== "all" && value !== s;
          return (
            <div
              key={s}
              className="bar-seg"
              data-dim={dim ? "true" : "false"}
              style={{ "--status": statusVar(s), flexGrow: ready ? counts[s] : 0, borderRightWidth: counts[s] > 0 ? 3 : 0 }}
            />
          );
        })}
      </div>
      <div className="legend" role={interactive ? "group" : undefined} aria-label={interactive ? "Filter by status" : undefined}>
        {items.map((it) => {
          const inner = (
            <React.Fragment>
              {it.value === "all" ? <span className="dot hollow" aria-hidden="true" /> : <span className="dot" aria-hidden="true" />}
              <span className="lg-label">{it.label}</span>
              <span className="lg-count">{it.count}</span>
            </React.Fragment>
          );
          const style = it.value === "all" ? undefined : { "--status": statusVar(it.value) };
          return interactive ? (
            <button key={it.value} type="button" className="lg" aria-pressed={value === it.value} onClick={() => onChange(it.value)} style={style}>
              {inner}
            </button>
          ) : (
            <div key={it.value} className="lg" style={style}>{inner}</div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- ViewSwitcher ----------

const VIEW_ICONS = {
  list: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M3 4h10M3 8h10M3 12h10" />
    </svg>
  ),
  tiles: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </svg>
  ),
  phases: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="3" height="11" rx="1" /><rect x="6.5" y="2.5" width="3" height="7" rx="1" /><rect x="10.5" y="2.5" width="3" height="9" rx="1" />
    </svg>
  ),
};

function ViewSwitcher({ value, onChange }) {
  const options = [
    { value: "list", label: "List" },
    { value: "tiles", label: "Tiles" },
    { value: "phases", label: "Phases" },
  ];
  return (
    <div className="switcher" role="group" aria-label="View">
      {options.map((opt) => (
        <button key={opt.value} type="button" aria-pressed={value === opt.value} onClick={() => onChange(opt.value)}>
          {VIEW_ICONS[opt.value]}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

const SORT_OPTIONS = [
  { value: "manual", label: "Manual order" },
  { value: "newest", label: "Date: newest first" },
  { value: "oldest", label: "Date: oldest first" },
  { value: "prio-desc", label: "Priority: high to low" },
  { value: "prio-asc", label: "Priority: low to high" },
];
const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };
const UNASSIGNED_FILTER = "__unassigned__";

// Closes a popover on outside click or Escape (Escape returns focus to the trigger).
function useDismiss(open, setOpen, rootRef, triggerRef) {
  useEffect(() => {
    if (!open) return undefined;
    function onDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, rootRef, triggerRef]);
}

const ChevronIcon = () => (
  <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 4.5 6 7.5 9 4.5" />
  </svg>
);

function MemberMultiSelect({ members, value, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  useDismiss(open, setOpen, rootRef, triggerRef);

  const options = [{ key: UNASSIGNED_FILTER, label: "Unassigned", name: "" }, ...members.map((m) => ({ key: m.name, label: m.name, name: m.name }))];
  const first = value[0] === UNASSIGNED_FILTER ? "Unassigned" : value[0];
  const summary = value.length === 0 ? "All" : value.length === 1 ? first : first + " +" + (value.length - 1);

  function toggle(key) {
    onChange(value.includes(key) ? value.filter((v) => v !== key) : [...value, key]);
  }

  return (
    <div className="fb-pop" ref={rootRef}>
      <button type="button" ref={triggerRef} className="pill" data-active={value.length > 0} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
          <circle cx="7" cy="4.8" r="2.4" /><path d="M2.5 12c.5-2.4 2.3-3.6 4.5-3.6s4 1.2 4.5 3.6" />
        </svg>
        <span className="pill-k">Member</span>
        <span className="pill-v">{summary}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="pop left" role="group" aria-label="Filter by members">
          <p className="pop-head">Members</p>
          {options.map((o) => (
            <label className="ms-opt" key={o.key} data-on={value.includes(o.key)}>
              <input type="checkbox" checked={value.includes(o.key)} onChange={() => toggle(o.key)} />
              {o.name ? <span className="avatar" aria-hidden="true">{initials(o.name)}</span> : <span className="avatar none" aria-hidden="true" />}
              <span className="ms-name">{o.label}</span>
            </label>
          ))}
          <div className="ms-foot">
            <button type="button" className="link" onClick={() => onChange([])} disabled={value.length === 0}>Clear</button>
            <button type="button" className="btn-primary pop-done" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

const SORT_GROUPS = [
  { head: "Manual", values: ["manual"] },
  { head: "Date created", values: ["newest", "oldest"] },
  { head: "Priority", values: ["prio-desc", "prio-asc"] },
];
const SORT_SHORT = { manual: "Manual order", newest: "Newest first", oldest: "Oldest first", "prio-desc": "Priority high to low", "prio-asc": "Priority low to high" };
const SORT_ITEM_LABEL = { manual: "Manual order", newest: "Newest first", oldest: "Oldest first", "prio-desc": "High to low", "prio-asc": "Low to high" };

function SortMenu({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  useDismiss(open, setOpen, rootRef, triggerRef);

  return (
    <div className="fb-pop" ref={rootRef}>
      <button type="button" ref={triggerRef} className="pill" data-active={value !== "manual"} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 2v10M1.8 9.8 4 12l2.2-2.2M10 12V2M7.8 4.2 10 2l2.2 2.2" />
        </svg>
        <span className="pill-k">Sort</span>
        <span className="pill-v">{SORT_SHORT[value]}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="pop right sort-pop" role="listbox" aria-label="Sort by">
          {SORT_GROUPS.map((g) => (
            <div key={g.head}>
              <p className="pop-head">{g.head}</p>
              {g.values.map((v) => (
                <button key={v} type="button" role="option" aria-selected={value === v} className="sort-opt" onClick={() => { onChange(v); setOpen(false); triggerRef.current?.focus(); }}>
                  <span>{SORT_ITEM_LABEL[v]}</span>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2.8 7.4 5.6 10.2 11.2 4" />
                  </svg>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterBar({
  view, sortMode, onSortChange, members, memberFilter, onMemberFilterChange,
  statusFilter, onStatusClear, onClearAll, visibleCount, totalCount,
}) {
  const showSort = view !== "phases";
  const sortActive = showSort && sortMode !== "manual";
  const memberActive = memberFilter.length > 0;
  const statusActive = statusFilter !== "all" && view !== "phases";
  const memberLabel = (v) => (v === UNASSIGNED_FILTER ? "Unassigned" : v);
  const anyFilter = memberActive || statusActive;
  const showCount = view !== "phases";

  return (
    <div className="filterbar" role="group" aria-label="Sort and filter projects">
      <div className="fb-row">
        <MemberMultiSelect members={members} value={memberFilter} onChange={onMemberFilterChange} />
        <div className="fb-spacer" />
        {showCount && <p className="fb-count" aria-live="polite">{visibleCount} of {totalCount} projects</p>}
        {showSort && <SortMenu value={sortMode} onChange={onSortChange} />}
      </div>

      {(anyFilter || sortActive) && (
        <div className="fb-chips">
          {memberFilter.map((v) => (
            <span className="chip" key={v}>
              <span className="chip-k">Member</span> <b>{memberLabel(v)}</b>
              <button type="button" onClick={() => onMemberFilterChange(memberFilter.filter((x) => x !== v))} aria-label={"Remove member filter " + memberLabel(v)}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" /></svg>
              </button>
            </span>
          ))}
          {statusActive && (
            <span className="chip">
              <span className="chip-k">Status</span> <b>{STATUS_LABELS[statusFilter] || statusFilter}</b>
              <button type="button" onClick={onStatusClear} aria-label="Remove status filter">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" /></svg>
              </button>
            </span>
          )}
          {anyFilter && <button type="button" className="link" onClick={onClearAll}>Clear all</button>}
          {sortActive && (
            <p className="fb-hint">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="5.5" /><path d="M7 6.2V10M7 4v.1" /></svg>
              Drag to reorder is off while sorted
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Header ----------

function Header({ onAddProject, onManageMembers, onManageTypes, onDescribeIdea, showIdeaButton, ideaButtonDisabled, view, onViewChange, connectionState, onSyncNow, syncing, syncStatus, onOpenSettings }) {
  return (
    <div className="top">
      <div>
        <h1 className="title">Task Tracker</h1>
        {connectionState === "unavailable" && (
          <p className="warn">Can’t reach the Task Tracker server &mdash; data cannot be saved.</p>
        )}
        {syncStatus && <p className="sync-status">{syncStatus}</p>}
      </div>
      <div className="controls">
        <ViewSwitcher value={view} onChange={onViewChange} />
        <button type="button" onClick={onSyncNow} className="btn-outline" disabled={connectionState !== "ready" || syncing}>
          {syncing ? "Syncing…" : "Sync notes now"}
        </button>
        <button type="button" onClick={onOpenSettings} className="btn-outline">Settings</button>
        <SignOutButton />
        <button type="button" onClick={onManageMembers} className="btn-outline" disabled={connectionState !== "ready"}>Manage members</button>
        <button type="button" onClick={onManageTypes} className="btn-outline" disabled={connectionState !== "ready"}>Manage project types</button>
        {showIdeaButton && (
          <button type="button" onClick={onDescribeIdea} className="btn-outline" disabled={ideaButtonDisabled}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 1.2c0 2.65 2.15 4.8 4.8 4.8-2.65 0-4.8 2.15-4.8 4.8 0-2.65-2.15-4.8-4.8-4.8C4.85 6 7 3.85 7 1.2z" />
            </svg>
            Describe an idea
          </button>
        )}
        <button type="button" onClick={onAddProject} className="btn-primary">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M7 2v10M2 7h10" />
          </svg>
          Add project
        </button>
      </div>
    </div>
  );
}

// ---------- MembersModal ----------

function MembersModal({ members, isMemberInUse, onAddMember, onDeleteMember, onClose }) {
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleAdd(e) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (members.some((m) => (m.name || "").toLowerCase() === trimmed.toLowerCase())) {
      setMessage(trimmed + " is already a member.");
      return;
    }
    setSaving(true);
    try {
      await onAddMember(trimmed);
      setNewName("");
      setMessage("");
    } catch (err) {
      setMessage("Could not add member. Please try again.");
    }
    setSaving(false);
  }

  async function handleDelete(member) {
    try {
      const result = await onDeleteMember(member);
      setMessage(result.ok ? "" : result.reason || "Unable to delete this member.");
    } catch (err) {
      setMessage("Could not delete member. Please try again.");
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Manage members" onClick={(e) => e.stopPropagation()}>
        <h2>Manage members</h2>

        {members.length === 0 ? (
          <p className="tm-empty">No members yet. Add someone below to assign projects to them.</p>
        ) : (
          <div className="manage-list-scroll">
            <ul className="tm-list">
              {members.map((m) => {
                const inUse = isMemberInUse(m.name);
                return (
                  <li key={m.id}>
                    <span className="who">
                      <span className="avatar" aria-hidden="true">{initials(m.name)}</span>
                      <span>{m.name}</span>
                    </span>
                    <button
                      type="button"
                      disabled={inUse}
                      onClick={() => handleDelete(m)}
                      className="link danger"
                      title={inUse ? "Cannot delete: assigned to a project" : "Delete member"}
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {message && <p className="err" style={{ marginTop: 10 }}>{message}</p>}

        <form onSubmit={handleAdd} className="tm-add" style={{ marginTop: 14 }}>
          <input
            type="text"
            id="manage-member-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New member name"
            className="field"
            autoFocus
          />
          <button type="submit" disabled={saving} className="btn-primary">{saving ? "Adding…" : "Add member"}</button>
        </form>

        <div className="actions" style={{ marginTop: 18 }}>
          <span />
          <div className="right">
            <button type="button" onClick={onClose} className="btn-quiet">Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- TypesModal ----------

function TypesModal({ types, isTypeInUse, onAddType, onDeleteType, onClose }) {
  const [newLabel, setNewLabel] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleAdd(e) {
    e.preventDefault();
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    if (types.some((t) => (t.label || "").toLowerCase() === trimmed.toLowerCase())) {
      setMessage(trimmed + " already exists.");
      return;
    }
    setSaving(true);
    try {
      await onAddType(trimmed);
      setNewLabel("");
      setMessage("");
    } catch (err) {
      setMessage("Could not add type. Please try again.");
    }
    setSaving(false);
  }

  async function handleDelete(id) {
    const result = await onDeleteType(id);
    setMessage(result.ok ? "" : result.reason || "Unable to delete this type.");
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Manage project types" onClick={(e) => e.stopPropagation()}>
        <h2>Manage project types</h2>

        {types.length === 0 ? (
          <p className="tm-empty">No types yet. Add one below.</p>
        ) : (
          <div className="manage-list-scroll">
            <ul className="tm-list">
              {types.map((t) => {
                const inUse = isTypeInUse(t.id);
                return (
                  <li key={t.id}>
                    <span>{t.label}</span>
                    <button
                      type="button"
                      disabled={inUse}
                      onClick={() => handleDelete(t.id)}
                      className="link danger"
                      title={inUse ? "Cannot delete: assigned to a project" : "Delete type"}
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {message && <p className="err" style={{ marginTop: 10 }}>{message}</p>}

        <form onSubmit={handleAdd} className="tm-add" style={{ marginTop: 14 }}>
          <input
            type="text"
            id="manage-type-input"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="New type name"
            className="field"
            autoFocus
          />
          <button type="submit" disabled={saving} className="btn-primary">{saving ? "Adding…" : "Add type"}</button>
        </form>

        <div className="actions" style={{ marginTop: 18 }}>
          <span />
          <div className="right">
            <button type="button" onClick={onClose} className="btn-quiet">Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- IdeaCapture (talk out an idea, let Claude draft it) ----------

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.25" y="1.5" width="4.5" height="7.5" rx="2.25" />
      <path d="M2.75 7.25a4.75 4.75 0 0 0 9.5 0" />
      <path d="M7.5 12v1.5" />
    </svg>
  );
}

function IdeaCapture({ onGenerate, onClose }) {
  const [idea, setIdea] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [micNote, setMicNote] = useState("");
  const ctlRef = useRef(null);
  const recognitionRef = useRef(null);

  const SpeechRecognitionCtor = typeof window !== "undefined"
    ? (window.SpeechRecognition || window.webkitSpeechRecognition)
    : null;

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => () => {
    ctlRef.current?.abort();
    try { recognitionRef.current?.stop(); } catch (e) {}
  }, []);

  const dictationFallbackNote = "Voice input isn't available in this view.";

  function stopListening() {
    try { recognitionRef.current?.stop(); } catch (e) {}
  }

  function toggleMic() {
    if (!SpeechRecognitionCtor) return;
    if (listening) { stopListening(); return; }

    setMicNote("");
    setInterim("");
    let recognition;
    try {
      recognition = new SpeechRecognitionCtor();
    } catch (e) {
      setMicNote(dictationFallbackNote);
      return;
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onresult = (e) => {
      let finalChunk = "";
      let interimChunk = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalChunk += res[0].transcript;
        else interimChunk += res[0].transcript;
      }
      if (finalChunk.trim()) {
        setIdea((prev) => {
          const sep = prev && !/\s$/.test(prev) ? " " : "";
          return prev + sep + finalChunk.trim() + " ";
        });
      }
      setInterim(interimChunk);
    };
    recognition.onerror = (e) => {
      setListening(false);
      setInterim("");
      setMicNote(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? dictationFallbackNote
          : "Voice input stopped unexpectedly. " + dictationFallbackNote
      );
    };
    recognition.onend = () => {
      setListening(false);
      setInterim("");
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch (e) {
      setMicNote(dictationFallbackNote);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = idea.trim();
    if (!trimmed) { setError("Describe the idea first."); return; }
    stopListening();
    setThinking(true);
    setError("");
    const ctl = new AbortController();
    ctlRef.current = ctl;
    try {
      await onGenerate(trimmed, ctl.signal);
      // success: the caller adds the projects to Ideation and closes this modal
    } catch (err) {
      setThinking(false);
      console.error("[Task Tracker] idea generation failed:", err);
      setError(copyForClaudeError(err));
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Describe an idea" onClick={(e) => e.stopPropagation()}>
        <h2>Describe an idea</h2>

        <form onSubmit={handleSubmit} className="form">
          <div>
            <label className="lbl" htmlFor="idea-text">Talk about your idea</label>
            <div className="idea-field-wrap">
              <textarea
                id="idea-text"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="e.g. I want something that reminds the team about weekly standups and lets people swap their slot with someone else..."
                rows={6}
                className={"field" + (SpeechRecognitionCtor ? " has-mic" : "")}
                autoFocus
                disabled={thinking}
              />
              {SpeechRecognitionCtor && (
                <button
                  type="button"
                  onClick={toggleMic}
                  className="mic-btn"
                  aria-pressed={listening}
                  aria-label={listening ? "Stop voice input" : "Start voice input"}
                  title={listening ? "Stop voice input" : "Start voice input"}
                  disabled={thinking}
                >
                  <MicIcon />
                </button>
              )}
            </div>
            {listening && (
              <p className="mic-status">
                Listening&hellip; {interim && <span className="mic-interim">{interim}</span>}
              </p>
            )}
            {micNote && <p className="mic-status mic-status-note">{micNote}</p>}
          </div>
          <p style={{ fontSize: 13, color: "var(--ink-2)", marginTop: -8 }}>
            Claude will analyze this and add a project (name and description) for each distinct project it finds, so notes or a transcript covering several projects add several cards. They start in Ideation, assigned to a member if you name one (add people under Manage members first), with your text saved in each project's Notes.
          </p>
          {error && <p className="err">{error}</p>}
          <div className="actions">
            <span />
            <div className="right">
              <button type="button" onClick={onClose} className="btn-quiet" disabled={thinking}>Cancel</button>
              <button type="submit" disabled={thinking || !idea.trim()} className="btn-primary">
                {thinking ? "Thinking…" : "Generate project"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- ProjectForm (modal) ----------

function ProjectForm({ project, draft, types, members, onClose, onSave, onDelete, onManageMembers, onManageTypes, notes, notesLoading, onAddNote, onEditNote, onDeleteNote }) {
  const isEditing = Boolean(project);
  const [name, setName] = useState(project?.name ?? draft?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? draft?.description ?? "");
  const [typeId, setTypeId] = useState(project?.typeId ?? draft?.typeId ?? types[0]?.id ?? "");
  const [priority, setPriority] = useState(project?.priority ?? draft?.priority ?? "medium");
  const [assignees, setAssignees] = useState(getAssignees(project));
  const [status, setStatus] = useState(project?.status ?? "ideation");
  const [dueDate, setDueDate] = useState(project?.dueDate ?? "");
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const selectedTypeExists = types.some((t) => t.id === typeId);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) { setError("Project name is required."); return; }
    if (!typeId || !selectedTypeExists) { setError("Select a project type."); return; }
    setSaving(true);
    try {
      await onSave({
        id: project?.id,
        name: name.trim(),
        description: description.trim(),
        typeId,
        priority,
        assignees,
        status,
        dueDate,
      });
      onClose();
    } catch (err) {
      setError("Could not save. Please try again.");
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!project) return;
    setSaving(true);
    try {
      await onDelete(project.id);
      onClose();
    } catch (err) {
      setError("Could not delete. Please try again.");
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className={"modal" + (isEditing ? " with-notes" : "")} role="dialog" aria-modal="true" aria-label={isEditing ? "Edit project" : "Add project"} onClick={(e) => e.stopPropagation()}>
        <h2>{isEditing ? "Edit project" : "Add project"}</h2>

        <div className="modal-split">
          <div className="modal-main">
            <form onSubmit={handleSubmit} className="form">
          <div>
            <label className="lbl" htmlFor="pf-name">
              Name <span className="req">*</span>
            </label>
            <input id="pf-name" type="text" value={name} onChange={(e) => setName(e.target.value)} className="field" autoFocus />
          </div>

          <div>
            <label className="lbl" htmlFor="pf-description">Description</label>
            <textarea id="pf-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="field" />
          </div>

          <div className="grid2">
            <div>
              <div className="lbl-row">
                <label className="lbl" htmlFor="pf-type">Type</label>
                <button type="button" className="link small" onClick={onManageTypes}>Manage types</button>
              </div>
              <select id="pf-type" value={typeId} onChange={(e) => setTypeId(e.target.value)} className="field">
                {!selectedTypeExists && <option value={typeId} disabled>Select a type&hellip;</option>}
                {types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>

            <div>
              <label className="lbl" htmlFor="pf-priority">Priority</label>
              <select id="pf-priority" value={priority} onChange={(e) => setPriority(e.target.value)} className="field">
                {PRIORITIES.map((p) => <option key={p} value={p}>{cap(p)}</option>)}
              </select>
            </div>
          </div>

          <div className="grid2">
            <div>
              <div className="lbl-row">
                <span className="lbl" id="pf-assignees-lbl">Assigned to</span>
                <button type="button" className="link small" onClick={onManageMembers}>Manage members</button>
              </div>
              <div className="assignee-list field" role="group" aria-labelledby="pf-assignees-lbl">
                {[...members.map((m) => m.name), ...assignees.filter((n) => !members.some((m) => m.name === n))].map((n) => (
                  <label key={n} className="assignee-opt">
                    <input
                      type="checkbox"
                      checked={assignees.includes(n)}
                      onChange={(e) => setAssignees(e.target.checked ? [...assignees, n] : assignees.filter((a) => a !== n))}
                    />
                    {n}
                  </label>
                ))}
                {members.length === 0 && assignees.length === 0 && <span className="nm none">No members yet</span>}
              </div>
            </div>

            <div>
              <label className="lbl" htmlFor="pf-status">Status</label>
              <select id="pf-status" value={status} onChange={(e) => setStatus(e.target.value)} className="field">
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select>
            </div>
          </div>

          <div className="grid2">
            <div>
              <label className="lbl" htmlFor="pf-due">Due date</label>
              <input id="pf-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="field" />
            </div>
          </div>

          {error && <p className="err">{error}</p>}

          <div className="actions">
            <div>
              {isEditing && !confirmingDelete && (
                <button type="button" onClick={() => setConfirmingDelete(true)} className="link danger">
                  Delete project
                </button>
              )}
              {isEditing && confirmingDelete && (
                <div className="confirm">
                  <span>Delete this project?</span>
                  <button type="button" onClick={handleDelete} className="link danger" disabled={saving}>
                    Yes, delete
                  </button>
                  <button type="button" onClick={() => setConfirmingDelete(false)} className="link" style={{ fontWeight: 500, color: "var(--ink-2)" }}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
            {!confirmingDelete && (
              <div className="right">
                <button type="button" onClick={onClose} className="btn-quiet">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary">
                  {saving ? "Saving…" : isEditing ? "Save changes" : "Add project"}
                </button>
              </div>
            )}
          </div>
        </form>
          </div>

          {isEditing && (
            <NotesPanel
              projectId={project.id}
              notes={notes}
              loading={notesLoading}
              members={members}
              onAddNote={onAddNote}
              onEditNote={onEditNote}
              onDeleteNote={onDeleteNote}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- NotesPanel (messages-style notes & updates) ----------

function formatNoteTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function NotesPanel({ projectId, notes, loading, members, onAddNote, onEditNote, onDeleteNote }) {
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [noteError, setNoteError] = useState("");

  const [author, setAuthor] = useState(() => {
    try {
      // "warboard-note-author" is the pre-rename key; fall back to it once.
      return localStorage.getItem("task-tracker-note-author") || localStorage.getItem("warboard-note-author") || "";
    } catch (e) { return ""; }
  });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const feedRef = useRef(null);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [notes.length]);

  async function handleSend(e) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setError("");
    try {
      await onAddNote(projectId, trimmed, author.trim());
      setText("");
      try { localStorage.setItem("task-tracker-note-author", author.trim()); } catch (e2) {}
    } catch (err) {
      setError("Could not post. Please try again.");
    }
    setSending(false);
  }

  function startEdit(n) { setEditingId(n.id); setEditText(n.text || ""); setConfirmId(null); setNoteError(""); }
  function cancelEdit() { setEditingId(null); setEditText(""); setNoteError(""); }

  async function saveEdit(n) {
    const trimmed = editText.trim();
    if (!trimmed || busyId) return;
    if (trimmed === (n.text || "").trim()) { cancelEdit(); return; }
    setBusyId(n.id);
    setNoteError("");
    try {
      await onEditNote(projectId, n.id, trimmed);
      cancelEdit();
    } catch (err) {
      setNoteError("Could not save the change. Please try again.");
    }
    setBusyId(null);
  }

  async function removeNote(n) {
    if (busyId) return;
    setBusyId(n.id);
    setNoteError("");
    try {
      await onDeleteNote(projectId, n.id);
      setConfirmId(null);
    } catch (err) {
      setNoteError("Could not delete the note. Please try again.");
    }
    setBusyId(null);
  }

  return (
    <div className="notes-col">
      <h3 className="notes-title">Notes &amp; updates</h3>

      <div className="notes-feed" ref={feedRef}>
        {loading && <p className="notes-empty">Loading&hellip;</p>}
        {!loading && notes.length === 0 && (
          <p className="notes-empty">No notes yet. Leave the first update.</p>
        )}
        {!loading && notes.map((n) => (
          <div key={n.id} className="note-msg">
            <div className="note-msg-head">
              <span className="note-author">{n.author || "Someone"}</span>
              <span className="note-time">{formatNoteTime(n.createdAt)}{n.editedAt ? " · edited" : ""}</span>
            </div>
            {editingId === n.id ? (
              <div className="note-edit">
                <textarea
                  className="field note-input"
                  value={editText}
                  rows={3}
                  autoFocus
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); }
                    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(n); }
                  }}
                  aria-label="Edit note"
                />
                <div className="note-actions">
                  <button type="button" className="btn-primary note-send" disabled={busyId === n.id || !editText.trim()} onClick={() => saveEdit(n)}>Save</button>
                  <button type="button" className="btn-quiet" onClick={cancelEdit}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <p className="note-text">{n.text}</p>
                <div className="note-actions">
                  {confirmId === n.id ? (
                    <>
                      <span className="note-confirm">Delete this note?</span>
                      <button type="button" className="link small danger" disabled={busyId === n.id} onClick={() => removeNote(n)}>Yes, delete</button>
                      <button type="button" className="link small" onClick={() => setConfirmId(null)}>No</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="icon-btn" onClick={() => startEdit(n)} aria-label="Edit note" title="Edit">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M9.4 2.2a1.3 1.3 0 0 1 1.8 1.8L4.6 10.6 2 11.2l.6-2.6z" />
                        </svg>
                      </button>
                      <button type="button" className="icon-btn danger" onClick={() => { setConfirmId(n.id); setNoteError(""); }} aria-label="Delete note" title="Delete">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M2.5 3.8h9M5.4 3.8V2.6h3.2v1.2M3.7 3.8l.5 7.6h5.6l.5-7.6M5.8 6v3.6M8.2 6v3.6" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {noteError && <p className="err">{noteError}</p>}

      <form onSubmit={handleSend} className="note-compose">
        <input
          type="text"
          id="note-author"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="Your name"
          className="field note-author-input"
          list="notes-author-options"
        />
        <datalist id="notes-author-options">
          {members.map((m) => <option key={m.id} value={m.name} />)}
        </datalist>
        <div className="note-compose-row">
          <textarea
            id="note-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { handleSend(e); }
            }}
            placeholder="Add a note or update&hellip;"
            className="field note-input"
            rows={2}
          />
          <button type="submit" disabled={sending || !text.trim()} className="btn-primary note-send">Post</button>
        </div>
        {error && <p className="err">{error}</p>}
      </form>
    </div>
  );
}

// ---------- Drag handle icon ----------

function DragHandleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="3" r="1.3" /><circle cx="11" cy="3" r="1.3" />
      <circle cx="5" cy="8" r="1.3" /><circle cx="11" cy="8" r="1.3" />
      <circle cx="5" cy="13" r="1.3" /><circle cx="11" cy="13" r="1.3" />
    </svg>
  );
}

// ---------- shared reorder logic (native HTML5 DnD + keyboard) ----------

function useReorderable(items, onReorder) {
  const dragIdRef = useRef(null);
  const [overId, setOverId] = useState(null);

  const handleDragStart = useCallback((id) => (e) => {
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", id); } catch (_) {}
  }, []);

  const handleDragOver = useCallback((id) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (id !== overId) setOverId(id);
  }, [overId]);

  const handleDrop = useCallback((id) => (e) => {
    e.preventDefault();
    const draggedId = dragIdRef.current;
    setOverId(null);
    dragIdRef.current = null;
    if (!draggedId || draggedId === id) return;
    onReorder(draggedId, id);
  }, [onReorder]);

  const handleDragEnd = useCallback(() => {
    dragIdRef.current = null;
    setOverId(null);
  }, []);

  const moveByKeyboard = useCallback((id, direction) => {
    const idx = items.findIndex((it) => it.id === id);
    if (idx === -1) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= items.length) return;
    onReorder(id, items[targetIdx].id);
  }, [items, onReorder]);

  return { overId, handleDragStart, handleDragOver, handleDrop, handleDragEnd, moveByKeyboard };
}

// ---------- empty state ----------

function EmptyState({ filter, onAdd, onClearFilter }) {
  const filtered = filter && filter !== "all";
  return (
    <div className="empty">
      <p>{filtered ? "No projects match these filters." : "No projects yet."}</p>
      {filtered ? (
        <button type="button" className="link" onClick={onClearFilter}>Clear filters</button>
      ) : (
        <button type="button" className="link" onClick={onAdd}>Add project</button>
      )}
    </div>
  );
}

// ---------- ProjectRow (List view) ----------

function ProjectRow({ project, typeLabel, onClick, dnd, isDraggingOver, onKeyReorder, reorderDisabled }) {
  return (
    <div
      onDragOver={reorderDisabled ? undefined : dnd.handleDragOver(project.id)}
      onDrop={reorderDisabled ? undefined : dnd.handleDrop(project.id)}
      className={"row" + (isDraggingOver ? " is-over" : "")}
      style={{ "--status": statusVar(project.status) }}
    >
      <button
        type="button"
        draggable={!reorderDisabled}
        disabled={reorderDisabled}
        title={reorderDisabled ? "Switch sort to Manual to reorder" : undefined}
        onDragStart={dnd.handleDragStart(project.id)}
        onDragEnd={dnd.handleDragEnd}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") { e.preventDefault(); onKeyReorder(project.id, -1); }
          if (e.key === "ArrowDown") { e.preventDefault(); onKeyReorder(project.id, 1); }
        }}
        aria-label={"Reorder " + project.name}
        className="handle"
      >
        <DragHandleIcon />
      </button>

      <div
        onClick={onClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
        className="rowmain"
      >
        <div style={{ minWidth: 0 }}>
          <p className="name">{project.name}</p>
          {project.description && <p className="desc">{project.description}</p>}
        </div>
        <Meta project={project} typeLabel={typeLabel} showStatus={true} />
      </div>
    </div>
  );
}

function ListHead({ sortMode }) {
  const arrow = { newest: " ↓", oldest: " ↑", "prio-desc": " ↓", "prio-asc": " ↑" }[sortMode] || "";
  const byDate = sortMode === "newest" || sortMode === "oldest";
  const byPrio = sortMode === "prio-desc" || sortMode === "prio-asc";
  return (
    <div className="row list-head" aria-hidden="true">
      <span className="handle"><DragHandleIcon /></span>
      <div className="rowmain">
        <span>Project</span>
        <span>Status</span>
        {/* <span>Type</span> */}
        <span data-sorted={byPrio}>Priority{byPrio ? arrow : ""}</span>
        <span>Assignee</span>
        <span>Due</span>
        <span data-sorted={byDate}>Created{byDate ? arrow : ""}</span>
      </div>
    </div>
  );
}

function ProjectListView({ projects, typesById, onSelectProject, onReorder, filter, onAdd, onClearFilter, reorderDisabled, sortMode }) {
  const dnd = useReorderable(projects, onReorder);
  if (projects.length === 0) {
    return <EmptyState filter={filter} onAdd={onAdd} onClearFilter={onClearFilter} />;
  }
  return (
    <div className="list">
      <ListHead sortMode={sortMode} />
      {projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          typeLabel={typesById[project.typeId]?.label ?? "Unknown"}
          onClick={() => onSelectProject(project)}
          dnd={dnd}
          isDraggingOver={dnd.overId === project.id}
          onKeyReorder={dnd.moveByKeyboard}
          reorderDisabled={reorderDisabled}
        />
      ))}
    </div>
  );
}

// ---------- ProjectCard (Tiles + Phases) ----------

function ProjectCard({ project, typeLabel, onClick, dnd, isDraggingOver, onKeyReorder, showStatus, reorderDisabled }) {
  return (
    <div
      onDragOver={reorderDisabled ? undefined : dnd.handleDragOver(project.id)}
      onDrop={reorderDisabled ? undefined : dnd.handleDrop(project.id)}
      className={"card" + (isDraggingOver ? " is-over" : "")}
      data-plain={showStatus ? "false" : "true"}
      style={{ "--status": statusVar(project.status) }}
    >
      <button
        type="button"
        draggable={!reorderDisabled}
        disabled={reorderDisabled}
        title={reorderDisabled ? "Switch sort to Manual to reorder" : undefined}
        onDragStart={dnd.handleDragStart(project.id)}
        onDragEnd={dnd.handleDragEnd}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); onKeyReorder(project.id, -1); }
          if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); onKeyReorder(project.id, 1); }
        }}
        aria-label={"Reorder " + project.name}
        className="handle"
      >
        <DragHandleIcon />
      </button>

      <div
        onClick={onClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
        className="card-main"
      >
        <p className="name">{project.name}</p>
        {project.description && <p className="desc">{project.description}</p>}
      </div>
      <Meta project={project} typeLabel={typeLabel} showStatus={showStatus} />
    </div>
  );
}

function ProjectTilesView({ projects, typesById, onSelectProject, onReorder, filter, onAdd, onClearFilter, reorderDisabled }) {
  const dnd = useReorderable(projects, onReorder);
  if (projects.length === 0) {
    return <EmptyState filter={filter} onAdd={onAdd} onClearFilter={onClearFilter} />;
  }
  return (
    <div className="tiles">
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          typeLabel={typesById[project.typeId]?.label ?? "Unknown"}
          onClick={() => onSelectProject(project)}
          dnd={dnd}
          isDraggingOver={dnd.overId === project.id}
          onKeyReorder={dnd.moveByKeyboard}
          showStatus={true}
          reorderDisabled={reorderDisabled}
        />
      ))}
    </div>
  );
}

// ---------- Phases (Kanban) ----------

function PhaseColumn({ status, label, projects, typesById, onSelectProject, dnd, onDropOnColumn, onKeyReorder }) {
  const [isColumnOver, setIsColumnOver] = useState(false);
  return (
    <div className="col" style={{ "--status": statusVar(status) }}>
      <div className="col-head">
        <h3>{label}</h3>
        <span className="col-count">{projects.length}</span>
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setIsColumnOver(true); }}
        onDragLeave={() => setIsColumnOver(false)}
        onDrop={(e) => { e.preventDefault(); setIsColumnOver(false); onDropOnColumn(status); }}
        className={"drop" + (isColumnOver ? " over" : "")}
      >
        {projects.length === 0 && <p className="drop-empty">Drag a project here</p>}
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            typeLabel={typesById[project.typeId]?.label ?? "Unknown"}
            onClick={() => onSelectProject(project)}
            dnd={dnd}
            isDraggingOver={dnd.overId === project.id}
            onKeyReorder={onKeyReorder}
            showStatus={false}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectPhasesView({ projects, typesById, onSelectProject, onReorderWithinStatus, onMoveToStatus }) {
  const projectsByStatus = { ideation: [], inprogress: [], completed: [], dead: [] };
  for (const p of projects) projectsByStatus[p.status].push(p);

  const dnd = useReorderable(projects, (draggedId, overId) => {
    const dragged = projects.find((p) => p.id === draggedId);
    const over = projects.find((p) => p.id === overId);
    if (!dragged || !over) return;
    if (dragged.status === over.status) {
      onReorderWithinStatus(draggedId, overId);
    } else {
      onMoveToStatus(draggedId, over.status, overId);
    }
  });

  function handleKeyReorder(id, direction) {
    const project = projects.find((p) => p.id === id);
    if (!project) return;
    const siblings = projectsByStatus[project.status];
    const idx = siblings.findIndex((p) => p.id === id);
    const targetIdx = idx + direction;
    if (targetIdx >= 0 && targetIdx < siblings.length) {
      onReorderWithinStatus(id, siblings[targetIdx].id);
    }
  }

  return (
    <PhasesInner
      projectsByStatus={projectsByStatus}
      typesById={typesById}
      onSelectProject={onSelectProject}
      dnd={dnd}
      handleKeyReorder={handleKeyReorder}
      onMoveToStatus={onMoveToStatus}
    />
  );
}

function PhasesInner({ projectsByStatus, typesById, onSelectProject, dnd, handleKeyReorder, onMoveToStatus }) {
  const draggedIdRef = useRef(null);

  // Wrap handleDragStart to also remember id for column-level drops.
  const wrappedDnd = useMemo(() => ({
    ...dnd,
    handleDragStart: (id) => (e) => {
      draggedIdRef.current = id;
      dnd.handleDragStart(id)(e);
    },
    handleDragEnd: () => {
      draggedIdRef.current = null;
      dnd.handleDragEnd();
    },
  }), [dnd]);

  function onDropOnColumn(status) {
    const draggedId = draggedIdRef.current;
    draggedIdRef.current = null;
    if (!draggedId) return;
    onMoveToStatus(draggedId, status, undefined);
  }

  return (
    <div className="phases">
      {STATUSES.map((status) => (
        <PhaseColumn
          key={status}
          status={status}
          label={STATUS_LABELS[status]}
          projects={projectsByStatus[status]}
          typesById={typesById}
          onSelectProject={onSelectProject}
          dnd={wrappedDnd}
          onDropOnColumn={onDropOnColumn}
          onKeyReorder={handleKeyReorder}
        />
      ))}
    </div>
  );
}

// ---------- App ----------

function App() {
  const db = useDb();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadSettings().then(
      (s) => { if (!cancelled) { setSettings(s); setSettingsLoaded(true); } },
      (e) => { console.error(e); if (!cancelled) setSettingsLoaded(true); }
    );
    return () => { cancelled = true; };
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [folderHandle, setFolderHandle] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState(null);
  const [syncError, setSyncError] = useState("");
  const syncingRef = useRef(false);
  const rawProjects = useCollection(db, "projects");
  const rawTypes = useCollection(db, "types");
  const rawMembers = useCollection(db, "members");

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState(undefined);
  const [draftProject, setDraftProject] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [view, setView] = useState("list");
  const [memberFilter, setMemberFilter] = useState([]);
  const [sortMode, setSortModeState] = useState(() => {
    try {
      const saved = localStorage.getItem("task-tracker-sort-mode");
      return SORT_OPTIONS.some((o) => o.value === saved) ? saved : "manual";
    } catch (e) {
      return "manual";
    }
  });
  function setSortMode(mode) {
    setSortModeState(mode);
    try { localStorage.setItem("task-tracker-sort-mode", mode); } catch (e) {}
  }
  const [manageModal, setManageModal] = useState(null); // null | "members" | "types"
  const [ideaCaptureOpen, setIdeaCaptureOpen] = useState(false);

  const notesPath = editingProject ? "projects/" + editingProject.id + "/notes" : null;
  const rawNotes = useCollection(db, notesPath);
  const notes = useMemo(
    () => [...(rawNotes ?? [])].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
    [rawNotes]
  );
  const notesLoading = Boolean(editingProject) && rawNotes === null;

  useEffect(() => {
    ensureSeedTypes(db, rawTypes);
  }, [db, rawTypes]);

  const projects = rawProjects ?? [];
  const types = rawTypes && rawTypes.length > 0 ? rawTypes : SEED_TYPES;

  const typesById = useMemo(() => {
    const map = {};
    for (const t of types) map[t.id] = t;
    return map;
  }, [types]);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [projects]
  );
  const members = useMemo(
    () => [...(rawMembers ?? [])].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [rawMembers]
  );
  // Selected members that no longer exist are dropped; empty selection means "all".
  const activeMemberFilter = useMemo(
    () => memberFilter.filter((v) => v === UNASSIGNED_FILTER || members.some((m) => m.name === v)),
    [memberFilter, members]
  );
  const memberProjects = useMemo(() => {
    if (activeMemberFilter.length === 0) return sortedProjects;
    const selected = new Set(activeMemberFilter);
    return sortedProjects.filter((p) => {
      const names = getAssignees(p);
      return names.length ? names.some((n) => selected.has(n)) : selected.has(UNASSIGNED_FILTER);
    });
  }, [sortedProjects, activeMemberFilter]);
  const filteredProjects = statusFilter === "all" ? memberProjects : memberProjects.filter((p) => p.status === statusFilter);
  const visibleProjects = useMemo(() => {
    if (sortMode === "manual") return filteredProjects;
    const created = (p) => p.createdAt ?? 0;
    const prio = (p) => PRIORITY_RANK[p.priority] ?? 1;
    // Array.sort is stable, so remaining ties keep their manual order.
    return [...filteredProjects].sort((a, b) => {
      if (sortMode === "newest") return created(b) - created(a);
      if (sortMode === "oldest") return created(a) - created(b);
      const d = sortMode === "prio-desc" ? prio(b) - prio(a) : prio(a) - prio(b);
      return d || created(b) - created(a);
    });
  }, [filteredProjects, sortMode]);
  const reorderDisabled = sortMode !== "manual";
  const hasActiveFilter = statusFilter !== "all" || activeMemberFilter.length > 0;
  function clearFilters() { setStatusFilter("all"); setMemberFilter([]); }

  const isTypeInUse = useCallback((id) => projects.some((p) => p.typeId === id), [projects]);

  const isMemberInUse = useCallback((name) => projects.some((p) => getAssignees(p).includes(name)), [projects]);

  function openAddForm() { setEditingProject(undefined); setDraftProject(null); setIsFormOpen(true); }
  function openEditForm(project) { setEditingProject(project); setDraftProject(null); setIsFormOpen(true); }
  function closeForm() { setIsFormOpen(false); setEditingProject(undefined); setDraftProject(null); }

  async function handleGenerateIdea(ideaText, signal) {
    const drafts = await draftProjectsFromIdea({ ideaText, types, members: members.map((m) => m.name), signal });
    // Like Sync notes: add every project found straight to Ideation, with the raw text as a note.
    // New projects go to the top of the manual order, keeping the drafts' own order.
    const baseOrder = projects.reduce((min, p) => Math.min(min, p.order ?? 0), 0) - drafts.length;
    const now = Date.now();
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      const id = genId();
      await db.doc("projects/" + id).set({
        name: d.name,
        description: d.description,
        typeId: d.typeId ?? types[0]?.id,
        priority: d.priority ?? "medium",
        assignees: d.assignedTo ? [d.assignedTo] : [],
        status: "ideation",
        order: baseOrder + i,
        createdAt: now,
        updatedAt: now,
      });
      await db.doc("projects/" + id + "/notes/" + genId()).set({ text: ideaText, author: "Describe an idea", createdAt: now });
    }
    setStatusFilter("all");
    setIdeaCaptureOpen(false);
  }

  // ---- notes folder sync ----

  useEffect(() => {
    if (!db) return;
    let cancelled = false;
    getSavedFolder(db).then((h) => { if (!cancelled && h) setFolderHandle(h); });
    return () => { cancelled = true; };
  }, [db]);

  const runSync = useCallback(async (handleOverride, { force } = {}) => {
    const handle = handleOverride || folderHandle;
    if (!db || !handle || syncingRef.current) return;
    if (!settings.hasApiKey) { setSyncError("Add an API key for the selected AI provider in Settings to sync notes."); return; }
    syncingRef.current = true;
    setSyncing(true);
    setSyncError("");
    let leased = false;
    try {
      // Server-side lease: only one tab/window syncs at a time.
      const lease = await fetch("/api/sync/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: TAB_ID }),
      });
      if (lease.status === 409) throw { message: "A sync is already running in another tab or window. Try again in a minute." };
      if (!lease.ok) throw { message: "Could not start sync: the Task Tracker server did not respond." };
      leased = true;
      // Another tab may have synced since this one loaded; decide from current data.
      await db.reload();
      const renew = () => {
        fetch("/api/sync/acquire", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: TAB_ID }),
        }).catch(() => {});
      };
      const summary = await syncNotes({ store: db, handle, force: Boolean(force), onProgress: renew });
      setSyncSummary({ ...summary, at: Date.now() });
      const at = Date.now();
      setSettings((prev) => ({ ...prev, lastSyncAt: at }));
      saveSettings({ lastSyncAt: at }).catch((e) => console.error(e));
    } catch (err) {
      setSyncError((err && err.message) || "Sync failed.");
    } finally {
      if (leased) {
        fetch("/api/sync/release", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: TAB_ID }),
        }).catch(() => {});
      }
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [db, folderHandle, settings]);

  async function handleSyncNow() {
    if (!folderHandle) { setSettingsOpen(true); return; }
    await runSync();
  }

  async function handlePickFolder() {
    try {
      const h = await pickFolder(db);
      if (h) {
        setFolderHandle(h);
        setSyncError("");
      }
    } catch (err) {
      setSyncError((err && err.message) || "Could not open the folder.");
    }
  }

  async function handleSaveSettings(patch) {
    const next = await saveSettings(patch);
    setSettings(next);
  }

  let syncStatus = "";
  if (syncing) syncStatus = "Syncing notes…";
  else if (syncError) syncStatus = syncError;
  else if (syncSummary) {
    const s = syncSummary;
    syncStatus = "Last sync " + new Date(s.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) +
      ": " + s.created + " created, " + s.updated + " updated, " + s.skipped + " files unchanged" +
      (s.empty ? ", " + s.empty + " with no projects found" : "") +
      (s.failed.length ? ", " + s.failed.length + " failed (" + s.failed.map((f) => f.file + ": " + f.message).join("; ") + ")" : "") + "." +
      (s.created + s.updated === 0 && s.failed.length === 0 && s.skipped > 0
        ? " Nothing changed since the last sync (" + s.files.filter((f) => f.status === "unchanged").map((f) => f.name).join(", ") + ")."
        : "");
  } else if (settings.lastSyncAt) {
    syncStatus = "Last synced " + new Date(settings.lastSyncAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + ".";
  } else if (!folderHandle) {
    syncStatus = "No notes folder selected yet. Open Settings to choose one.";
  }

  async function handleSaveProject(input) {
    if (!db) throw new Error("db unavailable");
    if (input.id) {
      await db.doc("projects/" + input.id).update({
        name: input.name,
        description: input.description,
        typeId: input.typeId,
        priority: input.priority,
        assignees: input.assignees,
        assignedTo: "",
        status: input.status,
        dueDate: input.dueDate || "",
        updatedAt: Date.now(),
      });
    } else {
      // New projects go to the top of the manual order.
      const minOrder = projects.reduce((min, p) => Math.min(min, p.order ?? 0), 0);
      const id = genId();
      await db.doc("projects/" + id).set({
        name: input.name,
        description: input.description,
        typeId: input.typeId,
        priority: input.priority,
        assignees: input.assignees,
        status: input.status,
        dueDate: input.dueDate || "",
        order: minOrder - 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  async function handleDeleteProject(id) {
    if (!db) throw new Error("db unavailable");
    await db.doc("projects/" + id).delete();
  }

  async function handleAddNote(projectId, text, author) {
    if (!db) throw new Error("db unavailable");
    const id = genId();
    await db.doc("projects/" + projectId + "/notes/" + id).set({
      text,
      author: author || "",
      createdAt: Date.now(),
    });
  }

  async function handleEditNote(projectId, noteId, text) {
    if (!db) throw new Error("db unavailable");
    await db.doc("projects/" + projectId + "/notes/" + noteId).update({ text, editedAt: Date.now() });
  }

  async function handleDeleteNote(projectId, noteId) {
    if (!db) throw new Error("db unavailable");
    await db.doc("projects/" + projectId + "/notes/" + noteId).delete();
  }

  async function handleAddType(label) {
    if (!db) return;
    const id = genId();
    await db.doc("types/" + id).set({ label, isBuiltIn: false });
  }

  async function handleDeleteType(id) {
    if (isTypeInUse(id)) return { ok: false, reason: "This type is assigned to one or more projects." };
    if (!db) return { ok: false, reason: "Not connected." };
    await db.doc("types/" + id).delete();
    return { ok: true };
  }

  async function handleAddMember(name) {
    if (!db) throw new Error("db unavailable");
    await db.doc("members/" + genId()).set({ name, createdAt: Date.now() });
  }

  async function handleDeleteMember(member) {
    if (isMemberInUse(member.name)) return { ok: false, reason: "This member is assigned to one or more projects." };
    if (!db) return { ok: false, reason: "Not connected." };
    await db.doc("members/" + member.id).delete();
    return { ok: true };
  }

  // Reordering: recompute order for the full sorted list, write only changed docs.
  async function persistOrder(newOrderedIds) {
    if (!db) return;
    const byId = new Map(projects.map((p) => [p.id, p]));
    const writes = [];
    newOrderedIds.forEach((id, index) => {
      const p = byId.get(id);
      if (p && (p.order ?? 0) !== index) {
        writes.push(db.doc("projects/" + id).update({ order: index }));
      }
    });
    await Promise.all(writes);
  }

  async function handleReorder(activeId, overId) {
    if (activeId === overId) return;
    const sorted = [...sortedProjects];
    const oldIndex = sorted.findIndex((p) => p.id === activeId);
    const newIndex = sorted.findIndex((p) => p.id === overId);
    if (oldIndex === -1 || newIndex === -1) return;
    const [moved] = sorted.splice(oldIndex, 1);
    sorted.splice(newIndex, 0, moved);
    await persistOrder(sorted.map((p) => p.id));
  }

  async function handleReorderWithinStatus(activeId, overId) {
    await handleReorder(activeId, overId);
  }

  async function handleMoveToStatus(activeId, status, beforeId) {
    if (!db) return;
    const sorted = [...sortedProjects];
    const activeIndex = sorted.findIndex((p) => p.id === activeId);
    if (activeIndex === -1) return;
    const [moved] = sorted.splice(activeIndex, 1);
    const movedWithStatus = { ...moved, status };

    let insertAt = -1;
    if (beforeId) insertAt = sorted.findIndex((p) => p.id === beforeId);
    if (insertAt === -1) sorted.push(movedWithStatus);
    else sorted.splice(insertAt, 0, movedWithStatus);

    await db.doc("projects/" + activeId).update({ status, updatedAt: Date.now() });
    await persistOrder(sorted.map((p) => p.id));
  }

  const connectionState = db === null ? "unavailable" : db === undefined ? "loading" : "ready";
  const dataLoading = connectionState === "loading" || (db && (rawProjects === null || rawTypes === null || rawMembers === null));
  const showContent = !dataLoading && connectionState !== "unavailable";

  return (
    <div>
      <Header
        onAddProject={openAddForm}
        onManageMembers={() => setManageModal("members")}
        onManageTypes={() => setManageModal("types")}
        onDescribeIdea={() => setIdeaCaptureOpen(true)}
        showIdeaButton={true}
        ideaButtonDisabled={!settings.hasApiKey || connectionState !== "ready"}
        view={view}
        onViewChange={setView}
        connectionState={connectionState}
        onSyncNow={handleSyncNow}
        syncing={syncing}
        syncStatus={syncStatus}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {dataLoading && <p className="note">Loading&hellip;</p>}

      {!dataLoading && connectionState === "unavailable" && (
        <p className="empty">
          Can’t reach the Task Tracker server. Start it with npm run dev (API on port 3001).
        </p>
      )}

      {showContent && (
        <React.Fragment>
          <PipelineStrip
            projects={memberProjects}
            value={statusFilter}
            onChange={setStatusFilter}
            interactive={view !== "phases"}
          />

          <FilterBar
            view={view}
            sortMode={sortMode}
            onSortChange={setSortMode}
            members={members}
            memberFilter={activeMemberFilter}
            onMemberFilterChange={setMemberFilter}
            statusFilter={statusFilter}
            onStatusClear={() => setStatusFilter("all")}
            onClearAll={clearFilters}
            visibleCount={visibleProjects.length}
            totalCount={projects.length}
          />

          {view === "list" && (
            <ProjectListView
              reorderDisabled={reorderDisabled}
              sortMode={sortMode}
              projects={visibleProjects}
              typesById={typesById}
              onSelectProject={openEditForm}
              onReorder={handleReorder}
              filter={hasActiveFilter ? "active" : "all"}
              onAdd={openAddForm}
              onClearFilter={clearFilters}
            />
          )}
          {view === "tiles" && (
            <ProjectTilesView
              reorderDisabled={reorderDisabled}
              projects={visibleProjects}
              typesById={typesById}
              onSelectProject={openEditForm}
              onReorder={handleReorder}
              filter={hasActiveFilter ? "active" : "all"}
              onAdd={openAddForm}
              onClearFilter={clearFilters}
            />
          )}
          {view === "phases" && (
            <ProjectPhasesView
              projects={memberProjects}
              typesById={typesById}
              onSelectProject={openEditForm}
              onReorderWithinStatus={handleReorderWithinStatus}
              onMoveToStatus={handleMoveToStatus}
            />
          )}
        </React.Fragment>
      )}

      {manageModal === "members" && (
        <MembersModal
          members={members}
          isMemberInUse={isMemberInUse}
          onAddMember={handleAddMember}
          onDeleteMember={handleDeleteMember}
          onClose={() => setManageModal(null)}
        />
      )}

      {manageModal === "types" && (
        <TypesModal
          types={types}
          isTypeInUse={isTypeInUse}
          onAddType={handleAddType}
          onDeleteType={handleDeleteType}
          onClose={() => setManageModal(null)}
        />
      )}

      {ideaCaptureOpen && (
        <IdeaCapture
          onGenerate={handleGenerateIdea}
          onClose={() => setIdeaCaptureOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          folderName={folderHandle ? folderHandle.name : ""}
          folderSupported={folderApiSupported}
          onPickFolder={handlePickFolder}
          onSave={handleSaveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {isFormOpen && (
        <ProjectForm
          project={editingProject}
          draft={draftProject}
          types={types}
          members={members}
          onClose={closeForm}
          onSave={handleSaveProject}
          onDelete={handleDeleteProject}
          onManageMembers={() => setManageModal("members")}
          onManageTypes={() => setManageModal("types")}
          notes={notes}
          notesLoading={notesLoading}
          onAddNote={handleAddNote}
          onEditNote={handleEditNote}
          onDeleteNote={handleDeleteNote}
        />
      )}
    </div>
  );
}

export default App;
