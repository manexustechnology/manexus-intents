import "./style.css";
import { escapeHTML as esc } from "../shared/text.ts";
import { api, ApiError } from "./api.ts";
import { mountHome } from "./views/home.ts";
import { mountInvoice } from "./views/invoice-detail.ts";
import { mountInvoices } from "./views/invoices.ts";
import { mountPay } from "./views/pay.ts";
import { mountLogin } from "./views/login.ts";
import { mountWithdraw } from "./views/withdraw.ts";
import { disconnectWallet, type Session } from "./wallet/index.ts";

export type Mount = (el: HTMLElement, params: Record<string, string>) => () => void;

type Route = { name: string; params: Record<string, string>; public: boolean; nav: string; title: string };

const views = new Map<string, Mount>();
export function registerView(name: string, mount: Mount): void {
  views.set(name, mount);
}

const ROUTES: { pattern: RegExp; name: string; keys: string[]; public?: boolean; nav: string; title: string }[] = [
  { pattern: /^\/?$/, name: "home", keys: [], nav: "home", title: "Home" },
  { pattern: /^\/invoices\/?$/, name: "invoices", keys: [], nav: "invoices", title: "Invoices" },
  { pattern: /^\/invoices\/([^/]+)\/?$/, name: "invoice", keys: ["id"], nav: "invoices", title: "Invoice" },
  { pattern: /^\/withdraw\/?$/, name: "withdraw", keys: [], nav: "withdraw", title: "Withdraw" },
  { pattern: /^\/pay\/([^/]+)\/?$/, name: "pay", keys: ["publicId"], public: true, nav: "", title: "Pay invoice" },
];

export function parseRoute(hash: string): Route | null {
  const path = hash.replace(/^#/, "") || "/";
  for (const r of ROUTES) {
    const m = r.pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch {
        params[k] = m[i + 1];
      }
    });
    return { name: r.name, params, public: !!r.public, nav: r.nav, title: r.title };
  }
  return null;
}

registerView("home", mountHome);
registerView("invoices", mountInvoices);
registerView("invoice", mountInvoice);
registerView("withdraw", mountWithdraw);
registerView("pay", mountPay);

const NAV: [string, string, string, string][] = [
  ["home", "#/", "◫", "Home"],
  ["invoices", "#/invoices", "▤", "Invoices"],
  ["withdraw", "#/withdraw", "↗", "Withdraw"],
];

const app = document.querySelector<HTMLDivElement>("#app")!;
let session: Session | null | undefined; // undefined = not yet known
let sessionError = "";
let unmount: () => void = () => {};

function shortAccount(a: string): string {
  if (/^0x[0-9a-f]{40}$/.test(a)) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  return a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a;
}

const brand = `<a class="brand" href="#/" aria-label="Manexus home"><span class="brandmark">m</span>manexus<span class="dot">.</span></a>`;
const footer = `<footer><span>Non-custodial: Manexus never holds your keys or funds.</span><span>Powered by NEAR Intents</span></footer>`;

function shell(route: Route, s: Session): HTMLElement {
  app.className = "";
  app.innerHTML = `<aside>${brand}<span class="workspace">YOUR BUSINESS</span><nav aria-label="Main navigation">${NAV.map(
    ([id, href, icon, label]) =>
      `<a href="${href}" class="nav ${route.nav === id ? "active" : ""}"${route.nav === id ? ' aria-current="page"' : ""}><span>${icon}</span>${label}</a>`,
  ).join("")}</nav><div class="sidebottom"><div class="network"><i></i> Powered by NEAR Intents</div><p>Manexus · v0.1</p></div></aside><div class="page"><header><span class="crumb">Workspace <span>/</span> ${esc(route.title)}</span><div class="header-right"><span class="account-chip" title="${esc(s.account)}"><span class="kind">${s.kind === "near" ? "NEAR" : "EVM"}</span><span class="account-id">${esc(shortAccount(s.account))}</span></span><button class="textbutton" id="sign-out">Sign out</button></div></header><main id="content"></main>${footer}</div>`;
  app.querySelector<HTMLButtonElement>("#sign-out")!.onclick = signOut;
  return app.querySelector<HTMLElement>("#content")!;
}

function bare(title: string): HTMLElement {
  app.className = "bare";
  app.innerHTML = `<div class="page"><header>${brand}<span class="crumb">${esc(title)}</span></header><main id="content"></main>${footer}</div>`;
  return app.querySelector<HTMLElement>("#content")!;
}

function render(): void {
  unmount();
  unmount = () => {};
  const route = parseRoute(location.hash);
  if (!route) {
    const el = session ? shell({ name: "", params: {}, public: false, nav: "", title: "Not found" }, session) : bare("Not found");
    el.innerHTML = `<div class="heading"><div><h1>Page not found</h1><p class="muted"><a href="#/">Go to home</a></p></div></div>`;
    return;
  }
  if (route.public) {
    unmount = views.get(route.name)!(bare(route.title), route.params);
    return;
  }
  if (session === undefined) {
    bare("Loading").innerHTML = `<p class="muted" role="status">Loading…</p>`;
    return;
  }
  if (session === null) {
    unmount = mountLogin(
      bare("Sign in"),
      (s) => {
        session = s;
        sessionError = "";
        render();
      },
      sessionError,
    );
    return;
  }
  unmount = views.get(route.name)!(shell(route, session), route.params);
}

async function signOut(): Promise<void> {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* cookie may already be gone */
  }
  await disconnectWallet();
  session = null;
  render();
}

async function loadSession(): Promise<void> {
  try {
    session = await api<Session>("/api/me");
  } catch (e) {
    session = null;
    if (!(e instanceof ApiError && e.status === 401)) sessionError = "Could not reach the server. Try again in a moment.";
  }
  render();
}

window.addEventListener("hashchange", render);
render();
void loadSession();
