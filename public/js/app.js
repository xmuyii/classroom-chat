let me = null;
let groupRooms = []; // [{id, name, description, isMember, hasUnread}]
let dmRooms = [];    // [{id, name, hasUnread}]
let currentRoomId = null;
let currentRoomIsMember = false;
let ws = null;
let wsConnected = false;
let reconnectTimer = null;
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

  loadPrefs();
  await loadRooms();
  connectWS();
  wireStaticUI();
  maybeShowOnboarding();
}

/* ---------------- Preferences (local, per-browser) ---------------- */

function loadPrefs() {
  const soundOn = localStorage.getItem('pref_sound') === '1';
  document.getElementById('pref-sound').checked = soundOn;
}

function playPingSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 720;
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    // Audio isn't available in every context (e.g. before any user
    // interaction on some browsers) — failing silently is fine here.
  }
}

/* ---------------- Rooms & sidebar ---------------- */

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

  for (const room of groupRooms) {
    navGroup.appendChild(navItem(room.id, room.name, !room.isMember, room.isMember && room.hasUnread));
  }

  const dmLabel = document.createElement('div');
  dmLabel.className = 'nav-group';
  dmLabel.textContent = 'Personal messages';
  navGroup.appendChild(dmLabel);

  for (const dm of dmRooms) navGroup.appendChild(navItem(dm.id, dm.name, false, dm.hasUnread));

  navGroup.appendChild(newDmItem());
}

function navItem(roomId, label, locked, unread) {
  const el = document.createElement('div');
  el.className = `nav-item${locked ? ' locked' : ''}${unread ? ' unread' : ''}`;
  el.dataset.room = roomId;
  const text = document.createElement('span');
  text.textContent = label;
  el.appendChild(text);
  if (unread && !locked) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    el.appendChild(dot);
  }
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

  const topicEl = document.getElementById('room-topic');
  if (group && group.description) {
    topicEl.textContent = group.description;
    topicEl.hidden = false;
  } else {
    topicEl.hidden = true;
  }

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

  // Opening a room counts as reading it — clear its unread dot right away.
  if (group) group.hasUnread = false;
  if (dm) dm.hasUnread = false;
  renderNav();

  try {
    const data = await api(`/api/rooms/${roomId}/messages`);
    for (const m of data.messages) appendMessage(roomId, m);
    scrollToBottom();
  } catch (err) {
    if (err.code === 'not_a_member') {
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

  // Dedupe: a message can arrive twice for the same id (e.g. a held message
  // was rendered locally as pending, then re-broadcast once an admin
  // approves it) — replace rather than duplicate.
  const existing = container.querySelector(`.msg-row[data-id="${m.id}"]`);
  if (existing) existing.remove();

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
  bubble.className = `msg-bubble ${m.saved ? 'saved' : ''} ${m.pending ? 'pending' : ''}`;
  bubble.textContent = m.body;
  row.appendChild(bubble);

  if (m.pending) {
    const label = document.createElement('div');
    label.className = 'msg-pending-label';
    label.textContent = 'Awaiting review \u2014 only you can see this until it\u2019s approved.';
    row.appendChild(label);
    container.appendChild(row);
    return; // no save/flag/delete actions on a message that isn't visible yet
  }

  const isGroup = !!findGroupRoom(roomId);
  if (isGroup) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const star = document.createElement('button');
    star.className = `save-star ${m.saved ? 'active' : ''}`;
    star.textContent = m.saved ? '\u2605 saved' : '\u2606 save';
    star.title = m.saved ? 'Saved \u2014 stays past 9 days' : 'Save this message so it stays past 9 days';
    star.onclick = async () => {
      const nowSaved = !bubble.classList.contains('saved');
      try {
        await api(`/api/rooms/${roomId}/messages/${m.id}/save`, {
          method: 'POST',
          body: JSON.stringify({ saved: nowSaved }),
        });
        bubble.classList.toggle('saved', nowSaved);
        star.classList.toggle('active', nowSaved);
        star.textContent = nowSaved ? '\u2605 saved' : '\u2606 save';
      } catch (err) {
        toast(err.message);
      }
    };
    actions.appendChild(star);

    if (!mine) {
      const flagBtn = document.createElement('button');
      flagBtn.className = `flag-btn ${m.flagged ? 'active' : ''}`;
      flagBtn.textContent = m.flagged ? '\u2691 reported' : '\u2690 report to teacher';
      flagBtn.disabled = !!m.flagged;
      flagBtn.onclick = async () => {
        try {
          await api(`/api/rooms/${roomId}/messages/${m.id}/flag`, { method: 'POST' });
          flagBtn.textContent = '\u2691 reported';
          flagBtn.classList.add('active');
          flagBtn.disabled = true;
          toast('Reported to your teacher.');
        } catch (err) {
          toast(err.message);
        }
      };
      actions.appendChild(flagBtn);
    }

    if (me.isAdmin) {
      const delBtn = document.createElement('button');
      delBtn.className = 'delete-btn';
      delBtn.textContent = 'delete';
      delBtn.onclick = async () => {
        if (!confirm('Delete this message for everyone?')) return;
        try {
          await api(`/api/admin/messages/${m.id}`, { method: 'DELETE' });
        } catch (err) {
          toast(err.message);
        }
      };
      actions.appendChild(delBtn);
    }

    row.appendChild(actions);
  }

  container.appendChild(row);

  if (!mine) {
    const soundOn = localStorage.getItem('pref_sound') === '1';
    if (soundOn) playPingSound();
  }
}

function removeMessage(roomId, id) {
  if (roomId !== currentRoomId) return;
  const row = document.querySelector(`.msg-row[data-id="${id}"]`);
  if (row) row.remove();
}

/* ---------------- WebSocket: connection, heartbeat-aware UI ---------------- */

function setConnected(connected) {
  wsConnected = connected;
  document.getElementById('conn-status').hidden = connected;
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) sendBtn.disabled = !connected;
}

function connectWS() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${window.location.host}`);

  ws.onopen = () => {
    setConnected(true);
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'backlog') {
      for (const m of msg.messages) appendMessage(msg.roomId, m);
      scrollToBottom();
      markUnreadIfNotCurrent(msg.roomId);
    } else if (msg.type === 'message') {
      appendMessage(msg.roomId, msg.message);
      scrollToBottom();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ack', roomId: msg.roomId, messageId: msg.message.id }));
      }
      markUnreadIfNotCurrent(msg.roomId);
    } else if (msg.type === 'messages_deleted') {
      for (const id of msg.ids) removeMessage(msg.roomId, id);
    } else if (msg.type === 'typing') {
      showTyping(msg.roomId, msg.username);
    } else if (msg.type === 'room_added') {
      const existing = findGroupRoom(msg.room.id);
      if (existing) existing.isMember = true;
      else groupRooms.push({ id: msg.room.id, name: msg.room.name, isMember: true, hasUnread: false });
      renderNav();
      toast(`You were added to ${msg.room.name}.`);
      if (currentRoomId === msg.room.id) selectRoom(currentRoomId);
    } else if (msg.type === 'room_removed') {
      const existing = findGroupRoom(msg.roomId);
      if (existing) existing.isMember = false;
      renderNav();
      if (currentRoomId === msg.roomId) selectRoom(currentRoomId);
    } else if (msg.type === 'moderation_alert') {
      if (me.isAdmin) {
        document.getElementById('settings-dot').hidden = false;
        const reasonText = msg.reason === 'flagged' ? 'A message was flagged' : 'A message needs review';
        toast(`${reasonText} in ${msg.roomName || 'a room'}.`);
      }
    }
  };

  ws.onclose = () => {
    setConnected(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose fires right after in virtually all browsers; scheduling here
    // too (idempotent via the timer guard) covers the rare case it doesn't.
    setConnected(false);
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 1500);
}

function markUnreadIfNotCurrent(roomId) {
  if (roomId === currentRoomId) return;
  const group = findGroupRoom(roomId);
  const dm = findDmRoom(roomId);
  if (group) group.hasUnread = true;
  if (dm) dm.hasUnread = true;
  renderNav();
}

// A laptop coming back from sleep, or a tab regaining focus after a long
// time backgrounded, is exactly when a stale connection is most likely —
// nudge a reconnect immediately instead of waiting for the next heartbeat.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!ws || ws.readyState !== WebSocket.OPEN)) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connectWS();
  }
});

function showTyping(roomId, username) {
  if (roomId !== currentRoomId) return;
  const el = document.getElementById('typing-indicator');
  el.textContent = `${username} is typing\u2026`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 2500);
}

/* ---------------- Static UI wiring ---------------- */

function wireStaticUI() {
  document.getElementById('nav-settings').onclick = openSettings;
  document.getElementById('logout-btn').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  };

  document.getElementById('pref-sound').addEventListener('change', (e) => {
    localStorage.setItem('pref_sound', e.target.checked ? '1' : '0');
  });

  document.getElementById('replay-tour-btn').onclick = () => showOnboarding();

  document.getElementById('members-btn').onclick = openMemberPanel;
  document.getElementById('close-members-btn').onclick = () => {
    document.getElementById('member-panel').hidden = true;
  };

  document.getElementById('quick-add-btn').onclick = async () => {
    const errEl = document.getElementById('quick-add-error');
    errEl.textContent = '';
    const input = document.getElementById('quick-add-username');
    const username = input.value.trim();
    if (!username || !currentRoomId) return;
    try {
      await api(`/api/admin/rooms/${currentRoomId}/members`, {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
      input.value = '';
      toast(`Added ${username}.`);
      await openMemberPanel();
    } catch (err) {
      errEl.textContent = err.message;
    }
  };

  const input = document.getElementById('msg-input');
  const send = () => {
    const text = input.value.trim();
    if (!text || !currentRoomId || !currentRoomIsMember) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast('Not connected \u2014 reconnecting, try again in a moment.');
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        connectWS();
      }
      return;
    }
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

async function openMemberPanel() {
  if (!currentRoomId || !currentRoomIsMember) return;
  const group = findGroupRoom(currentRoomId);
  const quickAdd = document.getElementById('member-quick-add');
  quickAdd.hidden = !(me.isAdmin && group);
  document.getElementById('quick-add-username').value = '';
  document.getElementById('quick-add-error').textContent = '';

  try {
    // Admins use the admin endpoint so this always works even for a room
    // they manage but might not personally be chatting in.
    const data = me.isAdmin
      ? await api(`/api/admin/rooms/${currentRoomId}/members`)
      : await api(`/api/rooms/${currentRoomId}/members`);
    const list = document.getElementById('member-list');
    list.innerHTML = '';
    for (const m of data.members) {
      const row = document.createElement('div');
      row.className = `member-row ${m.username === me.username ? 'you' : ''}`;
      const dot = document.createElement('span');
      dot.className = `presence-dot ${m.online ? 'online' : ''}`;
      dot.title = m.online ? 'Online now' : 'Offline';
      const label = document.createElement('span');
      label.textContent = m.username === me.username ? `${m.username} (you)` : m.username;
      row.appendChild(dot);
      row.appendChild(label);
      list.appendChild(row);
    }
    document.getElementById('member-panel').hidden = false;
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- Settings / admin ---------------- */

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

  if (me.isAdmin) {
    document.getElementById('settings-dot').hidden = true;
    document.getElementById('moderation-section').hidden = false;
    await loadModerationQueues();
    await refreshAdminRoomPickers();
  }
}

async function loadModerationQueues() {
  const [pending, flagged] = await Promise.all([
    api('/api/admin/moderation/pending'),
    api('/api/admin/moderation/flagged'),
  ]);

  const pendingList = document.getElementById('mod-pending-list');
  pendingList.innerHTML = '';
  if (!pending.items.length) {
    pendingList.innerHTML = '<div class="hint-text">Nothing waiting.</div>';
  } else {
    for (const item of pending.items) {
      const el = document.createElement('div');
      el.className = 'mod-item';
      el.innerHTML = `
        <div class="mod-item-meta">${item.sender} \u00b7 ${item.room_name} \u00b7 ${new Date(item.created_at).toLocaleString()}</div>
        <div class="mod-item-body"></div>
        <div class="mod-item-actions">
          <button class="approve">Approve</button>
          <button class="reject">Reject</button>
        </div>`;
      el.querySelector('.mod-item-body').textContent = item.body;
      el.querySelector('.approve').onclick = async () => {
        try { await api(`/api/admin/moderation/${item.id}/approve`, { method: 'POST' }); loadModerationQueues(); }
        catch (err) { toast(err.message); }
      };
      el.querySelector('.reject').onclick = async () => {
        try { await api(`/api/admin/moderation/${item.id}/reject`, { method: 'POST' }); loadModerationQueues(); }
        catch (err) { toast(err.message); }
      };
      pendingList.appendChild(el);
    }
  }

  const flaggedList = document.getElementById('mod-flagged-list');
  flaggedList.innerHTML = '';
  if (!flagged.items.length) {
    flaggedList.innerHTML = '<div class="hint-text">Nothing flagged.</div>';
  } else {
    for (const item of flagged.items) {
      const el = document.createElement('div');
      el.className = 'mod-item';
      el.innerHTML = `
        <div class="mod-item-meta">${item.sender} \u00b7 ${item.room_name} \u00b7 ${new Date(item.created_at).toLocaleString()}</div>
        <div class="mod-item-body"></div>
        <div class="mod-item-actions">
          <button class="dismiss">Dismiss</button>
          <button class="delete">Delete</button>
        </div>`;
      el.querySelector('.mod-item-body').textContent = item.body;
      el.querySelector('.dismiss').onclick = async () => {
        try { await api(`/api/admin/moderation/${item.id}/dismiss-flag`, { method: 'POST' }); loadModerationQueues(); }
        catch (err) { toast(err.message); }
      };
      el.querySelector('.delete').onclick = async () => {
        if (!confirm('Delete this message for everyone?')) return;
        try { await api(`/api/admin/messages/${item.id}`, { method: 'DELETE' }); loadModerationQueues(); }
        catch (err) { toast(err.message); }
      };
      flaggedList.appendChild(el);
    }
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

  document.getElementById('save-room-btn').onclick = async () => {
    const roomId = document.getElementById('admin-room-select').value;
    if (!roomId) return;
    const name = document.getElementById('room-name-input').value.trim();
    const description = document.getElementById('room-topic-input').value.trim();
    if (!name) { toast('Room name can\u2019t be empty.'); return; }
    try {
      await api(`/api/admin/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify({ name, description }) });
      toast('Saved.');
      await loadRooms();
      await refreshAdminRoomPickers();
      if (currentRoomId === roomId) selectRoom(roomId);
    } catch (err) {
      toast(err.message);
    }
  };

  document.getElementById('admin-room-select').addEventListener('change', (e) => {
    renderRoomMemberList(e.target.value);
    const room = findGroupRoom(e.target.value);
    document.getElementById('room-name-input').value = (room && room.name) || '';
    document.getElementById('room-topic-input').value = (room && room.description) || '';
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

  if (roomSelect.value) {
    await renderRoomMemberList(roomSelect.value);
    const room = findGroupRoom(roomSelect.value);
    document.getElementById('room-name-input').value = (room && room.name) || '';
    document.getElementById('room-topic-input').value = (room && room.description) || '';
  }
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

/* ---------------- Onboarding tour ---------------- */

const ONBOARDING_STEPS = [
  {
    title: 'Welcome to Room One',
    body: 'This is where the class works together \u2014 group discussion, questions, and building projects as a team. A quick look around before you dive in.',
  },
  {
    title: 'Group chats',
    body: 'Each class or project has its own room, listed on the left. Messages in a group room disappear after 9 days automatically \u2014 tap the star on any message to keep it around longer, which is handy for pinning project notes or decisions.',
  },
  {
    title: 'Personal messages',
    body: 'Need to talk to one classmate directly? Start a personal message from the sidebar. Those are private and never expire.',
  },
  {
    title: 'Recovery codes',
    body: 'There\u2019s no email or phone number on this platform \u2014 if you forget your password, one of your recovery codes gets you back in. Find them anytime in Settings, and keep them somewhere safe.',
  },
];

function maybeShowOnboarding() {
  const key = `onboarding_seen_v1_${me.id}`;
  if (!localStorage.getItem(key)) showOnboarding();
}

function showOnboarding() {
  let step = 0;
  const overlay = document.getElementById('onboarding-overlay');
  const stepEl = document.getElementById('onboarding-step');
  const dotsEl = document.getElementById('onboarding-dots');
  const nextBtn = document.getElementById('onboarding-next');
  const skipBtn = document.getElementById('onboarding-skip');

  function render() {
    const s = ONBOARDING_STEPS[step];
    stepEl.innerHTML = `<div class="display">${s.title}</div><p>${s.body}</p>`;
    dotsEl.innerHTML = ONBOARDING_STEPS.map((_, i) => `<span class="${i === step ? 'active' : ''}"></span>`).join('');
    nextBtn.textContent = step === ONBOARDING_STEPS.length - 1 ? 'Done' : 'Next';
  }

  function finish() {
    localStorage.setItem(`onboarding_seen_v1_${me.id}`, '1');
    overlay.hidden = true;
    nextBtn.onclick = null;
    skipBtn.onclick = null;
  }

  nextBtn.onclick = () => {
    if (step === ONBOARDING_STEPS.length - 1) { finish(); return; }
    step += 1;
    render();
  };
  skipBtn.onclick = finish;

  step = 0;
  render();
  overlay.hidden = false;
}

boot();
