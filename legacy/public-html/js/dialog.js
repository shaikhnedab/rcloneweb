/* rcloneweb — Material-style modal dialogs (no browser confirm/alert/prompt) */
'use strict';

const Dialog = (() => {
  let overlay;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'dlg-overlay dialog-generic';
    overlay.innerHTML = `
      <div class="dlg-card" role="dialog" aria-modal="true">
        <div class="dlg-icon" id="dlg-icon"></div>
        <h3 class="dlg-title" id="dlg-title"></h3>
        <p class="dlg-message" id="dlg-message"></p>
        <input class="dlg-input hidden" id="dlg-input" spellcheck="false" autocomplete="off" />
        <div class="dlg-actions">
          <button class="btn ghost" id="dlg-cancel">Cancel</button>
          <button class="btn filled" id="dlg-ok">OK</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function open({ title, message, icon = '❓', okText = 'OK', cancelText = 'Cancel', danger = false, input = null }) {
    const el = ensureOverlay();
    el.querySelector('#dlg-title').textContent = title;
    el.querySelector('#dlg-message').textContent = message || '';
    const iconEl = el.querySelector('#dlg-icon');
    iconEl.textContent = icon;
    iconEl.className = 'dlg-icon' + (danger ? ' danger' : '');
    const okBtn = el.querySelector('#dlg-ok');
    okBtn.textContent = okText;
    okBtn.className = 'btn filled' + (danger ? ' danger' : '');
    el.querySelector('#dlg-cancel').textContent = cancelText;
    const inputEl = el.querySelector('#dlg-input');
    inputEl.classList.toggle('hidden', !input);
    if (input) { inputEl.value = input.value || ''; inputEl.placeholder = input.placeholder || ''; }

    el.classList.add('open');
    setTimeout(() => (input ? inputEl : okBtn).focus(), 50);

    return new Promise((resolve) => {
      const done = (val) => {
        el.classList.remove('open');
        okBtn.onclick = cancelBtn.onclick = null;
        el.onkeydown = null;
        resolve(val);
      };
      const okBtn2 = okBtn, cancelBtn = el.querySelector('#dlg-cancel');
      cancelBtn.classList.toggle('hidden', !cancelText);
      okBtn2.onclick = () => done(input ? inputEl.value : true);
      cancelBtn.onclick = () => done(input ? null : false);
      const esc = (e) => {
        if (e.key === 'Escape') done(input ? null : false);
        if (e.key === 'Enter' && document.activeElement !== cancelBtn) done(input ? inputEl.value : true);
      };
      document.addEventListener('keydown', esc, { once: true });
    });
  }

  return {
    confirm: (title, message, opts = {}) =>
      open({ title, message, icon: '⚠️', okText: 'Confirm', ...opts }),
    confirmDanger: (title, message, okText = 'Delete') =>
      open({ title, message, icon: '🗑', okText, danger: true }),
    prompt: (title, message, value = '', placeholder = '') =>
      open({ title, message, icon: '✏️', okText: 'Save', input: { value, placeholder } }),
    alert: (title, message, icon = 'ℹ️') =>
      open({ title, message, icon, cancelText: '', okText: 'Close' }).then(() => true),
  };
})();
