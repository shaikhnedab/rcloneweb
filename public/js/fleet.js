/* rcloneweb — Fleet module (deep, single seam for VPS + Destinations) */
'use strict';
const Fleet = (() => {
  const state = { vps: [], dest: [], editingVps: null, editingDest: null };

  async function listVps() {
    const r = await fetch('/api/fleet');
    if (!r.ok) return [];
    const j = await r.json();
    state.vps = j;
    return j;
  }
  async function listDest() {
    const r = await fetch('/api/destinations');
    if (!r.ok) return [];
    const j = await r.json();
    state.dest = j;
    return j;
  }
  async function createVps(payload) {
    const r = await fetch('/api/fleet', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if (!r.ok) throw new Error((await r.json()).error||'Failed');
    return r.json();
  }
  async function updateVps(id, payload) {
    const r = await fetch(`/api/fleet/${id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if (!r.ok) throw new Error((await r.json()).error||'Failed');
    return r.json();
  }
  async function deleteVps(id) {
    const r = await fetch(`/api/fleet/${id}`, {method:'DELETE'});
    if (!r.ok) throw new Error('Delete failed');
  }
  async function testVps(idOrPayload) {
    if (typeof idOrPayload === 'string') {
      const r = await fetch(`/api/fleet/${idOrPayload}/test`, {method:'POST'});
      return r.json();
    }
    const r = await fetch('/api/test/connection',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:'sftp', ...idOrPayload})});
    return r.json();
  }

  async function createDest(payload) {
    const r = await fetch('/api/destinations',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if (!r.ok) throw new Error((await r.json()).error||'Failed');
    return r.json();
  }
  async function updateDest(id, payload) {
    const r = await fetch(`/api/destinations/${id}`,{method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if (!r.ok) throw new Error((await r.json()).error||'Failed');
    return r.json();
  }
  async function deleteDest(id) {
    const r = await fetch(`/api/destinations/${id}`,{method:'DELETE'});
    if (!r.ok) throw new Error('Delete failed');
  }
  async function testDest(idOrPayload) {
    if (typeof idOrPayload === 'string') {
      const r = await fetch(`/api/destinations/${idOrPayload}/test`,{method:'POST'});
      return r.json();
    }
    const r = await fetch('/api/test/connection',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(idOrPayload)});
    return r.json();
  }

  return { state, listVps, listDest, createVps, updateVps, deleteVps, testVps, createDest, updateDest, deleteDest, testDest };
})();
