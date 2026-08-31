const views = {
  login: document.getElementById('view-login'),
  register: document.getElementById('view-register'),
  codes: document.getElementById('view-codes'),
  recover: document.getElementById('view-recover'),
};

function show(name) {
  for (const v of Object.values(views)) v.hidden = true;
  views[name].hidden = false;
}

document.getElementById('to-register').onclick = () => show('register');
document.getElementById('to-recover').onclick = () => show('recover');
document.getElementById('register-to-login').onclick = () => show('login');
document.getElementById('recover-to-login').onclick = () => show('login');

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  const form = new FormData(e.target);
  try {
    await postJSON('/api/auth/login', {
      username: form.get('username'),
      password: form.get('password'),
    });
    window.location.href = '/app.html';
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('register-error');
  errEl.textContent = '';
  const form = new FormData(e.target);
  try {
    const data = await postJSON('/api/auth/register', {
      username: form.get('username'),
      password: form.get('password'),
    });
    const grid = document.getElementById('codes-grid');
    grid.innerHTML = '';
    for (const code of data.recoveryCodes) {
      const chip = document.createElement('div');
      chip.className = 'code-chip';
      chip.textContent = code;
      grid.appendChild(chip);
    }
    show('codes');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('codes-confirm').addEventListener('change', (e) => {
  document.getElementById('codes-continue').disabled = !e.target.checked;
});

document.getElementById('codes-continue').addEventListener('click', () => {
  window.location.href = '/app.html';
});

document.getElementById('recover-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('recover-error');
  const okEl = document.getElementById('recover-success');
  errEl.textContent = '';
  okEl.textContent = '';
  const form = new FormData(e.target);
  try {
    await postJSON('/api/auth/recover', {
      username: form.get('username'),
      code: form.get('code'),
      newPassword: form.get('newPassword'),
    });
    okEl.textContent = 'Password updated — log in with your new password.';
    setTimeout(() => show('login'), 1400);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// If already logged in, skip straight to the app.
fetch('/api/auth/me').then((res) => {
  if (res.ok) window.location.href = '/app.html';
});
