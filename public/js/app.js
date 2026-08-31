let me = null;
let rooms = [];
let currentRoomId = null;
let ws = null;
let typingTimeout = null;
const typingUsers = new Map(); // roomId -> Set(username), cleared after a few seconds

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = '/';
    throw new Error('Not logged in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function boot() {
  try {
    const data = await api('/api/auth/me');
    me = data.user;
  } catch {
    return;
  }
  document.getElementById('whoami').textContent =
    `${me.username}${me.isAdmin ? ' · admin' : ''}`;

  if (me.isAdmin) document.getElementById('admin-section').hidden = false;

  await loadRooms();
  connectWS();
  wireStaticUI();
}

async function loadRooms() {
  const data = await api('/api/rooms');
  rooms = data.rooms;
  renderNav();
}

function renderNav() {
  const navGroup = document.getElementById('nav-group');
  navGroup.innerHTML = '';

  const group = rooms.find((r) => r.type === 'group');
  const dms = rooms.filter((r) => r.type === 'dm');

  if (group) navGroup.appendChild(navItem(group.id, group.name, 'group'));

  const label = document.createElement('div');
  label.className = 'nav-group';
  label.textContent = 'Personal messages';
  navGroup.appendChild(label);

  for (const dm of dms) navGroup.appendChild(navItem(dm.id, dm.name, 'dm'));

  navGroup.appendChild(newDmItem());
}

function navItem(roomId, label, type) {
  const el = document.createElement('div');
  el.className = 'nav-item';
  el.dataset.room = roomId;
  el.textContent = label;
  if (roomId === currentRoomId) el.classList.add('active');
  el.onclick = () => selectRoom(roomId);
  return el;
}

function newDmItem() {
  const el = document.createElement('div');
  el.className = 'nav-item';
  el.textContent = '+ New message';
  el.onclick = () => {
    const box = document.createElement('input');
    box.placeholder = 'Username…';
    box.style.margin = '4px 20px';
    box.style.width = 'calc(100% - 40px)';
    el.replaceWith(box);
    box.focus();
    box.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const username = box.value.trim();
      if (!username) return;
      try {
        const data = await api(`/api/rooms/dm/${encodeURIComponent(username)}`, { method: 'POST' });
        await loadRooms();
        selectRoom(data.roomId);
      } catch (err) {
        toast(err.message);
        box.replaceWith(el);
      }
    });
    box.addEventListener('blur', () => {
      setTimeout(() => { if (box.isConnected) box.replaceWith(el); }, 150);
    });
  };
  return el;
}

async function selectRoom(roomId) {
  currentRoomId = roomId;
  document.getElementById('main-settings').hidden = true;
  document.getElementById('main-chat').hidden = false;
  document.querySelectorAll('.nav-item[data-room]').forEach((el) => {
    el.classList.toggle('active', el.dataset.room === roomId);
  });
  document.getElementById('nav-settings').classList.remove('active');

  const room = rooms.find((r) => r.id === roomId);
  document.getElementById('room-title').textContent = room ? room.name : '';
  document.getElementById('room-sub').textContent =
    room && room.type === 'group' ? 'Messages here clear after 9 days unless saved.' : 'Private — kept indefinitely.';

  document.getElementById('composer').hidden = false;
  document.getElementById('messages').innerHTML = '';

  const data = await api(`/api/rooms/${roomId}/messages`);
  for (const m of data.messages) appendMessage(roomId, m);
  scrollToBottom();
}

function scrollToBottom() {
  const el = document.getElementById('messages');
  el.scrollTop = el.scrollHeight;
}

function appendMessage(roomId, m) {
  if (roomId !== currentRoomId) return;
  const container = document.getElementById('messages');
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  const mine = m.sender_id === me.id || m.sender === me.username;
  const row = document.createElement('div');
  row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;
  row.dataset.id = m.id;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const time = new Date(m.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  meta.textContent = `${mine ? 'You' : m.sender} · ${time}`;
  row.appendChild(meta);

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${m.saved ? 'saved' : ''}`;
  bubble.textContent = m.body;

  const room = rooms.find((r) => r.id === roomId);
  if (room && room.type === 'group') {
    const star = document.createElement('button');
    star.className = `save-star ${m.saved ? 'active' : ''}`;
    star.textContent = m.saved ? '★ saved — stays past 9 days' : '☆ save this message';
    star.onclick = async () => {
      const nowSaved = !bubble.classList.contains('saved');
      try {
        await api(`/api/rooms/${roomId}/messages/${m.id}/save`, {
          method: 'POST',
          body: JSON.stringify({ saved: nowSaved }),
        });
        bubble.classList.toggle('saved', nowSaved);
        star.classList.toggle('active', nowSaved);
        star.textContent = nowSaved ? '★ saved — stays past 9 days' : '☆ save this message';
      } catch (err) {
        toast(err.message);
      }
    };
    row.appendChild(bubble);
    row.appendChild(star);
  } else {
    row.appendChild(bubble);
  }

  container.appendChild(row);
}

function removeMessage(roomId, id) {
  if (roomId !== currentRoomId) return;
  const row = document.querySelector(`.msg-row[data-id="${id}"]`);
  if (row) row.remove();
}

function connectWS() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${window.location.host}`);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'backlog') {
      for (const m of msg.messages) appendMessage(msg.roomId, m);
      scrollToBottom();
    } else if (msg.type === 'message') {
      appendMessage(msg.roomId, msg.message);
      scrollToBottom();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ack', roomId: msg.roomId, messageId: msg.message.id }));
      }
    } else if (msg.type === 'messages_deleted') {
      for (const id of msg.ids) removeMessage(msg.roomId, id);
    } else if (msg.type === 'typing') {
      showTyping(msg.roomId, msg.username);
    }
  };

  ws.onclose = () => {
    setTimeout(connectWS, 1500); // simple reconnect; catch-up handles any gap
  };
}

function showTyping(roomId, username) {
  if (roomId !== currentRoomId) return;
  const el = document.getElementById('typing-indicator');
  el.textContent = `${username} is typing…`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 2500);
}

function wireStaticUI() {
  document.getElementById('nav-settings').onclick = openSettings;
  document.getElementById('logout-btn').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  };

  const input = document.getElementById('msg-input');
  const send = () => {
    const text = input.value.trim();
    if (!text || !currentRoomId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'chat', roomId: currentRoomId, body: text }));
    input.value = '';
    input.style.height = 'auto';
  };
  document.getElementById('send-btn').onclick = send;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else {
      clearTimeout(typingTimeout);
      if (currentRoomId && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'typing', roomId: currentRoomId }));
      }
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });

  document.getElementById('view-codes-btn').onclick = async () => {
    if (!confirm('This replaces all your current unused recovery codes. Continue?')) return;
    const data = await api('/api/auth/recovery-codes/regenerate', { method: 'POST' });
    const out = document.getElementById('codes-output');
    out.innerHTML = '<div class="code-grid" id="settings-codes-grid"></div><div class="hint-text" style="margin-top:8px;">Save these now — they won\'t be shown again.</div>';
    const grid = document.getElementById('settings-codes-grid');
    for (const code of data.recoveryCodes) {
      const chip = document.createElement('div');
      chip.className = 'code-chip';
      chip.textContent = code;
      grid.appendChild(chip);
    }
    refreshRemainingCount();
  };

  if (me.isAdmin) wireAdminPanel();
}

async function refreshRemainingCount() {
  const data = await api('/api/auth/me');
  document.getElementById('codes-remaining-text').textContent =
    `You have ${data.recoveryCodesRemaining} unused recovery code${data.recoveryCodesRemaining === 1 ? '' : 's'}.`;
}

async function openSettings() {
  document.getElementById('main-chat').hidden = true;
  document.getElementById('main-settings').hidden = false;
  document.querySelectorAll('.nav-item[data-room]').forEach((el) => el.classList.remove('active'));
  document.getElementById('nav-settings').classList.add('active');

  await refreshRemainingCount();

  const history = await api('/api/auth/admin/reset-history');
  const section = document.getElementById('reset-history-section');
  const list = document.getElementById('reset-history');
  list.innerHTML = '';
  if (history.resets.length) {
    section.hidden = false;
    for (const r of history.resets) {
      const div = document.createElement('div');
      div.className = 'reset-log';
      div.textContent = `Reset by ${r.admin_username} on ${new Date(r.created_at).toLocaleString()}`;
      list.appendChild(div);
    }
  } else {
    section.hidden = true;
  }
}

async function wireAdminPanel() {
  const select = document.getElementById('admin-user-select');
  const data = await api('/api/auth/users');
  select.innerHTML = data.users.map((u) => `<option value="${u.username}">${u.username}</option>`).join('');

  document.getElementById('admin-reset-btn').onclick = async () => {
    const errEl = document.getElementById('admin-error');
    errEl.textContent = '';
    const username = select.value;
    const newPassword = document.getElementById('admin-new-password').value;
    try {
      await api('/api/auth/admin/reset-password', {
        method: 'POST',
        body: JSON.stringify({ username, newPassword }),
      });
      toast(`Password reset for ${username}.`);
      document.getElementById('admin-new-password').value = '';
    } catch (err) {
      errEl.textContent = err.message;
    }
  };
}

boot();
