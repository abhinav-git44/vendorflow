'use strict';
const { html, raw } = require('./html');
const D = require('../domain');
const { COMPLIANCE_LABELS } = require('../services/compliance');

// ---------- Icons (inline SVG, Lucide-style strokes) ----------
const ICONS = {
  overview: '<path d="M3 13h8V3H3zM13 21h8v-8h-8zM3 21h8v-6H3zM13 11h8V3h-8z"/>',
  vendors: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/>',
  documents: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  compliance: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  approvals: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  tasks: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  team: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  claude: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  check: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  minus: '<path d="M5 12h14"/>', dot: '<circle cx="12" cy="12" r="4"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>', external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};
const icon = (name, cls = '') => raw(`<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);

// ---------- Status badges: always icon + label, never colour alone ----------
const TONE_ICON = { good: 'check', warning: 'clock', serious: 'alert', critical: 'x', info: 'dot', neutral: 'minus' };
function badge(tone, label) { return html`<span class="badge ${tone}">${icon(TONE_ICON[tone] || 'dot')}${label}</span>`; }

const VENDOR_TONE = { draft: 'neutral', pending_onboarding: 'info', under_review: 'warning', approved: 'good', rejected: 'critical', suspended: 'serious', archived: 'neutral' };
const DOC_TONE = { missing: 'critical', awaiting_file: 'neutral', uploaded: 'warning', pending_verification: 'warning', verified: 'good', rejected: 'critical', expired: 'serious', pending: 'warning' };
const TASK_TONE = { todo: 'info', in_progress: 'warning', completed: 'good', blocked: 'critical', cancelled: 'neutral' };
const APPROVAL_TONE = { pending: 'warning', approved: 'good', rejected: 'critical', cancelled: 'neutral' };
const COMP_TONE = { compliant: 'good', partial: 'warning', non_compliant: 'critical', no_checklist: 'neutral' };
const PRIORITY_TONE = { low: 'neutral', medium: 'info', high: 'serious', critical: 'critical' };
const RISK_TONE = PRIORITY_TONE;

const vendorBadge = (s) => badge(VENDOR_TONE[s], D.VENDOR_STATUS_LABELS[s]);
const docBadge = (s) => badge(DOC_TONE[s] || 'neutral', s === 'pending' ? 'Pending verification' : D.DOC_STATUS_LABELS[s] || s);
const taskBadge = (s) => badge(TASK_TONE[s], D.TASK_STATUS_LABELS[s]);
const approvalBadge = (s) => badge(APPROVAL_TONE[s], s[0].toUpperCase() + s.slice(1));
const complianceBadge = (s) => badge(COMP_TONE[s], COMPLIANCE_LABELS[s]);
const priorityBadge = (p) => badge(PRIORITY_TONE[p], p[0].toUpperCase() + p.slice(1));
const riskBadge = (r) => badge(RISK_TONE[r], `${r[0].toUpperCase() + r.slice(1)} risk`);
const actorChip = (a) => (a.actor_type === 'mcp' ? html`<span class="chip claude">${icon('claude')}via Claude</span>` : a.actor_type === 'system' ? html`<span class="chip">Automated</span>` : '');

function progress(percent, status) {
  if (percent === null || percent === undefined) return html`<span class="muted small">No checklist</span>`;
  return html`<span class="progress" title="${percent}% of mandatory requirements verified"><span class="bar"><span class="fill ${COMP_TONE[status] || ''}" style="width:${percent}%"></span></span><span class="pct">${percent}%</span></span>`;
}

const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + 'T00:00:00Z' : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
function fmtRelative(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}
const fmtBytes = (n) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function emptyState(title, text, action) {
  return html`<div class="empty"><p class="empty-title">${title}</p>${text ? html`<p class="muted">${text}</p>` : ''}${action || ''}</div>`;
}

function pagination(baseUrl, query, page, pages) {
  if (pages <= 1) return '';
  const link = (p) => { const q = new URLSearchParams(query); q.set('page', p); return `${baseUrl}?${q}`; };
  return html`<nav class="pager" aria-label="Pagination">
    ${page > 1 ? html`<a class="btn sm" href="${link(page - 1)}">Previous</a>` : html`<span class="btn sm disabled">Previous</span>`}
    <span class="muted small">Page ${page} of ${pages}</span>
    ${page < pages ? html`<a class="btn sm" href="${link(page + 1)}">Next</a>` : html`<span class="btn sm disabled">Next</span>`}
  </nav>`;
}

const options = (list, selected, labels = {}) => list.map((v) => {
  const [value, label] = Array.isArray(v) ? v : [v, labels[v] || v];
  return html`<option value="${value}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${label}</option>`;
});

// ---------- Charts (server-rendered SVG; hover tooltips via data-tip) ----------
/** Single-series column chart; thin bars with 4px rounded tops anchored to the baseline. */
function columnChart(points, { height = 210, label = 'Count' } = {}) {
  const w = 380, padL = 24, padB = 24, padT = 14;
  const max = Math.max(1, ...points.map((p) => p.count));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const plotW = w - padL - 8, plotH = height - padB - padT;
  const slot = plotW / points.length;
  const bw = Math.min(30, slot * 0.55);
  const y = (v) => padT + plotH - (v / top) * plotH;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return raw(`<svg class="chart" viewBox="0 0 ${w} ${height}" role="img" aria-label="${label} by month">
    ${ticks.map((t) => `<line x1="${padL}" x2="${w - 8}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? 'axis' : 'grid'}"/><text x="${padL - 6}" y="${y(t) + 4}" class="tick" text-anchor="end">${t}</text>`).join('')}
    ${points.map((p, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    const h = Math.max(0, (p.count / top) * plotH);
    const r = Math.min(4, h);
    const path = h > 0 ? `M${x},${y(0)} V${y(0) - h + r} q0,-${r} ${r},-${r} H${x + bw - r} q${r},0 ${r},${r} V${y(0)} Z` : '';
    return `<g class="hit" data-tip="${p.label}: ${p.count} vendor${p.count === 1 ? '' : 's'}"><rect x="${padL + slot * i}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"/>${path ? `<path d="${path}" class="series-1"/>` : ''}
      ${p.count ? `<text x="${x + bw / 2}" y="${y(0) - h - 6}" class="val" text-anchor="middle">${p.count}</text>` : ''}</g>
      <text x="${x + bw / 2}" y="${height - 8}" class="tick" text-anchor="middle">${p.label}</text>`;
  }).join('')}
  </svg>`);
}
function niceStep(max) { if (max <= 5) return 1; if (max <= 10) return 2; if (max <= 25) return 5; if (max <= 50) return 10; return Math.ceil(max / 5 / 10) * 10; }

/** Horizontal 100% stacked bar for a part-to-whole status split, with legend + table. */
function stackedStatusBar(segments, { label }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) return emptyState('No data yet', null);
  let acc = 0;
  const w = 520, h = 28;
  const rects = segments.filter((s) => s.value > 0).map((s, idx, arr) => {
    const width = (s.value / total) * w;
    const x = acc;
    acc += width;
    const gap = idx < arr.length - 1 ? 2 : 0;
    return `<rect x="${x}" y="0" width="${Math.max(0, width - gap)}" height="${h}" rx="4" class="tone-${s.tone}" data-tip="${s.label}: ${s.value} (${Math.round((s.value / total) * 100)}%)"/>`;
  }).join('');
  return html`<div class="stack-chart">
    ${raw(`<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${label}">${rects}</svg>`)}
    <ul class="legend">${segments.map((s) => html`<li><span class="sw tone-${s.tone}"></span>${s.label}<strong>${s.value}</strong><span class="muted">${Math.round((s.value / total) * 100)}%</span></li>`)}</ul>
  </div>`;
}

/** Labelled horizontal bars (magnitude per category, single hue). */
function hbarChart(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return html`<ul class="hbars">${rows.map((r) => html`<li data-tip="${r.label}: ${r.value}">
    <span class="hb-label">${r.label}</span><span class="hb-track"><span class="hb-fill ${r.tone ? `tone-${r.tone}` : ''}" style="width:${(r.value / max) * 100}%"></span></span><span class="hb-val">${r.value}</span></li>`)}</ul>`;
}

// ---------- Page shells ----------
const NAV = [
  ['WORKSPACE', [['overview', 'Overview', '/'], ['vendors', 'Vendors', '/vendors'], ['documents', 'Documents', '/documents'], ['compliance', 'Compliance', '/compliance'], ['approvals', 'Approvals', '/approvals'], ['tasks', 'Tasks', '/tasks']]],
  ['INSIGHTS', [['reports', 'Reports', '/reports'], ['activity', 'Activity Logs', '/activity']]],
  ['ADMINISTRATION', [['team', 'Team Members', '/team'], ['settings', 'Settings', '/settings']]],
];

function head(title) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · VendorFlow</title><link rel="stylesheet" href="/static/app.css"><link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <script src="/static/app.js" defer></script></head>`;
}

function flashHtml(flash) {
  if (!flash) return '';
  return html`<div class="toast ${flash.type || 'success'}" role="status" data-autohide>${icon(flash.type === 'error' ? 'alert' : 'check')}<span>${flash.msg}</span><button type="button" class="toast-x" aria-label="Dismiss">${icon('x')}</button></div>`;
}

function shell({ title, session, active, body, flash, unread = 0, orgs = [], demoMode }) {
  const orgName = orgs.find((o) => o.id === session.orgId)?.name || '';
  return html`${head(title)}<body>
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <a href="/" class="brand"><span class="brand-dot">V</span>VendorFlow</a>
      ${orgs.length > 1 ? html`<form method="post" action="/switch-org" class="org-switch"><input type="hidden" name="csrf" value="${session.csrf}">
        <select name="org_id" data-autosubmit aria-label="Organisation">${orgs.map((o) => html`<option value="${o.id}" ${o.id === session.orgId ? 'selected' : ''}>${o.name}</option>`)}</select></form>`
    : html`<div class="org-name" title="${orgName}">${orgName}</div>`}
      <nav>${NAV.map(([group, items]) => html`<div class="nav-group">${group}</div>${items.map(([key, label, href]) => html`<a href="${href}" class="nav-item ${active === key ? 'active' : ''}">${icon(key)}${label}</a>`)}`)}</nav>
      <a href="/settings#claude" class="claude-card">${icon('claude')}<span><strong>Claude connected?</strong><br><span class="muted small">Set up the MCP connector</span></span></a>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="btn icon-only mobile-only" type="button" data-toggle-sidebar aria-label="Menu">${icon('menu')}</button>
        <form class="global-search" action="/vendors" method="get" role="search">${icon('search')}<input name="q" placeholder="Search vendors, GSTIN, contacts…" aria-label="Search vendors"></form>
        <div class="topbar-right">
          ${demoMode && session.user.is_demo ? html`<span class="chip demo" title="Records marked demo are illustrative only">Demo workspace</span>` : ''}
          <a href="/notifications" class="btn icon-only bell" aria-label="Notifications${unread ? ` (${unread} unread)` : ''}">${icon('bell')}${unread ? html`<span class="dot-count">${unread > 99 ? '99+' : unread}</span>` : ''}</a>
          <details class="usermenu"><summary><span class="avatar">${initials(session.user.name)}</span><span class="desktop-only">${session.user.name}</span></summary>
            <div class="menu"><div class="menu-head"><strong>${session.user.name}</strong><span class="muted small">${session.user.email}</span><span class="muted small">${D.ROLE_LABELS[session.role]}</span></div>
            <a href="/settings#profile">Profile & password</a><form method="post" action="/logout"><input type="hidden" name="csrf" value="${session.csrf}"><button class="linklike">Sign out</button></form></div>
          </details>
        </div>
      </header>
      <main class="content">${body}</main>
    </div>
  </div>
  ${flashHtml(flash)}
  <dialog id="confirm-dialog"><form method="dialog"><p class="confirm-text"></p><div class="row gap end"><button class="btn" value="cancel">Cancel</button><button class="btn danger" value="ok">Confirm</button></div></form></dialog>
  <div id="tip" role="tooltip" hidden></div>
  </body></html>`.toString();
}

function bare(title, body, flash) {
  return html`${head(title)}<body class="auth-body"><main class="auth-card">
    <a href="/" class="brand center"><span class="brand-dot">V</span>VendorFlow</a>${body}</main>${flashHtml(flash)}</body></html>`.toString();
}

const initials = (n) => String(n || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

function pageHeader(title, subtitle, actions) {
  return html`<div class="page-head"><div><h1>${title}</h1>${subtitle ? html`<p class="muted">${subtitle}</p>` : ''}</div>${actions ? html`<div class="row gap wrap">${actions}</div>` : ''}</div>`;
}

module.exports = {
  icon, badge, vendorBadge, docBadge, taskBadge, approvalBadge, complianceBadge, priorityBadge, riskBadge, actorChip, progress,
  fmtDate, fmtRelative, fmtBytes, emptyState, pagination, options, columnChart, stackedStatusBar, hbarChart, shell, bare, pageHeader, initials,
  COMP_TONE, DOC_TONE,
};
