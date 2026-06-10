(() => {
  let websocket = null;
  let uuid = null;
  let action = 'com.leland.lg-webos-control.action';
  let settings = {};

  const $ = (id) => document.getElementById(id);
  const fields = ['host', 'portMode', 'actionType', 'volume', 'appId', 'inputId', 'toastMessage', 'label'];

  function setStatus(text, kind = '') {
    const el = $('tvStatus');
    el.textContent = text;
    el.className = `status ${kind}`;
  }

  function applySettings(next) {
    settings = { ...settings, ...(next || {}) };
    for (const id of fields) {
      const el = $(id);
      if (!el) continue;
      if (settings[id] !== undefined && settings[id] !== null) el.value = settings[id];
    }
    if (!settings.portMode) $('portMode').value = 'auto';
    if (!settings.actionType) $('actionType').value = 'volume-up';
    updateConditionals();
  }

  function collectSettings() {
    return {
      host: $('host').value.trim(),
      portMode: $('portMode').value || 'auto',
      actionType: $('actionType').value || 'volume-up',
      volume: Math.max(0, Math.min(100, Number($('volume').value || 0))),
      appId: $('appId').value.trim(),
      inputId: $('inputId').value.trim(),
      toastMessage: $('toastMessage').value,
      label: $('label').value.trim(),
    };
  }

  function send(payload) {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
    websocket.send(JSON.stringify({ event: 'sendToPlugin', action, context: uuid, payload }));
  }

  function saveSettings() {
    settings = collectSettings();
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
    websocket.send(JSON.stringify({ event: 'setSettings', context: uuid, payload: settings }));
  }

  function updateConditionals() {
    const type = $('actionType').value;
    $('volumeBox').classList.toggle('hidden', type !== 'volume-set');
    $('appBox').classList.toggle('hidden', type !== 'launch');
    $('inputBox').classList.toggle('hidden', type !== 'input');
    $('toastBox').classList.toggle('hidden', type !== 'toast');
  }

  function setBusy(busy) {
    for (const id of ['scan', 'pair', 'loadApps', 'loadInputs']) {
      const el = $(id);
      if (el) el.disabled = busy;
    }
  }

  function refreshDevices(devices = [], pairings = {}) {
    const select = $('devices');
    const seen = new Set();
    select.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'choose a TV...';
    select.appendChild(empty);

    for (const [host, p] of Object.entries(pairings || {})) {
      seen.add(host);
      const opt = document.createElement('option');
      opt.value = host;
      opt.textContent = `${p.name || 'paired LG TV'}  -  ${host}${p.port ? ':' + p.port : ''}`;
      select.appendChild(opt);
    }
    for (const d of devices || []) {
      const host = d.host || d.address;
      if (!host || seen.has(host)) continue;
      seen.add(host);
      const opt = document.createElement('option');
      opt.value = host;
      opt.textContent = `discovered TV  -  ${host}`;
      select.appendChild(opt);
    }
    if (settings.host && seen.has(settings.host)) select.value = settings.host;
  }

  function loadAppsFromResult(result) {
    const select = $('appSelect');
    select.innerHTML = '<option value="">choose app...</option>';
    const apps = (result && result.payload && (result.payload.launchPoints || result.payload.apps)) || [];
    apps.sort((a, b) => String(a.title || a.name || a.id).localeCompare(String(b.title || b.name || b.id)));
    for (const app of apps) {
      const id = app.id || app.appId;
      if (!id) continue;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${app.title || app.name || id}  -  ${id}`;
      select.appendChild(opt);
    }
  }

  function loadInputsFromResult(result) {
    const select = $('inputSelect');
    select.innerHTML = '<option value="">choose input...</option>';
    const inputs = (result && result.payload && (result.payload.devices || result.payload.inputs)) || [];
    for (const input of inputs) {
      const id = input.id || input.appId || input.label;
      if (!id) continue;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${input.label || input.name || id}${input.connected ? ' ✓' : ''}  -  ${id}`;
      select.appendChild(opt);
    }
  }

  function handlePluginMessage(msg) {
    const payload = msg.payload || {};
    if (payload.command === 'get-pairings' && payload.ok) {
      refreshDevices([], payload.pairings || {});
      return;
    }
    if (payload.command === 'scan') {
      setBusy(false);
      if (payload.ok) {
        refreshDevices(payload.devices || [], payload.pairings || {});
        setStatus(`scan complete: ${(payload.devices || []).length} candidate(s)`, 'ok');
      } else {
        setStatus(`scan failed: ${payload.error}`, 'bad');
      }
      return;
    }
    if (payload.command === 'pair') {
      if (payload.stage === 'waiting-for-tv-approval') {
        setStatus('waiting for TV approval prompt...', '');
        return;
      }
      setBusy(false);
      if (payload.ok) {
        refreshDevices([], payload.pairings || {});
        setStatus(`paired ${payload.name || payload.host || ''}${payload.port ? ':' + payload.port : ''}`, 'ok');
      } else {
        setStatus(`pair failed: ${payload.error}`, 'bad');
      }
      return;
    }
    if (payload.command === 'apps') {
      setBusy(false);
      if (payload.ok) {
        loadAppsFromResult(payload.result);
        setStatus('apps loaded', 'ok');
      } else setStatus(`apps failed: ${payload.error}`, 'bad');
      return;
    }
    if (payload.command === 'inputs') {
      setBusy(false);
      if (payload.ok) {
        loadInputsFromResult(payload.result);
        setStatus('inputs loaded', 'ok');
      } else setStatus(`inputs failed: ${payload.error}`, 'bad');
    }
  }

  window.connectElgatoStreamDeckSocket = (port, inUuid, registerEvent, info, actionInfo) => {
    uuid = inUuid;
    try {
      const parsed = JSON.parse(actionInfo || '{}');
      action = parsed.action || action;
      applySettings((parsed.payload && parsed.payload.settings) || {});
    } catch {}

    websocket = new WebSocket(`ws://127.0.0.1:${port}`);
    websocket.onopen = () => {
      websocket.send(JSON.stringify({ event: registerEvent, uuid }));
      send({ command: 'get-pairings' });
    };
    websocket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.event === 'sendToPropertyInspector') handlePluginMessage(msg);
      if (msg.event === 'didReceiveSettings') applySettings((msg.payload && msg.payload.settings) || {});
    };
  };

  document.addEventListener('DOMContentLoaded', () => {
    applySettings({ portMode: 'auto', actionType: 'volume-up', volume: 50, toastMessage: 'hello from Stream Deck', ...settings });
    for (const id of fields) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('change', saveSettings);
      el.addEventListener('input', () => {
        if (id === 'actionType') updateConditionals();
      });
    }
    $('actionType').addEventListener('change', () => { updateConditionals(); saveSettings(); });
    $('devices').addEventListener('change', () => {
      if ($('devices').value) {
        $('host').value = $('devices').value;
        saveSettings();
      }
    });
    $('appSelect').addEventListener('change', () => {
      if ($('appSelect').value) {
        $('appId').value = $('appSelect').value;
        saveSettings();
      }
    });
    $('inputSelect').addEventListener('change', () => {
      if ($('inputSelect').value) {
        $('inputId').value = $('inputSelect').value;
        saveSettings();
      }
    });
    $('scan').addEventListener('click', () => { setBusy(true); setStatus('scanning LAN via SSDP...'); send({ command: 'scan' }); });
    $('pair').addEventListener('click', () => {
      saveSettings();
      const s = collectSettings();
      if (!s.host) { setStatus('enter a TV IP first', 'bad'); return; }
      setBusy(true);
      setStatus('starting pairing... watch the TV');
      send({ command: 'pair', host: s.host, portMode: s.portMode });
    });
    $('loadApps').addEventListener('click', () => {
      saveSettings();
      const s = collectSettings();
      if (!s.host) { setStatus('enter/pair a TV first', 'bad'); return; }
      setBusy(true); setStatus('loading apps...'); send({ command: 'apps', host: s.host, portMode: s.portMode });
    });
    $('loadInputs').addEventListener('click', () => {
      saveSettings();
      const s = collectSettings();
      if (!s.host) { setStatus('enter/pair a TV first', 'bad'); return; }
      setBusy(true); setStatus('loading inputs...'); send({ command: 'inputs', host: s.host, portMode: s.portMode });
    });
  });
})();
