document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value }) });
    if (!r.ok) throw new Error((await r.json()).detail || 'Sign-in failed');
    const next = new URLSearchParams(location.search).get('next') || '/';
    location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  } catch (ex) {
    err.textContent = ex.message;
  }
});
