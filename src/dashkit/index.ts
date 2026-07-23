/**
 * dashkit — reusable engine for live project dashboards (and creative notes).
 *
 * This is the GIT-SoT source (Story 8.2): the note-report vault's dashboard renderer, extracted out of
 * the vault into `src/dashkit/`. It is a std slice — the SECOND Obsidian DOM edge (sibling of `cn`),
 * pinned to the note-report vault, CSS prefix `dk-` (AD-5/AD-6/AD-8). Story 8.3 builds the deploy bundle
 * that replaces the vault's frozen hand-off copy; until then the vault copy is frozen, not deleted.
 *
 * IDENTITY-FREE (D4/NFR3). The per-project vocabulary — the `PROJECTS` registry, its absolute sprint
 * paths, repo slugs, and the vault-relative `MIRROR_DIR` — is Pedro's data, NOT this renderer's. It stays
 * caller-local in the vault's `Scripts/dashkit.config.ts`; every function that needs it takes it as an
 * ARGUMENT (`project(registry, id)`, `projectsByGroup(registry)`, `storyTitle(key, titles)`,
 * `mirrorNotes(cfg, rows, mirrorDir, stamp)`). The renderer bakes in no consumer identity.
 *
 * VOCABULARY LIVES IN core (FR21/8.1). The status sets, parse, summary and predicates were promoted DOWN
 * into `core/sprint` — this edge IMPORTS them (`parseSprint`/`summarize`/`isDone`/…, `SprintRow`/
 * `SprintSummary`) rather than re-declaring them. The 10-cell bar geometry is `core.bar` (12.2). HTML
 * escaping is `core.escapeHtml` (9.2).
 *
 * Keep helpers pure and side-effect-free. Never eval() user input. Never do destructive vault actions.
 */

import { bar, escapeHtml } from '../core';
import {
  isClosed,
  isDone,
  isOpsKey,
  isProg,
  isStoryKey,
  parseOps,
  parseSprint,
  parseStatusMap,
  type SprintRow,
  type SprintSummary,
  summarize,
} from '../core/sprint';

// Re-export the core vocabulary this edge consumes, so a note that loads the deployed bundle keeps the
// same call surface it had against the vault original (`dk.parseSprint`, `dk.summarize`, `dk.isDone`, …).
export {
  isClosed,
  isDone,
  isOpsKey,
  isProg,
  isStoryKey,
  parseOps,
  parseSprint,
  parseStatusMap,
  type SprintRow,
  type SprintSummary,
  summarize,
};

// ── relationship model — a card is a BMAD project (has a sprint file); everything else is a relation:
//   group     → cluster label for the portfolio (e.g. "std ecosystem", "freelance")
//   related   → satellite repos (delivery taps, mirrors, forks) — host-aware links, NEVER cards
//   showcase  → non-repo deliverable artifacts (dirs/docs) — links, NEVER cards
export type Epic = { n: string; title: string; blurb: string; phase?: number; ship?: string };
export type RelatedRepo = {
  name: string;
  host: 'gh' | 'glab';
  role: string;
  url?: string;
  story?: string;
};
export type ShowcaseItem = { name: string; path: string; doc?: string };
export type Project = {
  id: string;
  name: string;
  note: string;
  sprintPath: string;
  epics: Epic[];
  storyTitles: Record<string, string>;
  group?: string;
  related?: RelatedRepo[];
  showcase?: ShowcaseItem[];
  // Optional issue-tracker binding (powers fetchOpenIssues / issueBoard). `repo` is the
  // host path ("owner/name"); `host` defaults to "glab"; `issuesUrl` is the human board link.
  repo?: string;
  host?: 'gh' | 'glab';
  issuesUrl?: string;
};

// ── edge-local helpers over the sprint rows (D-5: stay in the edge — only dashkit + the vault's
//    note-update consume them, and both are pinned to one vault; the Rule-of-Three for a core promotion
//    is unmet). ──

export const epicRows = (rows: SprintRow[], n: string): SprintRow[] =>
  rows.filter((r) => r.key.startsWith(n + '-'));
/** `2-0a-direct-workers-ai-transport` → `2.0a`. The story segment keeps any lower-case letter suffix
 *  so it stays in lockstep with `isStoryKey` (G1 numeric half, closed 2026-07-24) — otherwise a row the
 *  filter now admits would render as its raw key. */
export const storyNum = (key: string): string => {
  const m = key.match(/^(\d+)-(\d+[a-z]*)-/) || key.match(/^(ops)-(\d+)-/);
  return m ? m[1] + '.' + m[2] : key;
};
export const icon = (status: string): string =>
  isDone(status) ? '✅' : isProg(status) ? '🟡' : isClosed(status) ? '↪️' : '⬜';

/** Find the next actionable story (first that's neither done nor closed/superseded), or null.
 *  Pass `epics` to honor EXECUTION order (the EPICS array order, which can differ from sprint-file/
 *  numeric order after a resequence): the first actionable story in the first not-yet-finished epic.
 *  Without `epics`, falls back to sprint-file order (back-compat for callers that don't pass it). */
export function nextStory(rows: SprintRow[], epics?: Epic[]): SprintRow | null {
  const actionable = (r: SprintRow): boolean => !isDone(r.status) && !isClosed(r.status);
  if (epics && epics.length) {
    for (const e of epics) {
      const hit = rows.find((r) => r.key.startsWith(e.n + '-') && actionable(r));
      if (hit) return hit;
    }
    return null;
  }
  return rows.find(actionable) ?? null;
}

/** Look up a project config by id in an injected registry (throws a clear error if unknown). */
export function project(registry: Record<string, Project>, id: string): Project {
  const p = registry[id];
  if (!p)
    throw new Error("Unknown project '" + id + "'. Known: " + Object.keys(registry).join(', '));
  return p;
}

/** Registered projects grouped by their `group` label, preserving registry order. */
export function projectsByGroup(
  registry: Record<string, Project>
): { group: string; ids: string[] }[] {
  const order: string[] = [];
  const byGroup: Record<string, string[]> = {};
  for (const id of Object.keys(registry)) {
    const g = registry[id].group ?? 'ungrouped';
    if (!(g in byGroup)) {
      byGroup[g] = [];
      order.push(g);
    }
    byGroup[g].push(id);
  }
  return order.map((g) => ({ group: g, ids: byGroup[g] }));
}

const HOST_LABEL: Record<string, string> = { gh: 'GitHub', glab: 'GitLab' };

/** Inline HTML badges for a project's satellite repos (delivery taps, mirrors). "" if none. */
export function relatedHtml(p: Project): string {
  if (!p.related || !p.related.length) return '';
  return p.related
    .map((r) => {
      const name = r.url ? '<a href="' + r.url + '">' + r.name + '</a>' : r.name;
      const host =
        ' <span style="font-size:0.78em;color:var(--text-faint)">' +
        (HOST_LABEL[r.host] || r.host) +
        '</span>';
      const story = r.story
        ? ' <span style="color:var(--text-faint)">via ' + r.story + '</span>'
        : '';
      return (
        '<span style="display:inline-block;margin:3px 8px 0 0;padding:2px 8px;border-radius:6px;' +
        'background:var(--background-secondary);border:1px solid var(--background-modifier-border);font-size:0.85em">' +
        '📦 ' +
        r.role +
        ' → ' +
        name +
        host +
        story +
        '</span>'
      );
    })
    .join('');
}

/** Inline HTML for a project's non-repo showcase artifacts (dirs/docs). "" if none. */
export function showcaseHtml(p: Project): string {
  if (!p.showcase || !p.showcase.length) return '';
  return p.showcase
    .map(
      (s) =>
        '🧩 <strong>' +
        s.name +
        '</strong> <code>' +
        s.path +
        '</code>' +
        (s.doc ? ' <span style="color:var(--text-faint)">→ ' + s.doc + '</span>' : '')
    )
    .join('<br>');
}

/** Resolve a story's human title; pass a project's `storyTitles` (caller-local — no registry default). */
export function storyTitle(key: string, titles: Record<string, string>): string {
  const pre = (key.match(/^([a-z0-9]+-[a-z0-9]+)-/i) || [])[1];
  return (
    titles[pre] ||
    key
      .replace(/^[a-z0-9]+-[a-z0-9]+-/i, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// ── BMAD → project-manager mirror emitter (Phase 2) ─────────────────────────
// PURE: turns a project's sprint rows into project-manager v1.6.3-compatible note specs.
// Schema read straight from the plugin's main.js (pm-project / pm-task frontmatter + Jf/Qf
// field readers). The mirror is READ-ONLY: status flows sprint → mirror, NEVER back — so it
// is not a second source of truth (the repo's sprint-status.yaml stays canonical). The writer
// (the vault's Scripts/gen-mirror.ts) serializes these to <mirrorDir>/<id>/ and regen overwrites.

export type NoteSpec = { path: string; frontmatter: Record<string, unknown>; body: string };

// PM board columns → a stable project-manager status string (PM groups its board by this string).
// D-8: DERIVED from core/sprint's promoted sets, not a second enumeration of them. `isDone` (SPRINT_DONE)
// drives the `done` column; the three remaining columns below are board-presentation LABELS (the token
// is its own column), and everything else — `ready-for-dev` and every SPRINT_CLOSED member alike —
// collapses to `todo`. So the missing-`wont-do` class 8.1 warned about cannot recur here: closed states
// are uniform `todo` by fall-through, never re-listed. Output is byte-identical to the vault's old
// PM_STATUS table on every token (proven by the pmStatus-agrees-with-core test) — not a third delta.
const PM_COLUMN: Record<string, string> = {
  'in-progress': 'in-progress',
  review: 'review',
  backlog: 'backlog',
};
export const pmStatus = (s: string): string => (isDone(s) ? 'done' : (PM_COLUMN[s] ?? 'todo'));

const MIRROR_BANNER =
  '> [!warning] AUTO-GENERATED — do not edit\n' +
  "> Read-only mirror of the repo's `sprint-status.yaml` (status flows sprint → here, never back).\n" +
  '> Regenerate: `bun Scripts/gen-mirror.ts <project>`. Status SoT lives in the repo, not the vault.';

const mirrorTaskId = (id: string, key: string): string => `${id}-${key}`;

/** PURE: the project + task NoteSpecs for one registered project's sprint rows. `mirrorDir` is the
 *  vault-relative mirror root (caller-local, D4 — never baked in). `stamp` is injected (never Date.now()
 *  at module scope) so output is deterministic for tests. */
export function mirrorNotes(
  cfg: Project,
  rows: SprintRow[],
  mirrorDir: string,
  stamp = '1970-01-01T00:00:00.000Z'
): { project: NoteSpec; tasks: NoteSpec[] } {
  const dir = `${mirrorDir}/${cfg.id}`;
  const tasks: NoteSpec[] = rows.map((r) => {
    const epicN = (r.key.match(/^(\d+)-/) || [])[1] ?? '';
    const title = `${storyNum(r.key)} · ${storyTitle(r.key, cfg.storyTitles)}`;
    return {
      path: `${dir}/${cfg.id}-${r.key}.md`,
      frontmatter: {
        'pm-task': true,
        id: mirrorTaskId(cfg.id, r.key),
        title,
        status: pmStatus(r.status),
        type: 'task',
        progress: isDone(r.status) ? 100 : isProg(r.status) ? 50 : 0,
        tags: [cfg.id, `epic-${epicN}`],
        generated: true,
        source: cfg.sprintPath,
        'source-key': r.key,
        'source-status': r.status,
      },
      body: `${MIRROR_BANNER}\n\n# ${title}\n\nEpic ${epicN} · ${cfg.name} · sprint status: \`${r.status}\`\n`,
    };
  });
  const project: NoteSpec = {
    path: `${dir}/_${cfg.id}.md`,
    frontmatter: {
      'pm-project': true,
      id: cfg.id,
      title: `${cfg.name} (BMAD mirror)`,
      description: `Read-only project-manager mirror of ${cfg.name}'s BMAD sprint — ${rows.length} stories.`,
      taskIds: rows.map((r) => mirrorTaskId(cfg.id, r.key)),
      color: '#8b72be',
      icon: '📋',
      generated: true,
      source: cfg.sprintPath,
      createdAt: stamp,
    },
    body: `${MIRROR_BANNER}\n\n# ${cfg.name} — BMAD mirror\n\nGenerated board over \`${cfg.sprintPath}\`.\n`,
  };
  return { project, tasks };
}

// ── presentation (Obsidian CSS tokens only — never hard-coded hex) ──────────

export const ACCENT = 'hsl(var(--accent-h) var(--accent-s) var(--accent-l))';

/** A 10-wide Unicode progress bar as colored HTML (green when complete, accent when partial). Geometry
 *  comes from `core.bar` (12.2), clamped to [0, width] — so `done > total` yields a FULL track instead of
 *  the old `'░'.repeat(10 - fill)` RangeError (AC4, the sanctioned clamp delta; not to be restored). The
 *  fill glyphs are recounted from the returned track so the vault's two-tone rendering (colored fill +
 *  faint remainder) is byte-preserved for every in-range input; the green-when-complete rule is
 *  `done === total`, UNCHANGED from the vault, so no in-range color moves. */
export function barHtml(done: number, total: number): string {
  const track = bar(done, total, { width: 10, brackets: false });
  const fill = (track.match(/█/g) || []).length;
  const full =
    total > 0 && done === total ? 'var(--color-green)' : fill > 0 ? ACCENT : 'var(--text-faint)';
  const mono = 'font-family:var(--font-monospace);letter-spacing:2px;';
  return (
    '<span style="' +
    mono +
    'color:' +
    full +
    '">' +
    '█'.repeat(fill) +
    '</span>' +
    '<span style="' +
    mono +
    'color:var(--text-faint)">' +
    '░'.repeat(10 - fill) +
    '</span>'
  );
}

// ── DOM helpers (standard DOM, not Obsidian's el.createDiv augmentation) ─────

function div(parent: HTMLElement, cls: string, text?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

/** Resolve the Dataview API from the running app, or null if unavailable. */
export function getDataview(app: any): any | null {
  return app?.plugins?.plugins?.dataview?.api ?? null;
}

export type DkStat = {
  label: string;
  value: string | number;
  hint?: string;
  tone?: string;
  accent?: boolean;
};

/** Render one stat card. `tone` is a `--color-*-rgb` var name; `accent` uses the theme accent. */
export function statCard(container: HTMLElement, s: DkStat): HTMLElement {
  const card = div(container, 'dk-stat-card');
  if (s.accent) {
    card.style.background = 'hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.12)';
    card.style.border = '1px solid hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.35)';
  } else if (s.tone) {
    card.style.background = 'rgba(var(' + s.tone + '), 0.12)';
    card.style.border = '1px solid rgba(var(' + s.tone + '), 0.32)';
  }
  const v = div(card, 'dk-stat-value', String(s.value));
  v.style.color = s.accent ? ACCENT : s.tone ? 'rgb(var(' + s.tone + '))' : 'var(--text-normal)';
  div(card, 'dk-stat-label', s.label);
  if (s.hint) div(card, 'dk-stat-hint', s.hint);
  return card;
}

/** Render a horizontal grid of stat cards. */
export function statGrid(container: HTMLElement, stats: DkStat[]): HTMLElement {
  const grid = div(container, 'dk-stat-grid');
  for (const s of stats) statCard(grid, s);
  return grid;
}

/** Inject the shared `dk-` base styles once (id-guarded so re-renders don't duplicate). */
export function ensureStyles(id = 'dk-base-styles'): void {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    .dk-stat-grid { display: flex; flex-wrap: wrap; gap: 10px; margin: 0.4em 0 0.2em; }
    .dk-stat-card { flex: 1 1 110px; padding: 14px 16px; border-radius: 10px; text-align: center;
      background: var(--background-secondary); border: 1px solid var(--background-modifier-border); }
    .dk-stat-value { font-size: 1.9em; font-weight: 700; line-height: 1.1; }
    .dk-stat-label { margin-top: 4px; font-size: 0.72em; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--text-muted); }
    .dk-stat-hint { margin-top: 0.2rem; font-size: 0.72em; color: var(--text-faint); }
    .dk-stories { color: var(--text-muted); line-height: 1.7; }
    .dk-status { font-size: 0.82em; min-height: 1.1rem; color: var(--text-muted); margin-top: 0.4rem; }
    .dk-gl-issues .dk-gl-head { margin: 0 0 0.55rem; color: var(--text-muted); font-size: 0.85rem; }
    .dk-gl-issues details { margin: 0.4rem 0; padding: 0.5rem 0.9rem; border-radius: 10px; background: var(--background-secondary-alt); }
    .dk-gl-issues summary { cursor: pointer; font-weight: 700; }
    .dk-gl-issues pre.dk-brief { white-space: pre-wrap; font-size: 0.78rem; padding: 0.75rem; border-radius: 8px;
      background: var(--background-primary-alt); border: 1px solid var(--background-modifier-border); overflow-x: auto; }
    .dk-gl-issues .dk-gl-iid { font-family: var(--font-monospace); color: var(--text-accent); font-weight: 700; }
    .dk-gl-issues .dk-gl-label { display: inline-block; font-size: 0.68rem; padding: 0.05rem 0.45rem; border-radius: 999px;
      background: var(--background-modifier-border); color: var(--text-muted); margin-left: 0.25rem; }
    .dk-gl-issues .dk-gl-meta { color: var(--text-faint); font-size: 0.78rem; margin: 0.2rem 0 0.45rem; }
    .dk-gl-issues button.dk-gl-copy { cursor: pointer; font-size: 0.78rem; padding: 0.25rem 0.7rem; border-radius: 8px;
      border: 1px solid var(--background-modifier-border); background: var(--interactive-accent); color: var(--text-on-accent); }
    .dk-gl-issues button.dk-gl-copy:hover { filter: brightness(1.12); }
    .dk-gl-issues button.dk-gl-copyall { cursor: pointer; font-size: 0.8rem; padding: 0.3rem 0.85rem; border-radius: 8px;
      border: 1px solid var(--background-modifier-border); background: var(--background-secondary-alt); color: var(--text-normal); margin: 0.2rem 0 0.7rem; }
    .dk-gl-issues button.dk-gl-copyall:hover { filter: brightness(1.08); }
  `;
  document.head.appendChild(style);
}

// ── Live issue board (GitLab/GitHub) ────────────────────────────────────────
// Reusable across any project that sets `repo`/`host` in its registry entry. The
// fetch shells out to the host CLI (auth rides its own keyring — no token in a
// note); the render returns a self-styled DOM element with per-issue copy buttons.

// node globals — provided by CodeScript Toolkit (Obsidian desktop) and by bun at
// runtime; declared here so the vault needs no @types/node. Desktop-only (callers guard for mobile).
//
// ⚠ `require` is deliberately NOT declared. Node builtins are loaded through `nodeBuiltin()` instead,
// because a statically-visible `require('node:…')` is rewritten to an empty stub by the browser-target
// deploy bundler (see `nodeBuiltin`). Leaving the declaration out means re-introducing a bare
// `require(...)` here is a COMPILE error, not a silent runtime stub in the deployed artifact only.
declare const process: { env: Record<string, string | undefined> };

export type GlIssue = {
  iid: number;
  title: string;
  labels: string[];
  body: string;
  url: string;
  createdAt: string;
};

/** Flash a button to `done` text on click after copying `text`, then revert to `idle`. */
function copyButton(label: string, text: string, doneLabel: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = doneLabel;
    } catch (e) {
      btn.textContent = '⚠️ Clipboard blocked';
    }
    setTimeout(() => {
      btn.textContent = label;
    }, 2000);
  });
  return btn;
}

/** Fetch open issues for a project via its host CLI (`glab`/`gh`). Desktop-only
 *  (needs node:child_process + the CLI on PATH). Throws if `repo` is unset or the
 *  CLI is unreachable — callers should try/catch and fall back to a board link. */
export function fetchOpenIssues(cfg: Project, limit = 20): GlIssue[] {
  if (!cfg.repo) throw new Error("project '" + cfg.id + "' has no `repo` configured");
  // Runtime-resolved, never a literal require — see `nodeBuiltin`. A static one is stubbed by the
  // browser-target bundler and `cp.execSync` comes back undefined in the DEPLOYED artifact only.
  const cp = nodeBuiltin('node:child_process');
  // Obsidian's Electron GUI doesn't inherit the shell PATH — prepend the usual bins.
  const env = Object.assign({}, process.env, {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
  });
  const run = (cmd: string): string => cp.execSync(cmd, { encoding: 'utf8', env, timeout: 20000 });
  const host = cfg.host ?? 'glab';
  if (host === 'gh') {
    const arr = JSON.parse(
      run(
        'gh issue list -R ' +
          cfg.repo +
          ' --state open -L ' +
          limit +
          ' --json number,title,labels,body,url,createdAt'
      )
    );
    return arr.map((it: any) => ({
      iid: it.number,
      title: it.title,
      labels: (it.labels || []).map((l: any) => l.name),
      body: (it.body || '').trim(),
      url: it.url,
      createdAt: it.createdAt,
    }));
  }
  const enc = encodeURIComponent(cfg.repo);
  const arr = JSON.parse(
    run(
      'glab api "projects/' +
        enc +
        '/issues?state=opened&order_by=created_at&sort=desc&per_page=' +
        limit +
        '"'
    )
  );
  return arr.map((it: any) => ({
    iid: it.iid,
    title: it.title,
    labels: it.labels || [],
    body: (it.description || '').trim(),
    url: it.web_url,
    createdAt: it.created_at,
  }));
}

/** Render an open-issue board: collapsible per-issue cards with full body + copy
 *  buttons (per-issue and copy-all). Self-styled via ensureStyles() so it needs no
 *  surrounding wrapper or note CSS. */
export function issueBoard(
  issues: GlIssue[],
  opts: { boardUrl?: string; host?: 'gh' | 'glab' } = {}
): HTMLElement {
  ensureStyles();
  const host = document.createElement('div');
  host.className = 'dk-gl-issues';

  const src = opts.host === 'gh' ? 'gh' : 'glab api';
  const head = div(host, 'dk-gl-head');
  head.innerHTML =
    '<strong>' +
    issues.length +
    ' open issue' +
    (issues.length === 1 ? '' : 's') +
    '</strong> · live from <code>' +
    src +
    '</code>' +
    (opts.boardUrl ? ' · <a href="' + opts.boardUrl + '">board ↗</a>' : '');

  if (!issues.length) {
    div(host, 'dk-gl-meta', '🎉 No open issues.');
    return host;
  }

  const bodyOf = (it: GlIssue): string => it.body || '(no description)';
  const allText = issues
    .map((it) => '## #' + it.iid + ' — ' + it.title + '\n' + it.url + '\n\n' + bodyOf(it))
    .join('\n\n---\n\n');
  const copyAll = copyButton(
    '📋 Copy all ' + issues.length + ' issue bodies',
    allText,
    '✅ Copied all ' + issues.length
  );
  copyAll.className = 'dk-gl-copyall';
  host.appendChild(copyAll);

  for (const it of issues) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    const labels = (it.labels || [])
      .map((l) => '<span class="dk-gl-label">' + escapeHtml(l) + '</span>')
      .join('');
    sum.innerHTML =
      '<span class="dk-gl-iid">#' + it.iid + '</span> ' + escapeHtml(it.title) + ' ' + labels;
    det.appendChild(sum);

    const meta = div(det, 'dk-gl-meta');
    meta.innerHTML =
      'created ' +
      new Date(it.createdAt).toLocaleDateString() +
      ' · <a href="' +
      it.url +
      '">open ↗</a>';

    const pre = document.createElement('pre');
    pre.className = 'dk-brief';
    pre.textContent = bodyOf(it);
    det.appendChild(pre);

    const btn = copyButton('📋 Copy body', bodyOf(it), '✅ Copied #' + it.iid);
    btn.className = 'dk-gl-copy';
    det.appendChild(btn);

    host.appendChild(det);
  }
  return host;
}

// ── Session list + command deck (loom sessions list) ─────────────────────────
// DOM renderers for the loom-sessions-list creative note. IMPORT-FREE of sessionkit — dashkit is a std
// slice candidate and a slice must never depend on a non-slice (AD-8), so the note passes sessionkit's
// parsed rows + pure command builders IN as arguments. `runShell` is a generic desktop shell-out (any
// `--json` CLI, reused beyond loom); the table/deck are self-styled via ensureSessionStyles().

/**
 * Load a node builtin at RUNTIME, opaquely to the bundler.
 *
 * ⚠ NEVER write a literal `require('node:child_process')` in this file. `dashkit deploy` builds with
 * `target:"browser"`, and the bundler rewrites any statically-visible `require()` of a node builtin into
 * an EMPTY-MODULE STUB — the emitted artifact became `const cp = (() => ({}))`, so `cp.execSync` was
 * `undefined` and every shell-out died with "cp.execSync is not a function". That silently killed
 * `runShell` (all three live panels of the loom-sessions note) and `fetchOpenIssues` (the issue boards)
 * in the deployed bundle only — the source and its tests were fine, which is why it went unnoticed.
 *
 * Two runtimes, two different escape hatches, neither one sufficient alone:
 *   - Obsidian's Electron renderer exposes `require` as a GLOBAL (`process.getBuiltinModule` may be
 *     absent on its bundled Node).
 *   - bare bun (the deploy pipeline's own smoke test) has NO `globalThis.require`, but does have
 *     `process.getBuiltinModule`.
 * `inject` is the caller's escape hatch if a future host has neither.
 */
function nodeBuiltin(id: string, inject?: (id: string) => unknown): any {
  if (typeof inject === 'function') return inject(id);
  const globalRequire = (globalThis as any).require;
  if (typeof globalRequire === 'function') return globalRequire(id);
  const getBuiltin = (globalThis as any).process?.getBuiltinModule;
  if (typeof getBuiltin === 'function') return getBuiltin.call((globalThis as any).process, id);
  throw new Error(
    'desktop only — no node runtime (no globalThis.require, no process.getBuiltinModule): ' + id,
  );
}

/** Run a shell command, return raw stdout. Desktop-only (node:child_process + PATH). Throws on failure or
 *  an absent node runtime → callers guard + fall back (mobile). PATH is prepended because Obsidian's
 *  Electron GUI doesn't inherit the login shell PATH (same hazard fetchOpenIssues handles).
 *  `opts.require` injects a module loader for hosts exposing neither standard hatch (see `nodeBuiltin`). */
export function runShell(
  cmd: string,
  opts: { timeout?: number; require?: (id: string) => unknown } = {},
): string {
  if (typeof process === 'undefined') throw new Error('desktop only — no node runtime (mobile)');
  const cp = nodeBuiltin('node:child_process', opts.require);
  if (typeof cp?.execSync !== 'function')
    throw new Error('node:child_process resolved without execSync — bundler stubbed the builtin');
  const home = process.env.HOME || '';
  const env = Object.assign({}, process.env, {
    PATH: '/opt/homebrew/bin:/usr/local/bin:' + home + '/.bun/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
  });
  return cp.execSync(cmd, { encoding: 'utf8', env, timeout: opts.timeout ?? 20000 });
}

/** Collapse a leading $HOME to `~` for display (portable; no-op if HOME is unset or absent). */
export function collapseHome(p: string): string {
  const home = (typeof process !== 'undefined' && process.env && process.env.HOME) || '';
  return home && typeof p === 'string' && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

const relTime = (iso: string): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
};

/** Inject the session-table + command-deck styles once (id-guarded — sibling of ensureStyles). */
export function ensureSessionStyles(id = 'dk-session-styles'): void {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    .dk-sess-table { width: 100%; border-collapse: collapse; font-size: 0.86em; margin: 0.3em 0 0.2em; }
    .dk-sess-table th { text-align: left; font-size: 0.72em; letter-spacing: 0.05em; text-transform: uppercase;
      color: var(--text-muted); padding: 4px 10px; border-bottom: 1px solid var(--background-modifier-border); }
    .dk-sess-table td { padding: 6px 10px; border-bottom: 1px solid var(--background-modifier-border-hover); vertical-align: top; }
    .dk-sess-table tr:hover td { background: var(--background-secondary); }
    .dk-sess-name { font-weight: 600; color: var(--text-normal); }
    .dk-sess-none { color: var(--text-faint); }
    .dk-sess-id { font-family: var(--font-monospace); font-size: 0.9em; color: var(--text-accent);
      cursor: pointer; border-bottom: 1px dashed hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.5); }
    .dk-sess-id:hover { filter: brightness(1.2); }
    .dk-sess-count { font-family: var(--font-monospace); color: var(--text-muted); }
    .dk-deck { margin: 0.3em 0 0.6em; }
    .dk-deck-head { font-size: 0.85em; color: var(--text-muted); margin-bottom: 0.5rem; }
    .dk-deck-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 0.35rem 0; align-items: center; }
    .dk-deck-in { flex: 1 1 240px; padding: 7px 10px; border-radius: 8px; font-family: var(--font-monospace);
      font-size: 0.82em; background: var(--background-primary-alt); border: 1px solid var(--background-modifier-border); color: var(--text-normal); }
    .dk-chip { cursor: pointer; font-size: 0.82em; padding: 7px 12px; border-radius: 8px;
      border: 1px solid var(--background-modifier-border); background: var(--background-secondary-alt); color: var(--text-normal); }
    .dk-chip:hover { filter: brightness(1.1); border-color: hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.6); }
    .dk-dir-chip { cursor: pointer; font-size: 0.78em; padding: 4px 10px; border-radius: 999px; margin: 0 6px 6px 0;
      border: 1px solid var(--background-modifier-border); background: var(--background-secondary); color: var(--text-muted); }
    .dk-dir-chip:hover, .dk-dir-chip.dk-on { color: var(--text-on-accent); background: var(--interactive-accent); border-color: transparent; }
    .dk-deck-cmd { font-family: var(--font-monospace); font-size: 0.8em; color: var(--text-faint); margin-top: 0.35rem;
      padding: 6px 10px; border-radius: 8px; background: var(--background-primary-alt); word-break: break-all; }
  `;
  document.head.appendChild(style);
};

/**
 * One clickable `<td>` holding a session id. Clicking does BOTH: copies the FULL id to the clipboard
 * (this is the "I can't grab the id" fix — the cell shows a truncated `abcd1234…` for scannability, but
 * the click always copies the whole uuid) and fires `onPick(id)` to prefill the deck. A brief flash
 * confirms the copy. Reusable anywhere a session id is listed.
 */
function idCell(row: HTMLTableRowElement, id: string, onPick?: (id: string) => void): void {
  const td = document.createElement('td');
  if (!id) {
    const dash = document.createElement('span');
    dash.className = 'dk-sess-none';
    dash.textContent = '—';
    td.appendChild(dash);
    row.appendChild(td);
    return;
  }
  const span = document.createElement('span');
  span.className = 'dk-sess-id';
  const short = id.slice(0, 8) + '…';
  span.textContent = short;
  span.title = id + '  (click: copy full id + load into the deck)';
  span.addEventListener('click', async () => {
    if (onPick) onPick(id);
    try {
      await navigator.clipboard.writeText(id);
      span.textContent = '✓ id copied';
    } catch {
      span.textContent = '⚠ copy blocked';
    }
    setTimeout(() => {
      span.textContent = short;
    }, 1200);
  });
  td.appendChild(span);
  row.appendChild(td);
}

const cell = (row: HTMLTableRowElement, html: string, cls?: string): HTMLTableCellElement => {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.innerHTML = html;
  row.appendChild(td);
  return td;
};
const nameHtml = (v?: string): string =>
  v ? '<span class="dk-sess-name">' + escapeHtml(v) + '</span>' : '<span class="dk-sess-none">—</span>';

/**
 * Render a `loom sessions list` result as a `dk-` table. Accepts sessionkit's `SessionsList`
 * (`{mode:'projects'|'sessions', …}`) — passed in, never imported. Session rows clicking their id fire
 * `opts.onPick(id)` (wire it to a command deck). Self-styled; returns the table element.
 */
export function sessionsTable(
  list: any,
  opts: { onPick?: (id: string) => void } = {},
): HTMLElement {
  ensureSessionStyles();
  const table = document.createElement('table');
  table.className = 'dk-sess-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const heads =
    list?.mode === 'sessions'
      ? ['Name', 'Title', 'Msgs', 'Updated', 'Session id']
      : ['Project', 'Name (latest)', 'Title (latest)', 'Sess', 'Updated', 'Latest id'];
  for (const h of heads) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (list?.mode === 'sessions') {
    for (const s of list.sessions || []) {
      const tr = document.createElement('tr');
      cell(tr, nameHtml(s.name));
      cell(tr, s.title ? escapeHtml(s.title) : '<span class="dk-sess-none">—</span>');
      cell(tr, String(s.message_count ?? '·'), 'dk-sess-count');
      cell(tr, relTime(s.updated_at));
      idCell(tr, s.session_id || '', opts.onPick);
      tbody.appendChild(tr);
    }
  } else {
    for (const p of list?.projects || []) {
      const tr = document.createElement('tr');
      cell(tr, '<code>' + escapeHtml(collapseHome(p.real_path || '')) + '</code>');
      cell(tr, nameHtml(p.latest_name));
      cell(tr, p.latest_title ? escapeHtml(p.latest_title) : '<span class="dk-sess-none">—</span>');
      cell(tr, String(p.session_count ?? '·'), 'dk-sess-count');
      cell(tr, relTime(p.latest_mtime));
      idCell(tr, p.latest_session_id || '', opts.onPick);
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  return table;
}

/** One command-deck builder: a chip label + a pure `(id, name) => string` command builder. */
export type DeckBuilder = { label: string; fn: (id: string, name: string) => string };

/**
 * Render an interactive command deck: a session-id field + a name field + one copy-chip per builder.
 * The builders are pure `(id,name)=>string` fns (pass sessionkit.resumeCommand/renameCommand closures) —
 * dashkit stays import-free of sessionkit. Returns `{el, setId}` so a table row-pick can prefill the id.
 * A live preview line shows the first builder's current command. Clicking a chip copies to the clipboard.
 */
export function commandDeck(opts: {
  prefillId?: string;
  builders: DeckBuilder[];
  namePlaceholder?: string;
}): { el: HTMLElement; setId: (id: string) => void } {
  ensureSessionStyles();
  const el = document.createElement('div');
  el.className = 'dk-deck';

  div(el, 'dk-deck-head', '🛠️ Command deck — click a session id above to load it, edit freely, then copy a command.');

  const idIn = document.createElement('input');
  idIn.type = 'text';
  idIn.className = 'dk-deck-in';
  idIn.placeholder = 'session id (uuid)';
  idIn.value = opts.prefillId || '';

  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.className = 'dk-deck-in';
  nameIn.placeholder = opts.namePlaceholder || 'new name (for rename), e.g. "loom-sessions-16-17"';

  const inRow = div(el, 'dk-deck-row');
  inRow.appendChild(idIn);
  inRow.appendChild(nameIn);

  const preview = div(el, 'dk-deck-cmd');
  const refreshPreview = (): void => {
    const id = idIn.value.trim() || '<id>';
    const name = nameIn.value.trim() || '<name>';
    preview.textContent = opts.builders.length ? '$ ' + opts.builders[0].fn(id, name) : '';
  };
  idIn.addEventListener('input', refreshPreview);
  nameIn.addEventListener('input', refreshPreview);

  const btnRow = div(el, 'dk-deck-row');
  for (const b of opts.builders) {
    const btn = document.createElement('button');
    btn.className = 'dk-chip';
    btn.textContent = b.label;
    btn.addEventListener('click', async () => {
      const id = idIn.value.trim();
      if (!id) {
        btn.textContent = '⚠️ enter a session id';
        setTimeout(() => (btn.textContent = b.label), 1500);
        return;
      }
      const cmd = b.fn(id, nameIn.value.trim() || '<name>');
      try {
        await navigator.clipboard.writeText(cmd);
        btn.textContent = '✅ copied';
      } catch {
        btn.textContent = '⚠️ copy blocked';
      }
      setTimeout(() => (btn.textContent = b.label), 1600);
    });
    btnRow.appendChild(btn);
  }
  refreshPreview();

  return {
    el,
    setId: (id: string): void => {
      idIn.value = id;
      refreshPreview();
    },
  };
}
