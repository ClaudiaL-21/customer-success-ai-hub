// Sprint 16 — minimal login gate. Deliberately small: no signup, no
// password reset, no roles UI. Talks only to this app's own /api/login
// (same-origin) — never to Supabase directly from the browser, so nothing
// here needs a new external script or a CSP change.
//
// Session persistence: sessionStorage only (cleared when the tab closes).
// No refresh-token handling — a demo session simply expires and asks for a
// fresh sign-in. That's an intentional simplification, not an oversight.

const TOKEN_KEY = "cs_ai_hub_access_token";
let currentToken = null;
try { currentToken = sessionStorage.getItem(TOKEN_KEY); } catch { /* private mode etc. */ }

export function getAuthToken() {
  return currentToken;
}

// Shows a minimal login form covering the page and resolves once a session
// token exists (either restored from this tab's earlier sign-in, or after a
// successful new sign-in). Called once, at startup, before the rest of the
// app renders anything.
export function requireLogin() {
  if (currentToken) return Promise.resolve();
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "auth-overlay";
    overlay.innerHTML = `
      <form class="auth-form">
        <h2>Customer Success AI Hub</h2>
        <p class="sub">Sign in to continue.</p>
        <input type="email" name="email" placeholder="Email" required autocomplete="username">
        <input type="password" name="password" placeholder="Password" required autocomplete="current-password">
        <button type="submit">Sign in</button>
        <p class="auth-error" hidden></p>
      </form>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector("form");
    const errorEl = overlay.querySelector(".auth-error");
    const submitBtn = overlay.querySelector("button");
    form.addEventListener("submit", async e => {
      e.preventDefault();
      errorEl.hidden = true;
      submitBtn.disabled = true;
      const email = form.email.value.trim();
      const password = form.password.value;
      try {
        const res = await fetch("/api/login", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.accessToken) {
          errorEl.textContent = body.error || "Sign-in failed.";
          errorEl.hidden = false;
          submitBtn.disabled = false;
          return;
        }
        currentToken = body.accessToken;
        try { sessionStorage.setItem(TOKEN_KEY, currentToken); } catch { /* private mode etc. */ }
        overlay.remove();
        resolve();
      } catch {
        errorEl.textContent = "Sign-in failed. Please try again.";
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  });
}
