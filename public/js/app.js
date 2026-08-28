/* rcloneweb — UI wiring (Material theme, auth, dialogs, cron, live previews) */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const state = {
    id: null, doc: null, cm: null, dirty: false,
    cronExpr: '0 2 * * *',
  };
  const fleetState = { list: [], editingId: null };
  let editorManuallyEdited = false;

  // ---------- theme ----------
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('rcloneweb_theme', t);
    const b = $('#btn-theme');
    if (b) b.textContent = t === 'dark' ? '☀️' : '🌙';
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, isErr = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', isErr);
    el.classList.toggle('success', !isErr);
    el.classList.add('show');
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.classList.add('hidden'), 200); }, 2600);
  }

  // ---------- config <-> form ----------
  function cfgFromForm() {
    return {
      name: $('#f-name').value.trim() || 'untitled',
      sources: $$('#sources-list .source-row').map((r) => ({
        path: r.querySelector('.src-path').value.trim(),
        dest: r.querySelector('.src-dest') ? r.querySelector('.src-dest').value.trim() : '',
        include: r.querySelector('.src-include').value.trim(),
        exclude: r.querySelector('.src-exclude').value.trim(),
      })).filter((s) => s.path),
      dest: {
        type: $('#f-dest-type').value,
        remoteName: $('#f-remote-name').value.trim() || 'my-backup-remote',
        remotePath: $('#f-remote-path').value.trim(),
        host: $('#f-host').value.trim(),
        port: $('#f-port').value.trim(),
        user: $('#f-user').value.trim(),
        sftpAuth: $('#f-sftp-auth').value,
        keyPath: $('#f-key-path').value.trim(),
        s3Provider: $('#f-s3-provider').value,
        s3Bucket: $('#f-s3-bucket').value.trim(),
        s3Region: $('#f-s3-region').value.trim(),
        s3Endpoint: $('#f-s3-endpoint').value.trim(),
      },
      secrets: {
        embed: $('#f-secrets-embed').checked,
        password: $('#f-secret-pass').value,
        s3AccessKey: $('#f-secret-ak').value.trim(),
        s3SecretKey: $('#f-secret-sk').value,
      },
      options: {
        mode: $('#f-mode').value,
        dryRun: $('#f-dry-run').checked,
        bandwidth: $('#f-bandwidth').value.trim(),
        retentionDays: parseInt($('#f-retention').value, 10) || 0,
        logfile: $('#f-logfile').value.trim(),
        extraFlags: $('#f-extra-flags').value.trim(),
      },
      webhook: {
        enabled: $('#f-wh-enabled').checked,
        onlyOnFail: $('#f-wh-onlyfail').checked,
        url: $('#f-wh-url').value.trim(),
        username: $('#f-wh-user').value.trim() || 'Backup Bot',
        avatarUrl: $('#f-wh-avatar').value.trim(),
        title: $('#f-wh-title').value,
        description: $('#f-wh-desc').value,
        colorOk: $('#f-wh-color-ok').value,
        colorFail: $('#f-wh-color-fail').value,
        logLines: parseInt($('#f-wh-loglines').value, 10) || 0,
        sendLogOnFail: $('#f-wh-sendlog-fail').checked,
        sendLogOnSuccess: $('#f-wh-sendlog-success').checked,
      },
    };
  }

  function formFromCfg(cfg) {
    cfg = Generator.normalize(cfg);
    $('#f-name').value = state.doc?.name || cfg.name;
    const list = $('#sources-list');
    list.innerHTML = '';
    for (const s of cfg.sources) addSourceRow(s);
    $('#f-dest-type').value = cfg.dest.type;
    $('#f-remote-name').value = cfg.dest.remoteName;
    $('#f-remote-path').value = cfg.dest.remotePath;
    $('#f-host').value = cfg.dest.host;
    $('#f-port').value = cfg.dest.port;
    $('#f-user').value = cfg.dest.user;
    $('#f-sftp-auth').value = cfg.dest.sftpAuth;
    $('#f-key-path').value = cfg.dest.keyPath;
    $('#f-s3-provider').value = cfg.dest.s3Provider;
    $('#f-s3-bucket').value = cfg.dest.s3Bucket;
    $('#f-s3-region').value = cfg.dest.s3Region;
    $('#f-s3-endpoint').value = cfg.dest.s3Endpoint;
    $('#f-secrets-embed').checked = cfg.secrets.embed;
    $('#f-secret-pass').value = cfg.secrets.password;
    $('#f-secret-ak').value = cfg.secrets.s3AccessKey;
    $('#f-secret-sk').value = cfg.secrets.s3SecretKey;
    $('#f-mode').value = cfg.options.mode;
    $('#f-dry-run').checked = cfg.options.dryRun;
    $('#f-bandwidth').value = cfg.options.bandwidth;
    $('#f-retention').value = cfg.options.retentionDays || '';
    $('#f-logfile').value = cfg.options.logfile;
    $('#f-extra-flags').value = cfg.options.extraFlags;
    $('#f-wh-enabled').checked = cfg.webhook.enabled;
    $('#f-wh-onlyfail').checked = cfg.webhook.onlyOnFail;
    $('#f-wh-url').value = cfg.webhook.url;
    $('#f-wh-user').value = cfg.webhook.username;
    $('#f-wh-avatar').value = cfg.webhook.avatarUrl;
    $('#f-wh-title').value = cfg.webhook.title;
    $('#f-wh-desc').value = cfg.webhook.description;
    $('#f-wh-color-ok').value = cfg.webhook.colorOk;
    $('#f-wh-color-fail').value = cfg.webhook.colorFail;
    $('#f-wh-loglines').value = cfg.webhook.logLines;
    $('#f-wh-sendlog-fail').checked = cfg.webhook.sendLogOnFail ?? true;
    $('#f-wh-sendlog-success').checked = cfg.webhook.sendLogOnSuccess ?? true;
    syncSecretFieldsVisibility();
    updateDestFields();
    // source VPS is stored on the doc, not in generator config
    if (state.doc && state.doc.sourceVpsId) {
      const sel=$('#f-source-vps'); if(sel) sel.value=state.doc.sourceVpsId;
      const rsel=$('#f-run-vps'); if(rsel) rsel.value=state.doc.sourceVpsId;
    }
  }

  function addSourceRow(s = { path: '/', dest: '/', include: '', exclude: '' }) {
    const row = document.createElement('div');
    row.className = 'source-row';
    row.innerHTML = `
      <div class="src-with-browse"><input class="src-path" placeholder="/" spellcheck="false" aria-label="Source path" /><button type="button" class="btn tonal small browse-btn" data-kind="src" title="Browse VPS" aria-label="Browse source folder">📂</button></div>
      <div class="src-with-browse"><input class="src-dest" placeholder="remote:/  (empty = /)" spellcheck="false" aria-label="Remote destination" /><button type="button" class="btn tonal small browse-btn" data-kind="dest" title="Browse remote" aria-label="Browse destination">☁️</button></div>
      <div class="src-with-browse"><input class="src-include" placeholder="include (e.g. *.jpg)" spellcheck="false" aria-label="Include pattern" /><button type="button" class="btn tonal small browse-btn" data-kind="include" title="Browse for include" aria-label="Browse to add include">📂</button></div>
      <div class="src-with-browse"><input class="src-exclude" placeholder="exclude (e.g. *.tmp)" spellcheck="false" aria-label="Exclude pattern" /><button type="button" class="btn tonal small browse-btn" data-kind="exclude" title="Browse for exclude" aria-label="Browse to add exclude">📂</button></div>
      <button type="button" class="rm-btn" title="Remove source" aria-label="Remove source">✕</button>`;
    row.querySelector('.src-path').value = s.path || '';
    row.querySelector('.src-dest').value = s.dest || '';
    row.querySelector('.src-include').value = s.include || '';
    row.querySelector('.src-exclude').value = s.exclude || '';
    row.querySelector('.rm-btn').addEventListener('click', () => { row.remove(); onChange(); });
    row.querySelectorAll('.browse-btn').forEach(btn=>{
      btn.addEventListener('click', ()=> openBrowseForRow(row, btn.dataset.kind));
    });
    $('#sources-list').appendChild(row);
  }

  function updateDestFields() {
    const type = $('#f-dest-type').value;
    $$('.dest-fields').forEach((el) => {
      const raw = el.dataset.for || '';
      const forTypes = raw.split(/\s+/).filter(Boolean);
      el.classList.toggle('hidden', !forTypes.includes(type));
    });
    const authRow = $('#sftp-auth-row');
    if (authRow) authRow.classList.toggle('hidden', type !== 'sftp');
    const keyField = $('.key-field');
    if (keyField) keyField.classList.toggle('hidden', $('#f-sftp-auth').value !== 'key' || type !== 'sftp');
  }

  function syncSecretFieldsVisibility() {
    const embed = $('#f-secrets-embed').checked;
    const type = $('#f-dest-type').value;
    const needPass = type === 'sftp' ? $('#f-sftp-auth').value === 'password' : type === 'ftp';
    $('#secrets-block').classList.toggle('hidden', !(needPass || type === 's3'));
    $('#secret-pass-wrap').classList.toggle('hidden', !needPass);
    $('#secret-s3-wrap').classList.toggle('hidden', type !== 's3');
    $$('#secrets-block .embed-warn').forEach((e) => e.classList.toggle('hidden', !embed));
  }

  // ---------- fleet (now via deep Fleet module) ----------
  async function loadFleet() {
    try {
      // deep module is the single seam — two adapters: fetch vs in-memory for tests
      const list = await Fleet.listVps();
      fleetState.list = list;
      renderFleet();
      populateSourceSelectors();
    } catch {}
  }
  function renderFleet() {
    const nav = $('#fleet-list');
    if (!nav) return;
    nav.innerHTML = '';
    if (!fleetState.list.length) { nav.innerHTML = '<p class="hint" style="padding:4px 8px">no VPS yet</p>'; return; }
    for (const v of fleetState.list) {
      const div = document.createElement('div');
      div.className = 'fleet-item';
      div.innerHTML = `<span class="fleet-dot ${v.lastSeen?'online':''}" aria-hidden="true"></span><span class="nm">${v.name}</span><span class="fleet-actions"><button class="fleet-btn edit" title="Edit VPS" aria-label="Edit ${v.name}">✎</button><button class="fleet-btn danger del" title="Delete VPS" aria-label="Delete ${v.name}">✕</button></span>`;
      div.querySelector('.edit').addEventListener('click', (e)=>{ e.stopPropagation(); openVpsDialog(v.id); });
      div.querySelector('.del').addEventListener('click', async (e)=>{
        e.stopPropagation();
        const ok = await Dialog.confirmDanger(`Delete VPS "${v.name}"?`, '', 'Delete');
        if (!ok) return;
        await fetch(`/api/fleet/${v.id}`, {method:'DELETE'});
        loadFleet();
        toast('VPS deleted');
      });
      nav.appendChild(div);
    }
  }
  function populateSourceSelectors() {
    const sel = $('#f-source-vps');
    const runSel = $('#f-run-vps');
    if (!sel) return;
    const cur = sel.value;
    const runCur = runSel ? runSel.value : '';
    const placeholder = '<option value="">— Select VPS —</option>';
    sel.innerHTML = fleetState.list.length ? placeholder : '<option value="">No VPS — add one in Fleet</option>';
    if (runSel) runSel.innerHTML = fleetState.list.length ? placeholder : '<option value="">No VPS</option>';
    for (const v of fleetState.list) {
      const opt = `<option value="${v.id}">${v.name} (${v.host})</option>`;
      sel.insertAdjacentHTML('beforeend', opt);
      if (runSel) runSel.insertAdjacentHTML('beforeend', opt);
    }
    if (cur) sel.value = cur;
    if (runCur && runSel) runSel.value = runCur;
    // sync from doc after populate
    if (state.doc && state.doc.sourceVpsId) {
      sel.value = state.doc.sourceVpsId;
      if (runSel) runSel.value = state.doc.sourceVpsId;
    } else if (!cur && fleetState.list.length===1) {
      // auto-select single VPS
      sel.value = fleetState.list[0].id;
      if (runSel) runSel.value = fleetState.list[0].id;
    }
  }
  function openVpsDialog(id=null) {
    fleetState.editingId = id;
    const v = id ? fleetState.list.find(x=>x.id===id) : null;
    $('#vps-dlg-title').textContent = v ? 'Edit VPS' : 'Add VPS';
    $('#vps-name').value = v ? v.name : '';
    $('#vps-host').value = v ? v.host : '';
    $('#vps-port').value = v ? v.port : 22;
    $('#vps-user').value = v ? v.user : 'root';
    $('#vps-auth').value = v ? v.auth : 'password';
    $('#vps-pass').value = '';
    $('#vps-key').value = v ? (v.keyPath||'') : '';
    $('#vps-test-result').textContent = '';
    syncVpsAuthFields();
    $('#vps-dialog').classList.add('open');
    setTimeout(()=>$('#vps-name').focus(),50);
  }
  function closeVpsDialog(){ $('#vps-dialog').classList.remove('open'); }
  function syncVpsAuthFields(){
    const auth = $('#vps-auth').value;
    $('#vps-pass-wrap').classList.toggle('hidden', auth==='key');
    $('#vps-key-wrap').classList.toggle('hidden', auth!=='key');
  }
  async function saveVps(){
    const payload = {
      name: $('#vps-name').value.trim(),
      host: $('#vps-host').value.trim(),
      port: parseInt($('#vps-port').value,10)||22,
      user: $('#vps-user').value.trim()||'root',
      auth: $('#vps-auth').value,
      keyPath: $('#vps-key').value.trim(),
    };
    const pass = $('#vps-pass').value;
    if (pass) payload.password = pass;
    if (!payload.name || !payload.host) return toast('Name and host required', true);
    const url = fleetState.editingId ? `/api/fleet/${fleetState.editingId}` : '/api/fleet';
    const method = fleetState.editingId ? 'PUT' : 'POST';
    const res = await fetch(url, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if (!res.ok) { const d=await res.json().catch(()=>({})); return toast(d.error||'Failed to save VPS', true); }
    closeVpsDialog();
    await loadFleet();
    toast(fleetState.editingId?'VPS updated':'VPS added');
  }
  async function testSourceVps(){
    const vpsId = $('#f-source-vps').value;
    if (!vpsId) return toast('Select a Source VPS first — add one in Fleet', true);
    const btn = $('#btn-test-source'); const orig=btn.textContent; btn.textContent='…'; btn.disabled=true;
    try {
      const res = await fetch(`/api/fleet/${vpsId}/test`, {method:'POST'});
      const d=await res.json();
      if (d.missing && d.missing.length) {
        await Dialog.alert('Missing packages on source', d.msg, '⚠️');
      }
      toast(d.msg|| (d.ok?'SSH OK':'Failed'), !d.ok);
    } catch(e){ toast('Test failed', true); }
    btn.textContent=orig; btn.disabled=false;
  }
  async function testDestConnection(){
    const type=$('#f-dest-type').value;
    const selFleet=$('#f-dest-fleet')?.value;
    // if a fleet destination is selected, test that fleet's stored creds instead of manual fields
    if (selFleet && selFleet!=='manual') {
      const btn=$('#btn-test-dest'); const orig=btn.textContent; btn.textContent='…'; btn.disabled=true;
      try {
        const res=await fetch(`/api/destinations/${selFleet}/test`,{method:'POST'});
        const d=await res.json();
        toast(d.msg|| (d.ok?'Connection OK':'Failed'), !d.ok);
      } catch(e){ toast('Test failed', true); }
      btn.textContent=orig; btn.disabled=false;
      return;
    }
    const body={type, host:$('#f-host').value.trim(), port:$('#f-port').value.trim(), user:$('#f-user').value.trim(), sftpAuth:$('#f-sftp-auth').value, keyPath:$('#f-key-path').value.trim(), bucket:$('#f-s3-bucket').value.trim(), region:$('#f-s3-region').value.trim(), endpoint:$('#f-s3-endpoint').value.trim(), provider:$('#f-s3-provider').value };
    if (type==='sftp' || type==='ftp') body.password = $('#f-secret-pass').value;
    if (type==='s3') { body.accessKey=$('#f-secret-ak').value.trim(); body.secretKey=$('#f-secret-sk').value; }
    const btn=$('#btn-test-dest'); const orig=btn.textContent; btn.textContent='…'; btn.disabled=true;
    try {
      const res=await fetch('/api/test/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const d=await res.json();
      toast(d.msg|| (d.ok?'Connection OK':'Failed'), !d.ok);
    } catch(e){ toast('Test failed', true); }
    btn.textContent=orig; btn.disabled=false;
  }

  // ---------- destination fleet (via Fleet module) ----------
  const destFleetState = { list:[], editingId:null };
  async function loadDestinations(){
    try{ const list = await Fleet.listDest(); destFleetState.list=list; renderDestList(); populateDestFleetSelect(); }catch{}
  }
  function renderDestList(){
    const nav=$('#dest-list'); if(!nav) return;
    nav.innerHTML='';
    if(!destFleetState.list.length){ nav.innerHTML='<p class="hint" style="padding:4px 8px">no destinations yet</p>'; return; }
    for(const d of destFleetState.list){
      const div=document.createElement('div');
      div.className='fleet-item';
      const icon = d.type==='s3' ? '🪣' : (d.type==='ftp' ? '📂' : '🔐');
      div.innerHTML=`<span class="fleet-dot ${d.lastSeen?'online':''}" aria-hidden="true"></span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${icon} ${d.name}</span><span class="fleet-actions"><button class="fleet-btn edit" title="Edit destination" aria-label="Edit ${d.name}">✎</button><button class="fleet-btn danger del" title="Delete destination" aria-label="Delete ${d.name}">✕</button></span>`;
      div.querySelector('.edit').addEventListener('click',e=>{e.stopPropagation(); openDestDialog(d.id);});
      div.querySelector('.del').addEventListener('click',async e=>{
        e.stopPropagation();
        const ok=await Dialog.confirmDanger(`Delete destination "${d.name}"?`,'','Delete');
        if(!ok) return;
        await fetch(`/api/destinations/${d.id}`,{method:'DELETE'});
        loadDestinations();
        toast('Destination deleted');
      });
      // click to select in builder
      div.addEventListener('click',()=>{
        const sel=$('#f-dest-fleet'); if(sel){ sel.value=d.id; onDestFleetChange(); toast(`Selected ${d.name}`); }
      });
      nav.appendChild(div);
    }
  }
  function populateDestFleetSelect(){
    const sel=$('#f-dest-fleet'); if(!sel) return;
    const cur=sel.value;
    sel.innerHTML='<option value="manual">Manual — custom</option>';
    for(const d of destFleetState.list){
      const label = `${d.name} — ${d.type.toUpperCase()} ${d.host||d.s3Bucket||''}`;
      sel.insertAdjacentHTML('beforeend', `<option value="${d.id}">${label}</option>`);
    }
    if(cur) sel.value=cur;
    if(state.doc && state.doc.destFleetId) sel.value=state.doc.destFleetId;
  }
  function applyDestFleetToForm(id){
    const fieldset = document.querySelector('#editor fieldset:nth-of-type(3)');
    if(!id || id==='manual'){
      // enable manual fields
      if(fieldset) fieldset.querySelectorAll('input, select').forEach(el=>el.disabled=false);
      $('#dest-fleet-hint').textContent='Choose a saved destination or fill manually';
      return;
    }
    const d=destFleetState.list.find(x=>x.id===id);
    if(!d) return;
    // need full decrypted? list has no secret, but for form we fill what we have; password stays blank (kept on server)
    $('#f-dest-type').value=d.type;
    $('#f-remote-name').value=d.remoteName||'my-backup-remote';
    $('#f-remote-path').value=d.remotePath||'/';
    $('#f-host').value=d.host||'';
    $('#f-port').value=d.port||'';
    $('#f-user').value=d.user||'';
    $('#f-sftp-auth').value=d.sftpAuth||'password';
    $('#f-s3-provider').value=d.s3Provider||'AWS';
    $('#f-s3-bucket').value=d.s3Bucket||'';
    $('#f-s3-region').value=d.s3Region||'';
    $('#f-s3-endpoint').value=d.s3Endpoint||'';
    updateDestFields(); syncSecretFieldsVisibility();
    // lock manual fields when using fleet (but keep embed toggle usable)
    if(fieldset) fieldset.querySelectorAll('input, select').forEach(el=>{
      if(el.id==='f-dest-fleet' || el.id==='f-secrets-embed') return;
      el.disabled=true;
    });
    $('#dest-fleet-hint').textContent=`Using saved destination "${d.name}" — password will be embedded from fleet (or use env var if unchecked) — switch to Manual to edit`;
  }
  function onDestFleetChange(){
    const id=$('#f-dest-fleet').value;
    applyDestFleetToForm(id);
    // Destination switched — recompute per-row dests from the newly selected fleet
    $$('#sources-list .source-row .src-dest').forEach(el => el.value = '');
    markDirty();
    refreshAll();
  }
  function openDestDialog(id=null){
    destFleetState.editingId=id;
    const d=id ? destFleetState.list.find(x=>x.id===id) : null;
    $('#dest-dlg-title').textContent = d ? 'Edit Destination' : 'Add Destination';
    $('#dest-name').value = d?d.name:'';
    $('#dest-type').value = d?d.type:'sftp';
    $('#dest-remote-name').value = d?d.remoteName:'my-backup-remote';
    $('#dest-remote-path').value = d?d.remotePath:'/';
    $('#dest-host').value = d?d.host:'';
    $('#dest-port').value = d?d.port:'';
    $('#dest-user').value = d?d.user:'';
    $('#dest-sftp-auth').value = d?d.sftpAuth:'password';
    $('#dest-key-path').value = d? (destFleetState.editingId ? '' : '') : ''; // keyPath not in list, fetch if needed
    $('#dest-s3-provider').value = d?d.s3Provider:'AWS';
    $('#dest-s3-bucket').value = d?d.s3Bucket:'';
    $('#dest-s3-region').value = d?d.s3Region:'';
    $('#dest-s3-endpoint').value = d?d.s3Endpoint:'';
    $('#dest-password').value=''; $('#dest-ak').value=''; $('#dest-sk').value='';
    // fetch full for keyPath etc if editing
    if(id){
      fetch(`/api/destinations/${id}`).then(r=>r.json()).then(full=>{
        $('#dest-key-path').value=full.keyPath||'';
        syncDestDialogFields();
      });
    }
    $('#dest-test-result').textContent='';
    syncDestDialogFields();
    $('#dest-dialog').classList.add('open');
  }
  function closeDestDialog(){ $('#dest-dialog').classList.remove('open'); }
  function syncDestDialogFields(){
    const t=$('#dest-type').value;
    $$('.dest-dlg-row').forEach(el=>{
      const f=(el.dataset.for||'').split(/\s+/);
      el.classList.toggle('hidden', !f.includes(t));
    });
    const auth=$('#dest-sftp-auth').value;
    // key field visibility handled via data-for already, but ensure
  }
  async function saveDest(){
    const payload={
      name:$('#dest-name').value.trim(),
      type:$('#dest-type').value,
      host:$('#dest-host').value.trim(),
      port:$('#dest-port').value.trim(),
      user:$('#dest-user').value.trim(),
      remoteName:$('#dest-remote-name').value.trim()||'my-backup-remote',
      remotePath:$('#dest-remote-path').value.trim()||'/',
      sftpAuth:$('#dest-sftp-auth').value,
      keyPath:$('#dest-key-path').value.trim(),
      s3Provider:$('#dest-s3-provider').value,
      s3Bucket:$('#dest-s3-bucket').value.trim(),
      s3Region:$('#dest-s3-region').value.trim(),
      s3Endpoint:$('#dest-s3-endpoint').value.trim(),
    };
    const pw=$('#dest-password').value; if(pw) payload.password=pw;
    const ak=$('#dest-ak').value.trim(); if(ak) payload.s3AccessKey=ak;
    const sk=$('#dest-sk').value; if(sk) payload.s3SecretKey=sk;
    if(!payload.name) return toast('Name required', true);
    if(payload.type!=='s3' && !payload.host) return toast('Host required', true);
    const url=destFleetState.editingId ? `/api/destinations/${destFleetState.editingId}` : '/api/destinations';
    const method=destFleetState.editingId?'PUT':'POST';
    const r=await fetch(url,{method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if(!r.ok){ const d=await r.json().catch(()=>({})); return toast(d.error||'Failed', true); }
    closeDestDialog(); await loadDestinations(); toast(destFleetState.editingId?'Destination updated':'Destination added');
  }

  // ---------- browse ----------
  const browseState = { inputEl:null, kind:null, vpsId:null, multiselect:[] };
  function openBrowseForRow(row, kind){
    // include/exclude also browse source VPS
    if (kind==='include' || kind==='exclude') {
      const input = row.querySelector(kind==='include' ? '.src-include' : '.src-exclude');
      browseState.inputEl = input;
      browseState.kind = kind;
      const vpsId = ($('#f-source-vps')?.value) || '';
      if (!vpsId) return toast('Select a Source VPS first (add one in Fleet)', true);
      browseState.vpsId = vpsId;
      const curVal = input.value.trim();
      // For include/exclude, entries may be comma/space-separated or globs, so we
      // can't reliably derive a single start folder. Start at the source VPS root
      // '/' — the dialog already pre-seeds the existing selections as chips.
      const initial = '/';
      openBrowseDialog({ title: `Browse for ${kind} — ${fleetState.list.find(v=>v.id===vpsId)?.name || vpsId}`, initialPath: initial, mode:'vps' });
      // override browse select to insert pattern
      browseState.isIncludeExclude = true;
      return;
    }
    const input = kind==='src' ? row.querySelector('.src-path') : row.querySelector('.src-dest');
    browseState.inputEl = input;
    browseState.kind = kind;
    browseState.isIncludeExclude = false;
    if (kind==='src') {
      const vpsId = ($('#f-source-vps')?.value) || '';
      if (!vpsId) return toast('Select a Source VPS first (add one in Fleet)', true);
      browseState.vpsId = vpsId;
      const initial = input.value.trim() || '/';
      openBrowseDialog({ title: `Browse ${fleetState.list.find(v=>v.id===vpsId)?.name || vpsId}`, initialPath: initial, mode:'vps' });
    } else {
      // dest browse: if a fleet destination is selected, browse via that fleet's stored credentials
      const destFleetId = ($('#f-dest-fleet')?.value) || 'manual';
      if (destFleetId && destFleetId !== 'manual') {
        let cur = input.value.trim();
        if (cur.includes(':')) cur = cur.split(':').slice(1).join(':');
        if (!cur) {
          // use fleet's remotePath as default
          const d = destFleetState.list.find(x=>x.id===destFleetId);
          cur = d ? (d.remotePath||'/') : '';
          if (cur !== '/' && !cur.startsWith('/')) cur = '/' + cur;
        }
        browseState.destFleetId = destFleetId;
        browseState.remoteCfg = null;
        openBrowseDialog({ title: `Browse ${destFleetState.list.find(d=>d.id===destFleetId)?.name || destFleetId}`, initialPath: cur || '/', mode:'remoteFleet' });
        return;
      }
      let cur = input.value.trim();
      if (cur.includes(':')) cur = cur.split(':').slice(1).join(':');
      if (!cur) cur = '';
      const destCfg = {
        type: $('#f-dest-type').value,
        host: $('#f-host').value.trim(), port: $('#f-port').value.trim(), user: $('#f-user').value.trim(),
        sftpAuth: $('#f-sftp-auth').value, keyPath: $('#f-key-path').value.trim(),
        bucket: $('#f-s3-bucket').value.trim(), region: $('#f-s3-region').value.trim(),
        endpoint: $('#f-s3-endpoint').value.trim(), provider: $('#f-s3-provider').value,
        password: $('#f-secret-pass').value, accessKey: $('#f-secret-ak').value.trim(), secretKey: $('#f-secret-sk').value
      };
      browseState.remoteCfg = destCfg;
      browseState.destFleetId = null;
      openBrowseDialog({ title: 'Browse remote storage', initialPath: cur, mode:'remote' });
    }
  }
  let browseCurrentPath = '/';
  let browseMode = 'vps';
  function openBrowseDialog({title, initialPath, mode}){
    browseMode = mode;
    browseCurrentPath = initialPath || (mode==='remote' ? '' : '/');
    $('#browse-title').textContent = title;
    $('#browse-path').value = browseCurrentPath;
    // multiselect only for include/exclude
    const multi = browseState.kind==='include' || browseState.kind==='exclude';
    // Seed with any existing include/exclude entries so the user sees current state
    browseState.multiselect = multi
      ? ((browseState.inputEl && browseState.inputEl.value) || '').split(/[,\s]+/).filter(Boolean)
      : [];
    const multiBtn=$('#btn-browse-multi'), cntEl=$('#browse-select-count');
    if(multiBtn) multiBtn.classList.toggle('hidden', !multi);
    if(cntEl) cntEl.hidden = !multi;
    const selBar=$('#browse-selected');
    if(selBar) selBar.hidden = !multi;
    updateBrowseMultiBadge();
    $('#browse-dialog').classList.add('open');
    loadBrowsePath(browseCurrentPath);
  }
  function updateBrowseMultiBadge(){
    const n = browseState.multiselect.length;
    const cntEl=$('#browse-select-count'); if(cntEl) { cntEl.textContent=`${n} selected`; cntEl.hidden = !(n); }
    const multiBtn=$('#btn-browse-multi'); if(multiBtn) multiBtn.textContent=`Add selected (+${n})`;
    // render selected chips bar with remove buttons
    const selBar=$('#browse-selected');
    if(selBar){
      if(n){
        selBar.hidden=false;
        selBar.innerHTML = '<span class="hint" style="display:block;margin-bottom:4px">Selected — click a chip to remove:</span>';
        browseState.multiselect.forEach((p)=>{
          const chip=document.createElement('span');
          chip.className='browse-chip';
          chip.dataset.path=p;
          chip.textContent = (p.startsWith('/')?'':'/')+p;
          chip.setAttribute('title', 'Click to remove '+p);
          chip.setAttribute('role','button');
          chip.setAttribute('tabindex','0');
          chip.addEventListener('click',()=>{ removeFromMultiselect(p); });
          chip.addEventListener('keydown',(ev)=>{
            if(ev.key==='Enter'||ev.key===' '){ ev.preventDefault(); removeFromMultiselect(p); }
          });
          selBar.appendChild(chip);
        });
      } else {
        selBar.hidden=true;
        selBar.innerHTML='';
      }
    }
    // highlight selected rows in current list
    $$('#browse-list .browse-item').forEach((el)=>{
      const p = el.dataset.path;
      el.classList.toggle('selected', !!p && browseState.multiselect.includes(p));
    });
  }
  function removeFromMultiselect(p){
    const i=browseState.multiselect.indexOf(p);
    if(i>=0) browseState.multiselect.splice(i,1);
    updateBrowseMultiBadge();
  }
  function closeBrowseDialog(){ $('#browse-dialog').classList.remove('open'); }
  async function loadBrowsePath(path){
    browseCurrentPath = path;
    $('#browse-path').value = path;
    const listEl = $('#browse-list');
    listEl.innerHTML = '<p class="hint" style="padding:12px">Loading…</p>';
    try {
      let res, data;
      if (browseMode === 'vps') {
        const vpsId = browseState.vpsId;
        if (!vpsId) return toast('Select a Source VPS first', true);
        res = await fetch(`/api/fleet/${vpsId}/browse`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path})});
        data = await res.json();
      } else if (browseMode === 'remoteFleet') {
        const destId = browseState.destFleetId;
        res = await fetch(`/api/destinations/${destId}/browse`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path})});
        data = await res.json();
      } else {
        const cfg = browseState.remoteCfg || {};
        res = await fetch('/api/browse/remote', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...cfg, path})});
        data = await res.json();
      }
      if (!data.ok) {
        listEl.innerHTML = `<p class="hint" style="padding:12px;color:var(--danger)">${data.msg||'Failed'}</p>`;
        $('#browse-hint').textContent = data.msg||'';
        return;
      }
      listEl.innerHTML = '';
      if (!data.entries.length) listEl.innerHTML = '<p class="hint" style="padding:12px">Empty folder</p>';
      for (const e of data.entries) {
        const div = document.createElement('div');
        div.className = 'browse-item';
        div.dataset.path = e.path;
        div.setAttribute('role', 'button');
        div.setAttribute('tabindex', '0');
        const multi = browseState.kind==='include' || browseState.kind==='exclude';
        div.classList.toggle('multi', multi);
        div.innerHTML = `<span>${e.isDir ? '📁' : '📄'}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.name}</span><span class="browse-check" aria-hidden="true">✓</span>${e.isDir ? '<span class="hint">dir · dbl-click to open</span>' : '<span class="hint">file</span>'}`;
        const selectItem = () => {
          const multi = browseState.kind==='include' || browseState.kind==='exclude';
          if (multi) {
            // multi-select toggle (dirs and files)
            const p = e.path;
            const i = browseState.multiselect.indexOf(p);
            if (i>=0) browseState.multiselect.splice(i,1); else browseState.multiselect.push(p);
            div.classList.toggle('selected', i<0);
            updateBrowseMultiBadge();
            return;
          }
          if (e.isDir) {
            loadBrowsePath(e.path);
          } else {
            // select file
            $$('#browse-list .browse-item').forEach(el=>el.classList.remove('selected'));
            div.classList.add('selected');
            browseState.selectedPath = e.path;
            $('#browse-path').value = e.path;
          }
        };
        div.addEventListener('click', selectItem);
        div.addEventListener('dblclick', (ev)=>{
          ev.stopPropagation();
          if (e.isDir) loadBrowsePath(e.path);
          else { browseState.selectedPath = e.path; confirmBrowseSelect(); }
        });
        div.addEventListener('keydown', (ev)=>{
          if (ev.key==='Enter' || ev.key===' ') {
            ev.preventDefault();
            // In multi mode Space/Enter toggles selection; Enter on a dir opens it.
            if (e.isDir && ev.key==='Enter') loadBrowsePath(e.path);
            else selectItem();
          }
        });
        listEl.appendChild(div);
      }
      $('#browse-hint').textContent = `${data.entries.length} items in ${data.path}`;
    } catch(e){
      listEl.innerHTML = `<p class="hint" style="padding:12px;color:var(--danger)">Error: ${e.message}</p>`;
    }
  }
  function confirmBrowseSelect(){
    // multiselect (include/exclude): append all selected (or dirs-not-yet-in when empty)
    if (browseState.kind==='include' || browseState.kind==='exclude') {
      let paths = browseState.multiselect.slice();
      // if nothing explicitly multiselected, fall back to the current file selection/path
      if (!paths.length) {
        const single = browseState.selectedPath || $('#browse-path').value.trim();
        if (single) paths.push(single);
      }
      if (!paths.length) return;
      const existing = (browseState.inputEl.value||'').trim();
      const parts = existing ? existing.split(/[,\s]+/).filter(Boolean) : [];
      paths.forEach((p)=>{
        const raw = p.startsWith('/') ? p : '/'+p;
        if (!parts.includes(raw)) parts.push(raw);
      });
      browseState.inputEl.value = parts.join(', ');
      closeBrowseDialog();
      onChange();
      return;
    }
    let sel = browseState.selectedPath || $('#browse-path').value.trim();
    if (!sel) return;
    if (browseState.kind === 'dest') {
      // Reconstruct full remote spec: if user selected path like "backups/foo", prefix with remoteName
      const fullSel = sel;
      // If input already had "remote:" prefix, preserve it
      const existing = browseState.inputEl.value.trim();
      if (existing.includes(':')) {
        const remotePart = existing.split(':')[0];
        sel = remotePart + ':' + sel.replace(/^\/+/, '');
      } else {
        // Use global dest remoteName as prefix if available
        const rn = $('#f-remote-name').value.trim() || 'my-backup-remote';
        // If browsing S3, include bucket?
        const type = $('#f-dest-type').value;
        if (type==='s3') {
          const bucket = $('#f-s3-bucket').value.trim();
          if (bucket && !sel.startsWith(bucket)) sel = bucket + '/' + sel.replace(/^\/+/, '');
          sel = rn + ':' + sel;
        } else {
          sel = rn + ':' + sel.replace(/^\/+/, '');
        }
      }
    }
    browseState.inputEl.value = sel;
    closeBrowseDialog();
    onChange();
  }

  // ---------- live previews (always live from form) ----------
  function currentStatus() {
    return $$('input[name="pv-state"]').find((r) => r.checked)?.value === 'fail' ? 'FAIL' : 'SUCCESS';
  }

  function renderDiscordPreview() {
    const cfg = Generator.normalize(cfgFromForm());
    const w = cfg.webhook;
    const status = currentStatus();
    const ok = status === 'SUCCESS';
    const payload = Generator.buildPayload(cfg, status, {
      host: 'myserver', duration: '42',
      logTail: ok ? null : '[ERROR] rclone: failed to copy: dial tcp 10.0.0.5:22: connect refused\n[ERROR] /home/user/data/photos/2024/img_0042.jpg\n',
    });
    $('#pv-username').textContent = payload.username;
    const av = $('.discord-avatar');
    if (av) av.src = payload.avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png';
    $('#pv-time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const embedEl = $('#pv-embed');
    embedEl.style.display = w.enabled && w.url ? '' : 'none';
    $('#pv-color').style.background = ok ? w.colorOk : w.colorFail;
    const titleEl = $('#pv-title');
    titleEl.textContent = payload.embeds[0].title;
    titleEl.classList.toggle('hidden-el', !payload.embeds[0].title);
    $('#pv-desc').textContent = payload.embeds[0].description;
    $('#pv-footer').textContent = payload.embeds[0].footer?.text ?? '';
    const logEl = $('#pv-log');
    logEl.hidden = !(!ok && Number(w.logLines) > 0);
    if (!logEl.hidden) logEl.textContent = '[ERROR] rclone: failed to copy: dial tcp 10.0.0.5:22: connect refused';
  }

  function regenerateScript(force = false) {
    if (!force && state.doc?.manualEdited) return;
    state.cm.setValue(Generator.buildScript(cfgFromForm()));
  }

  function renderScriptPreview() {
    // always live from the builder form
    const live = Generator.buildScript(cfgFromForm());
    $('#script-preview').textContent = live;
  }

  function renderInstallTab() {
    if (!state.id || !state.doc) return;
    const token = state.doc.rawToken || '';
    const base = `${window.location.origin}/raw/${state.id}.sh?token=${encodeURIComponent(token)}`;
    $('#raw-url').textContent = base;
    $('#install-cmd').textContent = `curl -fsSL '${base}' -o backup.sh && chmod 700 backup.sh`;
    const expr = state.cronExpr || '0 2 * * *';
    $('#cron-line').textContent = `${expr} /root/${state.id}.sh`;
    $('#cron-line-curl').textContent = `${expr} curl -fsSL '${base}' -o /root/${state.id}.sh && /root/${state.id}.sh`;
    $('#env-example').textContent =
      `# in crontab -e (or systemd Environment=)\nFTP_PASS='hunter2' AWS_ACCESS_KEY_ID='AKIA...' AWS_SECRET_ACCESS_KEY='...' ${expr} curl -fsSL '${base}' -o /root/backup.sh && /root/backup.sh`;
    bindCopyButtons();
  }

  function refreshAll({ regen = false } = {}) {
    if (regen || !state.doc?.manualEdited) regenerateScript(true);
    renderDiscordPreview();
    renderScriptPreview();
    renderInstallTab();
    markDirty();
  }

  function onChange() { refreshAll(); }

  function markDirty() {
    state.dirty = true;
    $('#save-status').textContent = 'unsaved changes';
  }
  function markClean(msg = '') {
    state.dirty = false;
    $('#save-status').textContent = msg;
  }

  // ---------- persistence ----------
  async function saveDoc() {
    const cfg = cfgFromForm();
    const sourceVpsId = ($('#f-source-vps')?.value) || '';
    if (!sourceVpsId) return toast('Select a Source VPS first', true);
    const destFleetId = ($('#f-dest-fleet')?.value) || 'manual';
    const generated = Generator.buildScript(cfg);
    let manualEdited = editorManuallyEdited;
    let scriptToSave = editorManuallyEdited ? state.cm.getValue() : generated;
    // if not manually edited, ensure editor reflects generated
    if (!editorManuallyEdited && state.cm.getValue() !== generated) {
      state.cm.setValue(generated);
      scriptToSave = generated;
    }
    const body = {
      ...state.doc,
      name: cfg.name,
      config: cfg,
      cronExpr: state.cronExpr,
      sourceVpsId,
      destFleetId: destFleetId==='manual'?null:destFleetId,
      script: scriptToSave,
      manualEdited,
    };
    try {
      const res = await fetch(state.id ? `/api/scripts/${state.id}` : '/api/scripts', {
        method: state.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const doc = await res.json();
      const isNew = !state.id;
      state.id = doc.id; state.doc = doc;
      editorManuallyEdited = !!doc.manualEdited;
      markClean(isNew ? 'created ✓' : 'saved ✓');
      loadList(state.id);
      renderInstallTab();
      toast(isNew ? 'Script created' : 'Saved');
    } catch (e) {
      toast(`Save failed: ${e.message}`, true);
    }
  }

  async function deleteDoc() {
    if (!state.id) return;
    const ok = await Dialog.confirmDanger(`Delete "${state.doc.name}"?`, 'This cannot be undone.', 'Delete');
    if (!ok) return;
    await fetch(`/api/scripts/${state.id}`, { method: 'DELETE' });
    state.id = null; state.doc = null;
    showEmpty();
    loadList();
    toast('Deleted');
  }

  async function openDoc(id) {
    // check unsaved changes via dialog
    if (state.dirty) {
      const go = await Dialog.confirm('Unsaved changes', 'Discard your current edits?', { icon: '⚠️', okText: 'Discard', danger: true });
      if (!go) return;
    }
    const res = await fetch(`/api/scripts/${id}`);
    if (!res.ok) {
      if (res.status === 401) { showAuth(); return; }
      return toast('Failed to load script', true);
    }
    const doc = await res.json();
    state.id = doc.id; state.doc = doc;
    state.cronExpr = doc.cronExpr || '0 2 * * *';
    run.activeId = null;
    formFromCfg(doc.config || {});
    // restore selectors after populate
    populateSourceSelectors();
    populateDestFleetSelect();
    if (doc.sourceVpsId) {
      const sel=$('#f-source-vps'); if(sel) sel.value=doc.sourceVpsId;
      const rsel=$('#f-run-vps'); if(rsel) rsel.value=doc.sourceVpsId;
    }
    if (doc.destFleetId) {
      const dsel=$('#f-dest-fleet'); if(dsel){ dsel.value=doc.destFleetId; applyDestFleetToForm(doc.destFleetId); }
    } else {
      const dsel=$('#f-dest-fleet'); if(dsel) dsel.value='manual';
      applyDestFleetToForm('manual');
    }
    editorManuallyEdited = false;
    state.cm.setValue(doc.script || '');
    editorManuallyEdited = false;
    $('#empty-state').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    markClean('');
    loadList(id);
    renderDiscordPreview();
    renderScriptPreview();
    renderInstallTab();
    initCronMount();
  }

  function newDoc() {
    state.id = null; state.doc = null;
    run.activeId = null;
    state.cronExpr = '0 2 * * *';
    formFromCfg(Generator.defaultConfig());
    editorManuallyEdited = false;
    state.cm.setValue(Generator.buildScript(Generator.defaultConfig()));
    editorManuallyEdited = false;
    $('#empty-state').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    markDirty();
    loadList(null);
    renderDiscordPreview();
    renderScriptPreview();
    renderInstallTab();
    initCronMount();
    populateDestFleetSelect();
    const dsel=$('#f-dest-fleet'); if(dsel){ dsel.value='manual'; applyDestFleetToForm('manual'); }
    $('#f-name').focus();
  }

  function showEmpty() {
    $('#editor').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
  }

  // ---------- sidebar list ----------
  async function loadList(activeId) {
    const res = await fetch('/api/scripts');
    if (res.status === 401) { showAuth(); return; }
    if (!res.ok) return;
    const items = await res.json();
    const nav = $('#script-list');
    nav.innerHTML = '';
    for (const it of items) {
      const div = document.createElement('div');
      div.className = 'script-item' + (it.id === activeId ? ' active' : '');
      div.innerHTML = `<span class="nm"></span><button class="del" title="delete">🗑</button>`;
      div.querySelector('.nm').textContent = it.name;
      div.addEventListener('click', async () => {
        if (state.dirty) {
          const go = await Dialog.confirm('Unsaved changes', 'Discard your current edits?', { icon: '⚠️', okText: 'Discard', danger: true });
          if (!go) return;
        }
        openDoc(it.id);
      });
      div.querySelector('.del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await Dialog.confirmDanger(`Delete "${it.name}"?`, '', 'Delete');
        if (!ok) return;
        const r = await fetch(`/api/scripts/${it.id}`, { method: 'DELETE' });
        if (r.ok && it.id === state.id) { state.id = null; state.doc = null; showEmpty(); }
        loadList();
        toast('Deleted');
      });
      nav.appendChild(div);
    }
  }

  // ---------- run & logs ----------
  const run = { activeId: null, pollTimer: null, running: false };

  async function refreshRuns(selectId) {
    if (!state.id) return;
    try {
      const res = await fetch(`/api/scripts/${state.id}/runs`);
      if (!res.ok) return;
      const runs = await res.json();
      run._lastRuns = runs;
      const hist = $('#run-history');
      hist.innerHTML = '';
      run.running = runs.some((r) => !r.finishedAt);
      $('#btn-run-stop').classList.toggle('hidden', !run.running);
      $('#run-status').textContent = run.running ? '⏳ run in progress…' : '';
      // disable Run buttons when a run is active to prevent duplicate runs
      const runBtn=$('#btn-run'), dryBtn=$('#btn-run-dry');
      if(runBtn) runBtn.disabled = run.running;
      if(dryBtn) dryBtn.disabled = run.running;
      if(runBtn) runBtn.title = run.running ? 'A run is already in progress' : '';
      if(dryBtn) dryBtn.title = run.running ? 'A run is already in progress' : '';
      // update beautiful card for active or latest run
      const activeOrLatest = runs.find(r=>!r.finishedAt) || runs[0] || null;
      updateBeautifulRun(activeOrLatest);
      // also update live stats in text UI
      updateLiveStats(activeOrLatest);
      // When a run is live, always auto-show its log in the terminal so the
      // user sees streaming output even if they previously selected an old run.
      let liveShown = false;
      for (const r of runs) {
        const div = document.createElement('div');
        div.className = 'run-item' + (r.id === (selectId || run.activeId) ? ' active' : '');
        const ok = r.exitCode === 0;
        div.innerHTML = `<span class="st ${r.finishedAt ? (ok ? 'ok' : 'bad') : 'running'}"></span>
          <b>${r.dryRun ? '<span class="badge-dry">DRY</span> ' : ''}${r.name}</b>
          <span class="when">${new Date(r.startedAt).toLocaleString()}${r.finishedAt ? ` · ${r.exitCode ?? '?'} · ${Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000)}s` : ' · running…'}</span>
          <span style="margin-left:auto; display:flex; gap:6px">
            <button class="btn tonal small view-btn" title="View log">👁 View</button>
            <button class="btn tonal small dl-btn" title="Download log">⬇ Download</button>
          </span>`;
        div.querySelector('.view-btn').addEventListener('click', (e)=>{ e.stopPropagation(); showRun(r); document.querySelector('#run-terminal')?.scrollIntoView({behavior:'smooth', block:'center'}); });
        div.querySelector('.dl-btn').addEventListener('click', (e)=>{ e.stopPropagation(); downloadText(`run-${r.id}.log`, r.output||''); });
        div.addEventListener('click', () => showRun(r));
        hist.appendChild(div);
        if (!selectId && !liveShown && r.id === (run.activeId || runs[0]?.id)) { showRun(r); liveShown = true; }
      }
      // If a run is currently in progress but the loop didn't show it (e.g. user
      // had selected an old finished run), force-switch the terminal to the live run.
      if (!selectId && run.running && activeOrLatest && !activeOrLatest.finishedAt && !liveShown) {
        showRun(activeOrLatest);
      }
      if (!runs.length && !selectId) {
        $('#run-terminal').textContent = '// no runs yet — hit "Run now" or "Dry run"';
        $('#run-history').innerHTML = '<p class="hint">no runs recorded yet</p>';
        updateBeautifulRun(null);
      }
    } catch {}
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(run.pollTimer);
    // ultra-short & smooth when running: 350ms live (with jitter), 2500ms idle
    const delay = run.running ? 350 + Math.random()*100 : 2500;
    run.pollTimer = setTimeout(() => refreshRuns(), delay);
  }

  // Track last output length to detect hang and to avoid unnecessary scroll
  let lastOutputLen = 0;
  let lastOutputTime = Date.now();
  function getCompactLiveOutput(fullOutput) {
    if (!fullOutput) return '(no output)';
    const lines = fullOutput.split('\n');
    // Find the last stats-bearing line. rclone emits both forms:
    //   "Transferred:   X / Y, N%, S/s, ETA zs"   (--stats-one-line TTY)
    //   "2026.. INFO :  X / Y, N%, S/s, ETA zs"    (--stats via log, non-tty)
    const isStats = (l) => /(Transferred:|INFO\s*:\s*).*[KMGT]?i?B\s*\/\s*[0-9.]+\s*[KMGT]?i?B.*(ETA|\/s)/i.test(l);
    let lastStatsIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (isStats(lines[i])) { lastStatsIdx = i; break; }
    }
    if (lastStatsIdx !== -1) {
      // show from last Transferring block (or a couple before the last stats line)
      let start = lastStatsIdx;
      for (let i = lastStatsIdx; i >= 0; i--) {
        if (lines[i].includes('Transferring:')) { start = i; break; }
      }
      if (start === lastStatsIdx) start = Math.max(0, lastStatsIdx - 5);
      const compact = lines.slice(start).slice(-16).join('\n');
      return `— Live (compact, full log saved for download) —\n${compact}`;
    }
    // Fallback: show the last non-empty 16 lines so progress is visible even
    // before any stats line (early "Elapsed time:" / file lines)
    const nonEmpty = lines.map(l=>l.trim()).filter(Boolean);
    return nonEmpty.slice(-16).join('\n') || '(no output)';
  }
  function showRun(r) {
    const isNewSelection = run.activeId !== r.id;
    run.activeId = r.id;
    $$('#run-history .run-item').forEach((el) => el.classList.remove('active'));
    const term = $('#run-terminal');
    const wasNearBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 80;
    const wasEmpty = !term.textContent || term.textContent.startsWith('//');
    const output = r.output || '(no output)';
    const isLive = !r.finishedAt;
    // Use compact view for live runs, full for finished
    if (isLive) {
      term.textContent = getCompactLiveOutput(output);
      // For live, only auto-scroll if user was at bottom
      if (wasEmpty || wasNearBottom || isNewSelection) term.scrollTop = term.scrollHeight;
    } else {
      term.textContent = output;
      // For finished, do NOT auto-scroll - preserve user's position unless it's a new selection
      if (isNewSelection) term.scrollTop = 0;
      else if (wasNearBottom) term.scrollTop = term.scrollHeight;
    }
    $('#run-log-detail').textContent =
      `${r.name} — ${r.dryRun ? 'DRY RUN' : 'FULL RUN'}\nstarted ${r.startedAt}\n` +
      (r.finishedAt ? `finished ${r.finishedAt} · exit code ${r.exitCode}` : 'still running') +
      (isLive ? `\n\n[Live compact view — full log available via Download]` : '');
    updateBeautifulRun(r);
    updateLiveStats(r);
    // Hang detection: if live and output hasn't grown in 90s, warn
    if (isLive) {
      if (output.length !== lastOutputLen) {
        lastOutputLen = output.length;
        lastOutputTime = Date.now();
      } else if (Date.now() - lastOutputTime > 90000) {
        const hint = document.querySelector('#run-terminal');
        if (hint && !hint.dataset.hangWarned) {
          hint.dataset.hangWarned = '1';
          toast('Run appears hanged — no output for 90s. Check VPS or Stop and retry.', true);
        }
      }
    } else {
      lastOutputLen = 0;
      const termEl = document.querySelector('#run-terminal');
      if (termEl) delete termEl.dataset.hangWarned;
    }
  }
function updateLiveStats(r){
    const bar=$('#run-live-stats');
    if(!bar) return;
    if(!r){ bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const out=r.output||'';
    // parse elapsed
    const startMs=new Date(r.startedAt).getTime();
    const endMs=r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now();
    const elapsedSec=Math.max(0, Math.floor((endMs - startMs)/1000));
    const elapsedStr = `${Math.floor(elapsedSec/60)}m ${elapsedSec%60}s`;
    // Scan for the LAST rclone stats line so live updates track the latest
    // snapshot. rclone emits periodic lines like:
    //   "Transferred:   5 MiB / 10 MiB, 50%, 5 MiB/s, ETA 5s"
    // or the --stats-one-line INFO form:
    //   "2026/.. INFO :  5 MiB / 10 MiB, 50%, 5 MiB/s, ETA 5s"
    let transferred='—', speed='—', eta='—', checks='';
    const lines=out.split(/\r?\n/);
    for(const line of lines){
      const hasTrans = /\bTransferred\s*:/i.test(line) || /\b\d+(?:\.\d+)?\s*[KMGT]?i?B\s*\/\s*\d/.test(line);
      if(!hasTrans) continue;
      const mTrans=line.match(/([0-9.]+\s*[KMGT]?i?B\s*\/\s*[0-9.]+\s*[KMGT]?i?B)/i);
      if(mTrans) transferred=mTrans[1].trim();
      const mSpeed=line.match(/(\d+(?:\.\d+)?\s*[KMGT]?i?B\/s)/i);
      if(mSpeed) speed=mSpeed[0];
      const mEta=line.match(/ETA\s+([^\n,)]+)/i);
      if(mEta) eta=mEta[1].trim();
    }
    const mChecks = out.match(/Checks:\s*([^\n]+)/i);
    if(mChecks) checks=mChecks[1].trim();
    // fall back to any ETA/speed if no structured stats line found
    if(transferred==='—'){
      const mSpeed=out.match(/(\d+(?:\.\d+)?\s*[KMGT]?i?B\/s)/i); if(mSpeed) speed=mSpeed[0];
      const mEta=out.match(/ETA\s+([^\n,)]+)/i); if(mEta) eta=mEta[1].trim();
    }
    bar.innerHTML = `
      <span><b>⏱ Elapsed:</b> ${elapsedStr}</span>
      <span><b>📦 Transferred:</b> ${transferred}</span>
      ${speed!=='—' ? `<span><b>⚡ Speed:</b> ${speed}</span>` : ''}
      ${eta!=='—' && eta!=='-' ? `<span><b>⏳ ETA:</b> ${eta}</span>` : ''}
      ${checks ? `<span><b>✔ Checks:</b> ${checks}</span>` : ''}
      <span style="margin-left:auto"><b>Status:</b> ${r.finishedAt ? (r.exitCode===0?'✅ OK':'❌ Failed') : '⏳ Running'}</span>
    `;
  }

  let isTriggering = false;
  async function triggerRun(dryRun) {
    if (isTriggering) return;
    if (!state.id) return toast('Save the script first', true);
    if (run.running) return toast('A run is already in progress — wait or Stop it first', true);
    if (state.dirty) {
      await saveDoc();
      if (state.dirty) return;
    }
    const vpsId = ($('#f-run-vps')?.value) || ($('#f-source-vps')?.value) || '';
    if (!vpsId) return toast('Select a Source VPS first', true);
    isTriggering = true;
    const btnRun = $('#btn-run'), btnDry = $('#btn-run-dry');
    if (btnRun) btnRun.disabled = true;
    if (btnDry) btnDry.disabled = true;
    try {
      const res = await fetch(`/api/scripts/${state.id}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun, vpsId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        // Handle duplicate run error from backend
        if (res.status === 409) return toast(d.error || 'A run is already in progress', true);
        return toast(`Run failed to start: ${d.error || res.status}`, true);
      }
      toast(dryRun ? 'Dry run started' : 'Backup started');
      switchTab('run');
      refreshRuns();
    } finally {
      isTriggering = false;
      // Re-enable will be handled by refreshRuns based on run.running
      if (!run.running) {
        if (btnRun) btnRun.disabled = false;
        if (btnDry) btnDry.disabled = false;
      }
    }
  }

  async function stopRun() {
    const res = await fetch(`/api/scripts/${state.id}/runs`);
    const runs = await res.json();
    const active = runs.find((r) => !r.finishedAt);
    if (!active) return;
    await fetch(`/api/runs/${active.id}/stop`, { method: 'POST' });
    toast('Stop signal sent');
    refreshRuns();
  }

  async function clearLogs(){
    if (!state.id) return;
    const ok=await Dialog.confirmDanger('Clear all run logs for this script?','This cannot be undone.','Clear');
    if(!ok) return;
    const res=await fetch(`/api/scripts/${state.id}/runs`,{method:'DELETE'});
    if(res.ok){ toast('Logs cleared'); refreshRuns(); }
    else toast('Failed to clear', true);
  }
  function downloadText(filename, text){
    const blob=new Blob([text],{type:'text/plain'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=filename; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }
  function downloadLog(){
    const r = run.activeId ? (run._lastRuns||[]).find(x=>x.id===run.activeId) : null;
    const text = r ? r.output : ($('#run-terminal').textContent || '');
    if(!text || text.startsWith('//')) return toast('No log to download', true);
    const name = r ? `run-${r.id}.log` : `run-${new Date().toISOString().slice(0,10)}.log`;
    downloadText(name, text);
  }
  function downloadAllLogs(){
    const runs = run._lastRuns || [];
    if(!runs.length) return toast('No logs', true);
    let all = runs.map(r=>`===== ${r.name} | ${r.vpsName||r.vpsId} | ${r.startedAt} → ${r.finishedAt||'running'} | exit ${r.exitCode??''} =====\n${r.output||''}\n`).join('\n');
    downloadText(`all-logs-${state.id}.log`, all);
  }
  function updateBeautifulRun(r){
    const card=$('#run-beautiful');
    const title=$('#run-beautiful-title');
    const sub=$('#run-beautiful-subtitle');
    const icon=$('#run-beautiful-icon');
    const spinner=$('#run-beautiful-spinner');
    const fill=$('#run-progress-fill');
    const stepsEl=$('#run-steps');
    if(!card) return;
    if(!r){
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const isRunning=!r.finishedAt;
    const isOk=r.exitCode===0;
    icon.textContent = isRunning ? '⏳' : (isOk ? '✅' : '❌');
    icon.style.background = isRunning ? 'var(--surface-2)' : (isOk ? 'color-mix(in srgb, var(--green) 18%, var(--surface-2))' : 'color-mix(in srgb, var(--danger) 14%, var(--surface-2))');
    title.textContent = isRunning ? `Running on ${r.vpsName||r.vpsId}…` : (isOk ? `Completed on ${r.vpsName||r.vpsId}` : `Failed on ${r.vpsName||r.vpsId}`);
    sub.textContent = `${r.dryRun?'DRY RUN · ':''}${new Date(r.startedAt).toLocaleString()}${r.finishedAt ? ` → ${new Date(r.finishedAt).toLocaleString()}` : ' · running'}`;
    spinner.style.display = isRunning ? 'block' : 'none';
    // progress: if running, shimmering 62% with animation, if done 100%
    fill.classList.toggle('running', isRunning);
    fill.style.width = isRunning ? '62%' : '100%';
    if (!isRunning) fill.style.background = isOk ? 'var(--green)' : 'var(--danger)';
    else fill.style.background = '';
    // steps from output
    const out=r.output||'';
    const sources = (state.doc?.config?.sources||[]).map(s=>s.path);
    stepsEl.innerHTML='';
    if(sources.length){
      sources.forEach(p=>{
        const started = out.includes(`Starting sync for: ${p}`) || out.includes(p);
        const done = out.includes(`Sync for ${p} completed`);
        const el=document.createElement('span');
        el.className='run-step ' + (done ? 'done' : (started ? 'active' : ''));
        el.textContent = (done ? '✓ ' : (started ? '● ' : '○ ')) + p.split('/').pop();
        el.title=p;
        stepsEl.appendChild(el);
      });
    } else {
      // fallback: show dry/run badge
      const el=document.createElement('span');
      el.className='run-step ' + (isRunning?'active':'done');
      el.textContent = r.dryRun ? '🧪 Dry run' : '▶ Full run';
      stepsEl.appendChild(el);
    }
  }

  // ---------- webhook test ----------
  async function testWebhook(status) {
    const cfg = Generator.normalize(cfgFromForm());
    if (!cfg.webhook.url) return toast('Enter a webhook URL first', true);
    const payload = Generator.buildPayload(cfg, status, {
      host: 'test-server', duration: '13',
      logTail: status === 'FAIL' ? '[ERROR] rclone: directory not found /home/user/data' : null,
    });
    const out = $('#webhook-result');
    out.classList.remove('hidden');
    out.textContent = 'POST ' + cfg.webhook.url + '\n' + JSON.stringify(payload, null, 2) + '\n\nsending…';
    try {
      const res = await fetch('/api/test-webhook', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cfg.webhook.url, payload }),
      });
      const data = await res.json().catch(() => ({}));
      out.textContent += res.ok ? '✓ delivered to Discord' : `✗ ${data.error || res.status}\n${data.detail || ''}`;
      toast(res.ok ? 'Test sent — check your Discord channel' : 'Webhook test failed', !res.ok);
    } catch (e) {
      out.textContent += `✗ ${e.message}`;
      toast('Webhook test failed', true);
    }
  }

  // ---------- cron mount ----------
  function initCronMount() {
    const mount = $('#cron-mount');
    if (!mount) return;
    CronBuilder.mount(mount, (expr) => {
      state.cronExpr = expr;
      renderInstallTab();
      markDirty();
    });
  }

  // ---------- schedule management (panel-run) ----------
  let editingScheduleId = null;
  function resetScheduleForm(){
    editingScheduleId = null;
    const btn=$('#btn-save-schedule');
    if(btn){ btn.textContent='+ Add Schedule'; btn.classList.remove('danger'); }
    const cancelBtn=$('#btn-cancel-schedule');
    if(cancelBtn) cancelBtn.classList.add('hidden');
    const hint=$('#sched-save-hint');
    if(hint) hint.textContent='';
    // reset cron builder to default
    try{ CronBuilder.setCron('0 2 * * *'); }catch{}
    const sel=$('#sched-vps');
    if(sel && fleetState.list.length) {
      if(fleetState.list.length===1) sel.value=fleetState.list[0].id;
      else if(state.doc && state.doc.sourceVpsId) sel.value=state.doc.sourceVpsId;
    }
    const chk=$('#sched-enabled');
    if(chk) chk.checked=true;
  }
  function startEditSchedule(s){
    editingScheduleId = s.id;
    const sel=$('#sched-vps');
    if(sel) sel.value=s.vpsId;
    const chk=$('#sched-enabled');
    if(chk) chk.checked=!!s.enabled;
    try{ CronBuilder.setCron(s.cronExpr); }catch{}
    // need to re-render cron builder with new value - force remount
    const mount=$('#cron-mount');
    if(mount){
      CronBuilder.mount(mount, (expr)=>{ state.cronExpr=expr; renderInstallTab(); markDirty(); });
      // after mount, set again to ensure state
      try{ CronBuilder.setCron(s.cronExpr); }catch{}
    }
    state.cronExpr=s.cronExpr;
    const btn=$('#btn-save-schedule');
    if(btn){ btn.textContent='✓ Update Schedule'; }
    const cancelBtn=$('#btn-cancel-schedule');
    if(cancelBtn) cancelBtn.classList.remove('hidden');
    const hint=$('#sched-save-hint');
    if(hint) hint.textContent=`Editing schedule for ${s.vpsId} — ${s.cronExpr}`;
    // scroll to form
    document.querySelector('#tab-schedule .preview-card')?.scrollIntoView({behavior:'smooth', block:'start'});
  }
  async function loadSchedules(){
    if (!state.id) return;
    const sel=$('#sched-vps');
    if (sel && fleetState.list.length && !sel.options.length) {
      // populate VPS options for schedule form
      sel.innerHTML = fleetState.list.map(v=>`<option value="${v.id}">${v.name} (${v.host})</option>`).join('');
      if (fleetState.list.length===1) sel.value=fleetState.list[0].id;
      else if (state.doc && state.doc.sourceVpsId) sel.value=state.doc.sourceVpsId;
    }
    try{
      const res=await fetch(`/api/schedules?scriptId=${state.id}`);
      const list=await res.json();
      const container=$('#schedule-list');
      const empty=$('#schedule-empty');
      if (!list.length){ container.innerHTML=''; if(empty) empty.style.display='block'; return; }
      if(empty) empty.style.display='none';
      container.innerHTML='';
      for(const s of list){
        const vpsName = fleetState.list.find(v=>v.id===s.vpsId)?.name || s.vpsId;
        const friendly = (()=>{ try{ const p=s.cronExpr.split(' '); if(p.length!==5) return s.cronExpr; const [mi,h]=p; if(mi.startsWith('*/')) return `Every ${mi.slice(2)} min`; if(h.startsWith('*/')) return `Every ${h.slice(2)}h at :${mi.padStart(2,'0')}`; return `Daily at ${h.padStart(2,'0')}:${mi.padStart(2,'0')}`; }catch{ return s.cronExpr; }})();
        const div=document.createElement('div');
        div.className='schedule-item';
        div.innerHTML=`
          <div class="sched-info">
            <b>${vpsName}</b> <span class="sched-expr">${s.cronExpr}</span> <span class="hint" style="margin-left:6px">${friendly}</span>
            <div class="hint" style="margin:4px 0 0">Created ${new Date(s.createdAt).toLocaleString()} ${s.lastRun? '· last '+new Date(s.lastRun).toLocaleString():''}</div>
          </div>
          <div class="schedule-toggle ${s.enabled?'on':''}" data-id="${s.id}" title="Toggle enabled"></div>
          <button class="btn tonal small" data-edit="${s.id}">✎ Edit</button>
          <button class="btn tonal small" data-del="${s.id}">🗑 Delete</button>`;
        div.querySelector('.schedule-toggle').addEventListener('click', async (e)=>{
          const id=e.currentTarget.dataset.id;
          const cur=list.find(x=>x.id===id);
          const res=await fetch(`/api/schedules/${id}`,{method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({enabled:!cur.enabled})});
          if(res.ok) loadSchedules();
        });
        div.querySelector('[data-edit]').addEventListener('click', ()=> startEditSchedule(s));
        div.querySelector('[data-del]').addEventListener('click', async ()=>{
          const ok=await Dialog.confirmDanger(`Delete schedule?`,'','Delete');
          if(!ok) return;
          await fetch(`/api/schedules/${s.id}`,{method:'DELETE'});
          // if we were editing this one, reset form
          if(editingScheduleId===s.id) resetScheduleForm();
          loadSchedules(); updateSchedulerStatus();
        });
        container.appendChild(div);
      }
    }catch{}
  }
  async function saveSchedule(){
    if (!state.id) return toast('Save the script first', true);
    const vpsId=$('#sched-vps')?.value;
    if (!vpsId) return toast('Select a VPS for the schedule', true);
    const enabled=$('#sched-enabled')?.checked ?? true;
    const expr=state.cronExpr || '0 2 * * *';
    let res;
    if(editingScheduleId){
      res=await fetch(`/api/schedules/${editingScheduleId}`,{method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({vpsId, cronExpr:expr, enabled})});
      if(!res.ok){ const d=await res.json().catch(()=>({})); return toast(d.error||'Failed to update schedule', true); }
      toast('Schedule updated');
      resetScheduleForm();
    } else {
      res=await fetch('/api/schedules',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({scriptId:state.id, vpsId, cronExpr:expr, enabled})});
      if(!res.ok){ const d=await res.json().catch(()=>({})); return toast(d.error||'Failed to save schedule', true); }
      toast('Schedule added — panel will run it automatically');
    }
    loadSchedules(); updateSchedulerStatus();
  }
  async function updateSchedulerStatus(){
    try{
      const r=await fetch('/api/scheduler/status');
      const s=await r.json();
      const el=$('#scheduler-status');
      if(el) el.textContent = s.enabled ? `${s.enabled} enabled / ${s.total} total` : 'no schedules';
      const last=$('#scheduler-last');
      if(last) last.textContent = new Date().toLocaleTimeString();
    }catch{}
  }
  async function triggerScheduler(){
    const btn=$('#btn-trigger-scheduler');
    if(btn){ btn.textContent='…'; btn.disabled=true; }
    try{
      const r=await fetch('/api/schedules/trigger',{method:'POST'});
      const d=await r.json();
      toast(d.count ? `Triggered ${d.count} due schedule(s)` : 'No schedules due right now');
      if(d.count) refreshRuns();
      updateSchedulerStatus();
    }catch{ toast('Trigger failed', true); }
    if(btn){ btn.textContent='▶ Run due now'; btn.disabled=false; }
  }
  // auto-trigger due schedules every 60s while panel is open (panel-run)
  setInterval(async ()=>{
    if(!state.id) return;
    updateSchedulerStatus();
    try{
      const r=await fetch('/api/schedules/trigger',{method:'POST'});
      const d=await r.json();
      if(d.count) { toast(`Auto-ran ${d.count} due schedule(s)`); refreshRuns(); loadSchedules(); }
    }catch{}
  }, 60000);

  // ---------- tabs & clipboard ----------
  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'script') state.cm.refresh();
    if (name === 'run' && state.id) refreshRuns();
  }

  function bindCopyButtons(root = document) {
    root.querySelectorAll('.copy-btn:not([data-bound])').forEach((b) => {
      b.dataset.bound = '1';
      b.addEventListener('click', () => {
        const text = b.dataset.copyText || $(b.dataset.copyTarget)?.textContent || '';
        navigator.clipboard.writeText(text).then(() => toast('Copied'));
      });
    });
  }

  // ---------- auth / boot ----------
  let authMode = 'login';

  function showAuth(setupNeeded = null) {
    $('#auth-view').classList.remove('hidden');
    $('#app').classList.add('hidden');
    if (setupNeeded === null) {
      fetch('/api/auth/status').then((r) => r.json()).then((s) => showAuth(s.setupNeeded));
      return;
    }
    authMode = setupNeeded ? 'setup' : 'login';
    const sub = setupNeeded ? 'Create the first admin account' : 'Sign in to continue';
    $('#auth-subtitle').textContent = sub;
    $('#auth-submit').textContent = setupNeeded ? 'Create account' : 'Sign in';
    $('#auth-error').classList.add('hidden');
    $('#auth-user').focus();
  }

  function showApp() {
    $('#auth-view').classList.add('hidden');
    $('#app').classList.remove('hidden');
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    const u = $('#auth-user').value.trim();
    const pw = $('#auth-pass').value;
    if (!u || pw.length < 6) {
      $('#auth-error').textContent = 'Username required, password must be at least 6 characters';
      $('#auth-error').classList.remove('hidden');
      return;
    }
    const url = authMode === 'setup' ? '/api/auth/setup' : '/api/auth/login';
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      $('#auth-error').textContent = d.error || 'Failed';
      $('#auth-error').classList.remove('hidden');
      return;
    }
    $('#whoami').textContent = u;
    showApp();
    loadList();
    showEmpty();
  }

  async function doLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    showAuth(false);
  }

  async function boot() {
    applyTheme(localStorage.getItem('rcloneweb_theme') || 'dark');
    // theme toggle
    $('#btn-theme').addEventListener('click', () => {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    // auth check — FAIL CLOSED: any error must never reveal the app.
    try {
      const res = await fetch('/api/auth/status');
      if (!res.ok) throw new Error('auth/status HTTP ' + res.status);
      const st = await res.json();
      if (st.setupNeeded) { showAuth(true); return; }
      if (!st.authenticated) { showAuth(false); return; }
      showApp();
    } catch (e) {
      console.error('[rcloneweb] auth check failed, showing login (fail-closed):', e);
      // If the API is unreachable/misrouted (e.g. nginx not sending /api/* to
      // api/index.php) we must NOT show the app. Show login and surface the error.
      $('#auth-error').textContent = 'Could not reach the API. Check server logs / nginx routing for /api/.';
      $('#auth-error').classList.remove('hidden');
      showAuth(false);
    }
  }

  // ---------- init (post-auth) ----------
  function initMain() {
    state.cm = CodeMirror.fromTextArea($('#cm-script'), {
      mode: 'shell', theme: 'material-darker', lineNumbers: true,
      lineWrapping: false, tabSize: 2, indentUnit: 2,
    });
    state.cm.on('change', (cm, change) => {
      // ignore programmatic setValue
      if (change.origin === 'setValue') return;
      editorManuallyEdited = true;
      markDirty();
    });

    $('#main').addEventListener('input', (e) => {
      if (e.target.closest('#tab-builder')) refreshAll();
    });
    $('#btn-add-source').addEventListener('click', () => { addSourceRow(); refreshAll(); });
    $('#f-dest-type').addEventListener('change', () => { updateDestFields(); syncSecretFieldsVisibility(); refreshAll(); });
    $('#f-sftp-auth').addEventListener('change', () => { updateDestFields(); syncSecretFieldsVisibility(); refreshAll(); });
    $('#f-secrets-embed').addEventListener('change', () => { syncSecretFieldsVisibility(); refreshAll(); });

    $$('input[name="pv-state"]').forEach((r) => r.addEventListener('change', renderDiscordPreview));

    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      switchTab(t.dataset.tab);
      if(t.dataset.tab==='schedule' && state.id) { loadSchedules(); updateSchedulerStatus(); }
    }));

    $('#btn-new').addEventListener('click', newDoc);
    $('#btn-save').addEventListener('click', saveDoc);
    $('#btn-delete').addEventListener('click', deleteDoc);
    $('#btn-regen').addEventListener('click', async () => {
      const hasEdits = state.doc?.manualEdited || editorManuallyEdited;
      if (hasEdits) {
        const ok = await Dialog.confirm('Overwrite manual edits?', 'Regenerating will discard edits you made in the Script Editor.', { icon: '↻', okText: 'Regenerate', danger: true });
        if (!ok) return;
      }
      regenerateScript(true);
      editorManuallyEdited = false;
      if (state.doc) state.doc.manualEdited = false;
      renderScriptPreview();
      markDirty();
      toast('Regenerated from builder');
    });
    $('#btn-send-success').addEventListener('click', () => testWebhook('SUCCESS'));
    $('#btn-send-fail').addEventListener('click', () => testWebhook('FAIL'));
    $('#btn-quick-test').addEventListener('click', () => { switchTab('webhook-test'); testWebhook('SUCCESS'); });

    $('#btn-run').addEventListener('click', () => triggerRun(false));
    $('#btn-run-dry').addEventListener('click', () => triggerRun(true));
    $('#btn-run-stop').addEventListener('click', stopRun);
    // fleet
    $('#btn-add-vps').addEventListener('click', () => openVpsDialog());
    $('#btn-vps-cancel').addEventListener('click', closeVpsDialog);
    $('#btn-vps-save').addEventListener('click', saveVps);
    $('#vps-auth').addEventListener('change', syncVpsAuthFields);
    $('#btn-vps-test').addEventListener('click', async ()=>{
      const payload={name:$('#vps-name').value.trim(), host:$('#vps-host').value.trim(), port:parseInt($('#vps-port').value,10)||22, user:$('#vps-user').value.trim()||'root', auth:$('#vps-auth').value, password:$('#vps-pass').value, keyPath:$('#vps-key').value.trim()};
      if(!payload.host) return toast('Host required', true);
      const r=await fetch('/api/test/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:payload.auth==='key'?'sftp':'sftp', host:payload.host, port:payload.port, user:payload.user, password:payload.password, sftpAuth:payload.auth, keyPath:payload.keyPath})}).then(x=>x.json()).catch(()=>({ok:false,msg:'failed'}));
      // actually test source via fleet endpoint if editing
      $('#vps-test-result').textContent = r.msg || (r.ok?'ok':'failed');
      toast(r.msg|| (r.ok?'OK':'Failed'), !r.ok);
    });
    $('#btn-test-source').addEventListener('click', testSourceVps);
    $('#btn-test-dest').addEventListener('click', testDestConnection);
    $('#f-source-vps').addEventListener('change', (e)=>{
      const v=e.target.value;
      const rsel=$('#f-run-vps'); if(rsel) rsel.value=v;
      markDirty();
    });
    // schedule
    const schedBtn=$('#btn-save-schedule');
    if(schedBtn) schedBtn.addEventListener('click', saveSchedule);
    const cancelSchedBtn=$('#btn-cancel-schedule');
    if(cancelSchedBtn) cancelSchedBtn.addEventListener('click', resetScheduleForm);
    const trigBtn=$('#btn-trigger-scheduler');
    if(trigBtn) trigBtn.addEventListener('click', triggerScheduler);
    // logs
    const clearBtn=$('#btn-clear-logs');
    if(clearBtn) clearBtn.addEventListener('click', clearLogs);
    const dlBtn=$('#btn-download-log');
    if(dlBtn) dlBtn.addEventListener('click', downloadLog);
    const viewBtn=$('#btn-view-log');
    if(viewBtn) viewBtn.addEventListener('click', ()=>{
      const r = run._lastRuns?.find(x=>x.id===run.activeId) || run._lastRuns?.[0];
      if(!r || !r.output) return toast('No log to view', true);
      Dialog.alert(`Log — ${r.name} (${new Date(r.startedAt).toLocaleString()})`, r.output.slice(0,12000) + (r.output.length>12000 ? '\n... (truncated, download for full)' : ''), '📄');
    });
    const dlLiveBtn=$('#btn-download-live-log');
    if(dlLiveBtn) dlLiveBtn.addEventListener('click', downloadLog);
    const dlAllBtn=$('#btn-download-all-logs');
    if(dlAllBtn) dlAllBtn.addEventListener('click', downloadAllLogs);
    // destination fleet
    $('#btn-add-dest').addEventListener('click', ()=> openDestDialog());
    $('#btn-dest-cancel').addEventListener('click', closeDestDialog);
    $('#btn-dest-save').addEventListener('click', saveDest);
    $('#dest-type').addEventListener('change', syncDestDialogFields);
    $('#dest-sftp-auth').addEventListener('change', syncDestDialogFields);
    $('#btn-dest-test').addEventListener('click', async ()=>{
      const payload={name:$('#dest-name').value.trim(), type:$('#dest-type').value, host:$('#dest-host').value.trim(), port:$('#dest-port').value.trim(), user:$('#dest-user').value.trim(), remoteName:$('#dest-remote-name').value.trim(), remotePath:$('#dest-remote-path').value.trim(), sftpAuth:$('#dest-sftp-auth').value, keyPath:$('#dest-key-path').value.trim(), s3Provider:$('#dest-s3-provider').value, s3Bucket:$('#dest-s3-bucket').value.trim(), s3Region:$('#dest-s3-region').value.trim(), s3Endpoint:$('#dest-s3-endpoint').value.trim(), password:$('#dest-password').value, s3AccessKey:$('#dest-ak').value.trim(), s3SecretKey:$('#dest-sk').value };
      const r=await fetch('/api/test/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:payload.type, host:payload.host, port:payload.port, user:payload.user, password:payload.password, sftpAuth:payload.sftpAuth, keyPath:payload.keyPath, bucket:payload.s3Bucket, region:payload.s3Region, endpoint:payload.s3Endpoint, provider:payload.s3Provider, accessKey:payload.s3AccessKey, secretKey:payload.s3SecretKey})}).then(x=>x.json()).catch(()=>({ok:false,msg:'failed'}));
      $('#dest-test-result').textContent=r.msg|| (r.ok?'ok':'failed');
      toast(r.msg|| (r.ok?'OK':'Failed'), !r.ok);
    });
    $('#dest-dialog').addEventListener('click', e=>{ if(e.target.id==='dest-dialog') closeDestDialog(); });
    $('#f-dest-fleet').addEventListener('change', onDestFleetChange);
    // browse dialog
    $('#btn-browse-go').addEventListener('click', ()=> loadBrowsePath($('#browse-path').value.trim() || '/'));
    $('#btn-browse-up').addEventListener('click', ()=>{
      const cur = $('#browse-path').value.trim() || '/';
      const up = cur === '/' ? '/' : cur.replace(/\/[^\/]*\/?$/, '') || '/';
      loadBrowsePath(up);
    });
    $('#btn-browse-mkdir').addEventListener('click', async ()=>{
      const name = await Dialog.prompt('New Folder', 'Enter folder name', '', 'my-folder');
      if (!name) return;
      const clean = name.trim().replace(/[\/\\]/g,'').replace(/\s+/g,'-');
      if (!clean) return toast('Invalid name', true);
      const base = browseCurrentPath || (browseMode==='remote' || browseMode==='remoteFleet' ? '' : '/');
      const newPath = (base ? base.replace(/\/+$/,'') : '') + '/' + clean;
      let res, data;
      try {
        if (browseMode === 'vps') {
          const vpsId = browseState.vpsId;
          if (!vpsId) res = await fetch('/api/browse/mkdir-local', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:newPath})});
          else res = await fetch(`/api/fleet/${vpsId}/mkdir`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:newPath})});
        } else if (browseMode === 'remoteFleet') {
          res = await fetch(`/api/destinations/${browseState.destFleetId}/mkdir`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:newPath})});
        } else {
          const cfg = browseState.remoteCfg || {};
          res = await fetch('/api/browse/mkdir-remote', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...cfg, path:newPath})});
        }
        data = await res.json();
        if (!data.ok) return toast(data.msg||'mkdir failed', true);
        toast('Created ' + clean);
        loadBrowsePath(browseCurrentPath);
      } catch(e){ toast('mkdir failed: '+e.message, true); }
    });
    $('#btn-browse-cancel').addEventListener('click', closeBrowseDialog);
    $('#btn-browse-select').addEventListener('click', confirmBrowseSelect);
    const multiBtn=$('#btn-browse-multi');
    if(multiBtn) multiBtn.addEventListener('click', confirmBrowseSelect);
    $('#browse-dialog').addEventListener('click', (e)=>{ if(e.target.id==='browse-dialog') closeBrowseDialog(); });
    $('#browse-path').addEventListener('keydown', (e)=>{ if(e.key==='Enter') loadBrowsePath(e.target.value.trim()||'/'); });

    $('#btn-logout').addEventListener('click', (e) => { e.preventDefault(); doLogout(); });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDoc(); }
    });

    bindCopyButtons();
    showEmpty();
    loadList();
    loadFleet();
    loadDestinations();
    initCronMount();
    // close VPS dialog on overlay click
    $('#vps-dialog').addEventListener('click', (e)=>{ if(e.target.id==='vps-dialog') closeVpsDialog(); });
    window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#login-form').addEventListener('submit', handleAuthSubmit);
    boot();
    initMain();
  });
})();
