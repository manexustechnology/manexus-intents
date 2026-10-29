import { escapeHTML as esc } from "../../shared/text.ts";
import { NEAR_WALLETS, signIn, type Kind, type NearWalletId, type Session } from "../wallet/index.ts";

export function mountLogin(el: HTMLElement, onSignedIn: (s: Session) => void, notice = ""): () => void {
  let alive = true;
  el.innerHTML = `<section class="login">
  <p class="eyebrow">NON-CUSTODIAL INVOICING</p>
  <h1>Sign in with your wallet.</h1>
  <p class="muted">Payments settle into your own NEAR Intents account. Manexus never holds your keys or funds. Signing in only signs a message; it does not send a transaction.</p>
  <div class="login-options">
    <div class="panel login-card">
      <h2>NEAR account</h2>
      <p class="fine">Meteor or HOT wallet. Your Intents account is your NEAR account id.</p>
      <button class="primary full" data-connect="near" aria-expanded="false">Connect NEAR wallet</button>
      <div class="wallet-choices" hidden>${NEAR_WALLETS.map((w) => `<button class="choice" data-near="${esc(w.id)}">${esc(w.name)}</button>`).join("")}</div>
    </div>
    <div class="panel login-card">
      <h2>EVM account</h2>
      <p class="fine">Browser wallet such as MetaMask (regular accounts only, not smart-contract wallets). Your Intents account is your 0x address.</p>
      <button class="primary full" data-connect="evm">Connect EVM wallet</button>
    </div>
  </div>
  <p class="error" id="login-status" role="status">${esc(notice)}</p>
  <p class="fine">Powered by NEAR Intents</p>
</section>`;
  const status = el.querySelector<HTMLElement>("#login-status")!;
  const buttons = () => el.querySelectorAll<HTMLButtonElement>("button");
  const choices = el.querySelector<HTMLElement>(".wallet-choices")!;

  async function run(kind: Kind, nearWallet?: NearWalletId) {
    buttons().forEach((b) => (b.disabled = true));
    status.className = "fine";
    status.textContent = "Waiting for your wallet…";
    try {
      const s = await signIn(kind, nearWallet);
      if (alive) onSignedIn(s);
    } catch (e) {
      if (!alive) return;
      status.className = "error";
      const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
      status.textContent = !msg
        ? "Sign-in was cancelled or failed."
        : /failed to fetch|networkerror|load failed/i.test(msg)
          ? "Network error while contacting the wallet or server. Try again."
          : msg;
    } finally {
      if (alive) buttons().forEach((b) => (b.disabled = false));
    }
  }

  el.querySelector<HTMLButtonElement>('[data-connect="near"]')!.onclick = (e) => {
    choices.hidden = !choices.hidden;
    (e.currentTarget as HTMLElement).setAttribute("aria-expanded", String(!choices.hidden));
  };
  el.querySelector<HTMLButtonElement>('[data-connect="evm"]')!.onclick = () => run("evm");
  el.querySelectorAll<HTMLButtonElement>("[data-near]").forEach((b) => (b.onclick = () => run("near", b.dataset.near as NearWalletId)));
  return () => {
    alive = false;
  };
}
