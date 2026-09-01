let me = null;
let groupRooms = []; // [{id, name, isMember}]
let dmRooms = [];    // [{id, name}]
let currentRoomId = null;
let currentRoomIsMember = false;
let ws = null;
let typingTimeout = null;

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
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    err.code = data.code;
    throw err;
  }
  return data;
}

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

function findGroupRoom(id) { return groupRooms.find((r) => r.id === id); }
function findDmRoom(id) { return dmRooms.find((r) => r.id === id); }

async function boot() {
  try {
    const data = await api('/api/auth/me');
    me = data.user;
  } catch {
    return;
  }
  document.getElementById('whoami').textContent =
    `${me.username}${me.isAdmin ? ' \u00b7 admin' : ''}`;

  if (me.isAdmin) {
    document.getElementById('admin-section').hidden = false;
    document.getElementById('admin-rooms-section').hidden = false;
  }

  await loadRooms();
  connectWS();
  wireStaticUI();
}

async function loadRooms() {
  const data = await api('/api/rooms');
  groupRooms = data.groupRooms;
  dmRooms = data.dmRooms;
  renderNav();
}

function renderNav() {
  const navGroup = document.getElementById('nav-group');
  navGroup.innerHTML = '';

  const groupLabel = document.createElement('div');
  groupLabel.className = 'nav-group';
  groupLabel.textContent = 'Group chats';
  navGroup.appendChild(groupLabel);

  for (const room of groupRooms) navGroup.appendChild(navItem(room.id, room.name, !room.isMember));

  const dmLabel = document.createElement('div');
  dmLabel.className = 'nav-group';
  dmLabel.textContent = 'Personal messages';
  navGroup.appendChild(dmLabel);

  for (const dm of dmRooms) navGroup.appendChild(navItem(dm.id, dm.name, false));

  navGroup.appendChild(newDmItem());
}

function navItem(roomId, label, locked) {
  const el = document.createElement('div');
  el.className = `nav-item${locked ? ' locked' : ''}`;
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
    box.placeholder = 'Username\u2026';
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
  document.getElementById('member-panel').hidden = true;
  document.querySelectorAll('.nav-item[data-room]').forEach((el) => {
    el.classList.toggle('active', el.dataset.room === roomId);
  });
  document.getElementById('nav-settings').classList.remove('active');

  const group = findGroupRoom(roomId);
  const dm = findDmRoom(roomId);
  const room = group || dm;
  document.getElementById('room-title').textContent = room ? room.name : '';

  if (group && !group.isMember) {
    currentRoomIsMember = false;
    document.getElementById('room-sub').textContent = '';
    document.getElementById('composer').hidden = true;
    document.getElementById('members-btn').hidden = true;
    const container = document.getElementById('messages');
    container.innerHTML = '';
    const denied = document.createElement('div');
    denied.className = 'access-denied';
    denied.innerHTML = '<div class="display">Access denied</div><p>You\u2019re not a member of this room yet. Ask an admin to add you.</p>';
    container.appendChild(denied);
    document.getElementById('typing-indicator').textContent = '';
    return;
  }

  currentRoomIsMember = true;
  document.getElementById('room-sub').textContent =
    group ? 'Messages here clear after 9 days unless saved.' : 'Private \u2014 kept indefinitely.';
  document.getElementById('composer').hidden = false;
  document.getElementById('members-btn').hidden = !group;
  document.getElementById('messages').innerHTML = '';

  try {
    const data = await api(`/api/rooms/${roomId}/messages`);
    for (const m of data.messages) appendMessage(roomId, m);
    scrollToBottom();
  } catch (err) {
    if (err.code === 'not_a_member') {
      // Membership state was stale client-side (e.g. just removed) \u2014 refresh and retry the render.
      await loadRooms();
      selectRoom(roomId);
    } else {
      toast(err.message);
    }
  }
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
  meta.textContent = `${mine ? 'You' : m.sender} \u00b7 ${time}`;
  row.appendChild(meta);

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${m.saved ? 'saved' : ''}`;
  bubble.textContent = m.body;

  const isGroup = !!findGroupRoom(roomId);
  if (isGroup) {
    const star = document.createElement('button');
    star.className = `save-star ${m.saved ? 'active' : ''}`;
    star.textContent = m.saved ? '\u2605 saved \u2014 stays past 9 days' : '\u2606 save this message';
    star.onclick = async () => {
      const nowSaved = !bubble.classList.contains('saved');
      try {
        await api(`/api/rooms/${roomId}/messages/${m.id}/save`, {
          method: 'POST',
          body: JSON.stringify({ saved: nowSaved }),
        });
        bubble.classList.toggle('saved', nowSaved);
        star.classList.toggle('active', nowSaved);
        star.textContent = nowSaved ? '\u2605 saved \u2014 stays past 9 days' : '\u2606 save this message';
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
    } else if (msg.type === 'room_added') {
      const existing = findGroupRoom(msg.room.id);
      if (existing) existing.isMember = true;
      else groupRooms.push({ id: msg.room.id, name: msg.room.name, isMember: true });
      renderNav();
      toast(`You were added to ${msg.room.name}.`);
      if (currentRoomId === msg.room.id) selectRoom(currentRoomId);
    } else if (msg.type === 'room_removed') {
      const existing = findGroupRoom(msg.roomId);
      if (existing) existing.isMember = false;
      renderNav();
      if (currentRoomId === msg.roomId) selectRoom(currentRoomId);
    }
  };

  ws.onclose = () => {
    setTimeout(connectWS, 1500); // simple reconnect; catch-up handles any gap
  };
}

function showTyping(roomId, username) {
  if (roomId !== currentRoomId) return;
  const el = document.getElementById('typing-indicator');
  el.textContent = `${username} is typing\u2026`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 2500);
}

function wireStaticUI() {
  document.getElementById('nav-settings').onclick = openSettings;
  document.getElementById('logout-btn').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  };

  document.getElementById('members-btn').onclick = async () => {
    if (!currentRoomId || !currentRoomIsMember) return;
    try {
      const data = await api(`/api/rooms/${currentRoomId}/members`);
      const list = document.getElementById('member-list');
      list.innerHTML = '';
      for (const m of data.members) {
        const row = document.createElement('div');
        row.className = `member-row ${m.username === me.username ? 'you' : ''}`;
        row.textContent = m.username === me.username ? `${m.username} (you)` : m.username;
        list.appendChild(row);
      }
      document.getElementById('member-panel').hidden = false;
    } catch (err) {
      toast(err.message);
    }
  };
  document.getElementById('close-members-btn').onclick = () => {
    document.getElementById('member-panel').hidden = true;
  };

  const input = document.getElementById('msg-input');
  const send = () => {
    const text = input.value.trim();
    if (!text || !currentRoomId || !currentRoomIsMember || !ws || ws.readyState !== WebSocket.OPEN) return;
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
      if (currentRoomId && currentRoomIsMember && ws && ws.readyState === WebSocket.OPEN) {
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
    out.innerHTML = '<div class="code-grid" id="settings-codes-grid"></div><div class="hint-text" style="margin-top:8px;">Save these now \u2014 they won\'t be shown again.</div>';
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
  document.getElementById('member-panel').hidden = true;
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

  if (me.isAdmin) await refreshAdminRoomPickers();
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

  document.getElementById('create-room-btn').onclick = async () => {
    const errEl = document.getElementById('create-room-error');
    errEl.textContent = '';
    const input = document.getElementById('new-room-name');
    const name = input.value.trim();
    if (!name) return;
    try {
      await api('/api/admin/rooms', { method: 'POST', body: JSON.stringify({ name }) });
      input.value = '';
      await loadRooms();
      await refreshAdminRoomPickers();
      toast(`Created "${name}".`);
    } catch (err) {
      errEl.textContent = err.message;
    }
  };

  document.getElementById('add-member-btn').onclick = async () => {
    const errEl = document.getElementById('add-member-error');
    errEl.textContent = '';
    const roomId = document.getElementById('admin-room-select').value;
    const username = document.getElementById('admin-add-user-select').value;
    if (!roomId || !username) return;
    try {
      await api(`/api/admin/rooms/${roomId}/members`, { method: 'POST', body: JSON.stringify({ username }) });
      toast(`Added ${username}.`);
      await renderRoomMemberList(roomId);
    } catch (err) {
      errEl.textContent = err.message;
    }
  };

  document.getElementById('admin-room-select').addEventListener('change', (e) => {
    renderRoomMemberList(e.target.value);
  });
}

async function refreshAdminRoomPickers() {
  const [roomsData, usersData] = await Promise.all([
    api('/api/admin/rooms'),
    api('/api/auth/users'),
  ]);

  const roomSelect = document.getElementById('admin-room-select');
  const prevRoom = roomSelect.value;
  roomSelect.innerHTML = roomsData.rooms
    .map((r) => `<option value="${r.id}">${r.name} (${r.member_count})</option>`)
    .join('');
  if (prevRoom && roomsData.rooms.some((r) => r.id === prevRoom)) roomSelect.value = prevRoom;

  const userSelect = document.getElementById('admin-add-user-select');
  userSelect.innerHTML = usersData.users.map((u) => `<option value="${u.username}">${u.username}</option>`).join('');

  if (roomSelect.value) await renderRoomMemberList(roomSelect.value);
}

async function renderRoomMemberList(roomId) {
  if (!roomId) return;
  const data = await api(`/api/admin/rooms/${roomId}/members`);
  const container = document.getElementById('room-member-list');
  container.innerHTML = '';
  if (!data.members.length) {
    container.innerHTML = '<div class="hint-text">No members yet.</div>';
    return;
  }
  for (const m of data.members) {
    const row = document.createElement('div');
    row.className = 'room-member-row';
    const label = document.createElement('span');
    label.textContent = m.username;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'quiet';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = async () => {
      try {
        await api(`/api/admin/rooms/${roomId}/members/${encodeURIComponent(m.username)}`, { method: 'DELETE' });
        toast(`Removed ${m.username}.`);
        renderRoomMemberList(roomId);
        refreshAdminRoomPickers();
      } catch (err) {
        toast(err.message);
      }
    };
    row.appendChild(label);
    row.appendChild(removeBtn);
    container.appendChild(row);
  }
}

boot();
