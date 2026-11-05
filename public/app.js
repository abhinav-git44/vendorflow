// VendorFlow progressive enhancements. The app works without JavaScript.
(() => {
  'use strict';

  // Confirm dialogs for destructive forms: <form data-confirm="...">
  const dialog = document.getElementById('confirm-dialog');
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.confirm || form.dataset.confirmed) return;
    e.preventDefault();
    if (!dialog || typeof dialog.showModal !== 'function') { form.dataset.confirmed = '1'; form.submit(); return; }
    dialog.querySelector('.confirm-text').textContent = form.dataset.confirm;
    dialog.returnValue = '';
    dialog.showModal();
    dialog.addEventListener('close', function onClose() {
      dialog.removeEventListener('close', onClose);
      if (dialog.returnValue === 'ok') { form.dataset.confirmed = '1'; form.requestSubmit ? form.requestSubmit() : form.submit(); }
    });
  });

  // Prevent double submits.
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (e.defaultPrevented) return;
    setTimeout(() => form.querySelectorAll('button:not([type=button])').forEach((b) => { b.disabled = true; }), 0);
  });

  // Auto-submit selects (status changes, org switcher).
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches && el.matches('select[data-autosubmit]')) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
  });

  // Uppercase GSTIN/PAN as you type.
  document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('input[data-upper]')) e.target.value = e.target.value.toUpperCase(); });

  // Copy buttons.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) {
      const el = document.querySelector(btn.dataset.copy);
      try { await navigator.clipboard.writeText(el.textContent.trim()); btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); } catch { /* clipboard blocked */ }
    }
    if (e.target.closest('[data-toggle-sidebar]')) document.getElementById('sidebar').classList.toggle('open');
    if (e.target.closest('.toast-x')) e.target.closest('.toast').remove();
    // close other popovers
    document.querySelectorAll('details.pop[open], details.usermenu[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });

  // Toast auto-hide.
  const toast = document.querySelector('.toast[data-autohide]');
  if (toast && !toast.classList.contains('error')) setTimeout(() => toast.remove(), 5000);

  // Chart / data tooltips: any [data-tip].
  const tip = document.getElementById('tip');
  if (tip) {
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) { tip.hidden = true; return; }
      tip.textContent = t.dataset.tip;
      tip.hidden = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (tip.hidden) return;
      const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${x}px`;
      tip.style.top = `${e.clientY + 14}px`;
    });
  }

  // Scroll highlighted rows into view.
  const hl = document.querySelector('.highlight');
  if (hl) hl.scrollIntoView({ block: 'center' });
})();
