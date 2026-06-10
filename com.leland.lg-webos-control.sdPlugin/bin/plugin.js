#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const WebSocket = require('ws');

const PLUGIN_UUID = 'com.leland.lg-webos-control';
const ACTION_UUID = 'com.leland.lg-webos-control.action';
const DEFAULT_PORTS = [3001, 3000];
const PERMISSIONS = [
  'LAUNCH',
  'LAUNCH_WEBAPP',
  'CONTROL_AUDIO',
  'CONTROL_INPUT_MEDIA_PLAYBACK',
  'READ_INSTALLED_APPS',
  'READ_RUNNING_APPS',
  'READ_INPUT_DEVICE_LIST',
  'READ_CURRENT_CHANNEL',
  'WRITE_NOTIFICATION_TOAST',
];

const state = {
  streamDeck: null,
  pluginUUID: null,
  registerEvent: null,
  info: null,
  actions: new Map(),
  mediaIntent: new Map(),
};

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(...parts) {
  console.log('[lg-webos-control]', ...parts);
}

function dataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'LG webOS Stream Deck Control');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'LG webOS Stream Deck Control');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'lg-webos-streamdeck-control');
}

function configPath() {
  return path.join(dataDir(), 'tv-pairings.json');
}

function readPairings() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writePairings(pairings) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(pairings, null, 2));
  try { fs.chmodSync(configPath(), 0o600); } catch {}
}

function sanitizedPairings() {
  const pairings = readPairings();
  const out = {};
  for (const [host, cfg] of Object.entries(pairings)) {
    out[host] = { host, port: cfg.port, name: cfg.name || '', paired: Boolean(cfg.clientKey) };
  }
  return out;
}

function redactedError(err) {
  const text = err && err.message ? err.message : String(err);
  return text.replace(/client-key":"[^"]+/gi, 'client-key":"[REDACTED]')
    .replace(/clientKey":"[^"]+/gi, 'clientKey":"[REDACTED]');
}

function makeRegisterPayload(clientKey) {
  const manifest = {
    manifestVersion: 1,
    appVersion: '0.1.0',
    signed: {
      created: '2026-06-10T00:00:00Z',
      appId: PLUGIN_UUID,
      vendorId: 'com.leland',
      localizedAppNames: { '': 'LG webOS Stream Deck Control' },
      localizedVendorNames: { '': 'LG webOS Control' },
      permissions: PERMISSIONS,
    },
    permissions: PERMISSIONS,
    signatures: [],
  };
  const payload = { pairingType: 'PROMPT', manifest };
  if (clientKey) payload['client-key'] = clientKey;
  return payload;
}

function parsePortMode(portMode) {
  if (portMode === '3001') return [3001];
  if (portMode === '3000') return [3000];
  const n = Number(portMode);
  if (n === 3000 || n === 3001) return [n];
  return DEFAULT_PORTS;
}

async function connectTv(host, options = {}) {
  if (!host) throw new Error('missing TV IP/host');
  const pairings = readPairings();
  const tvCfg = pairings[host] || {};
  const requestedPorts = options.port ? [Number(options.port)] : parsePortMode(options.portMode);
  const ports = [...new Set([tvCfg.port, ...requestedPorts].filter(Boolean).map(Number))];
  let lastErr;

  for (const port of ports) {
    const proto = port === 3001 ? 'wss' : 'ws';
    const url = `${proto}://${host}:${port}`;
    try {
      const ws = await new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 });
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
        socket.once('unexpected-response', (_req, res) => reject(new Error(`unexpected HTTP ${res.statusCode}`)));
      });

      let nextId = 1;
      const pending = new Map();
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg.id || !pending.has(msg.id)) return;
        const item = pending.get(msg.id);
        if (item.type === 'register') {
          const newKey = msg.payload && msg.payload['client-key'];
          const acceptedExistingKey = item.hasClientKey && msg.type === 'response' && msg.payload && msg.payload.returnValue === true;
          if (msg.type === 'registered' || newKey || acceptedExistingKey) {
            pending.delete(msg.id);
            clearTimeout(item.timer);
            item.resolve(msg);
          } else if (msg.type === 'error') {
            pending.delete(msg.id);
            clearTimeout(item.timer);
            item.reject(new Error(JSON.stringify(msg)));
          }
          return;
        }
        pending.delete(msg.id);
        clearTimeout(item.timer);
        if (msg.type === 'error') item.reject(new Error(JSON.stringify(msg)));
        else item.resolve(msg);
      });

      function request(type, uri, payload, timeoutMs = 15000, meta = {}) {
        const id = String(nextId++);
        const packet = { id, type };
        if (uri) packet.uri = uri;
        if (payload !== undefined) packet.payload = payload;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              reject(new Error(`timeout waiting for ${type} ${uri || ''}`));
            }
          }, timeoutMs);
          pending.set(id, { resolve, reject, type, timer, ...meta });
          ws.send(JSON.stringify(packet));
        });
      }

      const reg = await request('register', undefined, makeRegisterPayload(tvCfg.clientKey), tvCfg.clientKey ? 8000 : 60000, { hasClientKey: Boolean(tvCfg.clientKey) });
      const newKey = reg.payload && reg.payload['client-key'];
      if (newKey && newKey !== tvCfg.clientKey) {
        pairings[host] = { ...tvCfg, clientKey: newKey, port };
        writePairings(pairings);
      } else if (tvCfg.clientKey && tvCfg.port !== port) {
        pairings[host] = { ...tvCfg, port };
        writePairings(pairings);
      }

      return {
        port,
        request: (uri, payload, timeoutMs) => request('request', uri, payload, timeoutMs),
        subscribe: (uri, payload, timeoutMs) => request('subscribe', uri, payload, timeoutMs),
        close: () => ws.close(),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('could not connect to TV');
}

async function discover(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const hits = new Map();
    const msg = Buffer.from([
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 2',
      'ST: ssdp:all',
      '', '',
    ].join('\r\n'));

    socket.on('message', (buf, rinfo) => {
      const text = buf.toString('utf8');
      if (!/lg|webos|lgtv|tv/i.test(text)) return;
      const server = (text.match(/^SERVER:\s*(.+)$/im) || [])[1] || '';
      const location = (text.match(/^LOCATION:\s*(.+)$/im) || [])[1] || '';
      const usn = (text.match(/^USN:\s*(.+)$/im) || [])[1] || '';
      hits.set(rinfo.address, { host: rinfo.address, address: rinfo.address, server, location, usn });
    });
    socket.on('error', () => {});
    socket.bind(() => {
      try { socket.setBroadcast(true); socket.setMulticastTTL(2); } catch {}
      socket.send(msg, 1900, '239.255.255.250');
      setTimeout(() => { try { socket.close(); } catch {}; resolve([...hits.values()]); }, timeoutMs);
    });
  });
}

function send(event, payload) {
  if (!state.streamDeck || state.streamDeck.readyState !== WebSocket.OPEN) return;
  state.streamDeck.send(JSON.stringify({ event, ...payload }));
}

function setTitle(context, title) {
  send('setTitle', { context, payload: { title: String(title || '') } });
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

const ICON_ALIASES = {
  'media-play-pause': 'media-play-pause',
  'mute-toggle': 'mute-toggle',
};

function iconNameFor(settingsOrKind) {
  const raw = typeof settingsOrKind === 'string'
    ? settingsOrKind
    : normalizeSettings(settingsOrKind || {}).actionType;
  const name = ICON_ALIASES[raw] || raw || 'default';
  return /^[a-z0-9-]+$/.test(name) ? name : 'default';
}

function readIconSvg(settingsOrKind) {
  const primary = iconNameFor(settingsOrKind);
  const candidates = [primary, 'default'];
  for (const name of candidates) {
    const iconPath = path.join(__dirname, '..', 'imgs', `${name}.svg`);
    try {
      return fs.readFileSync(iconPath, 'utf8');
    } catch {}
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="28" fill="#090d13"/></svg>';
}

function setTileIcon(context, settingsOrKind) {
  const settings = typeof settingsOrKind === 'string' ? { actionType: settingsOrKind } : normalizeSettings(settingsOrKind || {});
  const image = svgDataUrl(readIconSvg(settingsOrKind));
  send('setImage', { context, payload: { image } });
  setTitle(context, settings.label || '');
}

function setDialFeedback(context, settingsOrKind, value = 'Rotate') {
  const settings = typeof settingsOrKind === 'string' ? { actionType: settingsOrKind } : normalizeSettings(settingsOrKind || {});
  const iconKind = typeof settingsOrKind === 'string' ? settingsOrKind : (settings.actionType || 'volume-up');
  send('setFeedback', {
    context,
    payload: {
      title: settings.label || 'LG TV',
      value,
      indicator: 50,
      icon: svgDataUrl(readIconSvg(iconKind)),
    },
  });
}

function isEncoderMessage(msg) {
  return String((msg.payload && msg.payload.controller) || '').toLowerCase() === 'encoder';
}

function setActionVisual(context, settingsOrKind, msg, value) {
  if (msg && isEncoderMessage(msg)) setDialFeedback(context, settingsOrKind, value);
  else setTileIcon(context, settingsOrKind);
}

function showOk(context) { send('showOk', { context }); }
function showAlert(context) { send('showAlert', { context }); }

function sendToPi(action, context, payload) {
  send('sendToPropertyInspector', { action: action || ACTION_UUID, context, payload });
}

function setSettings(context, settings) {
  send('setSettings', { context, payload: settings || {} });
}

function normalizeSettings(settings = {}) {
  return {
    host: settings.host || settings.tvHost || '',
    portMode: settings.portMode || 'auto',
    actionType: settings.actionType || 'volume-up',
    volume: Number.isFinite(Number(settings.volume)) ? Number(settings.volume) : 50,
    appId: settings.appId || '',
    inputId: settings.inputId || '',
    toastMessage: settings.toastMessage || 'hello from Stream Deck',
    label: settings.label || '',
  };
}

function titleForSettings(settings) {
  const s = normalizeSettings(settings);
  return s.label || '';
}

function mediaIntentKey(settings) {
  const s = normalizeSettings(settings);
  return `${s.host}|${s.appId || 'default'}`;
}

async function playPauseToggle(conn, settings) {
  const key = mediaIntentKey(settings);
  const current = state.mediaIntent.get(key);

  // Cheaty but reliable: the dedicated play/pause commands work on this TV,
  // but LG/Spotify state and playPause do not. So keep local intent and
  // alternate explicit commands. Unknown starts with pause because the normal
  // desk use case is Spotify already playing and Leland wants to pause it.
  const command = current === 'paused' ? 'play' : 'pause';
  const res = await conn.request(`ssap://media.controls/${command}`);
  state.mediaIntent.set(key, command === 'pause' ? 'paused' : 'playing');
  return res;
}

async function runTvAction(settings) {
  const s = normalizeSettings(settings);
  const conn = await connectTv(s.host, { portMode: s.portMode });
  try {
    switch (s.actionType) {
      case 'volume-up': return await conn.request('ssap://audio/volumeUp');
      case 'volume-down': return await conn.request('ssap://audio/volumeDown');
      case 'mute': return await conn.request('ssap://audio/setMute', { mute: true });
      case 'unmute': return await conn.request('ssap://audio/setMute', { mute: false });
      case 'mute-toggle': {
        const status = await conn.request('ssap://audio/getStatus');
        const payload = status.payload || {};
        const current = Boolean(payload.mute || (payload.volumeStatus && payload.volumeStatus.muteStatus));
        return await conn.request('ssap://audio/setMute', { mute: !current });
      }
      case 'volume-set': return await conn.request('ssap://audio/setVolume', { volume: Math.max(0, Math.min(100, Number(s.volume) || 0)) });
      case 'launch': {
        if (!s.appId) throw new Error('missing app id');
        return await conn.request('ssap://system.launcher/launch', { id: s.appId });
      }
      case 'input': {
        if (!s.inputId) throw new Error('missing input id');
        const id = s.inputId.startsWith('com.') ? s.inputId : `com.webos.app.${s.inputId.toLowerCase().replace('_', '')}`;
        return await conn.request('ssap://system.launcher/launch', { id });
      }
      case 'media-play-pause': return await playPauseToggle(conn, s);
      case 'media-play': {
        const res = await conn.request('ssap://media.controls/play');
        state.mediaIntent.set(mediaIntentKey(s), 'playing');
        return res;
      }
      case 'media-pause': {
        const res = await conn.request('ssap://media.controls/pause');
        state.mediaIntent.set(mediaIntentKey(s), 'paused');
        return res;
      }
      case 'media-stop': {
        const res = await conn.request('ssap://media.controls/stop');
        state.mediaIntent.set(mediaIntentKey(s), 'paused');
        return res;
      }
      case 'media-rewind': return await conn.request('ssap://media.controls/rewind');
      case 'media-fast-forward': return await conn.request('ssap://media.controls/fastForward');
      case 'toast': return await conn.request('ssap://system.notifications/createToast', { message: s.toastMessage || 'hello from Stream Deck' });
      case 'status': return await conn.request('ssap://audio/getStatus');
      default: throw new Error(`unknown action ${s.actionType}`);
    }
  } finally {
    conn.close();
  }
}

async function handlePiCommand(msg) {
  const { action, context, payload = {} } = msg;
  const command = payload.command;
  try {
    if (command === 'scan') {
      const devices = await discover(Number(payload.timeoutMs) || 3500);
      sendToPi(action, context, { command, ok: true, devices, pairings: sanitizedPairings() });
      return;
    }

    if (command === 'pair') {
      const host = payload.host;
      const portMode = payload.portMode || 'auto';
      sendToPi(action, context, { command, ok: true, stage: 'waiting-for-tv-approval', message: 'approve the prompt on the TV' });
      const conn = await connectTv(host, { portMode });
      let name = '';
      try {
        const info = await conn.request('ssap://system/getSystemInfo', undefined, 8000);
        name = (info.payload && (info.payload.modelName || info.payload.product_name)) || '';
      } catch {}
      conn.close();
      const pairings = readPairings();
      if (pairings[host]) {
        pairings[host].name = name || pairings[host].name || '';
        writePairings(pairings);
      }
      sendToPi(action, context, { command, ok: true, stage: 'paired', host, port: (pairings[host] || {}).port, name, pairings: sanitizedPairings() });
      return;
    }

    if (command === 'status' || command === 'apps' || command === 'inputs') {
      const host = payload.host;
      const portMode = payload.portMode || 'auto';
      const conn = await connectTv(host, { portMode });
      try {
        let res;
        if (command === 'status') res = await conn.request('ssap://audio/getStatus');
        if (command === 'apps') res = await conn.request('ssap://com.webos.applicationManager/listLaunchPoints');
        if (command === 'inputs') res = await conn.request('ssap://tv/getExternalInputList');
        sendToPi(action, context, { command, ok: true, result: res });
      } finally {
        conn.close();
      }
      return;
    }

    if (command === 'get-pairings') {
      sendToPi(action, context, { command, ok: true, pairings: sanitizedPairings() });
      return;
    }

    sendToPi(action, context, { command, ok: false, error: `unknown command ${command}` });
  } catch (err) {
    sendToPi(action, context, { command, ok: false, error: redactedError(err) });
  }
}

async function handleKeyDown(msg) {
  const context = msg.context;
  const settings = normalizeSettings((msg.payload && msg.payload.settings) || {});
  if (!settings.host) {
    setActionVisual(context, 'error', msg, 'Set TV IP');
    showAlert(context);
    return;
  }
  setActionVisual(context, 'busy', msg, 'Working');
  try {
    const res = await runTvAction(settings);
    showOk(context);
    setActionVisual(context, settings, msg, 'Ready');
  } catch (err) {
    log('action failed', redactedError(err));
    setActionVisual(context, 'error', msg, 'Error');
    showAlert(context);
  }
}

async function handleDialRotate(msg) {
  const context = msg.context;
  const settings = normalizeSettings((msg.payload && msg.payload.settings) || {});
  const ticks = Number((msg.payload && msg.payload.ticks) || 0);
  if (!settings.host || !ticks) {
    setDialFeedback(context, settings.host ? 'volume-up' : 'error', settings.host ? 'Rotate' : 'Set TV IP');
    if (!settings.host) showAlert(context);
    return;
  }

  const count = Math.min(10, Math.max(1, Math.abs(Math.round(ticks))));
  const actionType = ticks > 0 ? 'volume-up' : 'volume-down';
  setDialFeedback(context, actionType, ticks > 0 ? 'Vol +' : 'Vol −');
  try {
    for (let i = 0; i < count; i += 1) {
      await runTvAction({ ...settings, actionType });
    }
    showOk(context);
    setDialFeedback(context, actionType, 'Ready');
  } catch (err) {
    log('dial rotate failed', redactedError(err));
    setDialFeedback(context, 'error', 'Error');
    showAlert(context);
  }
}

async function handleDialPress(msg) {
  if (msg.payload && msg.payload.pressed === false) return;
  const context = msg.context;
  const settings = normalizeSettings((msg.payload && msg.payload.settings) || {});
  if (!settings.host) {
    setDialFeedback(context, 'error', 'Set TV IP');
    showAlert(context);
    return;
  }
  setDialFeedback(context, 'mute-toggle', 'Mute');
  try {
    await runTvAction({ ...settings, actionType: 'mute-toggle' });
    showOk(context);
    setDialFeedback(context, 'mute-toggle', 'Ready');
  } catch (err) {
    log('dial press failed', redactedError(err));
    setDialFeedback(context, 'error', 'Error');
    showAlert(context);
  }
}

async function handleTouchTap(msg) {
  const context = msg.context;
  const settings = normalizeSettings((msg.payload && msg.payload.settings) || {});
  if (!settings.host) {
    setDialFeedback(context, 'error', 'Set TV IP');
    showAlert(context);
    return;
  }
  setDialFeedback(context, 'media-play-pause', 'Play/Pause');
  try {
    await runTvAction({ ...settings, actionType: 'media-play-pause' });
    showOk(context);
    setDialFeedback(context, 'media-play-pause', 'Ready');
  } catch (err) {
    log('touch tap failed', redactedError(err));
    setDialFeedback(context, 'error', 'Error');
    showAlert(context);
  }
}

function handleWillAppear(msg) {
  const settings = normalizeSettings((msg.payload && msg.payload.settings) || {});
  state.actions.set(msg.context, { action: msg.action, settings });
  setActionVisual(msg.context, settings, msg, 'Rotate');
}

function handleDidReceiveSettings(msg) {
  const settings = normalizeSettings((msg.payload && msg.payload.settings) || {});
  state.actions.set(msg.context, { action: msg.action, settings });
  setActionVisual(msg.context, settings, msg, 'Rotate');
}

function connectStreamDeck() {
  const port = argValue('-port');
  state.pluginUUID = argValue('-pluginUUID') || PLUGIN_UUID;
  state.registerEvent = argValue('-registerEvent') || 'registerPlugin';
  try { state.info = JSON.parse(argValue('-info') || '{}'); } catch { state.info = {}; }
  if (!port) {
    log('missing -port; Stream Deck launches plugins with websocket args');
    process.exit(1);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  state.streamDeck = ws;
  ws.on('open', () => {
    ws.send(JSON.stringify({ event: state.registerEvent, uuid: state.pluginUUID }));
    log('registered with Stream Deck');
  });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.event === 'willAppear') return handleWillAppear(msg);
    if (msg.event === 'didReceiveSettings') return handleDidReceiveSettings(msg);
    if (msg.event === 'keyDown') return handleKeyDown(msg);
    if (msg.event === 'dialRotate') return handleDialRotate(msg);
    if (msg.event === 'dialPress') return handleDialPress(msg);
    if (msg.event === 'touchTap') return handleTouchTap(msg);
    if (msg.event === 'sendToPlugin') return handlePiCommand(msg);
  });
  ws.on('error', (err) => log('Stream Deck websocket error', err.message || err));
  ws.on('close', () => process.exit(0));
}

connectStreamDeck();
