/* rcloneweb — user-friendly cron schedule builder */
'use strict';

const CronBuilder = (() => {
  const DAYS = [
    { v: 0, n: 'Sun' }, { v: 1, n: 'Mon' }, { v: 2, n: 'Tue' }, { v: 3, n: 'Wed' },
    { v: 4, n: 'Thu' }, { v: 5, n: 'Fri' }, { v: 6, n: 'Sat' },
  ];

  let mode = 'daily'; // everyN | hourly | daily | weekly | monthly | custom
  let state = {
    nMinutes: 15,
    nHours: 6,
    time: '02:30',
    days: [1],       // weekly
    dom: 1,          // monthly
    custom: '*/15 * * * *',
  };

  function el(html) { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

  function describe(expr) {
    const [mi, h, dom, mon, dow] = expr.split(' ');
    if (expr === state.custom && mode === 'custom') return `Custom expression`;
    if (/^\*\/(\d+)$/.test(mi) && h === '*' ) return `Every ${mi.slice(2)} minutes`;
    if (mi.startsWith('0 ') && /^\*\/(\d+)$/.test(h)) return `Every ${h.slice(2)} hours (minute 0)`;
    const hm = `${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
    if (dom === '*' && dow === '*') return `Every day at ${hm}`;
    if (dow !== '*') {
      const names = dow.split(',').map((d) => DAYS[+d]?.n ?? d).join(', ');
      return `${names} at ${hm}`;
    }
    if (dom !== '*') return `Day ${dom} of every month at ${hm}`;
    return expr;
  }

  function build() {
    const [hh, mm] = state.time.split(':').map(Number);
    switch (mode) {
      case 'everyN': return `*/${state.nMinutes} * * * *`;
      case 'hourly': return `${mm} */${state.nHours} * * *`;
      case 'daily': return `${mm} ${hh} * * *`;
      case 'weekly': return `${mm} ${hh} * * ${(state.days.length ? [...state.days].sort().join(',') : '*')}`;
      case 'monthly': return `${mm} ${hh} ${state.dom} * *`;
      case 'custom': return state.custom;
    }
  }

  function render(container, onChange) {
    container.innerHTML = '';
    container.classList.add('cron-builder');

    // preset chips
    const chips = el(`<div class="cron-chips"></div>`);
    const presets = [
      ['everyN', '⏱ Every N min'], ['hourly', '🕒 Every N hrs'], ['daily', '📅 Daily'],
      ['weekly', '📆 Weekly'], ['monthly', '🗓 Monthly'], ['custom', '⚙ Advanced'],
    ];
    for (const [m, label] of presets) {
      const b = el(`<button type="button" class="chip ${m === mode ? 'active' : ''}">${label}</button>`);
      b.addEventListener('click', () => { mode = m; render(container, onChange); onChange(); });
      chips.appendChild(b);
    }
    container.appendChild(chips);

    const body = el(`<div class="cron-body"></div>`);

    const timeInput = () => `
      <label class="field">Time of day
        <input type="time" id="cron-time" value="${state.time}" />
      </label>`;

    if (mode === 'everyN') {
      body.innerHTML = `
        <label class="field">Run every
          <input type="number" id="cron-nmin" min="1" max="59" value="${state.nMinutes}" />
        </label><span class="unit">minutes</span>`;
      body.querySelector('#cron-nmin').addEventListener('input', (e) => { state.nMinutes = Math.max(1, Math.min(59, +e.target.value || 1)); onChange(); });
    } else if (mode === 'hourly') {
      body.innerHTML = `
        <label class="field">Run every
          <input type="number" id="cron-nhr" min="1" max="23" value="${state.nHours}" />
        </label><span class="unit">hours</span>
        <label class="field">at minute
          <input type="number" id="cron-min" min="0" max="59" value="${state.time.split(':')[1]}" />
        </label>`;
      body.querySelector('#cron-nhr').addEventListener('input', (e) => { state.nHours = Math.max(1, Math.min(23, +e.target.value || 1)); onChange(); });
      body.querySelector('#cron-min').addEventListener('input', (e) => {
        const [hh] = state.time.split(':');
        const mm = String(Math.min(59, Math.max(0, +e.target.value || 0))).padStart(2, '0');
        state.time = `${hh.padStart(2, '0')}:${mm}`;
        onChange();
      });
    } else if (mode === 'daily') {
      body.innerHTML = timeInput();
      body.querySelector('#cron-time').addEventListener('change', (e) => { state.time = e.target.value || '02:30'; onChange(); });
    } else if (mode === 'weekly') {
      body.innerHTML = `<div class="day-chips">${DAYS.map((d) =>
        `<button type="button" class="chip day ${state.days.includes(d.v) ? 'active' : ''}" data-day="${d.v}">${d.n}</button>`).join('')}
      </div>` + timeInput();
      body.querySelectorAll('.day').forEach((b) => b.addEventListener('click', () => {
        const v = +b.dataset.day;
        const i = state.days.indexOf(v);
        if (i >= 0) state.days.splice(i, 1); else state.days.push(v);
        b.classList.toggle('active');
        onChange();
      }));
      body.querySelector('#cron-time').addEventListener('change', (e) => { state.time = e.target.value || '02:30'; onChange(); });
    } else if (mode === 'monthly') {
      body.innerHTML = `
        <label class="field">Day of month
          <input type="number" id="cron-dom" min="1" max="28" value="${state.dom}" />
        </label>` + timeInput();
      body.querySelector('#cron-dom').addEventListener('input', (e) => { state.dom = Math.max(1, Math.min(28, +e.target.value || 1)); onChange(); });
      body.querySelector('#cron-time').addEventListener('change', (e) => { state.time = e.target.value || '02:30'; onChange(); });
    } else {
      body.innerHTML = `
        <label class="field grow">Cron expression (min hour dom month dow)
          <input id="cron-custom" value="${state.custom.replace(/"/g, '&quot;')}" spellcheck="false" />
        </label>`;
      body.querySelector('#cron-custom').addEventListener('input', (e) => { state.custom = e.target.value.trim() || '* * * * *'; onChange(); });
    }
    container.appendChild(body);

    const out = el(`<div class="cron-out">
      <div class="cron-summary"></div>
      <code class="cron-expr"></code>
    </div>`);
    container.appendChild(out);

    updateOutput(out, onChange);
  }

  function updateOutput(out, _onChange) {
    const expr = build();
    out.querySelector('.cron-summary').textContent = '📅 ' + describe(expr);
    out.querySelector('.cron-expr').textContent = expr;
  }

  function setCron(expr) {
    expr = String(expr||'').trim();
    if (!expr) return;
    // try to infer mode
    const parts = expr.split(/\s+/);
    if (parts.length===5) {
      const [mi,h,dom,mon,dow] = parts;
      if (/^\*\/\d+$/.test(mi) && h==='*' && dom==='*' && dow==='*') {
        mode='everyN'; state.nMinutes=parseInt(mi.slice(2),10)||15; return;
      }
      if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(h) && dom==='*' && dow==='*') {
        mode='hourly'; state.nHours=parseInt(h.slice(2),10)||6; state.time=`00:${String(parseInt(mi,10)).padStart(2,'0')}`; return;
      }
      if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom==='*' && dow==='*') {
        mode='daily'; state.time=`${String(parseInt(h,10)).padStart(2,'0')}:${String(parseInt(mi,10)).padStart(2,'0')}`; return;
      }
      if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom==='*' && dow!== '*') {
        mode='weekly'; state.time=`${String(parseInt(h,10)).padStart(2,'0')}:${String(parseInt(mi,10)).padStart(2,'0')}`; state.days=dow.split(',').map(v=>parseInt(v,10)).filter(n=>!isNaN(n)); return;
      }
      if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom!=='*' && dow==='*') {
        mode='monthly'; state.time=`${String(parseInt(h,10)).padStart(2,'0')}:${String(parseInt(mi,10)).padStart(2,'0')}`; state.dom=parseInt(dom,10)||1; return;
      }
    }
    mode='custom'; state.custom=expr;
  }

  // public: mount into a container; calls onChange(expr) whenever it changes
  function mount(container, onChange) {
    const wrappedChange = () => onChange(build());
    render(container, wrappedChange);
    onChange(build());
  }

  return { mount, setCron, getState: ()=>({mode, state}), build, describe };
})();
